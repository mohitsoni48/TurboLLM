// turbollm/src/ext/context-limit.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkContextFits, estimateTokens } from './context-limit.js'

const depsWithWindow = (n: number) => ({
  manager: { status: () => ({ state: 'running', model: 'test', contextSize: n }) },
} as never)

test('the estimate scales with content length', () => {
  const small = estimateTokens([{ role: 'user', content: 'hi' }])
  const large = estimateTokens([{ role: 'user', content: 'x'.repeat(4000) }])
  assert.ok(large > small)
  assert.ok(small > 0, 'even a tiny message costs tokens')
})

test('a short history fits a large window', () => {
  const r = checkContextFits(depsWithWindow(32_000), [{ role: 'user', content: 'hello' }])
  assert.equal(r.fits, true)
  assert.equal(r.limit, 32_000)
})

test('a long history does not fit a small window', () => {
  const msgs = Array.from({ length: 200 }, () => ({ role: 'user' as const, content: 'x'.repeat(2000) }))
  const r = checkContextFits(depsWithWindow(4096), msgs)
  assert.equal(r.fits, false)
  assert.ok(r.estimated > r.limit)
})

test('headroom is reserved for the reply, so a prompt that exactly fills the window is refused', () => {
  // A prompt that consumes the entire window leaves no room to answer — "fits" must mean
  // "fits with room to reply", not "fits with room for nothing".
  const msgs = [{ role: 'user' as const, content: 'x'.repeat(4 * 4000) }]
  const r = checkContextFits(depsWithWindow(4000), msgs)
  assert.equal(r.fits, false)
})

test('an unknown window is permissive rather than blocking', () => {
  const r = checkContextFits({ manager: { status: () => ({ state: 'running', model: 'm' }) } } as never, [{ role: 'user', content: 'hi' }])
  assert.equal(r.fits, true, 'never refuse a request because we could not read the window')
})
