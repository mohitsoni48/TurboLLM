// turbollm/src/ext/limits.test.ts
//
// TenantLimiter (spec 27 §8.4, §5.4): per-tenant in-flight cap and sliding-window request rate.
// Bounded on purpose — an over-cap caller is refused rather than queued (see limits.ts header).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TenantLimiter } from './limits.js'

test('the limiter caps concurrent runs per tenant', () => {
  const lim = new TenantLimiter({ maxInFlight: 2, ratePerMinute: 1000 })
  assert.equal(lim.tryAcquire('acme'), true)
  assert.equal(lim.tryAcquire('acme'), true)
  assert.equal(lim.tryAcquire('acme'), false, 'the third concurrent run is refused')
  assert.equal(lim.tryAcquire('globex'), true, 'another tenant is unaffected')
  lim.release('acme')
  assert.equal(lim.tryAcquire('acme'), true)
})

test('the limiter caps request rate per tenant', () => {
  const lim = new TenantLimiter({ maxInFlight: 100, ratePerMinute: 3 })
  assert.equal(lim.tryRequest('acme'), true)
  assert.equal(lim.tryRequest('acme'), true)
  assert.equal(lim.tryRequest('acme'), true)
  assert.equal(lim.tryRequest('acme'), false)
  assert.equal(lim.tryRequest('globex'), true)
})
