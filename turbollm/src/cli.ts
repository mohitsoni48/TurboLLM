import { takeBootEnvironment } from './util/boot-env'
import { hideChildConsoleWindows } from './util/hide-console-windows'
import { closeAllLifelines, killTetheredSync, refuseNewTetheredSpawns, setJobSentinel, tetherReady } from './util/tether'
import { JobSentinel } from './util/win-job-sentinel'
import { checkOrphansReaped } from './util/pid1'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConfigStore,
  configAccessProblem,
  configuredDaemonPort,
  defaultConfigPath,
  migrateLegacyDataDir,
} from './config/config'
import { killTrackedEnginesSync } from './engines/manager'
import { packagedAndroidApp } from './engines/zip-install'
import { stopUsageMonitor } from './sysinfo/usage'
import { stopDaemonTicks } from './util/daemon-ticks'
import { launchCli } from './cli-launch'
import { removeOwnPidfile, findRunningDaemon, claimDataDir, releaseDataDirClaim, stopDaemon, resolveDaemonAddress, localDaemonOrigin, daemonReachHost, DATA_DIR_IN_USE_EXIT_CODE, CONFIG_ACCESS_EXIT_CODE } from './daemon-pid'
import { RESTART_REQUESTED_EXIT_CODE, planRestartExit } from './daemon-restart'
import { runMcpServer } from './mcp-server'
import { closeTerminalSockets } from './terminal/terminal-routes'
import { killTrackedTerminalsSync } from './terminal/terminal-manager'
import { killTrackedTunnelsSync } from './remote/child-process'
import { TELEMETRY_ENV } from './telemetry/disabled'
import { bootDaemon } from './boot'

// What this daemon's parent promised it (util/boot-env.ts): the desktop app's supervision, a restart keeper, a stdin
// lifeline. Read first, bound to the parent's pid and removed from process.env, so nothing spawned below inherits
// them: a TurboLLM run from a Code terminal or bash command is never taken for the app's own daemon.
const boot = takeBootEnvironment()
// The parent's lifeline (the desktop app, or the restart keeper): it holds this daemon's stdin, so stdin ends when
// the parent ends, however it ends, and this daemon then shuts down gracefully. A paused stdin never emits 'end', so
// it is resumed. Before the shutdown handler exists (the parent died during boot), it exits at once.
let beginShutdown: ((reason: string) => void) | null = null
if (boot.stdinLifeline) {
  const reason = boot.keeperPid !== null ? 'the keeper ended' : 'the desktop app closed'
  let ended = false
  const onEnd = () => {
    if (ended) return
    ended = true
    if (beginShutdown) beginShutdown(reason)
    else process.exit(0)
  }
  process.stdin.once('end', onEnd)
  process.stdin.once('close', onEnd)
  process.stdin.once('error', onEnd)
  process.stdin.resume()
}
// stdout and stderr may be a terminal that is gone (closed: the next write to the hung-up tty fails with EIO), or a
// parent's that went away with it (EPIPE). With no 'error' listener that write error is thrown as an uncaught
// exception: closing the terminal ended the daemon within milliseconds of its hangup, at the "shutting down" line,
// with none of its graceful shutdown run (replies not saved as stopped, engines SIGKILLed by the exit handler).
// `launch` and `mcp-server` get them too, and still end with their child and their stdin.
process.stdout.on('error', () => { /* the terminal is gone */ })
process.stderr.on('error', () => { /* the terminal is gone */ })

// Stop child processes (the agent engine's shell tool, engine binaries, git,
// etc.) from flashing a console window on Windows when the daemon has no console
// of its own. Must run before anything spawns — patches the shared low-level
// spawn path, so it covers the external pi SDK's named spawn import too.
hideChildConsoleWindows()
// Every long-lived child is started through util/tether.ts, which ties it to this process's life. On the Android
// app that first runs libtether_exec.so's self-test (at most 3 s), so the first engine already starts under the
// helper when it passes; everywhere else this resolves at once.
await tetherReady()

// Entrypoint for the TurboLLM daemon (npm bin "turbollm"): wiring + graceful
// shutdown. ADR-023 (Node/TS stack).
//
// Version is read from package.json — the single source of truth — so the daemon
// always reports the published version with no manual bump. Works in dev (this
// file is src/cli.ts) and in the built package (dist/cli.js); both sit one level
// below package.json. Falls back if the file can't be read.
let version = '0.1.1'
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? version
} catch { /* keep fallback */ }

