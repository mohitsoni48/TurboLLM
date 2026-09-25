// daemon-supervisor.test.js — plain `node --test`, Node built-ins only (ADR-442).
const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')

const {
  RESTART_REQUESTED_EXIT_CODE,
  decideOnDaemonExit,
  isRunning,
  createDaemonSupervisor
} = require('./daemon-supervisor')

const DAEMON_RESTART_SOURCE = join(__dirname, '..', 'turbollm', 'src', 'daemon-restart.ts')
const DAEMON_EXIT_CODE_DECLARATION = /export const RESTART_REQUESTED_EXIT_CODE = (\d+)/

const FAKE_DAEMON = join(__dirname, 'test-fixtures', 'fake-daemon.js')
const DEADLINE_MS = 10_000
const POLL_INTERVAL_MS = 50

const supervisors = []
const tempDirs = []

after(() => {
  for (const supervisor of supervisors) supervisor.stop()
  for (const dir of tempDirs) {
    readPids(dir).filter(alive).forEach(endLeftoverDaemon)
    rmSync(dir, { recursive: true, force: true })
  }
})

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

test('a requested restart (exit 75) is respawned and the new daemon is the one tracked', async () => {
  const dir = newDir()
  const lost = []
  const supervisor = supervise({ spawnDaemon: fakeDaemon(dir, '75'), onDaemonLost: (reason) => lost.push(reason) })
  supervisor.start()

  await waitUntil(() => readPids(dir).length === 2, DEADLINE_MS, 'the respawned daemon')
  const pids = readPids(dir)
  assert.equal(pids.length, 2)
  assert.equal(supervisor.current().pid, pids[1])
  await waitUntil(() => !alive(pids[0]), DEADLINE_MS, 'the restarted daemon to be gone')
  assert.ok(alive(pids[1]), 'the respawned daemon is alive')

  supervisor.stop()
  await waitUntil(() => !alive(pids[1]), DEADLINE_MS, 'the respawned daemon to stop')
  await sleep(300)
  assert.equal(readPids(dir).length, 2, 'nothing is respawned after stop()')
  assert.deepEqual(lost, [])
})

test('a crash is never respawned: the app is told the daemon is lost, once', async () => {
  const dir = newDir()
  const lost = []
  supervise({ spawnDaemon: fakeDaemon(dir, '1'), onDaemonLost: (reason) => lost.push(reason) }).start()

  await waitUntil(() => lost.length === 1, DEADLINE_MS, 'the daemon to be reported lost')
  await sleep(300)
  assert.deepEqual(lost, ['exited (code=1, signal=none)'])
  assert.equal(readPids(dir).length, 1)
})

// POSIX runs the fixture's SIGTERM handler, which exits 75; Windows terminates it. Neither may respawn.
test('a daemon that exits while the app is quitting is not respawned', async () => {
  const dir = newDir()
  const lost = []
  const supervisor = supervise({
    spawnDaemon: fakeDaemon(dir, '75', 10_000),
    onDaemonLost: (reason) => lost.push(reason)
  })
  supervisor.start()
  await waitUntil(() => readPids(dir).length === 1, DEADLINE_MS, 'the daemon to start')
  const [pid] = readPids(dir)

  supervisor.stop()
  await waitUntil(() => !alive(pid), DEADLINE_MS, 'the daemon to stop')
  await sleep(500)
  assert.equal(readPids(dir).length, 1)
  assert.deepEqual(lost, [])
})

test('start() returns the spawned child and current() tracks it', () => {
  const child = fakeChild()
  const supervisor = supervise({ spawnDaemon: () => child, onDaemonLost: () => {} })

  assert.equal(supervisor.current(), null)
  assert.equal(supervisor.start(), child)
  assert.equal(supervisor.current(), child)
})

test('start() lets a synchronous spawn failure reach the caller', () => {
  const lost = []
  const supervisor = supervise({
    spawnDaemon: () => { throw new Error('no daemon files') },
    onDaemonLost: (reason) => lost.push(reason)
  })

  assert.throws(() => supervisor.start(), /no daemon files/)
  assert.deepEqual(lost, [])
})

function supervise (deps) {
  const supervisor = createDaemonSupervisor({ log: { log () {}, error () {} }, ...deps })
  supervisors.push(supervisor)
  return supervisor
}

function fakeDaemon (dir, mode, delayMs) {
  return () => spawn(
    process.execPath,
    [FAKE_DAEMON, dir, mode, String(delayMs ?? 0)],
    { stdio: 'ignore', windowsHide: true }
  )
}

function fakeChild () {
  return Object.assign(new EventEmitter(), {
    pid: 0,
    exitCode: null,
    signalCode: null,
    killCalls: [],
    kill (signal) {
      this.killCalls.push(signal)
      return true
    }
  })
}

function newDir () {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-supervisor-'))
  tempDirs.push(dir)
  return dir
}

function readPids (dir) {
  const pidsFile = join(dir, 'pids.txt')
  if (!existsSync(pidsFile)) return []
  return readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number)
}

async function waitUntil (predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function endLeftoverDaemon (pid) {
  try {
    process.kill(pid)
  } catch {
    // It exited between the alive() check and now, which is the outcome we wanted.
  }
}
