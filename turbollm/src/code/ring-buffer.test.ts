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