// ── Node version guard ────────────────────────────────────────────────────────
// 22.13.0, not just 22, on desktop — that's when node:sqlite became available without
// the --experimental-sqlite flag (GitHub #40); on 22.5.0-22.12.x importing it bare throws
// ERR_UNKNOWN_BUILTIN_MODULE despite `node -v` reporting 22.x. Android is exempt: it never
// touches node:sqlite at all (sqlite-adapter.ts routes it through sql.js instead — see that
// module's header), and its embedded `nodejs-mobile` runtime ships Node 18.20.4, confirmed
// live (TurboLLM Android's PROVENANCE.md + its emulator verification) — well under 22.13.0
// but irrelevant to this specific guard's actual reason for existing.
const isAndroid = process.platform === 'android'
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (!isAndroid && (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13))) {
  process.stderr.write(
    `TurboLLM requires Node.js 22.13.0 or newer.\n` +
    `You are running Node.js ${process.versions.node}.\n` +
    `Please upgrade: https://nodejs.org\n`,
  )
  process.exit(1)
}

// ── Crash safety net ────────────────────────────────────────────────────────────
// A client that disconnects mid-stream (Claude cancels a turn, a browser tab closes,
// `curl | head` exits) can surface a stray AbortError as an UNHANDLED rejection. Node
// makes that fatal by default — and a dying daemon orphans its llama-server child, which
// keeps the model loaded and its queue draining while the UI shows nothing. That cascade
// is the heart of the reported bug. A local inference daemon must outlive any single
// client: swallow the expected abort, log anything genuinely unexpected, and keep serving.
process.on('unhandledRejection', (reason) => {
  if ((reason as { name?: string } | null)?.name === 'AbortError') return
  console.warn('unhandledRejection (continuing):', reason)
})

// ── Arg helpers ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)

function hasFlag(...names: string[]): boolean {
  return names.some((n) => argv.includes(n))
}

/** The value after `name`, or undefined when `name` is absent or last. */
function optionalArg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

function argValue(name: string, fallback: string): string {
  return optionalArg(name) ?? fallback
}

// `--no-telemetry` is expressed as the env var rather than a second code path,
// so the flag and TURBOLLM_TELEMETRY can never disagree (ADR-299). Set before
// anything reads it. One-way by design: it can only turn telemetry off.
if (hasFlag('--no-telemetry')) process.env[TELEMETRY_ENV] = 'off'

// ── `turbollm launch <cli>` — start a coding CLI wired to TurboLLM ──────────────
// Handled before --help so `turbollm launch claude --help` forwards --help to the
// launched CLI rather than printing TurboLLM's help.
if (argv[0] === 'launch') {
  const target = argv[1] ?? ''
  const modelKey = argValue('--model', '') || undefined
  // Resolve the daemon's port without ever assuming a fixed default: an explicit
  // --port wins; otherwise the running daemon's pidfile gives its ACTUAL bound port
  // (correct even when it was started with --port/--addr or a custom --config);
  // otherwise the configured port in config.json; otherwise the shipped default. On the host that
  // pidfile records when it is a loopback one other than 127.0.0.1 (`--addr [::1]:6996`), where
  // nothing answers on 127.0.0.1 (localDaemonOrigin).
  const launchConfigPath = argValue('--config', defaultConfigPath())
  const explicitPort = Number(argValue('--port', '')) || undefined
  const { port, host: daemonHost } = resolveDaemonAddress(
    dirname(launchConfigPath),
    explicitPort,
    configuredDaemonPort(launchConfigPath),
  )
  // Session-scoped auth token (terminal-routes.ts, session-auth.ts) — lets the gateway tell
  // which Code session's terminal this launch belongs to, for the live thinking-budget
  // override and usage-stat attribution. Undefined for a manually-run `turbollm launch`
  // (falls back to the shared static AUTH_TOKEN, cli-launch.ts).
  const authToken = argValue('--token', '') || undefined
  // Everything after `launch <cli>` is forwarded to the CLI, minus our own flags.
  const passthrough = argv.slice(2).filter(
    (a, i, arr) =>
      a !== '--port' && arr[i - 1] !== '--port' &&
      a !== '--model' && arr[i - 1] !== '--model' &&
      a !== '--config' && arr[i - 1] !== '--config' &&
      a !== '--token' && arr[i - 1] !== '--token' &&
      a !== '--code-session-id' && arr[i - 1] !== '--code-session-id',
  )
  const code = await launchCli(target, port, passthrough, undefined, modelKey, undefined, authToken, undefined, daemonHost)
  // Tell the daemon the agent is done. The shell that ran us stays alive on purpose
  // (`-NoExit`/`exec bash`, pty-session.ts), so from the daemon's side the PTY still looks like a
  // running agent terminal — reattaching would hand the user a bare prompt with stale scrollback
  // and never relaunch. This is the only place that reliably knows the agent exited. Best-effort
  // and time-boxed: a failed report must never delay or block the CLI's own exit.
  // TurboLLM's OWN Code-session id, passed by buildTerminalLaunchCommand for every terminal launch
  // and independent of whatever session flag the harness itself does or doesn't support.
  //
  // This used to read the HARNESS's `--session-id`/`--resume`, which opencode is deliberately never
  // given (it cannot register a caller-chosen id at all). So for opencode this was always '' and the
  // report never fired — leaving `agentExited` unset, so `POST .../terminal` took the reuse branch
  // forever and handed the user a dead shell with stale scrollback on every reopen. That is verbatim
  // the failure terminal-routes.ts documents as already fixed; for opencode it happened on every
  // single exit. The harness flags remain as a fallback for a launch command built before this flag.
  const codeSessionId =
    argValue('--code-session-id', '') || argValue('--session-id', '') || argValue('--resume', '')
  if (codeSessionId) {
    try {
      await fetch(`${localDaemonOrigin(daemonHost, port)}/api/v1/code/sessions/${codeSessionId}/terminal/agent-exited`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exitCode: code }),
        signal: AbortSignal.timeout(2000),
      })
    } catch { /* daemon gone or restarting — the terminal dies with it anyway */ }
  }
  process.exit(code)
}

