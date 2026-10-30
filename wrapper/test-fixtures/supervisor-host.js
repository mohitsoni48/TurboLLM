// Test-only stand-in for the Electron main process in the Windows job-object test.
//
//   node supervisor-host.js <dir> supervised        run the real supervisor over fake-daemon.js 75;
//                                                   once the respawned daemon has recorded its PID,
//                                                   exit WITHOUT stop() (an Electron crash or kill)
//   node supervisor-host.js <dir> detached-control  spawn one fake daemon detached and unref'd (the
//                                                   shape that used to orphan the daemon), then exit
//
//   node supervisor-host.js <dir> lifeline <daemon mode> <graceS>
//                                                   run the real supervisor over lifeline-daemon.js, launched the
//                                                   way the app launches its daemon (daemonSpawnSpec), and stay
//                                                   until killed (an Electron crash or kill)
//
// Exit codes: 0 reached the expected PID count; 3 the supervisor reported the daemon lost; 4 timed out.
const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createDaemonSupervisor, daemonSpawnSpec } = require('../daemon-supervisor')

const [dir, mode] = process.argv.slice(2)
const fakeDaemon = join(__dirname, 'fake-daemon.js')
const pidsFile = join(dir, 'pids.txt')

function recordedPidCount () {
  if (!existsSync(pidsFile)) return 0
  return readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean).length
}

function exitOnceRecorded (count) {
  const poll = setInterval(() => {
    if (recordedPidCount() >= count) {
      clearInterval(poll)
      process.exit(0)
    }
  }, 50)
  setTimeout(() => process.exit(4), 10_000)
}

if (mode === 'lifeline') {
  const [daemonMode, graceS] = process.argv.slice(4)
  const spec = daemonSpawnSpec({
    platform: process.platform, node: process.execPath, args: [join(__dirname, 'lifeline-daemon.js'), dir, daemonMode],
    cwd: dir, env: process.env, appPid: process.pid, graceS: Number(graceS),
  })
  createDaemonSupervisor({
    spawnDaemon: () => spawn(spec.node, spec.args, { ...spec.options, stdio: spec.options.stdio.map((s, i) => (i === 1 || i === 2 ? 'ignore' : s)) }),
    onDaemonLost: () => {},
    log: { log () {}, error () {} },
  }).start()
  setInterval(() => {}, 1 << 30)
} else if (mode === 'detached-control') {
  spawn(process.execPath, [fakeDaemon, dir, 'stay'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  exitOnceRecorded(1)
} else {
  const supervisor = createDaemonSupervisor({
    spawnDaemon: () => spawn(process.execPath, [fakeDaemon, dir, '75'], { stdio: 'ignore', windowsHide: true }),
    onDaemonLost: () => process.exit(3),
    log: { log () {}, error () {} },
  })
  supervisor.start()
  exitOnceRecorded(2)
}
