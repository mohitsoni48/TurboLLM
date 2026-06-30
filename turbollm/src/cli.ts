import { hideChildConsoleWindows } from './util/hide-console-windows'
import { spawn } from 'node:child_process'
import { openSync, readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, defaultConfig, defaultConfigPath, getModelProfile, migrateLegacyDataDir } from './config/config'
import { Manager, killTrackedEnginesSync, reapStaleEngines, type StartOpts } from './engines/manager'
import { ComfyGuard } from './engines/comfy-guard'
import { Registry } from './engines/registry'
import { ProvisionState } from './engines/provision-state'
import { BuildState } from './engines/build-state'
import { UpdateChecker } from './engines/update'
import { UpdateScheduler } from './engines/update-scheduler'
import { AppUpdateChecker } from './app-update'
import { applyEngineUpdate } from './engines/update-apply'
import { seedDefaultEngines } from './engines/seed'
import { engineAcceptsFormat } from './engines/compat'
import { Scanner } from './models/scanner'
import { seedDefaultModelDir } from './models/hf-cache'
import { HashStore } from './models/hashes'
import { resolveProfile, profileToArgs, type LoadProfile } from './models/profile'
import { getSysInfo } from './sysinfo/sysinfo'
import { ConversationStore } from './chat/db'
import { HfClient } from './hf/hf'
import { DownloadManager } from './downloads/downloads'
import { BenchRunner } from './bench/bench'
import { ModelRouter } from './gateway/model-router'
import { ToolRegistry } from './tools/tool-registry'
import { GenerationGate } from './agents/gate'
import { AgentTaskState } from './agents/task-state'
import { AgentRunManager } from './agents/run-manager'
import { launchCli } from './cli-launch'
import { writePidfile, removePidfile, stopDaemon, resolveDaemonPort } from './daemon-pid'
import { createApp } from './server'
import { provisionTunnelApiKey } from './auth'
import { TunnelManager, reapStaleTunnels, killTrackedTunnelsSync } from './tunnel/manager'
import type { Deps } from './deps'

// Stop child processes (the agent engine's shell tool, engine binaries, git,
// etc.) from flashing a console window on Windows when the daemon has no console
// of its own. Must run before anything spawns — patches the shared low-level
// spawn path, so it covers the external pi SDK's named spawn import too.
hideChildConsoleWindows()

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
// 22.13.0, not just 22 — that's when node:sqlite became available without the
// --experimental-sqlite flag (GitHub #40); on 22.5.0-22.12.x importing it bare
// throws ERR_UNKNOWN_BUILTIN_MODULE despite `node -v` reporting 22.x.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
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

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

/** The daemon's configured port from config.json, falling back to the shipped
 *  default. Best-effort — a missing/invalid config yields the shipped default.
 *  Keeps the literal default in ONE place (defaultConfig) rather than hardcoded. */
function configuredDaemonPort(configPath: string): number {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { daemon?: { port?: number } }
    if (typeof cfg.daemon?.port === 'number' && cfg.daemon.port > 0) return cfg.daemon.port
  } catch { /* missing or invalid config — use the shipped default below */ }
  return defaultConfig().daemon.port
}

