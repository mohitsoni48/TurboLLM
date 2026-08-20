// turbollm/src/ext/idempotency.test.ts
//
// IdempotencyStore (spec 27 §7.6). The commit point under test elsewhere (routes.runs.ts) is
// run creation, before the engine is touched — these tests cover the store's own contract in
// isolation: replay, tenant scoping, and TTL expiry.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdempotencyStore } from './idempotency.js'

test('an idempotency key replays the original result instead of re-running', () => {
  const store = new IdempotencyStore()
  const first = store.remember('acme', 'key-1', { run_id: 'run_a' })
  assert.deepEqual(first, { run_id: 'run_a' })
  const replay = store.lookup('acme', 'key-1')
  assert.deepEqual(replay, { run_id: 'run_a' }, 'a retry must return the ORIGINAL run, not start a second')
})

test('idempotency keys are scoped per tenant', () => {
  const store = new IdempotencyStore()
  store.remember('acme', 'shared-key', { run_id: 'run_a' })
  assert.equal(store.lookup('globex', 'shared-key'), null)
})

test('expired idempotency entries are dropped', () => {
  const store = new IdempotencyStore({ ttlMs: 1 })
  store.remember('acme', 'k', { run_id: 'r' })
  store.prune(Date.now() + 10)
  assert.equal(store.lookup('acme', 'k'), null)
})