// ── `turbollm mcp-server` — expose Code as an MCP tool over stdio (TODO.md item 4) ──────
// A thin bridge to an ALREADY-RUNNING daemon's existing HTTP API — deliberately does NOT
// start a daemon, load a model, or touch ConfigStore/Manager itself, so it stays a fast,
// side-effect-free process an MCP host can spawn per connection. See mcp-server.ts for the
// full scope rationale. Handled here (before the heavy daemon bootstrap below) for the same
// reason `launch` is: this process's job ends at stdio, it never needs Registry/Manager/etc.
if (argv[0] === 'mcp-server') {
  const mcpConfigPath = argValue('--config', defaultConfigPath())
  const mcpExplicitPort = Number(argValue('--port', '')) || undefined
  // On the pidfile's host when it is a loopback one other than 127.0.0.1, as for launch above.
  const mcpDaemon = resolveDaemonAddress(
    dirname(mcpConfigPath),
    mcpExplicitPort,
    configuredDaemonPort(mcpConfigPath),
  )
  await runMcpServer(localDaemonOrigin(mcpDaemon.host, mcpDaemon.port), version)
  process.exit(0)
}

// ── --help / -h ───────────────────────────────────────────────────────────────
if (hasFlag('--help', '-h')) {
  process.stdout.write(
    `\nTurboLLM ${version} — local LLM platform\n\n` +
    `Usage:\n` +
    `  npx turbollm [options]\n` +
    `  turbollm [options]\n` +
    `  turbollm launch <cli>            # run a coding CLI on your local model\n\n` +
    `Commands:\n` +
    `  launch claude                    Launch Claude Code wired to TurboLLM. Auto-loads\n` +
    `                                   the last-used model if none is loaded, and pins\n` +
    `                                   Claude Code to whatever model is loaded.\n` +
    `  launch claude --model <key>      Load a specific model by key or name, then launch\n` +
    `  launch opencode|kilo|openclaw|hermes\n` +
    `                                   Wire that CLI to TurboLLM (writes its config file)\n` +
    `  mcp-server                       Run an MCP server over stdio, bridging to an already-\n` +
    `                                   running TurboLLM daemon so other agentic CLIs can\n` +
    `                                   delegate tasks to Code. Add to a host's MCP config as:\n` +
    `                                   { "command": "npx", "args": ["turbollm", "mcp-server"] }\n\n` +
    `Options:\n` +
    `  --port <n>     Port to listen on / connect to (default: 6996)\n` +
    `  --addr <h:p>   Full host:port override (e.g. 0.0.0.0:6996, [::1]:6996)\n` +
    `                 Binding a non-loopback address turns on API-key enforcement;\n` +
    `                 if no key exists yet, one is generated and printed on startup.\n` +
    `  --no-open      Do not open a browser window on startup\n` +
    `  --tunnel       Expose this daemon on the internet via a cloudflared quick\n` +
    `                 tunnel (Cloud Launch) — prints the public URL + a required\n` +
    `                 access token. For running TurboLLM on a rented cloud GPU box.\n` +
    `  --print-token  Mint a fresh API key and print it as a stable 'Token:   <key>'\n` +
    `                 line on every startup, whether or not one already existed —\n` +
    `                 unlike the automatic non-loopback bootstrap key (which only\n` +
    `                 ever mints once, on the very first boot), this always gives\n` +
    `                 you a freshly known-good token to grep out of 'docker logs'\n` +
    `                 after any restart. Default in the official Docker images.\n` +
    `  --config <f>   Path to a custom config file\n` +
    `  --no-telemetry Disable telemetry entirely, whatever this install's saved\n` +
    `                 setting says (same as TURBOLLM_TELEMETRY=off). For CI,\n` +
    `                 containers, and scripted daemons.\n` +
    `  --stop         Stop a running TurboLLM daemon and exit\n` +
    `  --help, -h     Show this help message\n\n` +
    `Examples:\n` +
    `  npx turbollm                     # start on default port, open browser\n` +
    `  turbollm --port 9000             # listen on port 9000\n` +
    `  turbollm --no-open               # start without opening a browser\n` +
    `  turbollm --addr 0.0.0.0:6996    # bind to all interfaces (LAN sharing)\n` +
    `  turbollm --tunnel --no-open      # run on a rented GPU box, reachable via a public URL\n` +
    `  turbollm --addr 0.0.0.0:6996 --print-token   # LAN/Docker: always print a usable token\n` +
    `  turbollm --stop                  # stop the running daemon\n` +
    `  turbollm launch claude           # open Claude Code on your loaded model\n` +
    `  turbollm launch claude --model qwen3-8b   # load qwen3-8b, then launch\n` +
    `  turbollm launch opencode         # wire opencode to TurboLLM, then launch it\n\n` +
    `Environment:\n` +
    `  TURBOLLM_ADVERTISED_HOST\n` +
    `                 Host (or host:port) to put in the URLs TurboLLM hands out —\n` +
    `                 Turbo Link strings and chat-share links. Set this when the\n` +
    `                 address others must use isn't one this machine can see, e.g.\n` +
    `                 inside a Docker container, where the only interface found is\n` +
    `                 the container-internal bridge IP (172.17.0.2) and the real\n` +
    `                 address is the published host:port outside.\n` +
    `                 e.g. TURBOLLM_ADVERTISED_HOST=192.168.1.50:6996\n\n`,
  )
  process.exit(0)
}

