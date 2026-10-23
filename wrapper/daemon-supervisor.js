// daemon-supervisor.js — owns the desktop daemon's lifetime across restarts (ADR-442), and ties it to the app's:
// the daemon cannot outlive the app however the app ends (daemonSpawnSpec), and Quit stops it gracefully on every
// OS (stop()). Electron-free on purpose, so it can be tested with real child processes under plain `node --test`.
// A daemon exits RESTART_REQUESTED_EXIT_CODE to ask for a fresh one; any other exit means the daemon is gone.
// It exits DATA_DIR_IN_USE_EXIT_CODE when its start guard refused it because another TurboLLM holds its data
// dir (a CLI daemon on ~/.turbollm), and CONFIG_ACCESS_EXIT_CODE when it may not read or write its config.json
// (another user's, as `sudo turbollm` leaves it): gone too, but the app tells the user why (main.js onDaemonLost).
// The constants mirror turbollm/src/daemon-restart.ts and turbollm/src/daemon-pid.ts, and
// daemon-supervisor.test.js pins that.

const { spawnSync } = require('node:child_process')
const { accessSync, constants, realpathSync, statSync } = require('node:fs')
const { basename } = require('node:path')

const RESTART_REQUESTED_EXIT_CODE = 75 // mirrors turbollm/src/daemon-restart.ts
const DATA_DIR_IN_USE_EXIT_CODE = 73 // mirrors turbollm/src/daemon-pid.ts
const CONFIG_ACCESS_EXIT_CODE = 77 // mirrors turbollm/src/daemon-pid.ts

/** How long Quit (stop()) waits for the daemon's own graceful shutdown before it ends the daemon, and how long the
 *  POSIX watcher (DAEMON_WRAP) gives a daemon whose app died before it SIGKILLs it. The daemon's teardown is bounded
 *  by its own 12 s fallback. */
const QUIT_GRACE_MS = 15_000
/** A daemon refused because the data dir is in use (exit 73) within this long of the app's start is started again,
 *  every RETRY_EVERY_MS, before the app says so: a relaunch right after a Quit finds the previous daemon still
 *  shutting down (on macOS Quit does not wait for it), which holds the data dir until it has finished. */
const RETRY_WINDOW_MS = 15_000
const RETRY_EVERY_MS = 1_000
/** The daemon's arguments in the portable form, as turbollm util/tether.ts's wrapper has them: bash as /bin/sh takes
 *  `set -u` from an exported SHELLOPTS holding `nounset`, and bash 4.0 then took an empty `"$@"` for an unbound
 *  variable, so a command with no arguments never started. The app always passes cli.js, so this only keeps the
 *  script the same as tether.ts's. */
const ARGS = '${1+"$@"}'

/**
 * The POSIX launch: `/bin/sh -c DAEMON_WRAP <node> <cli.js> <args…>`, detached (the daemon leads its own process
 * group and session), with stdio [pipe, pipe, pipe, pipe]. The script starts a watcher and execs the daemon in
 * place (same pid, so its parent is the app, which its stdin lifeline is bound to: TURBOLLM_LIFELINE=stdin:<app
 * pid>). The watcher blocks on fd 3, whose other end only the app holds, and the daemon never sees fd 3. When the
 * app dies, however it dies, the kernel closes fd 3: the daemon, if still there, gets SIGTERM (the app's death has
 * also ended its stdin, which shuts it down gracefully by itself), and a daemon still running after `graceS` (a
 * wedged event loop) is SIGKILLed: its pid, not its group. A package manager the daemon runs under sudo stays in the
 * daemon's group (turbollm util/tether.ts, term mode) and must only ever get SIGTERM, which its own watcher sends
 * once the daemon is gone; every other child of the daemon ends by its own lifeline. The watcher is double-forked,
 * so it is not the daemon's child, and it stays in the daemon's group, which pins the group id and so the daemon's
 * pid number: `kill -0 $$` can never reach another process that got the number. When the daemon exits first (Quit,
 * a restart's exit 75), the app closes fd 3 at its 'exit' and the watcher leaves without a signal.
 *
 * dash (Debian's and Ubuntu's /bin/sh) and busybox ash pass on at their exec only the variables whose names are
 * shell identifiers, so the daemon lost `spring.profiles.active`, npm's `npm_config_//registry.npmjs.org/:_authToken`
 * or an exported bash function (`BASH_FUNC_f%%`) the app was started with, and so did everything it runs. With such
 * a name, daemonSpawnSpec runs this script under `bash --norc -p` instead (bashProgram), which passes every name on,
 * so no value travels anywhere: --norc, since a `bash -c` whose stdin is a socket (the app's pipes) takes itself for
 * rshd's and runs ~/.bashrc when SHLVL is unset, as it is for an app started from a desktop session; -p, so it runs
 * no BASH_ENV and defines no exported function, which could stand in for the watcher's `read` or `kill`. Without a
 * bash, or with SHELLOPTS or BASHOPTS exported (bash would pass on its own options under those names), `carried`
 * holds those names, whose values travel as TURBOLLM_TETHER_V<i> (the i-th name), and the script execs the daemon
 * through `env`, which sets each name from its carrier and drops the carriers. No value is in sh's argv then, but
 * each is in env's from env's exec to the daemon's, which /proc shows every local user (turbollm util/tether.ts).
 *
 * bash, under its own name or as /bin/sh (macOS, Fedora), reads two exported variables that changed the watcher,
 * and dash reads neither. Its `read` takes TMOUT for a timeout, so on a host that exports one (CIS hardening sets
 * TMOUT=900) the watcher sent the daemon its SIGTERM TMOUT seconds after the app started it: the watcher unsets it,
 * and the daemon keeps it. As /bin/sh it also takes options from an exported SHELLOPTS, which an interactive
 * shell's `export SHELLOPTS` fills with `monitor`, and job control gave the watcher a process group of its own,
 * where it no longer pinned the daemon's pid: the script turns job control off (`set +m`) before it forks it.
 */
