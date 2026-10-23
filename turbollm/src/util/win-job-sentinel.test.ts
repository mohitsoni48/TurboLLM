// The Windows job sentinel's protocol, as util/tether.ts speaks it, against a stand-in sentinel (a node script that
// makes no job: test-support/fake-job-sentinel.cjs), so it runs on every OS with the tether acting as on Windows
// (_setTetherPlatform). Before, nothing tied a Windows child's own children to the daemon: libuv's job allows
// breakaway, and Git for Windows breaks every child it creates away from such a job, so a Git Bash command's
// children, a build's compiler tree and a Code terminal's programs outlived a killed daemon. What the real sentinel
// does on Windows (its jobs, its guard, its sweep) runs on windows-latest only, at the end of this file.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { JobSentinel, sentinelScriptPath } from './win-job-sentinel'
import {
  _setTetherPlatform, closeAllLifelines, killTetheredTree, recountHeld, releaseTetherScope, setJobSentinel, spawnHeld,
  spawnTethered, stopTethered, tetherTerminal,
} from './tether'
import { createRobustBashOperations } from '../code/robust-bash'
import { isGone, killRecorded, pidWrittenTo, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const FAKE = fileURLToPath(new URL('../test-support/fake-job-sentinel.cjs', import.meta.url))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`)
    await sleep(20)
  }
}

/** A stand-in sentinel, tied in as the tether's, with the tether acting as on Windows. `received()`: every line it
 *  was sent; `logs`: what the daemon logged about it. */
function useFakeSentinel(env: Record<string, string> = {}) {
  const dir = tmpDir('tllm-fake-sentinel-')
  const logFile = join(dir, 'received.log')
  const logs: string[] = []
  const s = new JobSentinel({
    command: process.execPath,
    args: [FAKE],
    env: { ...process.env, FAKE_SENTINEL_LOG: logFile, FAKE_SENTINEL_DIED: join(dir, 'died'), ...env },
    log: (line) => logs.push(line),
    restartDelaysMs: [50],
  }).start()
  _setTetherPlatform('win32')
  setJobSentinel(s)
  const received = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [])
  return {
    s,
    logs,
    received,
    count: (line: string) => received().filter((l) => l === line).length,
    async done() {
      await stopTethered(200, { platform: 'win32', treeKill: () => { /* the tests' children are killed by pid */ } })
      setJobSentinel(null)
      s.stop()
      _setTetherPlatform(null)
      killRecorded()
    },
  }
}

const node = (code: string) => [process.execPath, ['-e', code]] as const

test('an answer that comes before the exit is kept: the job is ended at the exit, and only once', async () => {
  const f = useFakeSentinel()
  try {
    const [cmd, args] = node('setTimeout(() => {}, 400)')
    const before = Date.now()
    const child = spawnTethered(cmd, args, { stdio: 'ignore' }, { kind: 'probe' })
    const after = Date.now()
    record(child.pid)
    await waitFor(() => f.received().some((l) => l.startsWith('add ')), 5000, 'the add')
    const [, , pid, start, end] = (f.received().find((l) => l.startsWith('add ')) as string).split(' ')
    assert.equal(Number(pid), child.pid)
    assert.ok(Number(start) >= before && Number(start) <= Number(end) && Number(end) <= after, 'the window around the spawn() call')
    await sleep(100)
    assert.equal(f.count('end 1000'), 0, 'nothing is ended while it runs')
    await once(child, 'exit')
    await waitFor(() => f.count('end 1000') === 1, 5000, 'its job ended at its exit')
    killTetheredTree(child, 'SIGKILL') // after the exit: the handle was given back already
    await stopTethered(100, { platform: 'win32', treeKill: () => {} })
    await sleep(100)
    assert.equal(f.count('end 1000'), 1, 'a handle is ended once')
  } finally {
    await f.done()
  }
})

test('an answer after the exit is acted on as the exit was: a probe\'s job is ended, never dropped', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_ADD_MS: '400' })
  try {
    const [cmd, args] = node('')
    const child = spawnTethered(cmd, args, { stdio: 'ignore' }, { kind: 'probe' })
    await once(child, 'exit')
    assert.equal(f.count('end 1000'), 0)
    await waitFor(() => f.count('end 1000') === 1, 5000, 'the late answer ends the job')
  } finally {
    await f.done()
  }
})

test('an answer after the exit of a held command asks whether anything is left: held until its scope is released', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_ADD_MS: '300', FAKE_SENTINEL_IDLE: 'held' })
  try {
    const [cmd, args] = node('')
    const { child, tied } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:late' })
    await once(child, 'exit')
    await tied
    await waitFor(() => f.received().some((l) => /^idle \d+ 1000$/.test(l)), 5000, 'the idle')
    await sleep(100)
    assert.equal(f.count('end 1000'), 0, 'something is left: held')
    await releaseTetherScope('code-session:late')
    assert.equal(f.count('end 1000'), 1, 'the release ends it')
  } finally {
    await f.done()
  }
})

test('a held command\'s job with nothing left is closed by the sentinel, and not ended again', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_IDLE: 'closed' })
  try {
    const [cmd, args] = node('')
    const { child } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:empty' })
    await once(child, 'exit')
    await waitFor(() => f.received().some((l) => /^idle \d+ 1000$/.test(l)), 5000, 'the idle')
    await releaseTetherScope('code-session:empty')
    await sleep(100)
    assert.equal(f.count('end 1000'), 0, 'the closed handle is never given back twice')
  } finally {
    await f.done()
  }
})

// An `idle` that finds its job empty closes the handle in the daemon, and the daemon's handle table hands a closed value
// out again, so the next child added can get the same one. An `end` sent while that idle was unanswered (an archive's
// release, the shutdown, the keeper, all in the 60 s re-count's round trip) then reached the sentinel behind the idle
// and the add, passed its is-a-job check and killed that other child's tree. The stand-in here gives a closed handle
// out again first and SIGKILLs the child a handle names at an `end`, as TerminateJobObject would.
test('an end asked for while an idle is unanswered waits for its answer: an idle that closed the job sends no end, and the child given its handle runs on', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_REUSE: '1', FAKE_SENTINEL_IDLE: 'held,closed' })
  try {
    const [cmd, args] = node('')
    const { child } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:reuse' })
    await once(child, 'exit')
    await waitFor(() => f.received().some((l) => /^idle \d+ 1000$/.test(l)), 5000, 'the exit\'s idle')
    await sleep(100) // answered `held`: the job is held in its scope
    // One tick: the re-count's idle (answered `closed`, which frees 1000), an unrelated child's add (it gets 1000
    // again), and the session's release.
    const recount = recountHeld()
    const [cmd2, args2] = node('setTimeout(() => {}, 1500)')
    const other = spawnTethered(cmd2, args2, { stdio: 'ignore' }, { kind: 'probe' })
    record(other.pid)
    await releaseTetherScope('code-session:reuse')
    assert.equal(await recount, 1, 'the re-count closed the empty job')
    await waitFor(() => f.received().filter((l) => l.startsWith('add ')).length === 2, 5000, 'the other child\'s add')
    await sleep(200)
    assert.deepEqual(f.received().filter((l) => l.startsWith('end ')), [], 'no end for the job the idle closed')
    assert.equal(other.exitCode, null, 'the child given the closed handle\'s value runs on')
    assert.equal(other.signalCode, null)
    const [code, signal] = await once(other, 'exit')
    assert.deepEqual([code, signal], [0, null], 'and ends by itself')
    await waitFor(() => f.count('end 1000') === 1, 5000, 'its own exit ends its job, once')
  } finally {
    await f.done()
  }
})

test('an end asked for while an idle is unanswered is sent once the idle says the job is held, before the release resolves', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_IDLE: 'held', FAKE_SENTINEL_IDLE_MS: '400' })
  try {
    const [cmd, args] = node('')
    const { child } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:inflight' })
    await once(child, 'exit')
    await waitFor(() => f.received().some((l) => /^idle \d+ 1000$/.test(l)), 5000, 'the exit\'s idle')
    await sleep(500) // answered `held`
    const recount = recountHeld()
    await releaseTetherScope('code-session:inflight')
    const lines = f.received()
    assert.equal(lines.filter((l) => l === 'end 1000').length, 1, 'ended once')
    assert.ok(lines.lastIndexOf('end 1000') > lines.findLastIndex((l) => /^idle \d+ 1000$/.test(l)), 'after the idle')
    assert.equal(await recount, 0)
  } finally {
    await f.done()
  }
})

test('the restart keeper lets an idle in flight be answered before it stops the sentinel: a held job is still ended', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_IDLE: 'held' })
  try {
    const [cmd, args] = node('')
    const { child } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:keeper' })
    await once(child, 'exit')
    await waitFor(() => f.received().some((l) => /^idle \d+ 1000$/.test(l)), 5000, 'the exit\'s idle')
    await sleep(100)
    const sentinelPid = f.s.pid() as number
    void recountHeld()
    closeAllLifelines()
    await waitFor(() => f.count('end 1000') === 1, 5000, 'the held job ended at the idle\'s answer')
    await waitFor(() => isGone(sentinelPid), 5000, 'then the sentinel stops')
  } finally {
    await f.done()
  }
})

test('refused and gone leave the child untied: a refusal is logged, and nothing more is sent for either', async () => {
  for (const kind of ['refused', 'gone']) {
    const f = useFakeSentinel({ FAKE_SENTINEL_ADD: kind })
    const warn = console.warn
    const warned: string[] = []
    console.warn = (line: string) => { warned.push(String(line)) }
    try {
      const [cmd, args] = node('setTimeout(() => {}, 200)')
      const child = spawnTethered(cmd, args, { stdio: 'ignore' }, { kind: 'probe' })
      await waitFor(() => f.received().length > 0, 5000, 'the add')
      await once(child, 'exit')
      await sleep(200)
      assert.deepEqual(f.received().filter((l) => !l.startsWith('add ')), [], `${kind}: no end, no idle`)
      if (kind === 'refused') assert.ok(warned.some((l) => /the windows job sentinel refused pid \d+ \(its parent is 4, not the daemon\)/.test(l)), warned.join('\n'))
      else assert.deepEqual(warned, [])
    } finally {
      console.warn = warn
      await f.done()
    }
  }
})

test('a sentinel that dies is restarted, the add it had not answered is sent again, and its jobs are still ended', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_DIE_ON_ADD: '1' })
  try {
    const [cmd, args] = node('setTimeout(() => {}, 600)')
    const child = spawnTethered(cmd, args, { stdio: 'ignore' }, { kind: 'probe' })
    record(child.pid)
    await waitFor(() => f.received().filter((l) => l.startsWith('add ')).length === 2, 5000, 'the add sent again to the restarted sentinel')
    const adds = f.received().filter((l) => l.startsWith('add '))
    assert.equal(adds[0], adds[1], 'the same request')
    assert.ok(f.logs.some((l) => /windows job sentinel it exited \(9\); restarting it \(1\/1\)/.test(l)), f.logs.join('\n'))
    await once(child, 'exit')
    await waitFor(() => f.count('end 1000') === 1, 5000, 'its job ended at its exit')
  } finally {
    await f.done()
  }
})

// An idle the dead sentinel had been sent may have closed its job's handle before it died, and a handle value closed is
// given out again (the restarted stand-in numbers its handles from 1000 again, as the daemon may reuse one): sent
// again, that idle could close another job of the daemon's. It is answered `lost` instead, and the handle is never
// used again; what is left in that job ends with the daemon.
test('a sentinel that dies before it answers a held command\'s idle does not get it again: that job is never used again', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_DIE_ON_IDLE: '1', FAKE_SENTINEL_IDLE: 'closed' })
  const warn = console.warn
  const warned: string[] = []
  console.warn = (line: string) => { warned.push(String(line)) }
  try {
    const [cmd, args] = node('')
    const { child } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:lost' })
    await once(child, 'exit')
    await waitFor(() => f.logs.some((l) => /it exited \(9\); restarting it \(1\/1\)/.test(l)), 5000, 'the sentinel died on the idle and restarts')
    // The restarted sentinel answers: a running child gets handle 1000 there, the value the dead one had given.
    const [cmd2, args2] = node('setTimeout(() => {}, 5000)')
    const running = spawnTethered(cmd2, args2, { stdio: 'ignore' }, { kind: 'probe' })
    record(running.pid)
    await waitFor(() => f.received().filter((l) => l.startsWith('add ')).length === 2, 5000, 'the restarted sentinel\'s add')
    await sleep(200)
    assert.equal(f.received().filter((l) => l.startsWith('idle ')).length, 1, 'the idle is not sent again')
    await releaseTetherScope('code-session:lost')
    await sleep(100)
    assert.deepEqual(f.received().filter((l) => l.startsWith('end ')), [], 'nor is an end on the lost handle, at the release')
    assert.ok(warned.some((l) => /the windows job sentinel died before it said whether pid \d+'s job is empty/.test(l)), warned.join('\n'))
  } finally {
    console.warn = warn
    await f.done()
  }
})

// An `end` has no request id: the script answered a failed one `error <handle> …`, which was read as the answer to
// the pending request whose id had that value (an add then logged as refused, an idle taken as held). It now answers
// `error end <handle> …` (the real script's own answer is checked on Windows, below), which is logged, and the
// request whose id has the handle's value, pending meanwhile, gets its own answer: here the second request, id 2,
// answered 300 ms after an `end 2` fails.
test('a failed end is logged, and answers no pending request', async () => {
  const logs: string[] = []
  const s = new JobSentinel({
    command: process.execPath,
    args: [FAKE],
    env: { ...process.env, FAKE_SENTINEL_LOG: join(tmpDir('tllm-fake-sentinel-'), 'received.log'), FAKE_SENTINEL_END: 'error', FAKE_SENTINEL_ADD_MS: '300' },
    log: (line) => logs.push(line),
  }).start()
  try {
    assert.equal((await s.add(process.pid, 0, 0)).kind, 'ok', 'the first request (id 1), once the sentinel is ready')
    const second = s.add(process.pid, 0, 0)
    assert.equal(s.end('2'), true)
    await waitFor(() => logs.includes('[tether] windows job sentinel could not end job 2: cannot reach handle 2, error 6'), 5000, logs.join('\n'))
    assert.deepEqual(await second, { kind: 'ok', handle: '1001', members: 1 }, 'the request with id 2 got its own answer')
  } finally {
    s.stop()
  }
})

test('with no sentinel (no PowerShell) one line is logged, a held spawn is tied at once, and stops fall back to taskkill', async () => {
  const logs: string[] = []
  const s = new JobSentinel({ command: join(tmpDir('tllm-no-ps-'), 'powershell.exe'), log: (line) => logs.push(line) }).start()
  _setTetherPlatform('win32')
  setJobSentinel(s)
  try {
    await waitFor(() => logs.length > 0, 5000, 'the log line')
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^windows job sentinel unavailable \(it could not be started: .*ENOENT.*\): the children of TurboLLM's children are not tied to it; stops fall back to taskkill \/T$/)
    const [cmd, args] = node('setTimeout(() => {}, 5000)')
    const t0 = Date.now()
    const { child, tied } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:none' })
    record(child.pid)
    await tied
    assert.ok(Date.now() - t0 < 500, 'not held up waiting for a tie that cannot come')
    const killed: number[][] = []
    const stopping = stopTethered(300, { platform: 'win32', treeKill: (pids) => { killed.push(pids); for (const p of pids) process.kill(p, 'SIGKILL') } })
    await stopping
    assert.deepEqual(killed, [[child.pid]], 'the tree kill, as before the sentinel')
  } finally {
    setJobSentinel(null)
    s.stop()
    _setTetherPlatform(null)
    killRecorded()
  }
})

// A graceful stop does not wait for an answer still pending: the tree is killed at once, and the job ended when the
// answer comes.
test('a graceful stop tree-kills a child whose answer is pending, and ends its job when the answer comes', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_ADD_MS: '400' })
  try {
    const [cmd, args] = node('setTimeout(() => {}, 5000)')
    const child = spawnTethered(cmd, args, { stdio: 'ignore' }, { kind: 'probe' })
    record(child.pid)
    await waitFor(() => f.received().some((l) => l.startsWith('add ')), 5000, 'the add')
    const killed: number[][] = []
    await stopTethered(100, { platform: 'win32', treeKill: (pids) => { killed.push(pids) } })
    assert.deepEqual(killed, [[child.pid]], 'not held up by the pending answer')
    await waitFor(() => f.count('end 1000') === 1, 5000, 'its job ended once the answer came')
  } finally {
    await f.done()
  }
})

test('the restart keeper (closeAllLifelines) ends every job, running and held, and stops the sentinel', async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_IDLE: 'held' })
  try {
    const [cmd, args] = node('setTimeout(() => {}, 5000)')
    const running = spawnTethered(cmd, args, { stdio: 'ignore' }, { kind: 'probe' })
    record(running.pid)
    const [cmd2, args2] = node('')
    const { child: held } = spawnHeld(cmd2, args2, { stdio: 'ignore' }, { kind: 'code-bash', hold: 'code-session:k' })
    await once(held, 'exit')
    await waitFor(() => f.received().some((l) => l.startsWith('idle ')), 5000, 'the held one\'s idle')
    await sleep(50)
    const sentinelPid = f.s.pid() as number
    closeAllLifelines()
    await waitFor(() => f.count('end 1000') === 1 && f.count('end 1001') === 1, 5000, 'both jobs ended')
    await waitFor(() => isGone(sentinelPid), 5000, 'the sentinel to stop')
  } finally {
    await f.done()
  }
})

// The keeper's closeAllLifelines is synchronous and the replacement starts right after it: a job it cannot end then
// (the sentinel dead and not yet restarted) would keep its tree alive, in the keeper, until TurboLLM stops.
test('the restart keeper tree-kills a running child whose job it cannot end now (its sentinel restarting)', async () => {
  const dir = tmpDir('tllm-fake-sentinel-')
  const logs: string[] = []
  const s = new JobSentinel({
    command: process.execPath,
    args: [FAKE],
    env: { ...process.env, FAKE_SENTINEL_LOG: join(dir, 'received.log'), FAKE_SENTINEL_DIED: join(dir, 'died') },
    log: (line) => logs.push(line),
    restartDelaysMs: [10_000],
  }).start()
  _setTetherPlatform('win32')
  setJobSentinel(s)
  try {
    const [cmd, args] = node('setTimeout(() => {}, 5000)')
    const { child, tied } = spawnHeld(cmd, args, { stdio: 'ignore' }, { kind: 'probe', hold: 'daemon' })
    record(child.pid)
    await tied
    process.kill(s.pid() as number, 'SIGKILL')
    await waitFor(() => logs.some((l) => /restarting it \(1\/1\)/.test(l)), 5000, 'the sentinel restarting')
    const killed: number[][] = []
    closeAllLifelines({ treeKill: (pids) => { killed.push(pids) } })
    assert.deepEqual(killed, [[child.pid]], 'its tree killed while its root lives')
  } finally {
    setJobSentinel(null)
    s.stop()
    _setTetherPlatform(null)
    killRecorded()
  }
})

test('a Code terminal\'s shell gets a job of its own, ended when the terminal is released', async () => {
  const f = useFakeSentinel()
  try {
    const shell = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
    record(shell.pid)
    const tie = tetherTerminal(shell.pid as number, { startMs: Date.now() - 50, endMs: Date.now() })
    await waitFor(() => f.received().some((l) => l.startsWith(`add 1 ${shell.pid} `)), 5000, 'the shell\'s add')
    await sleep(50)
    tie.release()
    await waitFor(() => f.count('end 1000') === 1, 5000, 'its job ended')
    tie.release()
    await sleep(50)
    assert.equal(f.count('end 1000'), 1)
  } finally {
    await f.done()
  }
})

// A command that returns within milliseconds (`nohup srv &`, `cmd //c start srv`) could leave srv running, born
// outside its job, before the sentinel had tied the shell. The command now waits for its tie. The Code bash is bash on
// Windows (Git Bash, a bash on PATH or the shellPath setting). Here it is the host's: pi's getShellConfig takes
// /bin/bash first (bash 3.2 on macOS), and sh only where there is no bash, which these skip (robust-bash.test.ts runs
// the gate under dash, whose read has no -t).
const gateSkip = process.platform === 'win32' || existsSync('/bin/bash') ? false
  : spawnSync('sh', ['-c', 'command -v bash']).status === 0 ? false : 'the Code bash is bash (pi runs sh here)'
test('Code bash on Windows: a command starts only once its tie exists (an answer 500 ms late holds it that long)', { skip: gateSkip }, async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_ADD_MS: '500' })
  try {
    const ops = createRobustBashOperations({ sessionLabel: 'gate', sessionId: 'gate' })
    let out = ''
    const t0 = Date.now()
    const nodePath = process.execPath.replace(/\\/g, '/')
    const { exitCode } = await ops.exec(`"${nodePath}" -e "console.log(Date.now())"; read -r x && echo "stdin: $x" || echo stdin-empty`, tmpDir('tllm-gate-'), {
      onData: (d: Buffer) => { out += d.toString() },
    })
    assert.equal(exitCode, 0, out)
    const [started, stdin] = out.trim().split(/\r?\n/)
    assert.ok(Number(started) - t0 >= 450, `the command waited for its tie (${Number(started) - t0} ms)`)
    assert.equal(stdin, 'stdin-empty', 'and kept /dev/null as its stdin, as before')
    assert.ok(f.received().some((l) => l.startsWith('add ')))
  } finally {
    await releaseTetherScope('code-session:gate')
    await f.done()
  }
})

