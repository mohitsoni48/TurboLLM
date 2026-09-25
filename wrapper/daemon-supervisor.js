// daemon-supervisor.js — owns the desktop daemon's lifetime across restarts (ADR-442).
// Electron-free on purpose, so it can be tested with real child processes under plain `node --test`.
// A daemon exits RESTART_REQUESTED_EXIT_CODE to ask for a fresh one; any other exit means the daemon is gone.
// The constant mirrors turbollm/src/daemon-restart.ts, and daemon-supervisor.test.js pins that.

const RESTART_REQUESTED_EXIT_CODE = 75 // mirrors turbollm/src/daemon-restart.ts

/**
 * Tracks exactly one live daemon: respawns it on a requested restart, reports any other exit as lost
 * (once), and on stop() ends whichever daemon is live now.
 * @param {{ spawnDaemon: () => import('node:child_process').ChildProcess,
 *           onDaemonLost: (reason: string) => void,
 *           log?: Pick<Console,'log'|'error'>,
 *           killGraceMs?: number }} deps
 * @returns {{ start(): ChildProcess, stop(): void, current(): ChildProcess | null }}
 */
function createDaemonSupervisor ({ spawnDaemon, onDaemonLost, log = console, killGraceMs = 5000 }) {
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
    child.kill('SIGTERM')
    const escalation = setTimeout(() => isRunning(child) && child.kill('SIGKILL'), killGraceMs)
    escalation.unref() // a daemon that ignores SIGTERM must not hold the quitting app open
  }

  return { start, stop, current: () => current }
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
