// daemon-supervisor.test.js — plain `node --test`, Node built-ins only (ADR-442).
const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
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
const SUPERVISOR_HOST = join(__dirname, 'test-fixtures', 'supervisor-host.js')
const DEADLINE_MS = 10_000
const POLL_INTERVAL_MS = 50
const PROCESS_GONE_DEADLINE_MS = 5_000
const SURVIVAL_WINDOW_MS = 2_000
const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'job-object reaping is Windows-only' }

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
  const launches = countingSpawner(fakeDaemon(dir, '75'))
  const supervisor = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: (reason) => lost.push(reason) })
  supervisor.start()

  await waitUntil(() => readPids(dir).length === 2, DEADLINE_MS, 'the respawned daemon')
  const pids = readPids(dir)
  assert.equal(pids.length, 2)
  assert.equal(supervisor.current().pid, pids[1])
  await waitUntil(() => !alive(pids[0]), DEADLINE_MS, 'the restarted daemon to be gone')
  assert.ok(alive(pids[1]), 'the respawned daemon is alive')

  const stopped = once(supervisor.current(), 'exit')
  supervisor.stop()
  await waitUntil(() => !alive(pids[1]), DEADLINE_MS, 'the respawned daemon to stop')
  await stopped
  assert.equal(launches.count, 2, 'no daemon is spawned after stop()')
  assert.equal(readPids(dir).length, 2, 'nothing is respawned after stop()')
  assert.deepEqual(lost, [])
})

test('a crash is never respawned: the app is told the daemon is lost, once', async () => {
  const dir = newDir()
  const lost = []
  const launches = countingSpawner(fakeDaemon(dir, '1'))
  const child = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: (reason) => lost.push(reason) }).start()
  const exited = once(child, 'exit')

  await waitUntil(() => lost.length === 1, DEADLINE_MS, 'the daemon to be reported lost')
  await exited
  assert.equal(launches.count, 1, 'a crash is never respawned')
  assert.deepEqual(lost, ['exited (code=1, signal=none)'])
  assert.equal(readPids(dir).length, 1)
})

// POSIX runs the fixture's SIGTERM handler, which exits 75; Windows terminates it. Neither may respawn.
test('a daemon that exits while the app is quitting is not respawned', async () => {
  const dir = newDir()
  const lost = []
  const launches = countingSpawner(fakeDaemon(dir, '75', 10_000))
  const supervisor = supervise({
    spawnDaemon: launches.spawnDaemon,
    onDaemonLost: (reason) => lost.push(reason)
  })
  supervisor.start()
  await waitUntil(() => readPids(dir).length === 1, DEADLINE_MS, 'the daemon to start')
  const [pid] = readPids(dir)

  const stopped = once(supervisor.current(), 'exit')
  supervisor.stop()
  await waitUntil(() => !alive(pid), DEADLINE_MS, 'the daemon to stop')
  await stopped
  assert.equal(launches.count, 1, 'no daemon is spawned after stop()')
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

test('a daemon that cannot be spawned is reported lost once, not thrown', async () => {
  const dir = newDir()
  const lost = []
  supervise({
    spawnDaemon: () => spawn(join(dir, 'no-such-daemon-binary'), [], { stdio: 'ignore', windowsHide: true }),
    onDaemonLost: (reason) => lost.push(reason)
  }).start()

  await waitUntil(() => lost.length === 1, DEADLINE_MS, 'the daemon to be reported lost')
  await sleep(300)
  assert.equal(lost.length, 1)
  assert.match(lost[0], /^failed: /)
  assert.match(lost[0], /ENOENT/)
})

test('a respawn that throws is reported lost with its reason', async () => {
  const dir = newDir()
  const lost = []
  let spawnCalls = 0
  const spawnOnlyTheFirstDaemon = () => {
    spawnCalls += 1
    if (spawnCalls === 1) return fakeDaemon(dir, '75')()
    throw new Error('spawn blocked for test')
  }
  supervise({ spawnDaemon: spawnOnlyTheFirstDaemon, onDaemonLost: (reason) => lost.push(reason) }).start()

  await waitUntil(() => lost.length === 1, DEADLINE_MS, 'the failed respawn to be reported lost')
  assert.deepEqual(lost, ['could not be restarted: spawn blocked for test'])
  assert.equal(readPids(dir).length, 1)
})

test('an error followed by an exit reports the daemon lost once', () => {
  const lost = []
  const launches = fakeLaunches()
  const child = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: (reason) => lost.push(reason) }).start()

  child.emit('error', new Error('boom'))
  child.exitCode = 1
  child.emit('exit', 1, null)

  assert.deepEqual(lost, ['failed: boom'])
  assert.equal(launches.spawned.length, 1)
})