// ── `turbollm launch <cli>` — start a coding CLI wired to TurboLLM ──────────────
// Handled before --help so `turbollm launch claude --help` forwards --help to the
// launched CLI rather than printing TurboLLM's help.
if (argv[0] === 'launch') {
  const target = argv[1] ?? ''
  const modelKey = argValue('--model', '') || undefined
  // Resolve the daemon's port without ever assuming a fixed default: an explicit
  // --port wins; otherwise the running daemon's pidfile gives its ACTUAL bound port
  // (correct even when it was started with --port/--addr or a custom --config);
  // otherwise the configured port in config.json; otherwise the shipped default.
  const launchConfigPath = argValue('--config', defaultConfigPath())
  const explicitPort = Number(argValue('--port', '')) || undefined
  const port = resolveDaemonPort(
    dirname(launchConfigPath),
    explicitPort,
    configuredDaemonPort(launchConfigPath),
  )
  // Everything after `launch <cli>` is forwarded to the CLI, minus our own flags.
  const passthrough = argv.slice(2).filter(
    (a, i, arr) =>
      a !== '--port' && arr[i - 1] !== '--port' &&
      a !== '--model' && arr[i - 1] !== '--model' &&
      a !== '--config' && arr[i - 1] !== '--config',
  )
  const code = await launchCli(target, port, passthrough, undefined, modelKey)
  process.exit(code)
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
    `                                   Wire that CLI to TurboLLM (writes its config file)\n\n` +
    `Options:\n` +
    `  --port <n>     Port to listen on / connect to (default: 6996)\n` +
    `  --addr <h:p>   Full host:port override (e.g. 0.0.0.0:6996)\n` +
    `  --no-open      Do not open a browser window on startup\n` +
    `  --tunnel       Expose this daemon on the internet via a cloudflared quick\n` +
    `                 tunnel (Cloud Launch) — prints the public URL + a required\n` +
    `                 access token. For running TurboLLM on a rented cloud GPU box.\n` +
    `  --config <f>   Path to a custom config file\n` +
    `  --stop         Stop a running TurboLLM daemon and exit\n` +
    `  --help, -h     Show this help message\n\n` +
    `Examples:\n` +
    `  npx turbollm                     # start on default port, open browser\n` +
    `  turbollm --port 9000             # listen on port 9000\n` +
    `  turbollm --no-open               # start without opening a browser\n` +
    `  turbollm --addr 0.0.0.0:6996    # bind to all interfaces (LAN sharing)\n` +
    `  turbollm --tunnel --no-open      # run on a rented GPU box, reachable via a public URL\n` +
    `  turbollm --stop                  # stop the running daemon\n` +
    `  turbollm launch claude           # open Claude Code on your loaded model\n` +
    `  turbollm launch claude --model qwen3-8b   # load qwen3-8b, then launch\n` +
    `  turbollm launch opencode         # wire opencode to TurboLLM, then launch it\n\n`,
  )
  process.exit(0)
}

// ── Config + registry ─────────────────────────────────────────────────────────
// Default location → relocate any pre-0.x state into ~/.turbollm first. A
// `--config` override is an explicit choice (dev/preview), so leave it untouched.
if (!process.argv.includes('--config')) migrateLegacyDataDir()
const store = ConfigStore.load(argValue('--config', defaultConfigPath()))
if (store.brokenBackup()) {
  console.warn(`config was reset; previous file backed up at ${store.brokenBackup()}`)
}

// ── --stop ────────────────────────────────────────────────────────────────────
// Must come after ConfigStore.load so we have store.dir() for the pidfile path,
// but before daemon startup so we never spin up two daemons.
if (hasFlag('--stop')) {
  const result = await stopDaemon(store.dir())
  process.stdout.write(result.message + '\n')
  process.exit(0)
}

// Reap any engine processes orphaned by a previous daemon that didn't shut down
// cleanly (terminal closed, killed, crashed) BEFORE we load anything — otherwise a
// stale llama-server would still hold VRAM and keep draining its queue while this new
// daemon shows "no model loaded". Best-effort; never blocks startup.
const reaped = await reapStaleEngines(store.dir()).catch(() => 0)
if (reaped > 0) console.log(`reaped ${reaped} orphaned engine process(es) from a previous run`)
// Same idea for a cloudflared tunnel orphaned by an unclean previous shutdown — it
// would otherwise keep a public URL alive pointing at a port nothing still serves.
try {
  const reapedTunnels = reapStaleTunnels(store.dir())
  if (reapedTunnels > 0) console.log(`reaped ${reapedTunnels} orphaned tunnel process(es) from a previous run`)
} catch { /* best-effort */ }