// bash's read takes an exported TMOUT for a timeout (CIS hardening sets TMOUT=900): the gate's plain `read` gave up
// TMOUT seconds in and let the command start untied. On macOS this is bash 3.2, whose timed-out read returns 1, as at
// EOF, so a gate that read again after a timeout started it TMOUT seconds in there too.
test('Code bash on Windows: an exported TMOUT starts no command before its tie (TMOUT=1, an answer 1.6 s late), and the command keeps it', { skip: gateSkip }, async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_ADD_MS: '1600' })
  try {
    const ops = createRobustBashOperations({ sessionLabel: 'gate-tmout', sessionId: 'gate-tmout' })
    let out = ''
    const t0 = Date.now()
    const nodePath = process.execPath.replace(/\\/g, '/')
    const { exitCode } = await ops.exec(`"${nodePath}" -e "console.log(Date.now())"; echo "TMOUT=$TMOUT"`, tmpDir('tllm-gate-tmout-'), {
      onData: (d: Buffer) => { out += d.toString() },
      env: { ...process.env, TMOUT: '1' },
    })
    assert.equal(exitCode, 0, out)
    const [started, tmout] = out.trim().split(/\r?\n/)
    assert.ok(Number(started) - t0 >= 1500, `the command waited for its tie past TMOUT=1 (${Number(started) - t0} ms)`)
    assert.equal(tmout, 'TMOUT=1', 'and keeps TMOUT')
  } finally {
    await releaseTetherScope('code-session:gate-tmout')
    await f.done()
  }
})

