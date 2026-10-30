// Test-only stand-in for the desktop daemon behind daemon-supervisor.js daemonSpawnSpec. Binds no port.
//
//   node lifeline-daemon.js <dir> <mode>
//
// Writes <dir>/daemon.json with its pid, its parent's pid and the two variables the app sets. Mode 'graceful':
// when its stdin ends (the app's Quit, or the app's death) or on SIGTERM, it writes <dir>/graceful (what ended it)
// and exits 0 after 300 ms, as the daemon's own shutdown does. Mode 'wedged': it ignores both and never exits
// by itself (a daemon whose event loop is stuck), and starts a child in its own process group (as a package
// manager under sudo stays in the daemon's group) whose pid goes to <dir>/member.pid. Never writes to stdout or
// stderr after its app may have died.
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [dir, mode] = process.argv.slice(2)
writeFileSync(join(dir, 'daemon.json'), JSON.stringify({
  pid: process.pid, ppid: process.ppid, lifeline: process.env.TURBOLLM_LIFELINE, desktop: process.env.TURBOLLM_DESKTOP,
}))
if (mode === 'wedged') {
  process.on('SIGTERM', () => {})
  const member = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore' })
  writeFileSync(join(dir, 'member.pid'), String(member.pid))
} else {
  let ending = false
  const end = (why) => {
    if (ending) return
    ending = true
    writeFileSync(join(dir, 'graceful'), why)
    setTimeout(() => process.exit(0), 300)
  }
  process.stdin.on('end', () => end('stdin'))
  process.stdin.on('error', () => end('stdin'))
  process.stdin.resume()
  process.on('SIGTERM', () => end('SIGTERM'))
}
setInterval(() => {}, 1 << 30)