const registry = new Registry(store)
const pruned = registry.pruneDeadManagedBuilds()
if (pruned > 0) console.log(`pruned ${pruned} dangling engine build(s)`)
const provision = new ProvisionState()
// In-app compile-from-source status (ADR-100): live phase + log tail while a build runs.
const build = new BuildState()
// Honest update checker (ADR-085): per-engine installed/latest/hasUpdate, in-memory cached.
const updates = new UpdateChecker()
const enginesDir = join(store.dir(), 'engines')
void seedDefaultEngines(registry, enginesDir, provision).then(() => registry.ensureProbed())
const manager = new Manager(store)
const scanner = new Scanner(store)
// First-run seed (ADR-092): if no model dirs are configured and the HF hub cache
// exists, adopt it as the default so pre-existing HF models show up. One-time only;
// triggers its own rescan. Must run BEFORE the background rescan below.
seedDefaultModelDir(store, scanner)
void scanner.rescan() // discover models in the background
const hashes = new HashStore(store.dir())
const db = new ConversationStore(store.dir())
const hf = new HfClient(() => store.snapshot().hf.token, version)
// A completed download triggers a rescan so the new model shows up in the library.
const downloads = new DownloadManager(
  store,
  () => void scanner.rescan(),
  () => hf.authHeaders(),
  (repo, rfilename, rev) => hf.expandModelFiles(repo, rfilename, rev),
)
// Auto-benchmark + auto-tune runner (Differentiator #2, spec 09). Owns the engine
// exclusively for a run; reuses manager/profile control rather than reimplementing it.
const bench = new BenchRunner(manager, store, scanner, registry, version, hf)
// ComfyUI GPU coordinator (push): the installed ComfyUI gate node calls
// /api/v1/comfyui/acquire|release to unload/reload the model around renders. Event-
// driven — no polling. No-op until enabled in Settings + the node is installed.
const comfy = new ComfyGuard(store, manager)
// Gateway intelligence (v0.6.0): auto model-swap router. Resolves the `model`
// field in /v1/* requests and loads the matching model if not already running.
const modelRouter = new ModelRouter(store, registry, manager, scanner, comfy)
// Tool registry (v0.7.0): built-in tools + MCP host. Syncs MCP servers from config.
const toolRegistry = new ToolRegistry(store.snapshot().tools)
void (async () => {
  const cfg = store.snapshot()
  await toolRegistry.syncMcpServers(cfg.mcp.servers)
  void toolRegistry.buildToolDefinitions()
})()
const startedAt = Date.now()
// App self-update checker (F-006, ADR-031): is a newer TurboLLM published on npm than
// the version we're running? Informational only — npm does the upgrade. The route serves
// this cache offline-first; the startup check below warms it so the chip is ready.
const appUpdates = new AppUpdateChecker(version)
// `requestRestart` is attached after the server is created (it must close over it).
const deps: Deps = { store, registry, manager, scanner, hashes, db, provision, build, updates, appUpdates, hf, downloads, bench, modelRouter, comfy, tools: toolRegistry, version, startedAt }
deps.gate = new GenerationGate()
deps.agentTasks = new AgentTaskState()
// Agent engine: pi coding-agent runs with real shell/file execution (ADR pending). pi is
// marked `external` in tsup so its dynamic CommonJS require resolves at runtime instead of
// being inlined by esbuild (which crashed the bundle) — see tsup.config.ts.
deps.agents = new AgentRunManager(deps)
deps.agents.reconcileOnStartup()
// Cloud Launch (ADR-045/152): only wired when --tunnel is passed. Its mere presence
// on Deps is what forces auth enforcement on tunneled traffic (see auth.ts lanAuth) —
// absent entirely for the vast majority of runs that never asked for a tunnel.
const tunnelRequested = hasFlag('--tunnel')
if (tunnelRequested) deps.tunnel = new TunnelManager(store.dir())
const app = createApp(deps)

// Warm the app-update cache shortly after boot (ADR-031: "once per daemon start") so the
// Settings chip is ready without the user clicking refresh. Offline-silent; unref'd so it
// never holds the process open. The 24h re-check is on-demand when the cache goes stale.
setTimeout(() => void appUpdates.check(AbortSignal.timeout(10_000)).catch(() => {}), 5_000).unref()

// Background auto-update checker (ADR-085, Phase 6): runs shortly after boot + every
// ~24h. Refreshes per-engine update status; for 'auto' engines with an available update
// AND an idle engine it applies the rollback-safe update. 'notify' just keeps the badge
// fresh; 'off' is skipped. Don't auto-apply while ComfyUI holds the GPU.
const updateScheduler = new UpdateScheduler({
  store,
  registry,
  manager,
  updates,
  applyUpdate: async (engine) => {
    if (comfy.isBlocked()) return // ComfyUI owns the GPU — don't swap engines under it
    await applyEngineUpdate({ store, registry, manager, provision }, engine)
  },
})
updateScheduler.start()

// ── Resolve listen address ────────────────────────────────────────────────────
const cfg = store.snapshot()
const defaultHost = cfg.daemon.lanBind ? '0.0.0.0' : (cfg.daemon.host || '127.0.0.1')

// --port <n> is a convenience shorthand; --addr <h:p> is the full override.
const portFlag = argValue('--port', '')
let addr: string
if (portFlag) {
  addr = `${defaultHost}:${portFlag}`
} else {
  addr = argValue('--addr', `${defaultHost}:${cfg.daemon.port}`)
}
const lastColon = addr.lastIndexOf(':')
// Mutable so an in-place LAN/port rebind can re-point the listener without a full restart.
let host = addr.slice(0, lastColon) || '127.0.0.1'
let port = Number(addr.slice(lastColon + 1)) || 6996