// Stop can come after the shell has exited, while a job it left still writes to its output and keeps the command
// waiting. Node has reaped the shell by then, so its pid may name another process: the command's job is ended (the
// whole tree at once), and the shell's pid gets nothing, no `taskkill /T` and no bare kill. Each signal sent to that pid
// from its exit on is recorded here and not sent. ($$ and $! are Git Bash's own pids on Windows, so not there.)
test('Code bash on Windows: Stop after the shell has exited ends the command\'s job, and sends nothing to the shell\'s pid', { skip: process.platform === 'win32' ? 'POSIX pids from $$ and $!' : gateSkip }, async () => {
  const f = useFakeSentinel({ FAKE_SENTINEL_IDLE: 'held' })
  const realKill = process.kill.bind(process)
  let shell = 0
  let job = 0
  let reaped = false
  const toShell: Array<[number, string | number | undefined]> = []
  process.kill = ((pid: number, sig?: string | number) => {
    if (reaped && pid === shell) {
      toShell.push([pid, sig])
      return true
    }
    return realKill(pid, sig)
  }) as typeof process.kill
  const ac = new AbortController()
  try {
    const ops = createRobustBashOperations({ sessionLabel: 'post-exit', sessionId: 'post-exit' })
    let out = ''
    const exec = ops.exec('echo shell:$$; (while :; do echo tick; sleep 0.02; done) & echo job:$!; exit 0', tmpDir('tllm-gate-post-exit-'), {
      onData: (d: Buffer) => {
        out += d.toString()
        shell ||= Number(/shell:(\d+)/.exec(out)?.[1] ?? 0)
        job ||= Number(/job:(\d+)/.exec(out)?.[1] ?? 0)
        if (job) record(job)
      },
      signal: ac.signal,
    })
    const outcome = exec.then(() => 'resolved', (e: Error) => e.message)
    await waitFor(() => shell > 0 && job > 0, 5000, 'the pids')
    await waitFor(() => {
      try {
        realKill(shell, 0)
        return false
      } catch {
        return true // Node has reaped the shell
      }
    }, 5000, 'the shell\'s exit')
    reaped = true
    await waitFor(() => f.received().some((l) => /^idle \d+ 1000$/.test(l)), 5000, 'the idle')
    await sleep(100)
    assert.equal(f.count('end 1000'), 0, 'held: the job is left')
    ac.abort()
    await waitFor(() => f.count('end 1000') === 1, 2000, 'the end of the command\'s job')
    realKill(job, 'SIGKILL') // the stand-in only records the end; the real one ends the whole tree, this job with it
    assert.equal(await outcome, 'aborted')
    await sleep(1000) // the escalation came 0.8 s in
    assert.deepEqual(toShell, [], 'nothing was sent to the reaped shell\'s pid')
  } finally {
    process.kill = realKill
    await releaseTetherScope('code-session:post-exit')
    await f.done()
  }
})

