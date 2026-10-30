// A stand-in for util/win-job-sentinel.ps1, speaking its line protocol, for the protocol tests that run on every OS
// (util/win-job-sentinel.test.ts). It makes no job: it records every line it is sent, one per line, in the file
// FAKE_SENTINEL_LOG, and answers as FAKE_SENTINEL_* say:
//   FAKE_SENTINEL_READY_MS   wait this long before `ready` (default 0)
//   FAKE_SENTINEL_ADD        ok | gone | refused (default ok); FAKE_SENTINEL_ADD_MS: how long each answer takes
//   FAKE_SENTINEL_IDLE       closed | held (default held), or a comma list answered in turn, the last one repeating;
//                            FAKE_SENTINEL_IDLE_MS: how long each answer takes
//   FAKE_SENTINEL_DIE_ON_ADD exit, without answering, on the first `add` of this run (the file FAKE_SENTINEL_DIED
//                            marks that a run already died, so its restart answers)
//   FAKE_SENTINEL_DIE_ON_IDLE the same, on the first `idle`
//   FAKE_SENTINEL_END        error: answer every `end` as the script answers one that fails
//   FAKE_SENTINEL_REUSE      1: a handle closed (by an idle answered `closed`, or an `end`) is the first one handed out
//                            again, as the daemon's handle table reuses a freed slot, and an `end` SIGKILLs the child
//                            that handle names at that moment, as TerminateJobObject ends that job's tree
// Handles are numbered from 1000, per run.
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')

const env = process.env
const log = (line) => appendFileSync(env.FAKE_SENTINEL_LOG, `${line}\n`)
const say = (line) => process.stdout.write(`${line}\n`)
let handle = 1000
let buf = ''
let idles = 0
/** FAKE_SENTINEL_REUSE: closed handles, the next one out first, and the pid each open handle names. */
const free = []
const pidOf = new Map()
const release = (h) => {
  if (!env.FAKE_SENTINEL_REUSE || !pidOf.has(h)) return
  pidOf.delete(h)
  free.unshift(h)
}
setTimeout(() => say('ready'), Number(env.FAKE_SENTINEL_READY_MS || 0))
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    log(line)
    const f = line.split(' ')
    if (f[0] === 'add') {
      if (env.FAKE_SENTINEL_DIE_ON_ADD && env.FAKE_SENTINEL_DIED && !existsSync(env.FAKE_SENTINEL_DIED)) {
        writeFileSync(env.FAKE_SENTINEL_DIED, 'died')
        process.exit(9)
      }
      const h = env.FAKE_SENTINEL_REUSE && free.length > 0 ? free.shift() : handle++
      if (env.FAKE_SENTINEL_REUSE) pidOf.set(h, Number(f[2]))
      const kind = env.FAKE_SENTINEL_ADD || 'ok'
      const reply = kind === 'ok' ? `ok ${f[1]} ${h} 1` : kind === 'gone' ? `gone ${f[1]}` : `refused ${f[1]} its parent is 4, not the daemon`
      setTimeout(() => say(reply), Number(env.FAKE_SENTINEL_ADD_MS || 0))
    } else if (f[0] === 'idle') {
      if (env.FAKE_SENTINEL_DIE_ON_IDLE && env.FAKE_SENTINEL_DIED && !existsSync(env.FAKE_SENTINEL_DIED)) {
        writeFileSync(env.FAKE_SENTINEL_DIED, 'died')
        process.exit(9)
      }
      const answers = (env.FAKE_SENTINEL_IDLE || 'held').split(',')
      const answer = answers[Math.min(idles++, answers.length - 1)]
      if (answer === 'closed') release(Number(f[2]))
      const reply = answer === 'closed' ? `closed ${f[1]}` : `held ${f[1]} 1`
      setTimeout(() => say(reply), Number(env.FAKE_SENTINEL_IDLE_MS || 0))
    } else if (f[0] === 'end' && env.FAKE_SENTINEL_END === 'error') {
      say(`error end ${f[1]} cannot reach handle ${f[1]}, error 6`)
    } else if (f[0] === 'end' && env.FAKE_SENTINEL_REUSE && pidOf.has(Number(f[1]))) {
      try {
        process.kill(pidOf.get(Number(f[1])), 'SIGKILL')
      } catch {
        /* already gone */
      }
      release(Number(f[1]))
    }
  }
})
process.stdin.on('end', () => process.exit(0))
