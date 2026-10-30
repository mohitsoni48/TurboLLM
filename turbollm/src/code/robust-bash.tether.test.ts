// A Code agent's bash command is tethered and held per Code session (util/tether.ts): what it leaves running in
// the background keeps running after the command returns, until the session is closed (releaseTetherScope) or the
// daemon ends, however it ends. Before, a background job was cut loose: a SIGKILLed daemon left it running,
// parented to init, and even a graceful stop never ended it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { createRobustBashOperations } from './robust-bash'
import { withForegroundGitGc } from '../util/git-gc'
import { releaseTetherScope } from '../util/tether'
import { groupMembers, isGone, killRecorded, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'POSIX process groups (Windows ties these through its job sentinel)' : false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(command: string, sessionId: string, opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}) {
  const ops = createRobustBashOperations({ sessionLabel: sessionId, sessionId })
  let out = ''
  const t0 = Date.now()
  const { exitCode } = await ops.exec(command, tmpDir('tllm-bash-cwd-'), {
    onData: (d: Buffer) => { out += d.toString() },
    signal: opts.signal,
    env: opts.env,
  })
  return { exitCode, out, ms: Date.now() - t0 }
}

test('a background job outlives its command, ends with its own session\'s release, and with a SIGKILLed daemon', { skip }, async () => {
  const d = await startStandInDaemon(`
import { createRobustBashOperations } from ${srcUrl('code/robust-bash.ts')}
import { releaseTetherScope } from ${srcUrl('util/tether.ts')}
const run = async (command: string, sessionId: string) => {
  const ops = createRobustBashOperations({ sessionLabel: sessionId, sessionId })
  let out = ''
  const t0 = Date.now()
  const r = await ops.exec(command, process.cwd(), { onData: (b: Buffer) => { out += b.toString() } })
  return { out, exitCode: r.exitCode, ms: Date.now() - t0 }
}
const s1 = await run('sleep 300 & echo $!; echo ok', 's1')
const s2 = await run('nohup sleep 301 >/dev/null 2>&1 & echo $!', 's2')
report({ s1, s2 })
process.stdin.once('data', async () => {
  await releaseTetherScope('code-session:s1')
  report({ released: true })
})
setInterval(() => {}, 1e9)
`)
  try {
    const { s1, s2 } = await d.next<{ s1: { out: string; exitCode: number; ms: number }; s2: { out: string; ms: number } }>()
    const [job1, ok] = s1.out.trim().split('\n')
    const job2 = Number(s2.out.trim())
    record(Number(job1), job2)
    assert.equal(ok, 'ok')
    assert.equal(s1.exitCode, 0)
    assert.ok(s1.ms < 1000 && s2.ms < 1000, `the commands returned at once (${s1.ms} ms, ${s2.ms} ms)`)
    await sleep(200)
    assert.equal(isGone(Number(job1)), false, 's1\'s job outlives its command')
    assert.equal(isGone(job2), false, 's2\'s nohup job too')
    d.child.stdin?.write('release s1\n')
    await d.next()
    assert.deepEqual(await waitGone([Number(job1)], 1000), [], 'released with session s1')
    assert.equal(isGone(job2), false, 'another session\'s job lives on')
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([job2], 1000), [], 'and goes with the daemon')
  } finally {
    killRecorded(d.pid)
  }
})

test('a command that left nothing running leaves no process behind', { skip }, async () => {
  try {
    const { out } = await run('echo $$', 'plain')
    const shell = Number(out.trim())
    record(shell)
    const deadline = Date.now() + 1000
    while (groupMembers(shell).length > 0 && Date.now() < deadline) await sleep(20)
    assert.deepEqual(groupMembers(shell), [], 'its group (shell and watcher) is empty')
  } finally {
    killRecorded()
  }
})

