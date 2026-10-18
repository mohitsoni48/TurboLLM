// daemon-supervisor.test.js — plain `node --test`, Node built-ins only (ADR-442).
const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, join } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')

const {
  RESTART_REQUESTED_EXIT_CODE,
  DATA_DIR_IN_USE_EXIT_CODE,
  CONFIG_ACCESS_EXIT_CODE,
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
    onDaemonLost: (reason, details) => lost.push({ reason, details })
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

// On Windows kill() is TerminateProcess whatever the signal: the daemon's SIGTERM and 'exit' handlers never ran, so
// neither did the one that ends a running build's compiler tree, and cmake, ninja and cl/nvcc (which break away from
// the daemon's job object) kept compiling after the app quit. The tree must be ended while the daemon still links it.
test('stop() on Windows ends the daemon\'s whole tree before it signals the daemon', () => {
  const treeKills = []
  let child = null
  const supervisor = supervise({
    spawnDaemon: fakeLaunches().spawnDaemon,
    onDaemonLost: () => {},
    platform: 'win32',
    killTreeSync: (pid) => treeKills.push({ pid, killCallsBefore: [...child.killCalls] })
  })
  child = supervisor.start()
  child.pid = 4242

  supervisor.stop()
  assert.deepEqual(treeKills, [{ pid: 4242, killCallsBefore: [] }])
  assert.deepEqual(child.killCalls, ['SIGTERM'], 'kill() stays the fallback')
})

test('stop() on Windows still signals the daemon when its tree kill throws', () => {
  const errors = []
  const supervisor = createDaemonSupervisor({
    spawnDaemon: fakeLaunches().spawnDaemon,
    onDaemonLost: () => {},
    log: { log () {}, error (line) { errors.push(line) } },
    platform: 'win32',
    killTreeSync: () => { throw new Error('spawnSync taskkill ENOENT') }
  })
  supervisors.push(supervisor)
  const child = supervisor.start()
  child.pid = 4242

  assert.doesNotThrow(() => supervisor.stop())
  assert.deepEqual(child.killCalls, ['SIGTERM'])
  assert.deepEqual(errors, ['TurboLLM daemon tree kill failed: spawnSync taskkill ENOENT'])
})

test('stop() kills no tree on Linux/macOS, nor for a daemon that never got a pid', () => {
  for (const [platform, pid] of [['linux', 4242], ['darwin', 4242], ['win32', undefined]]) {
    const treeKills = []
    const supervisor = supervise({
      spawnDaemon: fakeLaunches().spawnDaemon,
      onDaemonLost: () => {},
      platform,
      killTreeSync: (p) => treeKills.push(p)
    })
    const child = supervisor.start()
    child.pid = pid

    supervisor.stop()
    assert.deepEqual(treeKills, [], `${platform}, pid ${pid}`)
    assert.deepEqual(child.killCalls, ['SIGTERM'], `${platform}, pid ${pid}`)
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
    const supervisor = supervise({ spawnDaemon: fakeDaemon(dir, 'stay'), onDaemonLost: () => {}, platform: 'win32' })
    const child = supervisor.start()
    await waitUntil(() => readPids(dir).length === 1, DEADLINE_MS, 'the daemon to start')
    const exited = once(child, 'exit')

    supervisor.stop()
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
test('stop() on Windows logs a taskkill that is missing or fails, and still signals the daemon', POSIX_ONLY, () => {
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
        platform: 'win32'
      })
      const child = supervisor.start()
      child.pid = 4242

      supervisor.stop()
      assert.equal(errors.length, 1, String(taskkill))
      assert.match(errors[0], logged)
      assert.deepEqual(child.killCalls, ['SIGTERM'], 'kill() stays the fallback')
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