function daemonWrap (graceS = QUIT_GRACE_MS / 1000, carried = null) {
  const watcher = 'unset TMOUT; trap "" HUP INT TERM; exec </dev/null >/dev/null 2>&1; ' +
    'while read -r _; do :; done <&3; ' +
    'kill -0 $$ 2>/dev/null || exit 0; kill -s TERM $$; i=0; ' +
    `while kill -0 $$ 2>/dev/null && [ $i -lt ${Number(graceS)} ]; do sleep 1; i=$((i+1)); done; ` +
    'kill -0 $$ 2>/dev/null && kill -s KILL $$'
  if (carried && carried.names.length > 0) {
    // env execs in place too (same pid). `--` before the pairs: a name may start with '-'.
    const unset = carried.names.map((_, i) => ` -u TURBOLLM_TETHER_V${i}`).join('')
    const pairs = carried.names.map((k, i) => ` ${shQuote(k)}="$TURBOLLM_TETHER_V${i}"`).join('')
    return `set +m; ( ( ${watcher} ) & ); exec ${shQuote(carried.env)}${unset} --${pairs} "$0" ${ARGS} 3<&-`
  }
  return `set +m; ( ( ${watcher} ) & ); exec "$0" ${ARGS} 3<&-`
}
const DAEMON_WRAP = daemonWrap()