// ── --stop ────────────────────────────────────────────────────────────────────
// Before daemon startup so we never spin up two daemons, and before the config is loaded: --stop
// needs only the data dir's pidfile. A load could save config.json, and `sudo turbollm --stop` (a
// daemon started elevated) left it owned by root, mode 0600: the owner's next start could not read
// it. The data dir is the config file's (ConfigStore.dir()). A daemon still booting or mid-rebind
// is waited for (stopDaemon), and the wait is said.
if (hasFlag('--stop')) {
  const result = await stopDaemon(dirname(argValue('--config', defaultConfigPath())), undefined, {
    onWait: (line) => process.stdout.write(line + '\n'),
  })
  process.stdout.write(result.message + '\n')
  // 1 only when the daemon it found is still running, or one booting or mid-rebind did not finish
  // in time (StopResult.failed), so `turbollm --stop && …` does not carry on beside it; nothing to
  // stop is still 0.
  process.exit(result.failed ? 1 : 0)
}

// ── Config + registry ─────────────────────────────────────────────────────────
// Default location → relocate any pre-0.x state into ~/.turbollm first. A
// `--config` override is an explicit choice (dev/preview), so leave it untouched.
if (!process.argv.includes('--config')) migrateLegacyDataDir()
const configPath = argValue('--config', defaultConfigPath())
// A config.json this user may not read or write (another user's, as `sudo turbollm` leaves it)
// ends the start with what to do about it, not an uncaught EACCES (configAccessProblem). It exits
// CONFIG_ACCESS_EXIT_CODE, not 1: on 1 the desktop app quit as after a crash, so it opened and
// vanished with these lines in a stderr no one sees; on this status it shows them (wrapper/main.js).
const store = (() => {
  try {
    return ConfigStore.load(configPath)
  } catch (e) {
    const problem = configAccessProblem(configPath, e)
    if (!problem) throw e
    console.error(problem)
    return process.exit(CONFIG_ACCESS_EXIT_CODE)
  }
})()
if (store.brokenBackup()) {
  // One of another user's is not reset by the load (ConfigStore.load never writes it), but any
  // update() of this run still saves the defaults over it, as this user: often the boot's own, as
  // its first telemetry event mints a machineId (the defaults have none). So the warning says
  // that, and neither that it was reset nor that it is left as it is.
  console.warn(
    store.brokenLeftInPlace()
      ? `config ${store.path()} could not be parsed and belongs to another user (a copy is at ` +
          `${store.brokenBackup()}): this run uses the default settings, and any save it ` +
          `makes (such as of the telemetry id it mints) writes them over the file as this user`
      : `config was reset; previous file backed up at ${store.brokenBackup()}`,
  )
}