// ── The real sentinel, on Windows (CI's windows-latest) ──────────────────────────────────────────────────────────

const windows = process.platform === 'win32' ? false : 'the real job sentinel (Windows)'

test('the sentinel script ships beside this module (and package.json copies it into dist)', () => {
  assert.equal(existsSync(sentinelScriptPath()), true)
  assert.match(sentinelScriptPath(), /win-job-sentinel\.ps1$/)
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { scripts: { build: string } }
  assert.ok(pkg.scripts.build.includes("cpSync('src/util/win-job-sentinel.ps1','dist/win-job-sentinel.ps1')"), 'the build copies it beside cli.js')
})

/** A stand-in daemon on Windows: the real sentinel (or none), and a tethered child that starts a detached
 *  grandchild (libuv's job lets a detached child out, as Git for Windows' children get out of it). */
/** A child that starts a detached grandchild and writes its pid to `pidFile`. */
function escapingEngine(pidFile: string): string {
  return "const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: 'ignore' }); " +
    `g.unref(); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1e9)`
}

/** The Windows pids of the running `ping -n <n> …` processes, found by their command lines. */
function pingPids(n: string): number[] {
  return String(spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -match '-n ${n} ' }).ProcessId`], { encoding: 'utf8' }).stdout ?? '').trim().split(/\s+/).filter(Boolean).map(Number)
}

async function waitForPing(n: string, ms = 20_000): Promise<number> {
  let pid = 0
  await waitFor(() => (pid = pingPids(n)[0] ?? 0) > 0, ms, `ping -n ${n} running`)
  record(pid)
  return pid
}

async function windowsDaemon(dir: string, withSentinel: boolean) {
  return startStandInDaemon(`