/** A name dash and busybox ash take from their environment and pass on: any other is dropped at the exec. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `s` as one single-quoted shell word. */
function shQuote (s) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function isExecutableFile (p) {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The `env` DAEMON_WRAP execs the daemon through when names must be carried, or null. */
function envProgram () {
  return ['/usr/bin/env', '/bin/env'].find(isExecutableFile) ?? null
}

/** The bash DAEMON_WRAP runs under when names must be passed on, or null: /bin/bash, else /bin/sh where that is bash
 *  (NixOS). A file whose real name is not bash's (busybox's `bash` applet, which is ash) is not taken. */
function bashProgram () {
  return ['/bin/bash', '/usr/bin/bash', '/bin/sh'].find((p) => {
    try {
      return isExecutableFile(p) && basename(realpathSync(p)).startsWith('bash')
    } catch {
      return false
    }
  }) ?? null
}

/**
 * How the app starts its daemon. `node` and `args` are the daemon's own command (node, cli.js and its flags).
 * - POSIX: behind DAEMON_WRAP (see there), detached, stdio [pipe, pipe, pipe, pipe].
 * - Windows: node itself, not detached, stdio [pipe, pipe, pipe], so the daemon sits in Electron's kill-on-close job:
 *   Electron's death, however it dies, ends it (and the job sentinel's jobs, whose handles the daemon holds).
 * Both set TURBOLLM_DESKTOP=1 (the app supervises it: it respawns it on exit 75) and TURBOLLM_LIFELINE=stdin:<app
 * pid>: the daemon shuts down gracefully when its stdin ends, which Quit does and the app's death does.
 * @param {{ platform: NodeJS.Platform, node: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
 *           appPid: number, graceS?: number, bash?: string | null }} o `bash`: the bash to pass names through
 *           (tests: null for none; looked up when absent).
 */
function daemonSpawnSpec ({ platform, node, args, cwd, env, appPid, graceS, bash }) {
  const options = {
    cwd,
    windowsHide: true, // hide the console window on Windows
    env: { ...env, TURBOLLM_DESKTOP: '1', TURBOLLM_LIFELINE: `stdin:${appPid}` },
  }
  if (platform === 'win32') return { node, args, options: { ...options, stdio: ['pipe', 'pipe', 'pipe'] } }
  const wrap = graceS === undefined ? DAEMON_WRAP : daemonWrap(graceS)
  const posix = { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }
  // Names dash or busybox ash as /bin/sh would drop (daemonWrap): passed on by bash, else carried past sh. env would
  // take a daemon path holding '=' for one more pair, so that one (and a system with neither) keeps the plain exec,
  // which keeps those names only where /bin/sh is bash.
  const names = Object.keys(options.env).filter((k) => k !== '' && !SHELL_NAME.test(k) && options.env[k] !== undefined)
  if (names.length > 0) {
    const viaBash = options.env.SHELLOPTS === undefined && options.env.BASHOPTS === undefined
      ? (bash === undefined ? bashProgram() : bash) : null
    if (viaBash) return { node: viaBash, args: ['--norc', '-p', '-c', wrap, node, ...args], options: posix }
    const envPath = node.includes('=') ? null : envProgram()
    if (envPath) {
      const next = { ...options.env }
      names.forEach((k, i) => {
        next[`TURBOLLM_TETHER_V${i}`] = next[k]
        delete next[k]
      })
      return { node: '/bin/sh', args: ['-c', daemonWrap(graceS, { env: envPath, names }), node, ...args], options: { ...posix, env: next } }
    }
  }
  return { node: '/bin/sh', args: ['-c', wrap, node, ...args], options: posix }
}

/**
 * Tracks exactly one live daemon: respawns it on a requested restart, starts it again when it was refused for a data
 * dir still in use shortly after the app's start (RETRY_WINDOW_MS), reports any other exit as lost (once), and on
 * stop() ends whichever daemon is live now. A loss says whether the daemon was refused because another TurboLLM
 * holds its data dir (dataDirInUse) or because it may not read or write its config.json (configAccess).
 *
 * stop() is graceful: it ends the daemon's stdin (its lifeline, daemonSpawnSpec), which runs the daemon's own
 * shutdown (chats saved as stopped, the store closed, engines and every tethered child stopped, on Windows each tree
 * ended while its root is alive), and resolves at the daemon's exit. A daemon still running after `quitGraceMs` is
 * ended: on Windows its whole tree with `taskkill /T /F` while it is still alive (its children are still linked to
 * it), then TerminateProcess; on POSIX a SIGKILL of its pid, not its group (see daemonWrap). Before, stop() sent
 * SIGTERM, which on Windows is a TerminateProcess: no teardown ran there at all.
 * @param {{ spawnDaemon: () => import('node:child_process').ChildProcess,
 *           onDaemonLost: (reason: string, details: { dataDirInUse: boolean, configAccess: boolean }) => void,
 *           log?: Pick<Console,'log'|'error'>,
 *           quitGraceMs?: number,
 *           platform?: NodeJS.Platform,
 *           killTreeSync?: (pid: number) => void,
 *           now?: () => number,
 *           retryWindowMs?: number,
 *           retryEveryMs?: number }} deps
 * @returns {{ start(): ChildProcess, stop(): Promise<void>, current(): ChildProcess | null }}
 */
function createDaemonSupervisor ({
  spawnDaemon, onDaemonLost, log = console, quitGraceMs = QUIT_GRACE_MS,
  platform = process.platform, killTreeSync = taskkillTreeSync,
  now = Date.now, retryWindowMs = RETRY_WINDOW_MS, retryEveryMs = RETRY_EVERY_MS
}) {
  let state = 'idle'
  let current = null
  let retryTimer = null
  const startedAt = now()

  function start () {
    const child = spawnDaemon()
    current = child
    if (state === 'idle') state = 'running'
    child.on('exit', (code, signal) => onExit(child, code, signal))
    child.on('error', (err) => onError(child, err))
    // An EPIPE when stop() ends the stdin of a daemon that has just died: its exit is handled above.
    child.stdin?.on?.('error', () => {})
    // The POSIX watcher's lifeline (daemonWrap): closed once the daemon has exited, so the watcher leaves without a
    // signal; only the app's own death closes it while the daemon runs.
    child.once('exit', () => child.stdio?.[3]?.destroy?.())
    return child
  }

  function onExit (child, code, signal) {
    if (child !== current) return
    const decision = decideOnDaemonExit({ code, signal, stopping: state !== 'running', sinceStartMs: now() - startedAt, retryWindowMs })
    if (decision.action === 'respawn') respawn()
    else if (decision.action === 'retry') retry(decision.reason)
    else if (decision.action === 'lost') lose(decision.reason, decision.dataDirInUse === true, decision.configAccess === true)
  }

  // Node may emit 'error' without 'exit' (a spawn that never started), or both.
  function onError (child, err) {
    if (child !== current || state !== 'running') return
    lose(`failed: ${err.message}`)
  }

  function respawn () {
    log.log(`TurboLLM daemon restarting (requested, exit ${RESTART_REQUESTED_EXIT_CODE})`)
    try {
      start()
    } catch (err) {
      lose(`could not be restarted: ${err.message}`)
    }
  }

  function retry (reason) {
    log.log(`TurboLLM daemon ${reason}; starting it again in ${retryEveryMs} ms`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (state !== 'running') return
      try {
        start()
      } catch (err) {
        lose(`could not be started again: ${err.message}`)
      }
    }, retryEveryMs)
  }

  function lose (reason, dataDirInUse = false, configAccess = false) {
    if (state !== 'running') return
    state = 'lost'
    onDaemonLost(reason, { dataDirInUse, configAccess })
  }

  function stop () {
    state = 'stopping'
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    const child = current
    if (!isRunning(child)) return Promise.resolve()
    return new Promise((resolve) => {
      const grace = setTimeout(() => {
        if (isRunning(child)) endDaemon(child)
        resolve()
      }, quitGraceMs)
      child.once('exit', () => {
        clearTimeout(grace)
        resolve()
      })
      try {
        child.stdin?.end()
      } catch (err) {
        log.error(`TurboLLM daemon stdin could not be closed: ${err.message}`)
      }
    })
  }

  function endDaemon (child) {
    // On Windows kill() is TerminateProcess whatever the signal, and the daemon's children (cmake, ninja and cl/nvcc
    // broke away from its job object) are cut loose once it is gone. So its whole tree is ended first, while its
    // children are still linked to it (once it is gone /T finds none), and synchronously. The kill below stays, for
    // a taskkill that is missing or failed.
    if (platform === 'win32' && child.pid > 0) {
      try {
        killTreeSync(child.pid)
      } catch (err) {
        log.error(`TurboLLM daemon tree kill failed: ${err.message}`)
      }
    }
    // POSIX: the daemon's pid alone (see daemonWrap): a package manager in its group gets only SIGTERM, from its
    // own watcher, and every other child of the daemon dies by its own lifeline.
    child.kill('SIGKILL')
  }

  return { start, stop, current: () => current }
}

