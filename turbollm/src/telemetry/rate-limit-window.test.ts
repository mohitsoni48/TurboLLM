import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateWindow, MACHINE_LIMIT, type RateLimitWindow } from './rate-limit-window'
import { MAX_BATCH } from './ingest'

const PERIOD_MS = 60_000

test('evaluateWindow: a fresh key starts a window and succeeds', () => {
  const { next, success } = evaluateWindow(undefined, 1_000, PERIOD_MS, 1, 20)
  assert.equal(success, true)
  assert.deepEqual(next, { count: 1, windowStart: 1_000 })
})

test('evaluateWindow: succeeds up to exactly the limit, then rejects', () => {
  let window: RateLimitWindow | undefined
  for (let i = 1; i <= 20; i++) {
    const { next, success } = evaluateWindow(window, 1_000, PERIOD_MS, 1, 20)
    assert.equal(success, true, `request ${i} should succeed`)
    window = next!
  }
  const { next, success } = evaluateWindow(window, 1_000, PERIOD_MS, 1, 20)
  assert.equal(success, false, 'the 21st request must be rejected')
  assert.equal(next, null, 'already at the limit — reject without paying for another write')
})

test('evaluateWindow: once already over limit, rejects without asking for a write', () => {
  const overLimit: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const { next, success } = evaluateWindow(overLimit, 1_050, PERIOD_MS, 1, 20)
  assert.equal(success, false)
  assert.equal(next, null, 'no write should be requested once the window is already exhausted')
})

test('evaluateWindow: a new window starts once the period has fully elapsed', () => {
  const stale: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const { next, success } = evaluateWindow(stale, 1_000 + PERIOD_MS, PERIOD_MS, 1, 20)
  assert.equal(success, true)
  assert.deepEqual(next, { count: 1, windowStart: 1_000 + PERIOD_MS })
})

test('evaluateWindow: the boundary is strict — exactly periodMs elapsed resets, one ms earlier does not', () => {
  const full: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const stillIn = evaluateWindow(full, 1_000 + PERIOD_MS - 1, PERIOD_MS, 1, 20)
  assert.equal(stillIn.success, false, 'one ms before expiry, still the same exhausted window')
  const justReset = evaluateWindow(full, 1_000 + PERIOD_MS, PERIOD_MS, 1, 20)
  assert.equal(justReset.success, true, 'exactly periodMs later, a fresh window')
})

test('evaluateWindow: amount charges the full event count, not 1 per call', () => {
  // A single request carrying 15 events should consume 15 units of capacity,
  // not 1 — otherwise a large batch bypasses the limit by request-count alone
  // (found in pre-release review).
  const { next, success } = evaluateWindow(undefined, 1_000, PERIOD_MS, 15, 20)
  assert.equal(success, true)
  assert.equal(next!.count, 15)

  const { success: secondSuccess } = evaluateWindow(next!, 1_000, PERIOD_MS, 15, 20)
  assert.equal(secondSuccess, false, '15 + 15 = 30 exceeds a limit of 20')
})

test('evaluateWindow: a zero-event batch always succeeds and never writes', () => {
  const { next, success } = evaluateWindow(undefined, 1_000, PERIOD_MS, 0, 20)
  assert.equal(success, true)
  assert.equal(next, null)
})

test('evaluateWindow: a zero-event batch succeeds even against an already-exhausted window', () => {
  const overLimit: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const { next, success } = evaluateWindow(overLimit, 1_010, PERIOD_MS, 0, 20)
  assert.equal(success, true, 'nothing was actually requested, so there is nothing to reject')
  assert.equal(next, null)
})

test('evaluateWindow: a full legitimate queue-drain fits in one window under the real machine limit', () => {
  const { success } = evaluateWindow(undefined, 1_000, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  assert.equal(success, true, 'a machine catching up after being offline must not be deadlocked by its own first flush')
})

test('evaluateWindow: two full queue-drains in one window exactly fill it, a third overflows', () => {
  const first = evaluateWindow(undefined, 1_000, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  const second = evaluateWindow(first.next!, 1_030, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  assert.equal(second.success, true, 'MACHINE_LIMIT is exactly 2x MAX_BATCH by design')
  const third = evaluateWindow(second.next!, 1_040, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  assert.equal(third.success, false)
})
