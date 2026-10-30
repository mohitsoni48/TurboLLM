// Unit tests for robust-bash.ts's Stop-button reliability fix (founder-reported gap,
// 2026-07-17). Exercises real spawned processes and real abort signals — not mocks — matching
// this codebase's own testing discipline for exactly this class of timing/process-lifecycle bug
// (see the module's own header for the live, timed testing that found the original bug).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { join } from 'node:path'
import { createRobustBashOperations, TIE_GATE } from './robust-bash'
import { tmpDir } from '../test-support/tmp'

function tmp(): string {
  return tmpDir('tllm-robust-bash-')
}

test('exec: runs a real command and returns its output + exit code', async () => {
  const ops = createRobustBashOperations({ sessionLabel: 'test-basic' })
  const chunks: string[] = []
  const result = await ops.exec('echo hello-robust-bash', tmp(), {
    onData: (d) => chunks.push(d.toString()),
  })
  assert.equal(result.exitCode, 0)
  assert.match(chunks.join(''), /hello-robust-bash/)
})

test('exec: a nonzero exit code is reported, not thrown', async () => {
  const ops = createRobustBashOperations({ sessionLabel: 'test-exit-code' })
  const result = await ops.exec('exit 7', tmp(), { onData: () => {} })
  assert.equal(result.exitCode, 7)
})

test('exec: throws "Working directory does not exist" for a missing cwd, without spawning', async () => {
  const ops = createRobustBashOperations({ sessionLabel: 'test-missing-cwd' })
  await assert.rejects(
    () => ops.exec('echo unreachable', join(tmp(), 'does-not-exist'), { onData: () => {} }),
    /Working directory does not exist/,
  )
})

test('exec: an already-aborted signal rejects immediately without spawning', async () => {
  const ops = createRobustBashOperations({ sessionLabel: 'test-preaborted' })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => ops.exec('echo unreachable', tmp(), { onData: () => {}, signal: ac.signal }),
    /aborted/,
  )
})

test('exec: aborting mid-command kills the real process within a bounded time (the actual bug this fixes)', async () => {
  const ops = createRobustBashOperations({ sessionLabel: 'test-live-abort' })
  const ac = new AbortController()
  const chunks: string[] = []
  const start = Date.now()
  const execPromise = ops.exec('sleep 30', tmp(), { onData: (d) => chunks.push(d.toString()), signal: ac.signal })
  // Give the shell a moment to actually spawn and start `sleep` before aborting — aborting
  // instantly would only prove the pre-spawn fast path (already covered above).
  await new Promise((r) => setTimeout(r, 300))
  ac.abort()
  await assert.rejects(() => execPromise, /aborted/)
  const elapsedMs = Date.now() - start
  // Must resolve well before `sleep 30` would naturally finish — this is the actual regression
  // test for "most of the time it doesn't work and waits for completion." Generous bound (the
  // module's own VERIFY_GRACE_MS + FINAL_VERIFY_MS ceiling plus scheduling slack), still an order
  // of magnitude under the 30s the unfixed bug could leave a process running for.
  assert.ok(elapsedMs < 10_000, `expected abort to resolve in well under 10s, took ${elapsedMs}ms`)
})

test('exec: a timeout kills the real process the same way an abort does', async () => {
  const ops = createRobustBashOperations({ sessionLabel: 'test-timeout' })
  const start = Date.now()
  await assert.rejects(
    () => ops.exec('sleep 30', tmp(), { onData: () => {}, timeout: 1 }),
    /timeout:1/,
  )
  const elapsedMs = Date.now() - start
  assert.ok(elapsedMs < 10_000, `expected timeout-triggered kill to resolve in well under 10s, took ${elapsedMs}ms`)
})

/** Runs TIE_GATE and a command after it under `shell`, with TMOUT=1 exported, and writes the gate's line 1.5 s in. */
async function runGate(shell: string, extra: NodeJS.ProcessEnv, command: string) {
  const child = spawn(shell, ['-c', `${TIE_GATE}${command}`], { env: { ...process.env, ...extra, TMOUT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const t0 = Date.now()
  let startedAt = 0
  let out = ''
  let err = ''
  child.stdout.on('data', (d: Buffer) => { if (!startedAt) startedAt = Date.now(); out += d.toString() })
  child.stderr.on('data', (d: Buffer) => { err += d.toString() })
  const line = setTimeout(() => child.stdin.end('\n'), 1500)
  const [code] = await new Promise<[number | null]>((resolve) => child.once('close', (c) => resolve([c])))
  clearTimeout(line)
  return { code, waited: startedAt - t0, out, err }
}

// On Windows a Code bash command waits behind TIE_GATE until its job exists (exec above). bash's read takes an exported
// TMOUT for a timeout, so the plain `read` let the command start TMOUT seconds in, before its line, untied. A
// `TMOUT= read` would not do where TMOUT is readonly (here through BASH_ENV, which a `bash -c` reads): the
// assignment fails and the read still times out. Git Bash is bash, so it runs here under the first bash on PATH: on a
// Mac that can be /bin/bash, 3.2, whose timed-out read returns 1, as at EOF.
const gateSkip = process.platform === 'win32' ? 'the host bash; on Windows win-job-sentinel.test.ts runs the gate in Git Bash'
  : spawnSync('sh', ['-c', 'command -v bash']).status === 0 ? false : 'needs bash'
test('TIE_GATE: bash runs the command only once its line comes, past an exported TMOUT and a readonly one; the command keeps TMOUT, and /dev/null as its stdin', { skip: gateSkip }, async () => {
  const dir = tmp()
  const bashEnv = join(dir, 'bash-env')
  writeFileSync(bashEnv, 'readonly TMOUT\n')
  for (const [what, extra] of [['exported', {}], ['readonly too', { BASH_ENV: bashEnv }]] as const) {
    const { code, waited, out, err } = await runGate('bash', extra, `echo started; printf '%s\\n' "$TMOUT"; read -r x && echo "stdin: $x" || echo stdin-empty`)
    assert.equal(code, 0, `${what}: ${err}`)
    assert.ok(waited >= 1400, `${what}: the command waited for its line past TMOUT=1 (it started after ${waited} ms)`)
    assert.deepEqual(out.trim().split('\n'), ['started', '1', 'stdin-empty'], `${what}: it keeps TMOUT, and /dev/null as its stdin`)
    assert.equal(err, '', `${what}: nothing on stderr`)
  }
})

// A Code shellPath can name a shell whose read has no -t (dash; Debian's and Ubuntu's /bin/sh, macOS's /bin/dash):
// with the gate's `read -t` alone, its "Illegal option -t" went into the command's output and the command started at
// once, untied. The plain read after it waits for the line.
const dashSkip = process.platform === 'win32' ? 'a POSIX dash' : spawnSync('sh', ['-c', 'command -v dash']).status === 0 ? false : 'needs dash'
test('TIE_GATE: a shell whose read has no -t (dash) runs the command only once its line comes, and puts nothing on stderr', { skip: dashSkip }, async () => {
  const { code, waited, out, err } = await runGate('dash', {}, 'echo started; read -r x && echo "stdin: $x" || echo stdin-empty')
  assert.equal(code, 0, err)
  assert.ok(waited >= 1400, `the command waited for its line (it started after ${waited} ms)`)
  assert.deepEqual(out.trim().split('\n'), ['started', 'stdin-empty'], 'it keeps /dev/null as its stdin')
  assert.equal(err, '', 'nothing on stderr')
})