test('an exit followed by an error reports the daemon lost once', () => {
  const lost = []
  const launches = fakeLaunches()
  const child = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: (reason) => lost.push(reason) }).start()

  child.exitCode = 1
  child.emit('exit', 1, null)
  child.emit('error', new Error('boom'))

  assert.deepEqual(lost, ['exited (code=1, signal=none)'])
})

test('stop() escalates to SIGKILL when the daemon ignores SIGTERM', async () => {
  const launches = fakeLaunches()
  const supervisor = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: () => {}, killGraceMs: 30 })
  const child = supervisor.start()

  supervisor.stop()
  assert.deepEqual(child.killCalls, ['SIGTERM'])
  await sleep(150)
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL'])
})

test('stop() does not escalate when the daemon exits within the grace period', async () => {
  const lost = []
  const launches = fakeLaunches()
  const supervisor = supervise({
    spawnDaemon: launches.spawnDaemon,
    onDaemonLost: (reason) => lost.push(reason),
    killGraceMs: 30
  })
  const child = supervisor.start()

  supervisor.stop()
  child.exitCode = 0
  child.emit('exit', 0, null)
  await sleep(150)

  assert.deepEqual(child.killCalls, ['SIGTERM'])
  assert.deepEqual(lost, [])
  assert.equal(launches.spawned.length, 1)
})

// The exit 75 has happened but its 'exit' event is still queued when the app starts quitting.
test('quitting in the gap after an exit 75 kills nothing and respawns nothing', () => {
  const lost = []
  const launches = fakeLaunches()
  const supervisor = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: (reason) => lost.push(reason) })
  const child = supervisor.start()

  child.exitCode = 75
  supervisor.stop()
  assert.deepEqual(child.killCalls, [])

  child.emit('exit', 75, null)
  assert.equal(launches.spawned.length, 1)
  assert.deepEqual(lost, [])
})

test('on Windows a supervised daemon dies with its host even without stop()', WINDOWS_ONLY, async () => {
  const dir = newDir()

  const hostExitCode = await runSupervisorHost(dir, 'supervised')
  assert.equal(hostExitCode, 0, 'host exit code (3: the supervisor lost the daemon, 4: it timed out)')
  const pids = readPids(dir)
  assert.equal(pids.length, 2)

  await waitUntil(
    () => pids.every((pid) => !alive(pid)),
    PROCESS_GONE_DEADLINE_MS,
    'both daemons to die with their host'
  )
})

test(
  'control: on Windows a detached child survives its host (the shape that orphaned the daemon)',
  WINDOWS_ONLY,
  async () => {
    const dir = newDir()

    const hostExitCode = await runSupervisorHost(dir, 'detached-control')
    assert.equal(hostExitCode, 0, 'host exit code (4: the detached child never recorded its PID)')
    const pids = readPids(dir)
    assert.equal(pids.length, 1)
    const [pid] = pids

    await sleep(SURVIVAL_WINDOW_MS)
    assert.ok(alive(pid), 'the liveness probe cannot see a survivor, so the job-object test proves nothing')

    process.kill(pid)
    await waitUntil(() => !alive(pid), PROCESS_GONE_DEADLINE_MS, 'the control survivor to be killed')
  }
)

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

async function runSupervisorHost (dir, mode) {
  const host = spawn(process.execPath, [SUPERVISOR_HOST, dir, mode], { stdio: 'ignore', windowsHide: true })
  const [exitCode] = await once(host, 'exit')
  return exitCode
}

function fakeLaunches () {
  const spawned = []
  const spawnDaemon = () => {
    const child = fakeChild()
    spawned.push(child)
    return child
  }
  return { spawned, spawnDaemon }
}

function countingSpawner (spawnDaemon) {
  const launches = { count: 0 }
  launches.spawnDaemon = () => {
    launches.count += 1
    return spawnDaemon()
  }
  return launches
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