import { setJobSentinel, spawnHeld } from ${srcUrl('util/tether.ts')}
import { JobSentinel } from ${srcUrl('util/win-job-sentinel.ts')}
const logs: string[] = []
if (${withSentinel}) setJobSentinel(new JobSentinel({ log: (l) => logs.push(l) }).start())
const engine = ${JSON.stringify(escapingEngine(join(dir, 'grandchild.pid')))}
const { child, tied } = spawnHeld(process.execPath, ['-e', engine], { stdio: 'ignore' }, { kind: 'probe', hold: 'daemon' })
await tied
await new Promise((r) => setTimeout(r, 500))
report({ child: child.pid, logs })
`)
}

test('Windows: a daemon killed outright (TerminateProcess) takes its children\'s escaped children with it', { skip: windows }, async () => {
  const dir = tmpDir('tllm-sentinel-real-')
  const d = await windowsDaemon(dir, true)
  try {
    const { child, logs } = await d.next<{ child: number; logs: string[] }>(60_000)
    const grandchild = await pidWrittenTo(join(dir, 'grandchild.pid'))
    record(child, grandchild)
    assert.deepEqual(logs, [], 'the sentinel started')
    spawnSync('taskkill', ['/F', '/PID', String(d.pid)]) // no /T: the daemon alone
    assert.deepEqual(await waitGone([child, grandchild], 2000), [], 'the engine and its escaped grandchild are gone')
  } finally {
    killRecorded(d.pid)
  }
})

test('Windows control: without the sentinel the escaped grandchild survives its daemon (the gap it closes)', { skip: windows }, async () => {
  const dir = tmpDir('tllm-sentinel-real-')
  const d = await windowsDaemon(dir, false)
  try {
    const { child } = await d.next<{ child: number }>(60_000)
    const grandchild = await pidWrittenTo(join(dir, 'grandchild.pid'))
    record(child, grandchild)
    spawnSync('taskkill', ['/F', '/PID', String(d.pid)])
    assert.deepEqual(await waitGone([child], 2000), [], 'libuv\'s job ends the direct child')
    await sleep(1000)
    assert.equal(isGone(grandchild), false, 'but not what got out of that job')
  } finally {
    killRecorded(d.pid)
  }
})

test('Windows: the pid-reuse guard refuses a process that is not the daemon\'s child, which survives the daemon', { skip: windows }, async () => {
  // Not this process's child: started by a `cmd` that exits at once.
  const dir = tmpDir('tllm-sentinel-guard-')
  const pidFile = join(dir, 'other.pid')
  const d = await startStandInDaemon(`
