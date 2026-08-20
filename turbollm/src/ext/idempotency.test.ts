// turbollm/src/ext/idempotency.test.ts
//
// IdempotencyStore (spec 27 §7.6). These tests cover the store's own contract in isolation:
// replay, tenant scoping, op scoping, and TTL expiry. The commit-point property itself — that
// the store is written at creation, before the engine is touched, so a retry during a long
// generation reattaches instead of starting a second run — is exercised at the route level,
// where the store is actually wired in: `routes.runs.test.ts` ("a duplicate Idempotency-Key on
// the generate path reattaches to the same run instead of starting a second one") and
// `routes.chats.test.ts` ("a duplicate Idempotency-Key on POST /chats returns the same chat
// rather than creating a second one"). The cross-endpoint collision fix (a single store shared
// across both routes) is exercised there too: `routes.runs.test.ts`'s "a chat-creation
// Idempotency-Key does not collide with a generate call reusing the same key value".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdempotencyStore } from './idempotency.js'

test('an idempotency key replays the original result instead of re-running', () => {
  const store = new IdempotencyStore()
  const first = store.remember('acme', 'runs:generate', 'key-1', { run_id: 'run_a' })
  assert.deepEqual(first, { run_id: 'run_a' })
  const replay = store.lookup('acme', 'runs:generate', 'key-1')
  assert.deepEqual(replay, { run_id: 'run_a' }, 'a retry must return the ORIGINAL run, not start a second')
})

test('idempotency keys are scoped per tenant', () => {
  const store = new IdempotencyStore()
  store.remember('acme', 'runs:generate', 'shared-key', { run_id: 'run_a' })
  assert.equal(store.lookup('globex', 'runs:generate', 'shared-key'), null)
})

test('idempotency keys are scoped per operation — the same key value used for two different operations never collides', () => {
  const store = new IdempotencyStore()
  store.remember('acme', 'chats:create', 'shared-key', { id: 'chat_a' })
  assert.equal(store.lookup('acme', 'runs:generate', 'shared-key'), null, 'a different op with the same tenant+key must be a miss, not the other op\'s cached value')
})

test('expired idempotency entries are dropped', () => {
  const store = new IdempotencyStore({ ttlMs: 1 })
  store.remember('acme', 'runs:generate', 'k', { run_id: 'r' })
  store.prune(Date.now() + 10)
  assert.equal(store.lookup('acme', 'runs:generate', 'k'), null)
})
