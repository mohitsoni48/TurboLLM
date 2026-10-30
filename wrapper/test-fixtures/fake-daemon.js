// Test-only stand-in for the TurboLLM daemon. Binds no port and writes only <dir>/pids.txt.
//
//   node fake-daemon.js <dir> <mode> [delayMs]
//
// Appends its PID to <dir>/pids.txt (one per line). If it is the FIRST PID in that file and
// <mode> is an exit code ('75', '1', ...), it exits with that code after delayMs (default 0);
// every later instance, and every instance in mode 'stay', stays alive until killed. On
// SIGTERM, or when its stdin ends (the app's Quit ends the daemon's stdin, its lifeline), it exits
// 75, like a daemon already finishing a restart teardown (SIGTERM is POSIX only: on Windows kill()
// terminates the process without running handlers).
const { appendFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const [dir, mode, delayMs] = process.argv.slice(2)
const pidsFile = join(dir, 'pids.txt')

process.on('SIGTERM', () => process.exit(75))
// Only a stdin the app holds (a pipe): with 'ignore' it is /dev/null, which ends at once.
if (!process.stdin.isTTY && process.env.FAKE_DAEMON_STDIN === 'pipe') {
  process.stdin.on('end', () => process.exit(75))
  process.stdin.resume()
}

appendFileSync(pidsFile, `${process.pid}\n`)
const instance = readFileSync(pidsFile, 'utf8').trim().split('\n').length

if (mode !== 'stay' && instance === 1) {
  setTimeout(() => process.exit(Number(mode)), Number(delayMs || 0))
}
setInterval(() => {}, 1 << 30)