import { JobSentinel } from ${srcUrl('util/win-job-sentinel.ts')}
const s = new JobSentinel({ log: () => {} }).start()
const starter = (await import('node:child_process')).spawn(process.execPath, ['-e', ${JSON.stringify(escapingEngine(pidFile).replace(/; setInterval\(\(\) => \{\}, 1e9\)$/, ''))}], { stdio: 'ignore' })
await new Promise((r) => starter.once('exit', r))
const other = Number((await import('node:fs')).readFileSync(${JSON.stringify(pidFile)}, 'utf8'))
const now = Date.now()
report({ other, reply: await s.add(other, now - 60_000, now) })
`)
  try {
    const { other, reply } = await d.next<{ other: number; reply: { kind: string; reason?: string } }>(60_000)
    record(other)
    assert.equal(reply.kind, 'refused', JSON.stringify(reply))
    assert.match(reply.reason ?? '', /not the daemon/)
    spawnSync('taskkill', ['/F', '/PID', String(d.pid)])
    await sleep(1000)
    assert.equal(isGone(other), false, 'an unrelated process is never tied')
  } finally {
    killRecorded(d.pid)
  }
})

test('Windows: the sentinel dying alone changes nothing: its jobs are the daemon\'s, and still end with it', { skip: windows }, async () => {
  const dir = tmpDir('tllm-sentinel-death-')
  const d = await startStandInDaemon(`
import { setJobSentinel, spawnHeld } from ${srcUrl('util/tether.ts')}
import { JobSentinel } from ${srcUrl('util/win-job-sentinel.ts')}
const s = new JobSentinel({ log: () => {}, restartDelaysMs: [] }).start()
setJobSentinel(s)
const engine = ${JSON.stringify(escapingEngine(join(dir, 'grandchild.pid')))}
const { child, tied } = spawnHeld(process.execPath, ['-e', engine], { stdio: 'ignore' }, { kind: 'probe', hold: 'daemon' })
await tied
await new Promise((r) => setTimeout(r, 500))
report({ child: child.pid, sentinel: s.pid() })
`)
  try {
    const { child, sentinel } = await d.next<{ child: number; sentinel: number }>(60_000)
    const grandchild = await pidWrittenTo(join(dir, 'grandchild.pid'))
    record(child, grandchild, sentinel)
    spawnSync('taskkill', ['/F', '/PID', String(sentinel)])
    await sleep(1000)
    assert.equal(isGone(child), false, 'the children live on')
    assert.equal(isGone(grandchild), false)
    spawnSync('taskkill', ['/F', '/PID', String(d.pid)])
    assert.deepEqual(await waitGone([child, grandchild], 2000), [], 'and still end with the daemon')
  } finally {
    killRecorded(d.pid)
  }
})

test('Windows: a Git Bash `nohup … &` that returns at once is in its command\'s job: it ends at the release and with the daemon', { skip: windows }, async () => {
  const dir = tmpDir('tllm-sentinel-bash-')
  const d = await startStandInDaemon(`
