// The pending tool-call approval registry's wait limit (a chat turn's, Settings → Tool permissions →
// "Wait for an answer"): a wait given one ends as 'timeout' once it has passed with no answer, and its
// timer is the wait's own, unref'd, and gone however the wait ends. A wait without one (Code's ask mode)
// waits until answered, as before.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pendingToolApprovalName, resolveToolApproval, waitForToolApproval } from './approval-gate'

/** Records every timer the gate starts and every one it clears, on the real timer functions. */
function spyTimers(t: { after: (fn: () => void) => void }) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const started: ReturnType<typeof setTimeout>[] = []
  const cleared = new Set<unknown>()
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const h = realSet(fn, ms)
    started.push(h)
    return h
  }) as typeof setTimeout
  globalThis.clearTimeout = ((h: ReturnType<typeof setTimeout>) => { cleared.add(h); realClear(h) }) as typeof clearTimeout
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear })
  return { started, cleared }
}

test('a wait given a limit ends as timeout once it passes with no answer, and is no longer pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let outcome: string | undefined
  void waitForToolApproval('c1:t1', new AbortController().signal, 'run_code', 60_000).then((d) => { outcome = d })
  t.mock.timers.tick(59_999)
  await Promise.resolve()
  assert.equal(outcome, undefined, 'still waiting a moment before the limit')
  assert.equal(pendingToolApprovalName('c1:t1'), 'run_code')
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal(outcome, 'timeout')
  assert.equal(pendingToolApprovalName('c1:t1'), undefined)
  assert.equal(resolveToolApproval('c1:t1', 'allow'), false, 'a late answer finds nothing to answer (the route\'s 404)')
})

test('a wait with no limit (0, or none given) waits until answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const outcomes: string[] = []
  void waitForToolApproval('c1:t2', new AbortController().signal, 'run_code', 0).then((d) => { outcomes.push(`zero:${d}`) })
  void waitForToolApproval('c1:t3', new AbortController().signal, 'run_code').then((d) => { outcomes.push(`none:${d}`) })
  t.mock.timers.tick(7 * 24 * 60 * 60_000)
  await Promise.resolve()
  assert.deepEqual(outcomes, [])
  assert.equal(resolveToolApproval('c1:t2', 'allow'), true)
  assert.equal(resolveToolApproval('c1:t3', 'deny'), true)
  await Promise.resolve()
  assert.deepEqual(outcomes, ['zero:allow', 'none:deny'])
})

test('an answer before the limit wins, and a Stop before it is a deny; neither leaves its timer behind', async (t) => {
  const { started, cleared } = spyTimers(t)
  const answered = waitForToolApproval('c1:t4', new AbortController().signal, 'run_code', 60_000)
  assert.equal(resolveToolApproval('c1:t4', 'allow'), true)
  assert.equal(await answered, 'allow')
  const stop = new AbortController()
  const stopped = waitForToolApproval('c1:t5', stop.signal, 'run_code', 60_000)
  stop.abort()
  assert.equal(await stopped, 'deny')
  assert.equal(pendingToolApprovalName('c1:t5'), undefined)
  assert.equal(started.length, 2, 'one timer per wait')
  for (const h of started) {
    assert.ok(cleared.has(h), 'cleared once the wait ended')
    assert.equal(h.hasRef(), false, 'unref\'d: a wait never keeps the daemon alive')
  }
})

test('a wait whose signal had already aborted is a deny and starts no timer', async (t) => {
  const { started } = spyTimers(t)
  const ac = new AbortController()
  ac.abort()
  assert.equal(await waitForToolApproval('c1:t6', ac.signal, 'run_code', 60_000), 'deny')
  assert.equal(started.length, 0)
  assert.equal(pendingToolApprovalName('c1:t6'), undefined)
})

test('a wait that ran out does not end the next wait on the same key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = waitForToolApproval('c1:t7', new AbortController().signal, 'run_code', 60_000)
  t.mock.timers.tick(60_000)
  assert.equal(await first, 'timeout')
  const second = waitForToolApproval('c1:t7', new AbortController().signal, 'run_code', 120_000)
  t.mock.timers.tick(60_000)
  assert.equal(pendingToolApprovalName('c1:t7'), 'run_code', 'the first wait\'s timer is gone with it')
  assert.equal(resolveToolApproval('c1:t7', 'allow'), true)
  assert.equal(await second, 'allow')
})
