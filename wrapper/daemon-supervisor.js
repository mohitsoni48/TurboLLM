// daemon-supervisor.js — owns the desktop daemon's lifetime across restarts (ADR-442).
// Electron-free on purpose, so it can be tested with real child processes under plain `node --test`.
// A daemon exits RESTART_REQUESTED_EXIT_CODE to ask for a fresh one; any other exit means the daemon is gone.
// It exits DATA_DIR_IN_USE_EXIT_CODE when its start guard refused it because another TurboLLM holds its data
// dir (a CLI daemon on ~/.turbollm), and CONFIG_ACCESS_EXIT_CODE when it may not read or write its config.json
// (another user's, as `sudo turbollm` leaves it): gone too, but the app tells the user why (main.js onDaemonLost).
// The constants mirror turbollm/src/daemon-restart.ts and turbollm/src/daemon-pid.ts, and
// daemon-supervisor.test.js pins that.

const { spawnSync } = require('node:child_process')

const RESTART_REQUESTED_EXIT_CODE = 75 // mirrors turbollm/src/daemon-restart.ts
const DATA_DIR_IN_USE_EXIT_CODE = 73 // mirrors turbollm/src/daemon-pid.ts
const CONFIG_ACCESS_EXIT_CODE = 77 // mirrors turbollm/src/daemon-pid.ts

/**
 * Tracks exactly one live daemon: respawns it on a requested restart, reports any other exit as lost
 * (once), and on stop() ends whichever daemon is live now. A loss says whether the daemon was refused
 * because another TurboLLM holds its data dir (dataDirInUse) or because it may not read or write its
 * config.json (configAccess).
 * @param {{ spawnDaemon: () => import('node:child_process').ChildProcess,
 *           onDaemonLost: (reason: string, details: { dataDirInUse: boolean, configAccess: boolean }) => void,
 *           log?: Pick<Console,'log'|'error'>,
 *           killGraceMs?: number,
 *           platform?: NodeJS.Platform,
 *           killTreeSync?: (pid: number) => void }} deps
 * @returns {{ start(): ChildProcess, stop(): void, current(): ChildProcess | null }}
 */
function createDaemonSupervisor ({
  spawnDaemon, onDaemonLost, log = console, killGraceMs = 5000,
  platform = process.platform, killTreeSync = taskkillTreeSync
}) {
  let state = 'idle'
  let current = null

  function start () {
    const child = spawnDaemon()
    current = child
    if (state === 'idle') state = 'running'
    child.on('exit', (code, signal) => onExit(child, code, signal))
    child.on('error', (err) => onError(child, err))
    return child
  }

  function onExit (child, code, signal) {
    if (child !== current) return
    const decision = decideOnDaemonExit({ code, signal, stopping: state !== 'running' })
    if (decision.action === 'respawn') respawn()
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

  function lose (reason, dataDirInUse = false, configAccess = false) {
    if (state !== 'running') return
    state = 'lost'
    onDaemonLost(reason, { dataDirInUse, configAccess })
  }

  function stop () {
    state = 'stopping'
    const child = current
    if (isRunning(child)) endDaemon(child)
  }

  function endDaemon (child) {
    // On Windows kill() is TerminateProcess whatever the signal, so the daemon's SIGTERM and 'exit' handlers never
    // run, nor does the one that ends a running build's compiler tree (build-runner.ts runStep). The vcvars step's
    // cmd.exe died with the daemon's job object, but cmake, ninja and cl/nvcc had broken away from it and kept
    // compiling after the app quit. So the daemon's whole tree is ended first, while its children are still linked
    // to it (once it is gone /T finds none), and synchronously: before-quit returns and Electron exits, and an async
    // taskkill would die with the app. The kill below stays, for a taskkill that is missing or failed.
    if (platform === 'win32' && child.pid > 0) {
      try {
        killTreeSync(child.pid)
      } catch (err) {
        log.error(`TurboLLM daemon tree kill failed: ${err.message}`)
      }
    }
    child.kill('SIGTERM')
    const escalation = setTimeout(() => isRunning(child) && child.kill('SIGKILL'), killGraceMs)
    escalation.unref() // a daemon that ignores SIGTERM must not hold the quitting app open
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
 * Pure.
 * @param {{ code: number | null, signal: string | null, stopping: boolean }} exit
 * @returns {{ action: 'respawn'|'lost'|'none', reason: string, dataDirInUse?: true, configAccess?: true }}
 */
function decideOnDaemonExit ({ code, signal, stopping }) {
  if (stopping) return { action: 'none', reason: 'stopping' }
  if (code === RESTART_REQUESTED_EXIT_CODE) {
    return { action: 'respawn', reason: `restart requested (exit ${RESTART_REQUESTED_EXIT_CODE})` }
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
  dataDirInUseNotice,
  configAccessNotice,
  decideOnDaemonExit,
  isRunning,
  createDaemonSupervisor
}