import { setJobSentinel, releaseTetherScope } from ${srcUrl('util/tether.ts')}
import { JobSentinel } from ${srcUrl('util/win-job-sentinel.ts')}
import { createRobustBashOperations } from ${srcUrl('code/robust-bash.ts')}
setJobSentinel(new JobSentinel({ log: () => {} }).start())
const run = async (command: string, sessionId: string) => {
  let out = ''
  const t0 = Date.now()
  await createRobustBashOperations({ sessionLabel: sessionId, sessionId }).exec(command, process.cwd(), { onData: (b: Buffer) => { out += b.toString() } })
  return { out: out.trim(), ms: Date.now() - t0 }
}
const a = await run('nohup ping -n 300 127.0.0.1 >/dev/null 2>&1 & echo $!', 'a')
const b = await run('nohup ping -n 301 127.0.0.1 >/dev/null 2>&1 & echo $!', 'b')
report({ a, b })
process.stdin.once('data', async () => { await releaseTetherScope('code-session:a'); report({ released: true }) })
`, { cwd: dir })
  try {
    const { a, b } = await d.next<{ a: { out: string; ms: number }; b: { out: string } }>(60_000)
    // $! is MSYS2's pid; the Windows pid of each ping is found by its command line.
    const [pa] = pingPids('300')
    const [pb] = pingPids('301')
    record(pa, pb)
    assert.ok(pa && pb, `both pings run (${a.out}, ${b.out})`)
    d.child.stdin?.write('release\n')
    await d.next(10_000)
    assert.deepEqual(await waitGone([pa], 2000), [], 'released with session a')
    assert.equal(isGone(pb), false, 'session b\'s lives on')
    spawnSync('taskkill', ['/F', '/PID', String(d.pid)])
    assert.deepEqual(await waitGone([pb], 2000), [], 'and goes with the daemon')
  } finally {
    killRecorded(d.pid)
  }
})

test('Windows: `cmd //c start //b ping` through Git Bash (cmd exits at once, its ping runs on) is in its command\'s job: it ends at the release and with the daemon', { skip: windows }, async () => {
  const dir = tmpDir('tllm-sentinel-start-')
  const d = await startStandInDaemon(`
import { setJobSentinel, releaseTetherScope } from ${srcUrl('util/tether.ts')}
import { JobSentinel } from ${srcUrl('util/win-job-sentinel.ts')}
import { createRobustBashOperations } from ${srcUrl('code/robust-bash.ts')}
setJobSentinel(new JobSentinel({ log: () => {} }).start())
const run = async (command: string, sessionId: string) => {
  let out = ''
  const { exitCode } = await createRobustBashOperations({ sessionLabel: sessionId, sessionId }).exec(command, process.cwd(), { onData: (b: Buffer) => { out += b.toString() } })
  return { out: out.trim(), exitCode }
}
const c = await run('cmd //c start //b ping -n 302 127.0.0.1 >/dev/null 2>&1; echo started', 'c')
const e = await run('cmd //c start //b ping -n 303 127.0.0.1 >/dev/null 2>&1; echo started', 'e')
report({ c, e })
process.stdin.once('data', async () => { await releaseTetherScope('code-session:c'); report({ released: true }) })
`, { cwd: dir })
  try {
    const { c, e } = await d.next<{ c: { out: string; exitCode: number }; e: { out: string; exitCode: number } }>(60_000)
    assert.deepEqual([c.exitCode, e.exitCode], [0, 0], `both commands returned (${c.out}; ${e.out})`)
    const pc = await waitForPing('302')
    const pe = await waitForPing('303')
    d.child.stdin?.write('release\n')
    await d.next(10_000)
    assert.deepEqual(await waitGone([pc], 2000), [], 'released with session c')
    assert.equal(isGone(pe), false, 'session e\'s lives on')
    spawnSync('taskkill', ['/F', '/PID', String(d.pid)])
    assert.deepEqual(await waitGone([pe], 2000), [], 'and goes with the daemon')
  } finally {
    killRecorded(d.pid)
  }
})

// A program started from a Code terminal with a console of its own (Start-Process) is beyond the pseudoconsole's
// close: only the shell's job ends it, at the terminal's release and with the daemon, however the daemon ends.
test('Windows: what a Code terminal\'s ConPTY shell starts, a program with its own console included, is in the shell\'s job: it ends at the release and with the daemon', { skip: windows }, async () => {
  const dir = tmpDir('tllm-sentinel-conpty-')
  const d = await startStandInDaemon(`
import { setJobSentinel } from ${srcUrl('util/tether.ts')}
import { JobSentinel } from ${srcUrl('util/win-job-sentinel.ts')}
import { PTYSession } from ${srcUrl('terminal/pty-session.ts')}
const s = new JobSentinel({ log: (l) => console.error(l) }).start()
setJobSentinel(s)
await s.add(process.pid, 0, 0) // answered (refused: not the daemon's child) once the sentinel is ready
const t1 = PTYSession.spawn(process.cwd(), 24, 120)
const t2 = PTYSession.spawn(process.cwd(), 24, 120)
report({ t1: t1.getPid(), t2: t2.getPid() })
process.stdin.setEncoding('utf8')
process.stdin.on('data', (line: string) => {
  if (line.startsWith('type')) {
    t1.write("Start-Process ping -ArgumentList '-n','310','127.0.0.1' -WindowStyle Hidden\\r")
    t2.write("Start-Process ping -ArgumentList '-n','311','127.0.0.1' -WindowStyle Hidden\\r")
  } else if (line.startsWith('release')) {
    t1.kill()
    report({ released: true })
  }
})
`, { cwd: dir })
  try {
    const { t1, t2 } = await d.next<{ t1: number; t2: number }>(60_000)
    record(t1, t2)
    await sleep(3000) // the shells' prompts
    d.child.stdin?.write('type\n')
    const p1 = await waitForPing('310')
    const p2 = await waitForPing('311')
    d.child.stdin?.write('release\n')
    await d.next(10_000)
    assert.deepEqual(await waitGone([p1], 2000), [], 'released with its terminal')
    assert.equal(isGone(p2), false, 'the other terminal\'s lives on')
    spawnSync('taskkill', ['/F', '/PID', String(d.pid)])
    assert.deepEqual(await waitGone([p2], 2000), [], 'and goes with the daemon')
  } finally {
    killRecorded(d.pid)
  }
})

// What a job allows: node and PowerShell trees run as they always did, and a program that asks to break away from
// its job (CREATE_BREAKAWAY_FROM_JOB) is refused with ERROR_ACCESS_DENIED (5) (Known). Without the job, libuv's own
// allows breakaway and the same request succeeds (0).
const BREAKAWAY_PS1 = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Breakaway {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Try() {
    const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000, CREATE_NO_WINDOW = 0x08000000;
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (CreateProcessW(null, new System.Text.StringBuilder("cmd.exe /c exit 0"), IntPtr.Zero, IntPtr.Zero, false, CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi)) {
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      return 0;
    }
    return Marshal.GetLastWin32Error();
  }
}
'@
[Breakaway]::Try()
`

test('Windows: node and PowerShell trees run normally in a job, and a program asking to break away from it gets ERROR_ACCESS_DENIED', { skip: windows }, async () => {
  const dir = tmpDir('tllm-sentinel-trees-')
  const ps1 = join(dir, 'breakaway.ps1')
  writeFileSync(ps1, BREAKAWAY_PS1)
  // The tethered child starts its own children only once its job exists (it waits for a line on stdin).
  const tree = "process.stdin.once('data', () => { const { execFileSync } = require('child_process'); const run = (c, a) => execFileSync(c, a, { encoding: 'utf8' }).trim(); " +
    "console.log(JSON.stringify({ node: run(process.execPath, ['-e', 'console.log(6 * 7)']), " +
    "powershell: run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& cmd.exe /c exit 3; Write-Output $LASTEXITCODE']), " +
    "breakaway: run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', process.argv[1]]) })) })"
  const d = await startStandInDaemon(`