// ── One daemon per data dir ───────────────────────────────────────────────────
// A second daemon on this data dir must stop HERE, before the boot side effects below: it would
// reset the running daemon's Tailscale serve, finalize its parked interactive routine runs as
// errored, start a second scheduler and auto-load a second engine — and then, failing to bind,
// exit. Refused only when a TurboLLM really answers on the pidfile's port (findRunningDaemon), so a
// stale pidfile, a recycled PID or a self-restart handing over never blocks a start.
//
// The pidfile is written only once a daemon has bound, so two daemons started together both
// found none here and both booted on one database. The data dir is therefore claimed first
// (daemon.lock, claimDataDir): of two starts at once only one gets past this point. The claim is
// released once this daemon's pidfile is written (the listen callback), and it is taken BEFORE
// the pidfile is read, so a start that gets it after that release sees this daemon's pidfile. An
// in-place rebind takes it again until its new pidfile is written (deps.rebind).
//
// Both refusals exit DATA_DIR_IN_USE_EXIT_CODE, not 1: the desktop app's daemon is refused here
// when a CLI daemon already uses the data dir, and the app shows these lines to the user on that
// status (wrapper/main.js) instead of quitting as if its daemon had crashed.
const claimHolder = claimDataDir(store.dir())
if (claimHolder) {
  console.error(
    `TurboLLM is already starting, or moving to a new address, for ${store.dir()}${claimHolder.pid ? ` (pid ${claimHolder.pid})` : ''}.\n` +
      `Use that one once it is up, or start this one with its own --config.`,
  )
  process.exit(DATA_DIR_IN_USE_EXIT_CODE)
}
// Also released on any exit that comes before the listen callback's release: a refused start
// just below, a failed bind, a crash during boot. Owner-scoped: never another start's claim.
process.on('exit', () => releaseDataDirClaim(store.dir()))
const runningDaemon = await findRunningDaemon(store.dir())
if (runningDaemon) {
  console.error(
    `TurboLLM is already running for ${store.dir()} (pid ${runningDaemon.pid}, http://${daemonReachHost(runningDaemon.host)}:${runningDaemon.port}).\n` +
      `Use that one, stop it first with \`turbollm --stop\`, or start this one with its own --config.`,
  )
  process.exit(DATA_DIR_IN_USE_EXIT_CODE)
}

// Windows: the job sentinel (util/win-job-sentinel.ts) puts every tethered child, and every Code terminal's shell, in
// a kill-on-close job of its own that allows no breakaway, whose only handle this process holds, so their whole
// trees end with it however it ends. A plain child, so it sits in libuv's own job and dies with this process too.
// Without PowerShell or Add-Type it logs one line, and stops fall back to taskkill /T. Started here, on the daemon's
// path only, before the reapers and the first tethered spawn (reconcileTailscale's CLI); a child spawned while it
// starts (1-3 s) waits for it. Not at the top of this file: there `launch` (every agent a Code terminal launches),
// `mcp-server` (every MCP host session), `--help`, `--stop` and a start refused above would each run PowerShell and
// Add-Type's compile for nothing (none of them needs a job: what a launch starts sits in libuv's job, its plain
// children and `launch hermes`'s `hermes config set`, a tethered one, which without a sentinel is a plain child there
// too), and where it is unavailable its line would land in the agent's terminal or the MCP host's stderr.
if (process.platform === 'win32') startJobSentinel()
function startJobSentinel(): void {
  setJobSentinel(new JobSentinel().start())
}


// ── The daemon (boot.ts) ──────────────────────────────────────────────────────
// Booted only here, after the data-dir guard and the job sentinel above: the reaps of a previous run's leftovers (the
// first thing it does) are side effects the guard keeps a second daemon from, and they spawn (Tailscale's CLI), which
// the sentinel must be up for. In it, in this order: the services, the app, the listener and the in-place rebind, then
// auto-load. What follows here (the orphan check, the restart, the shutdown, the exit net) is this process's own.
const daemon = await bootDaemon({
  store,
  version,
  portFlag: argValue('--port', ''),
  addr: optionalArg('--addr'),
  tunnel: hasFlag('--tunnel'),
  openBrowser: !hasFlag('--no-open'),
  printToken: hasFlag('--print-token'),
})
const { deps } = daemon

// Whether anything reaps TurboLLM's orphans, its tethered children's watchers among them (util/pid1.ts): a container
// whose PID 1 is node itself, or `tail`, leaves every one of them a zombie. Linux only, off the boot path; it warns.
void checkOrphansReaped()

