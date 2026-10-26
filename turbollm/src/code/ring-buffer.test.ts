import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RingBuffer } from './code-run-manager.js'

test('the default cap is unchanged for existing callers', () => {
  const b = new RingBuffer()
  for (let i = 0; i < 10; i++) b.push('delta', { i })
  assert.equal(b.head(), 10)
  assert.equal(b.since(0).length, 10)
})

test('an explicit cap bounds retention while seq keeps advancing', () => {
  const b = new RingBuffer(3)
  for (let i = 0; i < 6; i++) b.push('delta', { i })
  assert.equal(b.head(), 6, 'seq numbering must not restart when events are evicted')
  const retained = b.since(0)
  assert.equal(retained.length, 3)
  assert.deepEqual(retained.map((e) => (e.data as { i: number }).i), [3, 4, 5])
})

test('since() past the retained window returns only what survives', () => {
  const b = new RingBuffer(2)
  for (let i = 0; i < 5; i++) b.push('delta', { i })
  assert.equal(b.since(0).length, 2, 'a caller asking for evicted events gets the survivors')
  assert.equal(b.since(4).length, 1)
  assert.equal(b.since(99).length, 0)
})

test('startSeq continues a replacement buffer past the old one instead of restarting at 0', () => {
  const b = new RingBuffer(undefined, 900)
  assert.equal(b.head(), 900)
  assert.equal(b.push('delta', {}).seq, 900)
  assert.deepEqual(b.since(900).map((e) => e.seq), [900], 'a client cursor from the old buffer still replays it')
})

test('dropLast removes only the most recent matching event; since() is unaffected by the gap', () => {
  const b = new RingBuffer()
  b.push('tool_progress', { id: 'a', partial: '1' })
  b.push('delta', {})
  b.push('tool_progress', { id: 'a', partial: '12' })
  b.dropLast((e) => e.event === 'tool_progress')
  assert.deepEqual(b.since(0).map((e) => e.seq), [0, 1])
  b.dropLast((e) => e.event === 'nope')
  assert.equal(b.since(0).length, 2, 'no match drops nothing')
  assert.equal(b.head(), 3, 'seq numbering never goes back')
})