import { setJobSentinel, spawnHeld } from ${srcUrl('util/tether.ts')}
import { JobSentinel } from ${srcUrl('util/win-job-sentinel.ts')}
const logs: string[] = []
setJobSentinel(new JobSentinel({ log: (l) => logs.push(l) }).start())
const { child, tied } = spawnHeld(process.execPath, ['-e', ${JSON.stringify(tree)}, ${JSON.stringify(ps1)}], { stdio: ['pipe', 'pipe', 'inherit'] }, { kind: 'probe', hold: 'daemon' })
await tied
let out = ''
child.stdout?.on('data', (b: Buffer) => { out += b.toString() })
child.stdin?.end('go\\n')
await new Promise((r) => child.once('close', r)) // its output read to the end
report({ out: out.trim(), logs })
`, { cwd: dir })
  try {
    const { out, logs } = await d.next<{ out: string; logs: string[] }>(120_000)
    assert.deepEqual(logs, [], 'the sentinel started')
    assert.deepEqual(JSON.parse(out), { node: '42', powershell: '3', breakaway: '5' })
  } finally {
    killRecorded(d.pid)
  }
})

test('Windows: the sentinel\'s start, from spawn to its first answer, over 5 starts (PowerShell and Add-Type\'s compile)', { skip: windows, timeout: 300_000 }, async () => {
  const times: number[] = []
  try {
    for (let i = 0; i < 5; i++) {
      const logs: string[] = []
      const t0 = Date.now()
      const s = new JobSentinel({ log: (l) => logs.push(l) }).start()
      const startMs = Date.now()
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      const endMs = Date.now()
      record(child.pid)
      const r = await s.add(child.pid as number, startMs, endMs)
      times.push(Date.now() - t0)
      assert.equal(r.kind, 'ok', `${JSON.stringify(r)} ${logs.join(' / ')}`)
      if (r.kind === 'ok') s.end(r.handle)
      assert.deepEqual(await waitGone([child.pid as number], 5000), [], 'its end kills the job\'s tree')
      s.stop()
    }
  } finally {
    console.log(`windows job sentinel start, spawn to first answer (ms): ${times.join(', ')}`)
    killRecorded()
  }
  assert.ok(times.every((t) => t < 30_000), 'each within the ready timeout')
})

test('Windows: with PowerShell hidden from PATH the real sentinel logs one line, and a graceful stop still ends a child\'s tree', { skip: windows }, async () => {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v
  env.PATH = (process.env[pathKey] ?? '').split(';').filter((p) => p && !existsSync(join(p, 'powershell.exe'))).join(';')
  const logs: string[] = []
  const s = new JobSentinel({ env, log: (l) => logs.push(l) }).start()
  setJobSentinel(s)
  const dir = tmpDir('tllm-sentinel-nops-')
  try {
    await waitFor(() => logs.length > 0, 10_000, 'the log line')
    await sleep(200)
    assert.equal(logs.length, 1, logs.join('\n'))
    assert.match(logs[0], /^windows job sentinel unavailable \(it could not be started: .*ENOENT.*\): the children of TurboLLM's children are not tied to it; stops fall back to taskkill \/T$/)
    const pidFile = join(dir, 'grandchild.pid')
    const code = "const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' }); " +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1e9)`
    const child = spawnTethered(process.execPath, ['-e', code], { stdio: 'ignore' }, { kind: 'probe' })
    record(child.pid)
    const grandchild = await pidWrittenTo(pidFile)
    record(grandchild)
    await stopTethered(3000)
    assert.deepEqual(await waitGone([child.pid as number, grandchild], 5000), [], 'taskkill /T ended the child and its grandchild')
  } finally {
    setJobSentinel(null)
    s.stop()
    killRecorded()
  }
})

// An `end` has no request id: the script answered a failed one `error <handle> …`, read as the answer to the request
// whose id had that value. The value 2 is no handle (the kernel ignores a handle's two low bits, and 0 is never one),
// and the request after the end is the sentinel's second: id 2.
test('Windows: a failed end (a handle that is no job) is logged, and the request whose id has that value gets its own answer', { skip: windows }, async () => {
  const logs: string[] = []
  const s = new JobSentinel({ log: (l) => logs.push(l) }).start()
  const child = () => {
    const startMs = Date.now()
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    const endMs = Date.now()
    record(c.pid)
    return { pid: c.pid as number, startMs, endMs }
  }
  try {
    const a = child()
    const first = await s.add(a.pid, a.startMs, a.endMs)
    assert.equal(first.kind, 'ok', JSON.stringify(first))
    assert.equal(s.end('2'), true)
    const b = child()
    const second = await s.add(b.pid, b.startMs, b.endMs)
    assert.equal(second.kind, 'ok', `the add with id 2 got its own answer: ${JSON.stringify(second)}`)
    await waitFor(() => logs.some((l) => /^\[tether\] windows job sentinel could not end job 2: /.test(l)), 5000, logs.join('\n'))
    for (const r of [first, second]) if (r.kind === 'ok') s.end(r.handle)
    assert.deepEqual(await waitGone([a.pid, b.pid], 5000), [], 'the two real jobs end')
  } finally {
    s.stop()
    killRecorded()
  }
})
