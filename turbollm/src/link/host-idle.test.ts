import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canWake, hostIdleState } from './host-idle'
import type { Deps } from '../deps'

const NOW = 1_000_000

test('idle host with no recent local activity may be woken', () => {
  assert.equal(canWake({ generating: false, lastLocalActivityMs: null, nowMs: NOW }), true)
})

test('a host mid-generation may NOT be woken', () => {
  assert.equal(canWake({ generating: true, lastLocalActivityMs: null, nowMs: NOW }), false)
})

test('recent local activity blocks a wake even when not generating', () => {
  // The owner just clicked something. Evicting their model out from under them is the
  // exact hijack `wake` exists to prevent.
  assert.equal(canWake({ generating: false, lastLocalActivityMs: NOW - 5_000, nowMs: NOW }), false)
})

test('activity older than the grace window no longer blocks', () => {
  assert.equal(canWake({ generating: false, lastLocalActivityMs: NOW - 600_000, nowMs: NOW }), true)
})

test('the grace boundary is inclusive-safe and configurable', () => {
  assert.equal(canWake({ generating: false, lastLocalActivityMs: NOW - 60_000, nowMs: NOW, idleGraceMs: 60_000 }), true)
  assert.equal(canWake({ generating: false, lastLocalActivityMs: NOW - 59_999, nowMs: NOW, idleGraceMs: 60_000 }), false)
})

test('a future or clock-skewed timestamp is treated as recent, not as ancient', () => {
  // Fails SAFE: a bad clock must never authorise evicting the owner's model.
  assert.equal(canWake({ generating: false, lastLocalActivityMs: NOW + 10_000, nowMs: NOW }), false)
})

// A keep-N pool slot's generation is counted on its own Manager (scalability review 1.5): the host is still busy.
test('hostIdleState: a generating pool slot makes the host busy though the primary is idle', () => {
  const d = {
    manager: { sessionStats: () => ({ activeRequests: 0 }) },
    modelRouter: { poolGenerating: () => true },
  } as unknown as Deps
  assert.equal(hostIdleState(d).generating, true)
})