// The default tree kill: what `turbollm --stop` does on Windows (daemon-pid.ts), synchronously (see endDaemon).
// Bounded, so a taskkill that hangs cannot hold the quitting app open. spawnSync never throws: a missing taskkill
// (ENOENT), the timeout and a taskkill that failed come back in its result, so they are thrown from here for
// endDaemon to log.
function taskkillTreeSync (pid) {
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`taskkill exited with code ${r.status}`)
}

/**
 * Pure. `sinceStartMs`: how long ago the app started (by default long enough that nothing is retried).
 * @param {{ code: number | null, signal: string | null, stopping: boolean, sinceStartMs?: number, retryWindowMs?: number }} exit
 * @returns {{ action: 'respawn'|'retry'|'lost'|'none', reason: string, dataDirInUse?: true, configAccess?: true }}
 */
function decideOnDaemonExit ({ code, signal, stopping, sinceStartMs = Infinity, retryWindowMs = RETRY_WINDOW_MS }) {
  if (stopping) return { action: 'none', reason: 'stopping' }
  if (code === RESTART_REQUESTED_EXIT_CODE) {
    return { action: 'respawn', reason: `restart requested (exit ${RESTART_REQUESTED_EXIT_CODE})` }
  }
  // A relaunch right after a Quit: the previous daemon is still shutting down, and holds the data dir until it has
  // finished (at most QUIT_GRACE_MS). It used to show "already running" at once, for a TurboLLM that was going away.
  if (code === DATA_DIR_IN_USE_EXIT_CODE && sinceStartMs < retryWindowMs) {
    return { action: 'retry', reason: `refused: its data dir is still in use (exit ${DATA_DIR_IN_USE_EXIT_CODE}), within ${retryWindowMs / 1000} s of the app's start` }
  }
  if (code === DATA_DIR_IN_USE_EXIT_CODE) {
    return {
      action: 'lost',
      reason: `refused: another TurboLLM holds its data dir (exit ${DATA_DIR_IN_USE_EXIT_CODE})`,
      dataDirInUse: true
    }
  }
  if (code === CONFIG_ACCESS_EXIT_CODE) {
    return {
      action: 'lost',
      reason: `refused: it may not read or write its config file (exit ${CONFIG_ACCESS_EXIT_CODE})`,
      configAccess: true
    }
  }
  return { action: 'lost', reason: `exited (code=${code}, signal=${signal ?? 'none'})` }
}

