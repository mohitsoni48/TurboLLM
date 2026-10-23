// daemon-supervisor.test.js — plain `node --test`, Node built-ins only (ADR-442).
const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, join } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')

const {
  RESTART_REQUESTED_EXIT_CODE,
  DATA_DIR_IN_USE_EXIT_CODE,
  CONFIG_ACCESS_EXIT_CODE,
  DAEMON_WRAP,
  daemonWrap,
  daemonSpawnSpec,
  dataDirInUseNotice,
  configAccessNotice,
  decideOnDaemonExit,
  isRunning,
  createDaemonSupervisor
} = require('./daemon-supervisor')

const DAEMON_RESTART_SOURCE = join(__dirname, '..', 'turbollm', 'src', 'daemon-restart.ts')
const DAEMON_EXIT_CODE_DECLARATION = /export const RESTART_REQUESTED_EXIT_CODE = (\d+)/
const DAEMON_PID_SOURCE = join(__dirname, '..', 'turbollm', 'src', 'daemon-pid.ts')
const DATA_DIR_IN_USE_DECLARATION = /export const DATA_DIR_IN_USE_EXIT_CODE = (\d+)/
const CONFIG_ACCESS_DECLARATION = /export const CONFIG_ACCESS_EXIT_CODE = (\d+)/

const FAKE_DAEMON = join(__dirname, 'test-fixtures', 'fake-daemon.js')
const LIFELINE_DAEMON = join(__dirname, 'test-fixtures', 'lifeline-daemon.js')
const SUPERVISOR_HOST = join(__dirname, 'test-fixtures', 'supervisor-host.js')
const DEADLINE_MS = 10_000
const POLL_INTERVAL_MS = 50
const PROCESS_GONE_DEADLINE_MS = 5_000
const SURVIVAL_WINDOW_MS = 2_000
const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'job-object reaping is Windows-only' }
const POSIX_ONLY = { skip: process.platform === 'win32' && 'fakes taskkill with a shell script' }

const supervisors = []
const tempDirs = []
const unsettledDirs = new Set()

after(() => {
  for (const supervisor of supervisors) supervisor.stop()
  for (const dir of unsettledDirs) readPids(dir).filter(alive).forEach(endLeftoverDaemon)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

test('the restart exit code is 75', () => {
  assert.equal(RESTART_REQUESTED_EXIT_CODE, 75)
})

test('the restart exit code matches turbollm/src/daemon-restart.ts', () => {
  const declaration = readFileSync(DAEMON_RESTART_SOURCE, 'utf8').match(DAEMON_EXIT_CODE_DECLARATION)
  assert.ok(declaration, `${DAEMON_RESTART_SOURCE} must declare the daemon's RESTART_REQUESTED_EXIT_CODE`)
  assert.equal(Number(declaration[1]), RESTART_REQUESTED_EXIT_CODE)
})

test('the data-dir-in-use exit code matches turbollm/src/daemon-pid.ts', () => {
  const declaration = readFileSync(DAEMON_PID_SOURCE, 'utf8').match(DATA_DIR_IN_USE_DECLARATION)
  assert.ok(declaration, `${DAEMON_PID_SOURCE} must declare the daemon's DATA_DIR_IN_USE_EXIT_CODE`)
  assert.equal(Number(declaration[1]), DATA_DIR_IN_USE_EXIT_CODE)
  assert.equal(DATA_DIR_IN_USE_EXIT_CODE, 73)
})

test('the config-access exit code matches turbollm/src/daemon-pid.ts', () => {
  const declaration = readFileSync(DAEMON_PID_SOURCE, 'utf8').match(CONFIG_ACCESS_DECLARATION)
  assert.ok(declaration, `${DAEMON_PID_SOURCE} must declare the daemon's CONFIG_ACCESS_EXIT_CODE`)
  assert.equal(Number(declaration[1]), CONFIG_ACCESS_EXIT_CODE)
  assert.equal(CONFIG_ACCESS_EXIT_CODE, 77)
})

// The daemon's start guard refuses it when another TurboLLM (a CLI daemon on ~/.turbollm) holds its
// data dir. The app quit on it as on any crash, so the user never learnt why the app vanished.
test('decideOnDaemonExit: exit 73 is a daemon refused because another TurboLLM holds its data dir', () => {
  assert.deepEqual(
    decideOnDaemonExit({ code: 73, signal: null, stopping: false }),
    { action: 'lost', reason: 'refused: another TurboLLM holds its data dir (exit 73)', dataDirInUse: true }
  )
  assert.deepEqual(decideOnDaemonExit({ code: 73, signal: null, stopping: true }), { action: 'none', reason: 'stopping' })
})

// A daemon that may not read or write its config.json (another user's, as `sudo turbollm` leaves it) says
// whose it is and how to give it back, then exits. On exit 1 the app quit as on any crash, with that unseen.
// A relaunch right after a Quit (macOS does not wait for the daemon) found the previous daemon still shutting down,
// which holds the data dir until it has finished: the app said "already running" and quit.
test('decideOnDaemonExit: exit 73 within 15 s of the app\'s start is retried; after that it is a refusal', () => {
  assert.deepEqual(
    decideOnDaemonExit({ code: 73, signal: null, stopping: false, sinceStartMs: 14_999 }),
    { action: 'retry', reason: 'refused: its data dir is still in use (exit 73), within 15 s of the app\'s start' }
  )
  assert.equal(decideOnDaemonExit({ code: 73, signal: null, stopping: false, sinceStartMs: 15_000 }).action, 'lost')
  assert.equal(decideOnDaemonExit({ code: 73, signal: null, stopping: true, sinceStartMs: 0 }).action, 'none')
  assert.equal(decideOnDaemonExit({ code: 1, signal: null, stopping: false, sinceStartMs: 0 }).action, 'lost', 'only 73')
})

test('a daemon refused for its data dir right after the app\'s start is started again each second, then reported', async () => {
  let clock = 0
  const lost = []
  const launches = fakeLaunches()
  const supervisor = supervise({
    spawnDaemon: launches.spawnDaemon,
    onDaemonLost: (reason, details) => lost.push({ reason, details }),
    now: () => clock,
    retryEveryMs: 5
  })
  supervisor.start()
  for (let second = 1; second <= 15; second++) {
    const child = launches.spawned.at(-1)
    child.exitCode = 73
    child.emit('exit', 73, null)
    assert.deepEqual(lost, [], `not reported at ${second - 1} s`)
    await waitUntil(() => launches.spawned.length === second + 1, DEADLINE_MS, 'the next start')
    clock = second * 1000
  }
  const last = launches.spawned.at(-1)
  last.exitCode = 73
  last.emit('exit', 73, null)
  assert.deepEqual(lost, [{ reason: 'refused: another TurboLLM holds its data dir (exit 73)', details: { dataDirInUse: true, configAccess: false } }])
  await sleep(30)
  assert.equal(launches.spawned.length, 16, 'and not started again')
})

test('stop() cancels a pending retry', async () => {
  const launches = fakeLaunches()
  const supervisor = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: () => {}, now: () => 0, retryEveryMs: 20 })
  const child = supervisor.start()
  child.exitCode = 73
  child.emit('exit', 73, null)
  await supervisor.stop()
  await sleep(60)
  assert.equal(launches.spawned.length, 1, 'a quitting app starts no daemon')
})

