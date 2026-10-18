// daemon-supervisor.js — owns the desktop daemon's lifetime across restarts (ADR-442).
// Electron-free on purpose, so it can be tested with real child processes under plain `node --test`.
// A daemon exits RESTART_REQUESTED_EXIT_CODE to ask for a fresh one; any other exit means the daemon is gone.
// The constant mirrors turbollm/src/daemon-restart.ts, and daemon-supervisor.test.js pins that.

const { spawnSync } = require('node:child_process')

const RESTART_REQUESTED_EXIT_CODE = 75 // mirrors turbollm/src/daemon-restart.ts

/**
 * Tracks exactly one live daemon: respawns it on a requested restart, reports any other exit as lost
 * (once), and on stop() ends whichever daemon is live now.
 * @param {{ spawnDaemon: () => import('node:child_process').ChildProcess,
 *           onDaemonLost: (reason: string) => void,
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
    else if (decision.action === 'lost') lose(decision.reason)
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

  function lose (reason) {
    if (state !== 'running') return
    state = 'lost'
    onDaemonLost(reason)
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
 * @returns {{ action: 'respawn'|'lost'|'none', reason: string }}
 */
function decideOnDaemonExit ({ code, signal, stopping }) {
  if (stopping) return { action: 'none', reason: 'stopping' }
  if (code === RESTART_REQUESTED_EXIT_CODE) {
    return { action: 'respawn', reason: `restart requested (exit ${RESTART_REQUESTED_EXIT_CODE})` }
  }
  return { action: 'lost', reason: `exited (code=${code}, signal=${signal ?? 'none'})` }
}

/** Pure. Still running iff it has neither an exit code nor a terminating signal.
 *  (Replaces main.js's `!exitCode`, which is true for a process that exited with 0.) */
function isRunning (child) {
  return !!child && child.exitCode === null && child.signalCode === null
}

module.exports = { RESTART_REQUESTED_EXIT_CODE, decideOnDaemonExit, isRunning, createDaemonSupervisor }