/**
 * Pure. The dialog the app shows before it quits when its daemon was refused because another TurboLLM
 * holds the data dir. The daemon's own refusal (its stderr) names that one, its pid and address, and
 * how to stop it, so it is the detail; without it the dialog still says what to do.
 * @param {string} daemonStderr
 * @returns {{ title: string, message: string, detail: string }}
 */
function dataDirInUseNotice (daemonStderr) {
  const refusal = String(daemonStderr || '').trim()
  return {
    title: 'TurboLLM is already running',
    message: 'Another TurboLLM is already using your TurboLLM data folder, so the app cannot start its own. ' +
      'Stop that one, then open the app again.',
    detail: refusal || 'If it was started with `turbollm` in a terminal, `turbollm --stop` stops it.'
  }
}

/**
 * Pure. The dialog the app shows before it quits when its daemon may not read or write its config.json. The
 * daemon's own message (its stderr) names the file, whose it is and the `sudo chown` that gives it back, so it
 * is the detail; without it the dialog still says where the file is and what to do.
 * Windows has no sudo or chown, and there the daemon names no owner (no POSIX uid): its EPERM or EACCES comes
 * from the file's permissions, a read-only file or another program holding it, so the dialog says that.
 * @param {string} daemonStderr
 * @param {NodeJS.Platform} [platform]
 * @returns {{ title: string, message: string, detail: string }}
 */
function configAccessNotice (daemonStderr, platform = process.platform) {
  const problem = String(daemonStderr || '').trim()
  if (platform === 'win32') {
    return {
      title: 'TurboLLM cannot open its settings file',
      message: 'TurboLLM cannot read or write its settings file (config.json in your TurboLLM data folder), ' +
        'so the app cannot start. Check that your user may read and write it and its folder, that it is not ' +
        'read-only and that no other program holds it, then open the app again.',
      detail: problem || 'The file is .turbollm\\config.json in your user folder (%USERPROFILE%).'
    }
  }
  return {
    title: 'TurboLLM cannot open its settings file',
    message: 'TurboLLM cannot read or write its settings file (config.json in your TurboLLM data folder), ' +
      'so the app cannot start. This happens when it was run as another user, such as with sudo. ' +
      'Give the file back to your user, then open the app again.',
    detail: problem || 'The file is ~/.turbollm/config.json. If it belongs to another user, ' +
      '`sudo chown "$(id -un)" ~/.turbollm/config.json` gives it back.'
  }
}

/** Pure. Still running iff it has neither an exit code nor a terminating signal.
 *  (Replaces main.js's `!exitCode`, which is true for a process that exited with 0.) */
function isRunning (child) {
  return !!child && child.exitCode === null && child.signalCode === null
}

module.exports = {
  RESTART_REQUESTED_EXIT_CODE,
  DATA_DIR_IN_USE_EXIT_CODE,
  CONFIG_ACCESS_EXIT_CODE,
  QUIT_GRACE_MS,
  RETRY_WINDOW_MS,
  DAEMON_WRAP,
  daemonWrap,
  daemonSpawnSpec,
  dataDirInUseNotice,
  configAccessNotice,
  decideOnDaemonExit,
  isRunning,
  createDaemonSupervisor
}