// ── Self-restart (spec 08 §2) ──────────────────────────────────────────────────
// POST /api/v1/daemon/restart re-execs the daemon so port / LAN-bind changes take
// effect without the user killing the terminal. Ordering is what makes this safe:
//   1. stop the engine,
//   2. force open keep-alive sockets shut (SSE log/chat streams would otherwise hold
//      the listen socket open forever and block server.close),
//   3. close the server so the OLD process releases the port,
//   4. ONLY THEN finish, the way planRestartExit (daemon-restart.ts) decides:
//      - npm/CLI, Docker, a service: this process becomes the keeper of its replacement
//        (becomeKeeper, below);
//      - supervised (the desktop app, TURBOLLM_DESKTOP=1, or a keeper): spawn nothing and
//        exit 75. The supervisor starts the fresh daemon itself, as its own non-detached
//        child (ADR-442);
//      - exitOnly (app self-update, below): spawn nothing and exit 0.
// A watchdog finishes anyway if close hasn't completed in time. Fail-safe: on any
// thrown error we still finish, so the user is never left daemonless.
// A signal (Ctrl+C, `docker stop`, a closed terminal) or the stdin lifeline's end during the teardown wins: the
// shutdown it starts ends this process, finish() then starts and exits nothing (shuttingDown), and no restart starts
// once a shutdown has. Both teardowns wait on the same engine exits and both end in one server 'close', so finish()
// used to become the keeper, spawn the replacement and be ended by the shutdown's exit in the same tick: the
// replacement ran on, parented to init, its lifeline ignored. A supervised one exited 75, and its keeper started
// another daemon after the Ctrl+C.
let restarting = false
// Bound to this process's parent and evaluated once at boot (util/boot-env.ts): a TurboLLM started from a desktop
// Code terminal inherits no TURBOLLM_DESKTOP, and exits 75 only to a supervisor that is really there.
const supervised = boot.desktop || boot.keeperPid !== null

// The restart keeper. The replacement used to be spawned detached, with its output in restart.log: it landed in a
// session of its own, so npm returned to the prompt, and the new daemon and its engines were beyond Ctrl+C, `docker
// stop` and the closing of the terminal. It was also spawned without process.execArgv, so under `npm start` (tsx's
// loader, or `node --import tsx`) it died at once with ERR_MODULE_NOT_FOUND and TurboLLM simply ended.
//
// Now the old process stays, as a thin keeper in the terminal's foreground job (or as tini's child in a container),
// whichever path reached finish() (the teardown, or its 14 s watchdog, which may have got none of it done):
//   1. the exit net, now: every 'exit' listener once, in order, as process.exit would run them (the tethered kills,
//      engines, tunnels and terminals by pidfile, the pidfile, the data-dir claim, a build's kill), then every
//      lifeline closed, held ones included (closeAllLifelines). Whatever a stalled teardown left (a wedged engine)
//      dies now, and the replacement's reapers find no record whose owner is a live process. The old process's own
//      work still in flight (the restart stopped its Code runs and paused its downloads) starts no child from here on
//      (refuseNewTetheredSpawns);
//   2. nothing of the old process recurs, and nothing of it writes config.json. The restart stopped the routine and
//      update schedulers, the interactive-run sweep, ComfyUI's guard, a tunnel's health loop and the engines (their
//      idle watchdogs go with them); the keeper stops the rest: every daemonTick (the telemetry flushes and rollups,
//      the ext API's reaper, the terminals' idle sweep: util/daemon-ticks.ts), the Turbo Link poll and the usage
//      monitor, and its config store saves no more (ConfigStore.stopSaving). They ran on here with the old process's
//      state: the ext reaper's prune on the chat store closed below threw from its timer and ended the keeper (and
//      TurboLLM with it) 30 s after every such restart with the ext API on; the telemetry flushed with the consent
//      from before the restart, and a Link heartbeat wrote the stale config over the replacement's. An error thrown
//      by work of the old process still in flight is logged, not fatal: the keeper's one job is its replacement;
//   3. the listener and every connection, and the chat store, whatever state the teardown reached, so the
//      replacement can bind and is not refused as "already running";
//   4. no listener of the daemon's own is left: its shutdown handler would call server.close on a closed server,
//      whose callback runs at once and exits, cutting the replacement's own shutdown short;
//   5. the replacement: the same interpreter, execArgv (as fork does, so `--import tsx` reaches it) and argv, in the
//      same cwd, NOT detached, its output in this terminal, tied to the keeper by a stdin lifeline bound to the
//      keeper's pid (util/boot-env.ts);
//   6. signals: on POSIX SIGINT, SIGTERM and SIGHUP are relayed to the replacement and the keeper waits; on Windows
//      the console delivers its own event to the replacement, which sits in the keeper's kill-on-close job, so the
//      keeper ignores them and waits (a child.kill there would be a TerminateProcess);
//   7. the replacement's exit: 75 starts the next one (a later restart: keepers never chain), unless the keeper was
//      told to end meanwhile (a signal it relayed, or on Windows one the replacement got too: the replacement's restart
//      had finished first, and nothing of it is left), which ends it with 0; anything else ends the keeper with that
//      code, or 128+n for a signal;
//   8. however the keeper dies, the replacement's stdin ends and it shuts down gracefully.
function becomeKeeper(): void {
  for (const listener of process.listeners('exit')) {
    try {
      ;(listener as (code: number) => void).call(process, 0)
    } catch {
      /* best-effort, as the exit handler itself is */
    }
  }
  process.removeAllListeners('exit')
  closeAllLifelines()
  refuseNewTetheredSpawns()
  stopDaemonTicks()
  deps.links?.stop()
  stopUsageMonitor()
  store.stopSaving()
  process.on('uncaughtException', (e) => console.warn('keeper: an error from the old daemon\'s work (continuing):', e))
  const server = daemon.listener()
  try {
    ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
  } catch {
    /* best-effort */
  }
  try { closeTerminalSockets() } catch { /* best-effort */ }
  try { server.close() } catch { /* already closed */ }
  try { deps.db.close() } catch { /* already closed */ }
  try { removeOwnPidfile(store.dir()) } catch { /* best-effort */ }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.removeAllListeners(sig)

  let replacement: ChildProcess | null = null
  // Told to end (6.): a 75 that comes after it starts no next replacement.
  let ending = false
  function startReplacement(): void {
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, TURBOLLM_LIFELINE: `stdin:${process.pid}`, TURBOLLM_SUPERVISOR: `keeper:${process.pid}` },
      windowsHide: true,
    })
    replacement = child
    child.stdin?.on('error', () => { /* the replacement is gone: its exit is handled below */ })
    child.once('error', (e) => {
      console.error(`  Restart: the new TurboLLM could not start (${e.message}).`)
      process.exit(1)
    })
    child.once('exit', (code, signal) => {
      if (code === RESTART_REQUESTED_EXIT_CODE && !ending) {
        // Not left to the keeper's uncaughtException handler, which would keep it running with no replacement.
        try {
          startReplacement()
        } catch (e) {
          console.error(`  Restart: the new TurboLLM could not start (${(e as Error).message}).`)
          process.exit(1)
        }
        return
      }
      // A 75 after the keeper was told to end: that replacement's restart had finished first, and nothing of it is left.
      if (code === RESTART_REQUESTED_EXIT_CODE) process.exit(0)
      process.exit(code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0))
    })
  }
  if (process.platform === 'win32') {
    for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => { ending = true /* the replacement gets its own */ })
  } else {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(sig, () => {
        ending = true
        try {
          replacement?.kill(sig)
        } catch {
          /* already gone: its exit ends the keeper */
        }
      })
    }
  }
  startReplacement()
}
/** Test-only (cli.keeper.test.ts, util/boot-env.ts): a restart's teardown that never settles, so the watchdog
 *  finishes it. Resolved at once otherwise. */
