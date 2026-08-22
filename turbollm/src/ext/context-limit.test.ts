// turbollm/src/ext/context-limit.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkContextFits, estimateTokens } from './context-limit.js'
import type { Status } from '../engines/manager.js'

// Built against the REAL `Status` shape (`model: ModelInfo | null`, context window on
// `model.ctx` — there is no top-level `contextSize` field anywhere in the daemon). An earlier
// version of this fixture invented `{ model: 'test', contextSize: n }`, which let
// checkContextFits read a field that only ever existed in this test, never in production.
const statusWithWindow = (n: number): Status => ({
  state: 'running', err: null, port: 0, pid: 0, loadElapsedMs: 0,
  model: { key: 'test', name: 'test', quant: 'Q4_K_M', ctx: n, vision: false },
})
const depsWithWindow = (n: number) => ({ manager: { status: () => statusWithWindow(n) } } as never)

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
  const noModel: Status = { state: 'running', err: null, port: 0, pid: 0, loadElapsedMs: 0, model: null }
  const r = checkContextFits({ manager: { status: () => noModel } } as never, [{ role: 'user', content: 'hi' }])
  assert.equal(r.fits, true, 'never refuse a request because we could not read the window')
})
