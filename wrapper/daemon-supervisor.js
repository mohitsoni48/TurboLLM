// daemon-supervisor.js — owns the desktop daemon's lifetime across restarts (ADR-442).
// Electron-free on purpose, so it can be tested with real child processes under plain `node --test`.
// A daemon exits RESTART_REQUESTED_EXIT_CODE to ask for a fresh one; any other exit means the daemon is gone.
// The constant mirrors turbollm/src/daemon-restart.ts, and daemon-supervisor.test.js pins that.

const RESTART_REQUESTED_EXIT_CODE = 75 // mirrors turbollm/src/daemon-restart.ts

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

module.exports = { RESTART_REQUESTED_EXIT_CODE, decideOnDaemonExit, isRunning }