// ── Cross-platform browser open ───────────────────────────────────────────────
function openBrowser(url: string): void {
  let cmd: string
  let args: string[]
  if (process.platform === 'win32') {
    // `start` is a shell built-in; must go through cmd.exe.
    // The empty string after `start` is the window title (required when the
    // first arg might look like a flag to cmd).
    cmd = 'cmd'
    args = ['/c', 'start', '', url]
  } else if (process.platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.unref()
  child.on('error', () => {
    // Opening the browser is best-effort — never crash the daemon over it.
    console.log(`  Could not open browser automatically. Visit the URL above manually.`)
  })
}

// ── Start server ──────────────────────────────────────────────────────────────
const noOpen = hasFlag('--no-open')

// Cached for this process's lifetime: a raw API key can only ever be shown once
// (the store keeps only its hash), so a tunnel that restarts in-place (a rebind, or
// a rebind's retry loop) reprints the SAME token instead of minting — and orphaning —
// a fresh one every time the port changes.
let tunnelToken: string | null = null

// Bind with retry. On a self-restart the OLD listener may not have released the port
// the instant the replacement starts (Windows lingers the socket, and a 127.0.0.1 →
// 0.0.0.0 LAN switch is a conflicting bind), so retry EADDRINUSE for ~10s instead of
// crashing — otherwise a restart leaves the user with NO daemon. `server` is mutable
// so the restart handler below always closes the live instance.
let server: ReturnType<typeof serve>
let rebinding = false // suppress the full banner + browser-open during an in-place rebind
let prevHost = host // remembered before a rebind so we can revert if the new bind fails
let prevPort = port
function listen(attempt = 0): void {
  const s = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    const displayHost = host === '0.0.0.0' ? '0.0.0.0 (LAN)' : host
    const uiUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${info.port}`

    if (rebinding) {
      rebinding = false
      console.log(`  Re-bound to ${displayHost}:${info.port} (no restart — model stays loaded)`)
    } else {
      console.log(``)
      console.log(`  TurboLLM ${version} is ready!`)
      console.log(``)
      console.log(`  Local:   ${uiUrl}`)
      if (host === '0.0.0.0') {
        console.log(`  Network: http://<your-ip>:${info.port}  (LAN)`)
      }
      console.log(``)
      console.log(`  API:     ${uiUrl}/api/v1/status`)
      console.log(`  Stop:    Ctrl+C`)
      console.log(``)
      if (!noOpen) {
        openBrowser(uiUrl)
      }
    }

    // Keep the legacy one-liner for log parsers that key on it.
    process.stdout.write(`TurboLLM ${version} listening on http://${displayHost}:${info.port}\n`)

    // Cloud Launch (ADR-045/152): (re)start the tunnel pointed at whatever port we
    // just bound — covers both the initial start AND a later rebind (the tunnel
    // manager tears down any prior tunnel before spawning the new one). Fire-and-
    // forget: never blocks the banner or the listener on cloudflared's handshake.
    if (deps.tunnel) {
      void deps.tunnel
        .start(info.port)
        .then((url) => {
          console.log(`  Tunnel:  ${url}`)
          tunnelToken ??= provisionTunnelApiKey(deps)
          console.log(`  Token:   ${tunnelToken}`)
          console.log(`           (required for anyone using this tunnel URL)`)
          console.log(``)
        })
        .catch((e) => {
          console.error(`  Tunnel failed to start: ${e instanceof Error ? e.message : e}`)
        })
    }

    // Write pidfile so `turbollm --stop` can find and stop this process (F-035). Written
    // on every successful bind: the PID is constant, but an in-place rebind changes the
    // port, so refreshing it keeps the stored port accurate (used by --stop's identity
    // probe + the "stopped (port N)" message). `rebinding` is already reset to false above,
    // so this runs for both the initial bind and a rebind. Best-effort.
    try { writePidfile(store.dir(), process.pid, info.port) } catch { /* best-effort */ }
  })
  ;(s as unknown as { on?: (ev: 'error', cb: (e: NodeJS.ErrnoException) => void) => void }).on?.(
    'error',
    (e) => {
      if (e?.code === 'EADDRINUSE' && attempt < 20) {
        if (attempt === 0) console.log(`  Port ${port} busy (previous listener releasing) — retrying…`)
        setTimeout(() => listen(attempt + 1), 500)
      } else if (rebinding) {
        // A rebind couldn't bind the new address — revert so the daemon stays reachable.
        console.error(`Could not bind ${host}:${port} (${e?.message ?? e}); reverting to ${prevHost}:${prevPort}.`)
        rebinding = false
        host = prevHost
        port = prevPort
        listen()
      } else {
        console.error(`Could not bind ${host}:${port}: ${e?.message ?? e}`)
        process.exit(1)
      }
    },
  )
  server = s
}
listen()

