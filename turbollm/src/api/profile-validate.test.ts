import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateLoadProfileFields } from './profile-validate'

function validateWithCacheRam(cacheRam: unknown): string | null {
  return validateLoadProfileFields({ ctx: 4096, cacheRam }, { requireCtx: true })
}

test('cacheRam: omitted is fine, since older clients never send it', () => {
  assert.equal(validateLoadProfileFields({ ctx: 4096 }, { requireCtx: true }), null)
})

test('cacheRam: zero, positive whole MiB values and the 32-bit int ceiling are accepted', () => {
  assert.equal(validateWithCacheRam(0), null)
  assert.equal(validateWithCacheRam(2048), null)
  assert.equal(validateWithCacheRam(2_147_483_647), null)
})

test('cacheRam: anything else is rejected before it can reach the engine command line', () => {
  for (const bad of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2048', 1e21, 2_147_483_648]) {
    assert.match(String(validateWithCacheRam(bad)), /cacheRam must be a non-negative whole number/, `cacheRam=${String(bad)}`)
  }
})
