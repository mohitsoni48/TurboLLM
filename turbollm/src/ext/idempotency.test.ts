// turbollm/src/ext/idempotency.test.ts
//
// IdempotencyStore (spec 27 §7.6). These tests cover the store's own contract in isolation:
// replay, tenant scoping, and TTL expiry. The commit-point property itself — that the store is
// written at creation, before the engine is touched, so a retry during a long generation
// reattaches instead of starting a second run — is exercised at the route level, where the
// store is actually wired in: `routes.runs.test.ts` ("a duplicate Idempotency-Key on the
// generate path reattaches to the same run instead of starting a second one") and
// `routes.chats.test.ts` ("a duplicate Idempotency-Key on POST /chats returns the same chat
// rather than creating a second one").
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
