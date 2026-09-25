// Test-only stand-in for the Electron main process in the Windows job-object test.
//
//   node supervisor-host.js <dir> supervised        run the real supervisor over fake-daemon.js 75;
//                                                   once the respawned daemon has recorded its PID,
//                                                   exit WITHOUT stop() (an Electron crash or kill)
//   node supervisor-host.js <dir> detached-control  spawn one fake daemon detached and unref'd (the
//                                                   shape that used to orphan the daemon), then exit
//
// Exit codes: 0 reached the expected PID count; 3 the supervisor reported the daemon lost; 4 timed out.
const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createDaemonSupervisor } = require('../daemon-supervisor')

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

if (mode === 'detached-control') {
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