// In-place rebind (no full restart): re-point the HTTP listener at the host/port the
// config now wants, keeping the engine, model, DB, and chat state alive. A LAN toggle
// (same port) is seamless — the browser on 127.0.0.1 keeps working because 0.0.0.0
// includes loopback; it just reconnects after the brief close. The settings route
// schedules this AFTER its response flushes (closing the socket drops in-flight reqs).
deps.rebind = () => {
  const c = store.snapshot()
  const want = c.daemon.lanBind ? '0.0.0.0' : (c.daemon.host || '127.0.0.1')
  const wantPort = c.daemon.port
  if (want === host && wantPort === port) return // nothing changed
  prevHost = host
  prevPort = port
  host = want
  port = wantPort
  rebinding = true
  const old = server
  try {
    ;(old as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
  } catch {
    /* best-effort */
  }
  let reopened = false
  const reopen = () => {
    if (reopened) return
    reopened = true
    listen() // bind-retry covers the brief window the old socket takes to release
  }
  old.close(reopen)
  setTimeout(reopen, 3_000).unref() // don't wait forever on a stuck stream
}

// ── Self-restart (spec 08 §2) ──────────────────────────────────────────────────
// POST /api/v1/daemon/restart re-execs the daemon so port / LAN-bind changes take
// effect without the user killing the terminal. Ordering is what makes this safe:
//   1. stop the engine,
//   2. force open keep-alive sockets shut (SSE log/chat streams would otherwise hold
//      the listen socket open forever and block server.close),
//   3. close the server so the OLD process releases the port,
//   4. ONLY THEN spawn the detached replacement → no port-bind race,
//   5. exit.
// A watchdog spawns + exits anyway if close hasn't completed in time. Fail-safe:
// on any thrown error we still spawn + exit, so the user is never left daemonless.
let restarting = false
function spawnReplacement(): void {
  // Re-exec with the SAME interpreter + argv (minus argv[0]=node) and cwd, detached
  // so it outlives this dying parent. `stdio:'ignore'` (NOT 'inherit') is essential:
  // the parent is exiting, so inheriting its stdio handles would break the child's
  // streams the moment we exit (and fails outright when the parent was itself launched
  // detached). `unref()` lets the parent exit immediately. The replacement retries the
  // port bind, so it survives the brief window where this process still holds it.
  // Send the replacement's stdout/stderr to a log file (NOT the dead parent's
  // streams) so a failed restart leaves something to diagnose. Falls back to
  // 'ignore' if the file can't be opened.
  let out: number | 'ignore' = 'ignore'
  try {
    out = openSync(join(store.dir(), 'restart.log'), 'a')
  } catch {
    out = 'ignore'
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
}
deps.requestRestart = () => {
  if (restarting) return
  restarting = true
  updateScheduler.stop() // don't let an update tick fire mid-teardown
  comfy.stop() // don't let a tick reload a model mid-teardown
  let spawned = false
  const finish = () => {
    if (spawned) return
    spawned = true
    try {
      spawnReplacement()
    } catch (e) {
      console.warn(`restart spawn failed: ${e}`)
    }
    process.exit(0)
  }
  // Watchdog: if graceful teardown truly stalls, restart anyway. MUST exceed the
  // engine's own force-kill window (gracefulStop force-kills llama-server after ~8s —
  // on Windows the graceful taskkill is usually ignored, so a loaded model takes the
  // full 8s to die). A shorter watchdog would force-exit mid-shutdown and ORPHAN the
  // engine child (it holds GPU VRAM, so the restarted daemon then can't load a model).
  // 14s clears the 8s kill and stays under the UI's 20s recovery give-up.
  const watchdog = setTimeout(finish, 14_000)
  watchdog.unref()
  try {
    void Promise.all([manager.shutdown(), deps.tunnel?.shutdown() ?? Promise.resolve()]).finally(() => {
      try {
        db.close()
      } catch {
        /* best-effort */
      }
      // Drop keep-alive connections first so close()'s callback can actually fire.
      // closeAllConnections exists on Node 18.2+ http servers; guard for safety.
      const s = server as unknown as { closeAllConnections?: () => void }
      try {
        s.closeAllConnections?.()
      } catch {
        /* best-effort */
      }
      server.close(() => {
        clearTimeout(watchdog)
        finish()
      })
    })
  } catch (e) {
    // Any synchronous failure in the teardown path: still restart.
    console.warn(`restart teardown failed: ${e}`)
    clearTimeout(watchdog)
    finish()
  }
}

// ── Auto-load last model on start (spec 05 §7) ────────────────────────────────
// When enabled (Settings → Startup), re-load the last-used model so the daemon
// comes back ready to chat. Resolves the saved modelKey through the scanner +
// profile pipeline (same as POST /engine/start); falls back to a legacy devModel.
void (async () => {
  if (!cfg.autoLoadOnStart) return
  // Don't fight ComfyUI for the GPU at startup — if it's already rendering, skip the
  // auto-load (load it manually, or the guard's block lifts, once its queue drains).
  if (comfy.isBlocked()) return
  const active = registry.active()
  if (!active) return
  await scanner.rescan() // ensure the model list is populated before resolving
  const sys = getSysInfo()
  const entry = cfg.lastLoaded.modelKey ? scanner.get(cfg.lastLoaded.modelKey) : undefined

  let opts: StartOpts | null = null
  if (entry && !entry.incomplete && !entry.parseError && engineAcceptsFormat(active.kind, entry.format)) {
    if (entry.format !== 'gguf') {
      opts = {
        engine: active,
        model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: false },
        modelPath: entry.path,
        extraArgs: [],
      }
    } else {
      const saved = getModelProfile(cfg, entry.key, active.id) as Partial<LoadProfile> | undefined
      const profile = resolveProfile(entry, sys, saved, undefined, cfg.modelDefaults)
      opts = {
        engine: active,
        model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
        modelPath: entry.path,
        extraArgs: profileToArgs(profile, entry, active.capabilities, sys.cores),
      }
    }
  } else if (cfg.devModel) {
    opts = {
      engine: active,
      model: { key: cfg.devModel.modelPath, name: cfg.devModel.label, quant: '', ctx: 0, vision: false },
      modelPath: cfg.devModel.modelPath,
      extraArgs: cfg.devModel.extraArgs,
    }
  }
  if (opts) {
    // load() runs the reverse gate (F-011: ask ComfyUI to free its VRAM first) inside
    // the global load lock, so auto-load can't race a gateway/HTTP load. No-op unless
    // enabled + ComfyUI idle; non-fatal.
    manager
      .load(opts, { beforeStart: () => comfy.freeComfyUIBeforeLoad() })
      .catch((e) => console.warn(`auto-load failed: ${e}`))
  }
})()

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('shutting down')
    // Remove pidfile on clean shutdown so `turbollm --stop` doesn't find a stale entry.
    try { removePidfile(store.dir()) } catch { /* best-effort */ }
    updateScheduler.stop()
    comfy.stop()
    toolRegistry.disconnectAll()
    void Promise.all([manager.shutdown(), deps.tunnel?.shutdown() ?? Promise.resolve()]).finally(() => {
      db.close()
      server.close(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), 12_000).unref()
  })
}

// Last-resort synchronous safety net: whatever path leads here (clean exit, an
// unhandled crash that reaches 'exit', a process.exit elsewhere), make sure no engine
// child is left running. Graceful shutdown above already kills it on signals; this
// covers exits that bypass them so llama-server can never outlive the daemon. The
// startup reap is the backstop for the truly abrupt kills that skip 'exit' too.
process.on('exit', () => {
  try { killTrackedEnginesSync(store.dir()) } catch { /* best-effort */ }
  // Same last-resort net for a cloudflared tunnel — a leaked one keeps a PUBLIC URL
  // alive pointing at a port nothing may be serving anymore, worse than a leaked engine.
  try { killTrackedTunnelsSync(store.dir()) } catch { /* best-effort */ }
  // Best-effort pidfile cleanup — covers exits that bypass the signal handlers
  // (e.g. process.exit() called elsewhere). Graceful SIGTERM/SIGINT already
  // removed it above; this is a second-layer safety net.
  try { removePidfile(store.dir()) } catch { /* best-effort */ }
})