test('decideOnDaemonExit: exit 77 is a daemon that may not read or write its config file', () => {
  assert.deepEqual(
    decideOnDaemonExit({ code: 77, signal: null, stopping: false }),
    { action: 'lost', reason: 'refused: it may not read or write its config file (exit 77)', configAccess: true }
  )
  assert.deepEqual(decideOnDaemonExit({ code: 77, signal: null, stopping: true }), { action: 'none', reason: 'stopping' })
})

test('configAccessNotice: the dialog shows the daemon\'s message, which says whose the file is and how to give it back', () => {
  const problem = "TurboLLM cannot read or write its config file /Users/u/.turbollm/config.json (EACCES: permission denied, open '/Users/u/.turbollm/config.json').\n" +
    'It belongs to another user (uid 0; this is uid 501), as after running turbollm with sudo. Give it back to this user with:\n' +
    "  sudo chown \"$(id -un)\" '/Users/u/.turbollm/config.json'"
  for (const platform of ['darwin', 'linux']) {
    const notice = configAccessNotice(`${problem}\n`, platform)
    assert.equal(notice.title, 'TurboLLM cannot open its settings file')
    assert.match(notice.message, /cannot read or write its settings file/)
    assert.match(notice.message, /Give the file back to your user, then open the app again\./)
    assert.equal(notice.detail, problem)

    // Nothing read from its stderr: the dialog still names the file and how to give it back.
    for (const nothing of ['', '  \n', undefined]) {
      assert.match(configAccessNotice(nothing, platform).detail, /~\/\.turbollm\/config\.json/)
      assert.match(configAccessNotice(nothing, platform).detail, /sudo chown/)
    }
  }
})

