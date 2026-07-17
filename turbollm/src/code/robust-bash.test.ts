// Unit tests for robust-bash.ts's Stop-button reliability fix (founder-reported gap,
// 2026-07-17). Exercises real spawned processes and real abort signals — not mocks — matching
// this codebase's own testing discipline for exactly this class of timing/process-lifecycle bug
// (see the module's own header for the live, timed testing that found the original bug).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRobustBashOperations } from './robust-bash'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tllm-robust-bash-'))
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