test('Stop kills the command\'s background job too', { skip }, async () => {
  const ac = new AbortController()
  let job = 0
  try {
    const ops = createRobustBashOperations({ sessionLabel: 'stop', sessionId: 'stop' })
    let out = ''
    const exec = ops.exec('sleep 300 & echo $!; wait', tmpDir('tllm-bash-stop-'), {
      onData: (b: Buffer) => {
        out += b.toString()
        if (!job && out.includes('\n')) {
          job = Number(out.trim())
          record(job)
          ac.abort()
        }
      },
      signal: ac.signal,
    })
    await assert.rejects(exec, /aborted/)
    assert.ok(job > 0)
    assert.deepEqual(await waitGone([job], 2000), [])
  } finally {
    await releaseTetherScope('code-session:stop')
    killRecorded()
  }
})

// Stop or the timeout can come after the command's shell has exited: a job it left that still writes to its output
// keeps the command waiting, for as long as it writes at least every 100 ms (this one writes every 20 ms). Node has
// reaped the shell by then, so its pid may name another process. Every signal sent to that pid from then on is
// recorded and not sent, and its probe answers "alive", as a process that got the number would. Before, the kill went
// on with the pid: its probe, the escalation's bare SIGKILL 0.8 s later, and the group kill's bare-pid fallback once
// the group had ended.
//
// The window after the exit is the case's own here: 1 s (POST_EXIT_GRACE_MS), and the Stop or the timeout comes more
// than that after the exit, so only the job's writing keeps the command waiting until then, as in the daemon. With
// the daemon's 100 ms, CI's loaded macOS runner let more than 100 ms pass between two of the job's lines (a `sleep
// 0.02` per line, and perl's 20 ms select alike), the command settled before the Stop or the timeout came, and none
// of what the case checks ran: Stop found nothing to stop, and the setsid job, its output closed, died of SIGPIPE at
// its next line. When the command settles early, the message gives the job's longest silence after the exit, the
// one that ended at the settling included: no line marks its end, as finalize() removes the listeners then.
const perl = spawnSync('perl', ['-MPOSIX', '-e', '1']).status === 0
const POST_EXIT_GRACE_MS = 1000
for (const c of [
  { end: 'abort', job: 'in its group' },
  { end: 'timeout', job: 'in its group' },
  { end: 'abort', job: 'in a session of its own (setsid)' },
] as const) {
  const escaped = c.job !== 'in its group'
  const session = `post-exit-${c.end}${escaped ? '-setsid' : ''}`
  test(`${c.end === 'abort' ? 'Stop' : 'the timeout'} after the shell has exited, its job ${c.job} still writing: nothing is sent to the shell's pid${escaped ? '' : ', and the job\'s group is killed'}`, { skip: skip || (escaped && !perl && 'needs perl') }, async () => {
    const loop = escaped
      ? `perl -MPOSIX -e 'setsid(); $| = 1; while (1) { print "tick\\n"; select(undef, undef, undef, 0.02) }'`
      : 'while :; do echo tick; sleep 0.02; done'
    const realKill = process.kill.bind(process)
    let shell = 0
    let job = 0
    let reaped = false
    const toShell: Array<[number, string | number | undefined]> = []
    const groupKills: Array<[number, string | number | undefined]> = []
    process.kill = ((pid: number, sig?: string | number) => {
      if (reaped && pid === shell) {
        toShell.push([pid, sig])
        return true
      }
      if (reaped && pid === -shell) groupKills.push([pid, sig])
      return realKill(pid, sig)
    }) as typeof process.kill
    const ac = new AbortController()
    let exitSeen = false
    let lastLineAt = 0
    let longestSilence = 0
    let settledAt = 0
    try {
      const ops = createRobustBashOperations({ sessionLabel: session, sessionId: session, exitStdioGraceMs: POST_EXIT_GRACE_MS })
      let out = ''
      const exec = ops.exec(`echo shell:$$; ${escaped ? loop : `(${loop})`} & echo job:$!; ${escaped ? 'sleep 0.3; ' : ''}exit 0`, tmpDir('tllm-bash-post-exit-'), {
        onData: (b: Buffer) => {
          const now = Date.now()
          if (exitSeen) longestSilence = Math.max(longestSilence, now - lastLineAt)
          lastLineAt = now
          if (job) return
          out += b.toString()
          shell ||= Number(/shell:(\d+)/.exec(out)?.[1] ?? 0)
          job ||= Number(/job:(\d+)/.exec(out)?.[1] ?? 0)
          if (job) record(job)
        },
        signal: c.end === 'abort' ? ac.signal : undefined,
        timeout: c.end === 'timeout' ? 3 : undefined,
      })
      let settled = false
      const outcome = exec.then(() => 'resolved', (e: Error) => e.message).finally(() => { settled = true; settledAt = Date.now() })
      const silence = () => `the job's longest silence from the shell's exit until the command settled, as seen here: ${
        Math.max(longestSilence, (settledAt || Date.now()) - lastLineAt)} ms`
      const deadline = Date.now() + 3000
      while (!(shell && job) && Date.now() < deadline) await sleep(10)
      assert.ok(shell > 0 && job > 0, `the command printed its pids (${JSON.stringify(out.slice(0, 200))})`)
      for (;;) {
        try {
          realKill(shell, 0)
        } catch {
          exitSeen = true
          break // Node has reaped the shell
        }
        assert.ok(Date.now() < deadline, 'the shell exits')
        await sleep(10)
      }
      await sleep(50)
      reaped = true
      const reapedAt = Date.now()
      if (escaped) {
        while (groupMembers(shell).length > 0 && Date.now() < deadline) await sleep(20)
        assert.deepEqual(groupMembers(shell), [], 'the shell\'s group has ended (its watcher let go)')
      }
      assert.equal(settled, false, `the job keeps the command waiting (${silence()})`)
      if (c.end === 'abort') {
        await sleep(Math.max(0, reapedAt + POST_EXIT_GRACE_MS + 500 - Date.now()))
        assert.equal(settled, false, `the job's writing keeps the command waiting past the window after the exit (${silence()})`)
        ac.abort()
      }
      if (escaped) {
        await sleep(1500) // the escalation's bare SIGKILL came 0.8 s in
        assert.equal(isGone(job), false, 'nothing reaches a job that left the group')
        realKill(job, 'SIGKILL')
      }
      assert.equal(await outcome, c.end === 'abort' ? 'aborted' : 'timeout:3', silence())
      if (!escaped) {
        assert.deepEqual(await waitGone([job], 2000), [], 'the job went with its group')
        await sleep(1200) // the escalation's bare SIGKILL came 0.8 s in
        assert.deepEqual(groupKills, [[-shell, 'SIGKILL']], 'the group, which its watcher pinned')
      }
      assert.deepEqual(toShell, [], 'nothing was sent to the reaped shell\'s pid')
    } finally {
      process.kill = realKill
      await releaseTetherScope(`code-session:${session}`)
      killRecorded()
    }
  })
}

test('a command\'s env runs git\'s automatic gc in the foreground, after any GIT_CONFIG_COUNT entries it had', { skip }, async () => {
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Someone' }
  const { out } = await run('env | grep "^GIT_CONFIG_" | sort', 'gc-env', { env })
  assert.deepEqual(out.trim().split('\n'), [
    'GIT_CONFIG_COUNT=3',
    'GIT_CONFIG_KEY_0=user.name',
    'GIT_CONFIG_KEY_1=gc.autoDetach',
    'GIT_CONFIG_KEY_2=maintenance.autoDetach',
    'GIT_CONFIG_VALUE_0=Someone',
    'GIT_CONFIG_VALUE_1=false',
    'GIT_CONFIG_VALUE_2=false',
  ])
  assert.equal(withForegroundGitGc({}).GIT_CONFIG_COUNT, '2', 'no entries before: they are 0 and 1')
  assert.equal(withForegroundGitGc({}).GIT_CONFIG_KEY_0, 'gc.autoDetach')
})