test('configAccessNotice: on Windows the dialog names neither sudo nor chown', () => {
  // configAccessProblem names no owner there (no POSIX uid), only what Node got and what to check.
  const problem = "TurboLLM cannot read or write its config file C:\\Users\\u\\.turbollm\\config.json (EPERM: operation not permitted, open 'C:\\Users\\u\\.turbollm\\config.json').\n" +
    'Check that this user may read and write it and its folder.'
  const notice = configAccessNotice(`${problem}\n`, 'win32')
  assert.equal(notice.title, 'TurboLLM cannot open its settings file')
  assert.match(notice.message, /cannot read or write its settings file/)
  assert.match(notice.message, /no other program holds it, then open the app again\./)
  assert.doesNotMatch(notice.message, /sudo|chown|another user/)
  assert.equal(notice.detail, problem)

  for (const nothing of ['', '  \n', undefined]) {
    const { detail } = configAccessNotice(nothing, 'win32')
    assert.match(detail, /\.turbollm\\config\.json in your user folder/)
    assert.doesNotMatch(detail, /sudo|chown|~\//)
  }
})

test('dataDirInUseNotice: the dialog shows the daemon\'s refusal, which names the running one and how to stop it', () => {
  const refusal = 'TurboLLM is already running for /home/u/.turbollm (pid 4242, http://127.0.0.1:6996).\n' +
    'Use that one, stop it first with `turbollm --stop`, or start this one with its own --config.'
  const notice = dataDirInUseNotice(`${refusal}\n`)
  assert.equal(notice.title, 'TurboLLM is already running')
  assert.match(notice.message, /Another TurboLLM is already using your TurboLLM data folder/)
  assert.match(notice.message, /Stop that one, then open the app again\./)
  assert.equal(notice.detail, refusal)

  // Nothing read from its stderr: the dialog still says how to stop the other one.
  for (const nothing of ['', '  \n', undefined]) {
    assert.match(dataDirInUseNotice(nothing).detail, /`turbollm --stop` stops it/)
  }
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
  settled(dir)
})

test('a daemon refused for its data dir is not respawned: the app is told why, once', async () => {
  const dir = newDir()
  const lost = []
  const launches = countingSpawner(fakeDaemon(dir, '73'))
  const child = supervise({
    spawnDaemon: launches.spawnDaemon,
    onDaemonLost: (reason, details) => lost.push({ reason, details }),
    retryWindowMs: 0 // the app has been up longer than the retry window (the retry: below)
  }).start()
  const exited = once(child, 'exit')

  await waitUntil(() => lost.length === 1, DEADLINE_MS, 'the daemon to be reported lost')
  await exited
  assert.equal(launches.count, 1, 'a refused daemon is never respawned')
  assert.deepEqual(lost, [
    { reason: 'refused: another TurboLLM holds its data dir (exit 73)', details: { dataDirInUse: true, configAccess: false } }
  ])
  settled(dir)
})

test('a daemon that may not read or write its config file is not respawned: the app is told why, once', async () => {
  const dir = newDir()
  const lost = []
  const launches = countingSpawner(fakeDaemon(dir, '77'))
  const child = supervise({
    spawnDaemon: launches.spawnDaemon,
    onDaemonLost: (reason, details) => lost.push({ reason, details })
  }).start()
  const exited = once(child, 'exit')

  await waitUntil(() => lost.length === 1, DEADLINE_MS, 'the daemon to be reported lost')
  await exited
  assert.equal(launches.count, 1, 'a refused daemon is never respawned')
  assert.deepEqual(lost, [
    { reason: 'refused: it may not read or write its config file (exit 77)', details: { dataDirInUse: false, configAccess: true } }
  ])
  settled(dir)
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
  settled(dir)
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
  settled(dir)
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
  settled(dir)
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
  settled(dir)
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

// Quit used to send SIGTERM, a TerminateProcess on Windows (no teardown ran there at all), then SIGKILL after 5 s.
// Now it ends the daemon's stdin, which runs the daemon's own graceful shutdown, and waits for its exit.
test('stop() ends the daemon\'s stdin and resolves at its exit, with no signal', async () => {
  const lost = []
  const launches = fakeLaunches()
  const supervisor = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: (reason) => lost.push(reason), quitGraceMs: 1000 })
  const child = supervisor.start()

  let resolved = false
  const stopped = supervisor.stop().then(() => { resolved = true })
  assert.equal(child.stdinEnded, true, 'its lifeline ends: the daemon shuts down by itself')
  await sleep(20)
  assert.equal(resolved, false, 'stop() waits for the daemon')
  child.exitCode = 0
  child.emit('exit', 0, null)
  await stopped
  assert.deepEqual(child.killCalls, [], 'no signal: the daemon ended by itself')
  assert.deepEqual(lost, [])
  assert.equal(launches.spawned.length, 1)
})

test('stop() kills a daemon still running after the grace: its pid, with SIGKILL', async () => {
  const launches = fakeLaunches()
  const supervisor = supervise({ spawnDaemon: launches.spawnDaemon, onDaemonLost: () => {}, quitGraceMs: 30, platform: 'linux' })
  const child = supervisor.start()

  await supervisor.stop()
  assert.equal(child.stdinEnded, true)
  assert.deepEqual(child.killCalls, ['SIGKILL'], 'child.kill is kill(pid): the daemon alone, never its group')
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

// On Windows kill() is TerminateProcess whatever the signal, and cmake, ninja and cl/nvcc (which break away from the
// daemon's job object) kept compiling after the app quit. A daemon that has not finished its own shutdown within
// the grace has its tree ended while it still links it, then is killed.
test('stop() on Windows ends a daemon still running after the grace with its whole tree first, then kills it', async () => {
  const treeKills = []
  let child = null
  const supervisor = supervise({
    spawnDaemon: fakeLaunches().spawnDaemon,
    onDaemonLost: () => {},
    platform: 'win32',
    quitGraceMs: 30,
    killTreeSync: (pid) => treeKills.push({ pid, killCallsBefore: [...child.killCalls] })
  })
  child = supervisor.start()
  child.pid = 4242

  const stopped = supervisor.stop()
  assert.deepEqual(treeKills, [], 'nothing before the grace: the daemon shuts down by itself first')
  await stopped
  assert.deepEqual(treeKills, [{ pid: 4242, killCallsBefore: [] }])
  assert.deepEqual(child.killCalls, ['SIGKILL'], 'kill() stays the fallback')
})

test('stop() on Windows still kills the daemon when its tree kill throws', async () => {
  const errors = []
  const supervisor = createDaemonSupervisor({
    spawnDaemon: fakeLaunches().spawnDaemon,
    onDaemonLost: () => {},
    log: { log () {}, error (line) { errors.push(line) } },
    platform: 'win32',
    quitGraceMs: 30,
    killTreeSync: () => { throw new Error('spawnSync taskkill ENOENT') }
  })
  supervisors.push(supervisor)
  const child = supervisor.start()
  child.pid = 4242

  await supervisor.stop()
  assert.deepEqual(child.killCalls, ['SIGKILL'])
  assert.deepEqual(errors, ['TurboLLM daemon tree kill failed: spawnSync taskkill ENOENT'])
})

test('stop() kills no tree on Linux/macOS, nor for a daemon that never got a pid', async () => {
  for (const [platform, pid] of [['linux', 4242], ['darwin', 4242], ['win32', undefined]]) {
    const treeKills = []
    const supervisor = supervise({
      spawnDaemon: fakeLaunches().spawnDaemon,
      onDaemonLost: () => {},
      platform,
      quitGraceMs: 10,
      killTreeSync: (p) => treeKills.push(p)
    })
    const child = supervisor.start()
    child.pid = pid

    await supervisor.stop()
    assert.deepEqual(treeKills, [], `${platform}, pid ${pid}`)
    assert.deepEqual(child.killCalls, ['SIGKILL'], `${platform}, pid ${pid}`)
  }
})

// The default tree kill, Windows faked on POSIX with a taskkill stand-in (as build-runner.test.ts does for the build's
// own tree kill; not run on a Windows machine). The stand-in sleeps before it records its arguments, so this also
// catches a kill that does not wait for it: before-quit returns and Electron exits, taking an async taskkill with it.
test('stop() on Windows runs taskkill /PID <pid> /T /F synchronously, before the daemon\'s own kill', POSIX_ONLY, async () => {
  const dir = newDir()
  const binDir = join(dir, 'bin')
  const argsFile = join(dir, 'taskkill-args')
  mkdirSync(binDir)
  writeFileSync(join(binDir, 'taskkill'), `#!/bin/sh\nsleep 0.3\necho "$@" > '${argsFile}'\nkill -9 "$2"\n`, { mode: 0o755 })
  const actualPath = process.env.PATH
  process.env.PATH = `${binDir}${delimiter}${actualPath ?? ''}`
  try {
    // A daemon that does not end with its stdin (a wedged one): the grace runs out.
    const deaf = () => spawn(process.execPath, [FAKE_DAEMON, dir, 'stay', '0'], { stdio: 'ignore', windowsHide: true })
    const supervisor = supervise({ spawnDaemon: deaf, onDaemonLost: () => {}, platform: 'win32', quitGraceMs: 50 })
    const child = supervisor.start()
    await waitUntil(() => readPids(dir).length === 1, DEADLINE_MS, 'the daemon to start')
    const exited = once(child, 'exit')

    await supervisor.stop()
    assert.equal(existsSync(argsFile) && readFileSync(argsFile, 'utf8').trim(), `/PID ${child.pid} /T /F`)
    // Its SIGTERM handler would have exited 75: the tree kill reached it first.
    assert.deepEqual(await exited, [null, 'SIGKILL'])
    settled(dir)
  } finally {
    process.env.PATH = actualPath
  }
})

// spawnSync never throws: a missing taskkill and one that failed came back in its result, and the default tree kill
// dropped them, so the failure was never logged (only an injected tree kill could reach the log).
test('stop() on Windows logs a taskkill that is missing or fails, and still signals the daemon', POSIX_ONLY, async () => {
  const dir = newDir()
  settled(dir) // the fake daemon has a pid but no process
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const actualPath = process.env.PATH
  process.env.PATH = binDir
  try {
    for (const [taskkill, logged] of [
      [null, /^TurboLLM daemon tree kill failed: spawnSync taskkill ENOENT$/],
      ['#!/bin/sh\nexit 1\n', /^TurboLLM daemon tree kill failed: taskkill exited with code 1$/]
    ]) {
      if (taskkill) writeFileSync(join(binDir, 'taskkill'), taskkill, { mode: 0o755 })
      const errors = []
      const supervisor = createDaemonSupervisor({
        spawnDaemon: fakeLaunches().spawnDaemon,
        onDaemonLost: () => {},
        log: { log () {}, error (line) { errors.push(line) } },
        platform: 'win32',
        quitGraceMs: 10
      })
      const child = supervisor.start()
      child.pid = 4242

      await supervisor.stop()
      assert.equal(errors.length, 1, String(taskkill))
      assert.match(errors[0], logged)
      assert.deepEqual(child.killCalls, ['SIGKILL'], 'kill() stays the fallback')
    }
  } finally {
    process.env.PATH = actualPath
  }
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
  settled(dir)
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
    settled(dir)
  }
)

// ── The daemon cannot outlive the app (daemonSpawnSpec), against real processes ────────────────────────────────
// Before, the app spawned the daemon with no tie at all on Linux and macOS: an app that crashed or was killed left
// the daemon, its engines and everything they started running. Now the daemon's stdin is the app's (its lifeline),
// and on POSIX a watcher ends it if it does not finish by itself.

/** Whether `pid` is gone; a zombie counts as gone (it holds nothing, and an init may take seconds to reap it). */
function gone (pid) {
  if (process.platform === 'win32') return !alive(pid)
  const r = require('node:child_process').spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  const state = String(r.stdout || '').trim()
  return state === '' || state.startsWith('Z')
}

/** The live members of process group `pgid` (POSIX). */
function groupMembers (pgid) {
  const r = require('node:child_process').spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  return String(r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => Number(f[1]) === pgid && !String(f[2]).startsWith('Z')).map((f) => Number(f[0]))
}

async function daemonInfo (dir) {
  const file = join(dir, 'daemon.json')
  await waitUntil(() => existsSync(file) && readFileSync(file, 'utf8') !== '', DEADLINE_MS, 'the daemon to start')
  return JSON.parse(readFileSync(file, 'utf8'))
}

function killQuietly (pid) {
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

test('the app\'s daemon is told it is supervised, and its stdin lifeline names the app, its parent', async () => {
  const dir = newDir()
  const spec = daemonSpawnSpec({ platform: process.platform, node: process.execPath, args: [LIFELINE_DAEMON, dir, 'graceful'], cwd: dir, env: process.env, appPid: process.pid })
  const supervisor = supervise({ spawnDaemon: () => spawn(spec.node, spec.args, spec.options), onDaemonLost: () => {} })
  const child = supervisor.start()
  try {
    const info = await daemonInfo(dir)
    assert.equal(info.pid, child.pid, process.platform === 'win32' ? 'node itself' : 'the wrapper execs the daemon in place')
    assert.equal(info.ppid, process.pid)
    assert.equal(info.lifeline, `stdin:${process.pid}`)
    assert.equal(info.desktop, '1')
  } finally {
    await supervisor.stop()
    settled(dir)
  }
})

test('Quit (stop()) ends the daemon by its stdin, gracefully, and leaves nothing: no watcher either', async () => {
  const dir = newDir()
  const spec = daemonSpawnSpec({ platform: process.platform, node: process.execPath, args: [LIFELINE_DAEMON, dir, 'graceful'], cwd: dir, env: process.env, appPid: process.pid })
  const supervisor = supervise({ spawnDaemon: () => spawn(spec.node, spec.args, spec.options), onDaemonLost: () => {}, quitGraceMs: 5000 })
  const child = supervisor.start()
  const { pid } = await daemonInfo(dir)
  const exited = once(child, 'exit')
  await supervisor.stop()
  assert.deepEqual(await exited, [0, null], 'it exited by itself')
  assert.equal(readFileSync(join(dir, 'graceful'), 'utf8'), 'stdin', 'ended by its stdin lifeline')
  if (process.platform !== 'win32') {
    await waitUntil(() => groupMembers(pid).length === 0, DEADLINE_MS, 'the watcher to leave')
  }
  settled(dir)
})

test('an app killed outright (a crash): its daemon shuts down gracefully, by its stdin or its watcher\'s SIGTERM, and is gone within 3 s', async () => {
  const dir = newDir()
  const host = spawn(process.execPath, [SUPERVISOR_HOST, dir, 'lifeline', 'graceful', '15'], { stdio: 'ignore', windowsHide: true })
  let pid = 0
  try {
    pid = (await daemonInfo(dir)).pid
    const watcher = process.platform === 'win32' ? [] : groupMembers(pid).filter((p) => p !== pid)
    if (process.platform !== 'win32') assert.equal(watcher.length, 1, 'one watcher, in the daemon\'s group')
    host.kill('SIGKILL')
    // Windows: Electron's kill-on-close job ends the daemon at once (TerminateProcess, so no marker).
    await waitUntil(() => gone(pid), process.platform === 'win32' ? 1000 : 3000, 'the daemon to be gone')
    if (process.platform !== 'win32') {
      // The app's death ends the daemon's stdin and closes the watcher's fd 3 at once, and the watcher then sends
      // SIGTERM (DAEMON_WRAP): whichever reaches the daemon first runs its graceful shutdown. On a busy machine the
      // SIGTERM often does. A daemon that was SIGKILLed instead leaves no marker.
      assert.match(readFileSync(join(dir, 'graceful'), 'utf8'), /^(stdin|SIGTERM)$/, 'it shut down gracefully')
      await waitUntil(() => watcher.every(gone), 3000, 'the watcher to leave')
    }
    settled(dir)
  } finally {
    host.kill('SIGKILL')
    if (pid) killQuietly(pid)
  }
})

test('a wedged daemon whose app was killed is SIGKILLed after the grace: its pid only, not its group', { skip: process.platform === 'win32' && 'POSIX watcher (DAEMON_WRAP)' }, async () => {
  const dir = newDir()
  const host = spawn(process.execPath, [SUPERVISOR_HOST, dir, 'lifeline', 'wedged', '1'], { stdio: 'ignore' })
  let pid = 0
  let member = 0
  try {
    pid = (await daemonInfo(dir)).pid
    await waitUntil(() => existsSync(join(dir, 'member.pid')) && readFileSync(join(dir, 'member.pid'), 'utf8') !== '', DEADLINE_MS, 'the group member')
    member = Number(readFileSync(join(dir, 'member.pid'), 'utf8'))
    assert.ok(groupMembers(pid).includes(member), 'the member is in the daemon\'s group')
    host.kill('SIGKILL')
    await sleep(500)
    assert.equal(gone(pid), false, 'the watcher\'s SIGTERM is ignored: it waits out the grace')
    await waitUntil(() => gone(pid), 1000 + 3000, 'the wedged daemon to be killed')
    assert.equal(gone(member), false, 'a member of its group (a package manager under sudo) got no SIGKILL from it')
    settled(dir)
  } finally {
    host.kill('SIGKILL')
    if (pid) killQuietly(pid)
    if (member) killQuietly(member)
  }
})

test('DAEMON_WRAP is daemonWrap with the 15 s grace', () => {
  assert.match(DAEMON_WRAP, /\[ \$i -lt 15 \]/)
  assert.match(DAEMON_WRAP, /kill -0 \$\$ 2>\/dev\/null && kill -s KILL \$\$ \)/, 'the pid')
  assert.ok(!DAEMON_WRAP.includes('-- -$$'), 'never the group')
  assert.ok(DAEMON_WRAP.startsWith('set +m; ( ( unset TMOUT; '), 'job control off, then double-forked: the watcher is not the daemon\'s child')
})

test('the app\'s daemon keeps the variables whose names are not shell identifiers, byte for byte, through bash or env, and no carrier reaches it', { skip: process.platform === 'win32' ? 'POSIX launch' : false }, async () => {
  // dash and busybox ash drop these at their exec: npm's per-registry token, a Spring profile, exported bash
  // functions (two named like the watcher's commands: a `read` that fails would end its loop at once, a `kill` that
  // does nothing would leave it waiting out the grace), a quote, a leading dash; one value has quotes, newlines and
  // `$` in it.
  const unnamed = {
    'spring.profiles.active': 'dev',
    'npm_config_//registry.npmjs.org/:_authToken': `a 'b' "c"\n$HOME \`id\` $(id) \\ end\n`,
    'BASH_FUNC_tl_f%%': '() {  echo fn-ran\n}',
    'BASH_FUNC_read%%': '() { return 1; }',
    'BASH_FUNC_kill%%': '() { :; }',
    'it\'s-x': 'quoted',
    '-dash': 'leading dash'
  }
  const wrap = daemonWrap(15, { env: '/usr/bin/env', names: ['a.b', 'it\'s'] })
  assert.match(wrap, /; exec '\/usr\/bin\/env' -u TURBOLLM_TETHER_V0 -u TURBOLLM_TETHER_V1 -- 'a\.b'="\$TURBOLLM_TETHER_V0" 'it'\\''s'="\$TURBOLLM_TETHER_V1" "\$0" \$\{1\+"\$@"\} 3<&-$/)
  assert.equal(daemonWrap(15, { env: '/usr/bin/env', names: [] }), DAEMON_WRAP, 'nothing to carry: DAEMON_WRAP as before')
  // An app started from a desktop session: no SHLVL, so a bash -c whose stdin is a socket (the app's pipes) would
  // take itself for rshd's and run ~/.bashrc; and a BASH_ENV, which only a privileged bash skips.
  const dir = mkdtempSync(join(tmpdir(), 'tllm-desktop-names-'))
  const ran = join(dir, 'ran')
  mkdirSync(join(dir, 'home'))
  writeFileSync(join(dir, 'home', '.bashrc'), `echo bashrc >> '${ran}'\n`)
  writeFileSync(join(dir, 'bash-env'), `echo BASH_ENV >> '${ran}'\n`)
  const env = { ...process.env, ...unnamed, OK_VAR: 'ok', HOME: join(dir, 'home'), BASH_ENV: join(dir, 'bash-env') }
  delete env.SHLVL
  delete env.SHELLOPTS
  delete env.BASHOPTS
  // The daemon prints its environment, then runs on a little: a watcher whose `read` failed at once would SIGTERM it.
  const daemon = ['-e', 'process.stdout.write(JSON.stringify(process.env)); setTimeout(() => {}, 300)']
  for (const bash of [undefined, null]) {
    for (const graceS of [undefined, 1]) {
      const what = `${bash === null ? 'no bash' : 'bash'}, grace ${graceS}`
      const spec = daemonSpawnSpec({ platform: process.platform, node: process.execPath, args: daemon, cwd: tmpdir(), env, appPid: process.pid, graceS, bash })
      const plain = graceS === undefined ? DAEMON_WRAP : daemonWrap(graceS)
      if (bash === null) {
        assert.equal(spec.node, '/bin/sh', what)
      } else {
        // bash passes the names on itself, so its whole argv is its flags, the plain script and the daemon's command.
        assert.match(spec.node, /bash$|\/sh$/, what)
        assert.deepEqual(spec.args, ['--norc', '-p', '-c', plain, process.execPath, ...daemon], what)
      }
      const child = spawn(spec.node, spec.args, spec.options)
      let out = ''
      child.stdout.on('data', (b) => { out += b })
      // As start() does: fd 3 closed at the daemon's exit, so its watcher leaves without a signal.
      child.once('exit', () => child.stdio[3]?.destroy())
      child.stdin.end()
      const [code, signal] = await once(child, 'exit')
      assert.deepEqual({ code, signal }, { code: 0, signal: null }, `${what}: no watcher signalled the daemon`)
      const got = JSON.parse(out)
      for (const [k, v] of Object.entries({ ...unnamed, OK_VAR: 'ok', TURBOLLM_DESKTOP: '1', BASH_ENV: env.BASH_ENV })) assert.equal(got[k], v, `${k} (${what})`)
      assert.deepEqual(Object.keys(got).filter((k) => k.startsWith('TURBOLLM_TETHER_')), [], 'no carrier reaches the daemon')
      await waitUntil(() => groupMembers(child.pid).length === 0, DEADLINE_MS, `the watcher to leave (${what})`)
      assert.equal(existsSync(ran), false, `${what}: neither ~/.bashrc nor BASH_ENV ran`)
    }
  }
  // bash would pass on its own options as SHELLOPTS and BASHOPTS, so an app started with either goes through env.
  const opts = daemonSpawnSpec({ platform: process.platform, node: process.execPath, args: daemon, cwd: tmpdir(), env: { ...env, SHELLOPTS: 'braceexpand' }, appPid: process.pid })
  assert.equal(opts.node, '/bin/sh')
  assert.match(opts.args[1], / -- 'spring\.profiles\.active'="\$TURBOLLM_TETHER_V\d+"/)
  rmSync(dir, { recursive: true, force: true })
})

test('an exported TMOUT ends no desktop daemon, and an interactive shell\'s SHELLOPTS leaves its watcher in its group: under bash --norc -p and bash as /bin/sh', { skip: process.platform === 'win32' ? 'POSIX launch' : false }, async (t) => {
  const bash = require('node:child_process').spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  if (!bash) return t.skip('needs bash')
  const dir = mkdtempSync(join(tmpdir(), 'tllm-desktop-tmout-'))
  // A link named sh runs bash as /bin/sh runs on macOS and Fedora: in POSIX mode, taking options from SHELLOPTS.
  const asSh = join(dir, 'sh')
  symlinkSync(bash, asSh)
  // bash's read takes TMOUT for a timeout; and what `export SHELLOPTS` exports from an interactive bash. None of
  // the runner's own: an exported SHELLOPTS or BASHOPTS would send the first launch through /bin/sh and env.
  const env = { ...process.env, TMOUT: '1' }
  delete env.SHELLOPTS
  delete env.BASHOPTS
  const SHELLOPTS = 'braceexpand:emacs:hashall:histexpand:history:interactive-comments:monitor'
  // The daemon prints its TMOUT, runs 2.5 s, past it, and exits 0 unless a watcher signals it.
  const daemon = ['-e', 'process.stdout.write(String(process.env.TMOUT)); setTimeout(() => {}, 2500)']
  const launches = [
    // A name dash would drop: the script runs under bash --norc -p.
    ['bash --norc -p', daemonSpawnSpec({ platform: process.platform, node: process.execPath, args: daemon, cwd: tmpdir(), env: { ...env, 'spring.profiles.active': 'dev' }, appPid: process.pid, bash })],
    // The plain launch, under bash as /bin/sh.
    ['bash as /bin/sh', { ...daemonSpawnSpec({ platform: process.platform, node: process.execPath, args: daemon, cwd: tmpdir(), env: { ...env, SHELLOPTS }, appPid: process.pid }), node: asSh }]
  ]
  try {
    assert.deepEqual(launches[0][1].args.slice(0, 2), ['--norc', '-p'], 'the first launch is under bash --norc -p')
    for (const [what, spec] of launches) {
      const child = spawn(spec.node, spec.args, spec.options)
      let out = ''
      child.stdout.on('data', (b) => { out += b })
      // As start() does: fd 3 closed at the daemon's exit, so its watcher leaves without a signal.
      child.once('exit', () => child.stdio[3]?.destroy())
      const exited = once(child, 'exit')
      child.stdin.end()
      await sleep(500)
      assert.equal(groupMembers(child.pid).length, 2, `${what}: the daemon and its watcher, in the daemon's group`)
      const [code, signal] = await exited
      assert.deepEqual({ code, signal }, { code: 0, signal: null }, `${what}: no watcher signalled the daemon after TMOUT=1`)
      assert.equal(out, '1', `${what}: the daemon keeps TMOUT`)
      await waitUntil(() => groupMembers(child.pid).length === 0, DEADLINE_MS, `the watcher to leave (${what})`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an exported SHELLOPTS holding nounset: the launch script runs a command with no arguments, under /bin/sh and bash as /bin/sh, through sh and through env', { skip: process.platform === 'win32' ? 'POSIX launch' : false }, async (t) => {
  const bash = require('node:child_process').spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  if (!bash) return t.skip('needs bash')
  const dir = mkdtempSync(join(tmpdir(), 'tllm-desktop-nounset-'))
  // bash as /bin/sh takes `set -u` from SHELLOPTS, and bash 4.0 then took an empty "$@" for an unbound variable (exit
  // 127). The app always passes cli.js; node with no arguments runs its stdin, empty here, and exits 0. bash 3.2 and
  // 4.1 on pass either way; with a bash 4.0 first on PATH this fails without the script's ${1+"$@"}.
  const asSh = join(dir, 'sh')
  symlinkSync(bash, asSh)
  const env = { ...process.env, SHELLOPTS: 'braceexpand:hashall:interactive-comments:nounset' }
  delete env.BASHOPTS
  try {
    for (const sh of ['/bin/sh', asSh]) {
      for (const extra of [{}, { 'spring.profiles.active': 'dev' }]) {
        const what = `${sh === asSh ? 'bash as /bin/sh' : '/bin/sh'}, ${Object.keys(extra).length > 0 ? 'through env' : 'through sh'}`
        const spec = { ...daemonSpawnSpec({ platform: process.platform, node: process.execPath, args: [], cwd: tmpdir(), env: { ...env, ...extra }, appPid: process.pid }), node: sh }
        const child = spawn(spec.node, spec.args, spec.options)
        let err = ''
        child.stderr.on('data', (b) => { err += b })
        child.once('exit', () => child.stdio[3]?.destroy())
        const exited = once(child, 'exit')
        child.stdin.end()
        const [code, signal] = await exited
        assert.deepEqual({ code, signal }, { code: 0, signal: null }, `${what}: the command ran (${err.trim()})`)
        await waitUntil(() => groupMembers(child.pid).length === 0, DEADLINE_MS, `the watcher to leave (${what})`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function supervise (deps) {
  // A 1 s grace unless a test sets its own: after() stops every supervisor, and a fake child never exits.
  const supervisor = createDaemonSupervisor({ log: { log () {}, error () {} }, quitGraceMs: 1000, ...deps })
  supervisors.push(supervisor)
  return supervisor
}

function fakeDaemon (dir, mode, delayMs) {
  // stdin a pipe, as the app gives it (daemonSpawnSpec): stop() ends it, and the fake exits as the daemon does.
  return () => spawn(
    process.execPath,
    [FAKE_DAEMON, dir, mode, String(delayMs ?? 0)],
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, FAKE_DAEMON_STDIN: 'pipe' } }
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
  const child = Object.assign(new EventEmitter(), {
    pid: 0,
    exitCode: null,
    signalCode: null,
    killCalls: [],
    stdinEnded: false,
    kill (signal) {
      this.killCalls.push(signal)
      return true
    }
  })
  child.stdin = Object.assign(new EventEmitter(), { end () { child.stdinEnded = true } })
  return child
}

function newDir () {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-supervisor-'))
  tempDirs.push(dir)
  unsettledDirs.add(dir)
  return dir
}

// A test calls this once it has proved every daemon it recorded is dead. after() then never probes
// those PIDs again: Windows may already have given the number to an unrelated process.
function settled (dir) {
  unsettledDirs.delete(dir)
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
