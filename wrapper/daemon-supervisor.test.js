// daemon-supervisor.test.js — plain `node --test`, Node built-ins only (ADR-442).
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const {
  RESTART_REQUESTED_EXIT_CODE,
  decideOnDaemonExit,
  isRunning
} = require('./daemon-supervisor')

const DAEMON_RESTART_SOURCE = join(__dirname, '..', 'turbollm', 'src', 'daemon-restart.ts')
const DAEMON_EXIT_CODE_DECLARATION = /export const RESTART_REQUESTED_EXIT_CODE = (\d+)/

test('the restart exit code is 75', () => {
  assert.equal(RESTART_REQUESTED_EXIT_CODE, 75)
})

test('the restart exit code matches turbollm/src/daemon-restart.ts', () => {
  const declaration = readFileSync(DAEMON_RESTART_SOURCE, 'utf8').match(DAEMON_EXIT_CODE_DECLARATION)
  assert.ok(declaration, `${DAEMON_RESTART_SOURCE} must declare the daemon's RESTART_REQUESTED_EXIT_CODE`)
  assert.equal(Number(declaration[1]), RESTART_REQUESTED_EXIT_CODE)
})

test('decideOnDaemonExit: exit 75 while running asks for a respawn', () => {
  assert.deepEqual(
    decideOnDaemonExit({ code: 75, signal: null, stopping: false }),
    { action: 'respawn', reason: 'restart requested (exit 75)' }
  )
})

test('decideOnDaemonExit: nothing happens while the app is stopping, whatever the exit', () => {
  const exitsWhileStopping = [
    { code: 75, signal: null },
    { code: 0, signal: null },
    { code: 1, signal: null },
    { code: null, signal: 'SIGTERM' }
  ]
  for (const exit of exitsWhileStopping) {
    assert.deepEqual(
      decideOnDaemonExit({ ...exit, stopping: true }),
      { action: 'none', reason: 'stopping' },
      `code=${exit.code}, signal=${exit.signal}`
    )
  }
})

// A daemon that exits 0 without being asked to restart is gone: main.js used to ignore it (ADR-442).
test('decideOnDaemonExit: exit 0 means the daemon is lost', () => {
  assert.deepEqual(
    decideOnDaemonExit({ code: 0, signal: null, stopping: false }),
    { action: 'lost', reason: 'exited (code=0, signal=none)' }
  )
})

test('decideOnDaemonExit: a crash or a signal means the daemon is lost', () => {
  assert.deepEqual(
    decideOnDaemonExit({ code: 1, signal: null, stopping: false }),
    { action: 'lost', reason: 'exited (code=1, signal=none)' }
  )
  assert.deepEqual(
    decideOnDaemonExit({ code: null, signal: 'SIGTERM', stopping: false }),
    { action: 'lost', reason: 'exited (code=null, signal=SIGTERM)' }
  )
})

test('isRunning: only a child with neither an exit code nor a signal is running', () => {
  assert.equal(isRunning({ exitCode: null, signalCode: null }), true)
  assert.equal(isRunning({ exitCode: 0, signalCode: null }), false)
  assert.equal(isRunning({ exitCode: null, signalCode: 'SIGTERM' }), false)
  assert.equal(isRunning({ exitCode: -4058, signalCode: null }), false)
  assert.equal(isRunning(null), false)
  assert.equal(isRunning(undefined), false)
})