function testOnlyRestartStall(): Promise<void> {
  return boot.testStallRestart ? new Promise<void>(() => { /* never */ }) : Promise.resolve()
}
/** Test-only (cli.keeper.test.ts, util/boot-env.ts): a signal shutdown that takes this much longer. */
function testOnlySlowShutdown(): Promise<void> {
  return boot.testSlowShutdownMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, boot.testSlowShutdownMs)) : Promise.resolve()
}
// `exitOnly` is the app-self-update mode (spec 29 B.1 step 2): tear down exactly as a
// restart does — engine stopped, sockets drained, DB closed, port released — but do NOT
// spawn a replacement. Something else is going to: the detached update helper is already
// waiting for this PID to die so it can overwrite the package files (which Windows will
// not let it do while we hold them) and then relaunch us. Respawning here would race the
// installer against a live daemon, which is the precise failure this whole mechanism
// exists to avoid. Expressed as a flag on the existing path rather than a second copy of
// it, so the (carefully ordered, watchdog-guarded) teardown can never drift between the two.
// Not wired in the packaged Android app: there the daemon is the app's own in-process Node,
// which can start only once per process — process.exit() closes the whole app, and the
// "replacement" would be the app's executable, not node. Left unset, the restart and app-update
// routes answer 501 (and the web UI hides the control there).
if (!packagedAndroidApp()) deps.requestRestart = (opts?: { exitOnly?: boolean }) => {
  // A shutdown under way ends this process: no restart starts after it (see above).
  if (restarting || shuttingDown) return
  restarting = true
  const plan = planRestartExit({ exitOnly: opts?.exitOnly === true, supervised })
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    // Normally given up once the first bind writes the pidfile, but an in-place rebind takes the
    // claim again until its new bind writes one (deps.rebind), and a restart can come meanwhile:
    // the replacement must not find this process's start claim.
    releaseDataDirClaim(store.dir())
    // A signal or the lifeline's end came during the teardown: its shutdown ends this process, with 0, and nothing
    // starts a replacement (see above). Its own server.close or its fallback exits.
    if (shuttingDown) return
    if (plan.kind === 'become-keeper') {
      try {
        becomeKeeper()
        return
      } catch (e) {
        console.warn(`restart: could not start the new daemon: ${e}`)
      }
    } else if (plan.kind === 'supervisor-respawn') {
      console.log(boot.desktop
        ? `  Restarting: exiting with code ${plan.exitCode} so the TurboLLM desktop app starts a fresh daemon.`
        : `  Restarting: exiting with code ${plan.exitCode} so the keeper (pid ${boot.keeperPid}) starts a fresh daemon.`)
    }
    process.exit(plan.exitCode)
  }
  // Watchdog: if graceful teardown truly stalls, restart anyway. MUST exceed the
  // engine's own force-kill window (gracefulStop force-kills llama-server after ~8s
  // when SIGTERM has not ended it; on Windows it force-kills at once, and waits the
  // same 8s before killing again). A shorter watchdog would force-exit mid-shutdown
  // and ORPHAN the engine child (it holds GPU VRAM, so the restarted daemon then can't
  // load a model).
  // 14s clears the 8s kill and stays under the UI's 20s recovery give-up.
  const watchdog = setTimeout(finish, 14_000)
  watchdog.unref()
  try {
    // The teardown (boot.ts close: what it stops, and in which order), as a restart's: it also stops every Code run
    // and pauses every download, which would otherwise run on unseen in the keeper (becomeKeeper).
    void daemon.close({ forRestart: true, alsoWaitFor: testOnlyRestartStall }).then(() => {
      clearTimeout(watchdog)
      finish()
    })
  } catch (e) {
    // Any synchronous failure in the teardown path, a stop included: still restart. (The watchdog is armed before the
    // teardown's first stop now, which is all close() runs synchronously; a throw from one of them escaped the restart
    // before, leaving it half done.)
    console.warn(`restart teardown failed: ${e}`)
    clearTimeout(watchdog)
    finish()
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// On a signal, or when the parent's stdin lifeline ends (the desktop app or the restart keeper, above). On Windows
// Ctrl+Break (SIGBREAK) is graceful too: it used to end the daemon abruptly, with no teardown at all.
let shuttingDown = false
beginShutdown = (reason: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(reason ? `shutting down (${reason})` : 'shutting down')
  // Remove pidfile on clean shutdown so `turbollm --stop` doesn't find a stale entry — only our
  // own: never another daemon's on this data dir.
  try { removeOwnPidfile(store.dir()) } catch { /* best-effort */ }
  // The teardown (boot.ts close), the same one a restart runs: every running chat reply stopped first, the store
  // closed once they have ended, every connection dropped before the listener closes (an SSE stream otherwise holds
  // close() until the 12 s fallback below, and `--stop` SIGKILLs at 10 s, skipping the 'exit' handler's kill net).
  void daemon.close({ alsoWaitFor: testOnlySlowShutdown }).then(() => process.exit(0))
  setTimeout(() => process.exit(0), 12_000 + boot.testSlowShutdownMs).unref()
}
const shutdownSignals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const : ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
for (const sig of shutdownSignals) process.on(sig, () => beginShutdown?.(''))

// Last-resort synchronous safety net: whatever path leads here (clean exit, an
// unhandled crash that reaches 'exit', a process.exit elsewhere), make sure no engine
// child is left running. Graceful shutdown above already kills it on signals; this
// covers exits that bypass them so llama-server can never outlive the daemon. The
// startup reap is the backstop for the truly abrupt kills that skip 'exit' too.
process.on('exit', () => {
  // Every tethered child, by its end mode: a group SIGKILL, git's SIGTERM (its watcher finishes the job once this
  // process is gone), a package manager's SIGTERM. Held groups (a Code session's background jobs) included.
  try { killTetheredSync() } catch { /* best-effort */ }
  try { killTrackedEnginesSync(store.dir()) } catch { /* best-effort */ }
  // Same last-resort net for a cloudflared tunnel — a leaked one keeps a PUBLIC URL
  // alive pointing at a port nothing may be serving anymore, worse than a leaked engine.
  try { killTrackedTunnelsSync(store.dir()) } catch { /* best-effort */ }
  // Same last-resort net for terminal-agent CLI processes (claude/pi/opencode) — this was
  // PREVIOUSLY MISSING entirely, the actual cause of leaked claude.exe processes found live
  // in this repo (terminal-manager.ts's pidfile-tracking header has the full story).
  try { killTrackedTerminalsSync(store.dir()) } catch { /* best-effort */ }
  // Best-effort pidfile cleanup — covers exits that bypass the signal handlers
  // (e.g. process.exit() called elsewhere). Graceful SIGTERM/SIGINT already
  // removed it above; this is a second-layer safety net. Owner-scoped: a daemon that
  // failed to bind (another one holds the port) never wrote one and must not delete it.
  try { removeOwnPidfile(store.dir()) } catch { /* best-effort */ }
})
