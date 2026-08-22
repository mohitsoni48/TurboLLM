// turbollm/src/ext/idempotency.test.ts
//
// IdempotencyStore (spec 27 §7.6). These tests cover the store's own contract in isolation:
// replay, tenant scoping, owner scoping, op scoping, and TTL expiry. The commit-point property
// itself — that the store is written at creation, before the engine is touched, so a retry
// during a long generation reattaches instead of starting a second run — is exercised at the
// route level, where the store is actually wired in: `routes.runs.test.ts` ("a duplicate
// Idempotency-Key on the generate path reattaches to the same run instead of starting a second
// one") and `routes.chats.test.ts` ("a duplicate Idempotency-Key on POST /chats returns the same
// chat rather than creating a second one"). The cross-endpoint collision fix (a single store
// shared across both routes) is exercised there too: `routes.runs.test.ts`'s "a chat-creation
// Idempotency-Key does not collide with a generate call reusing the same key value". The
// cross-OWNER leak fix (N1, final-gate fix round) is exercised at both layers too: the owner
// tests below cover the store's own key derivation, and `routes.chats.test.ts`/
// `routes.runs.test.ts` each have a same-tenant-different-owner regression test reproducing the
// live-repro scenario end to end.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdempotencyStore } from './idempotency.js'

test('an idempotency key replays the original result instead of re-running', () => {
  const store = new IdempotencyStore()
  const first = store.remember('acme', 'u1', 'runs:generate', 'key-1', { run_id: 'run_a' })
  assert.deepEqual(first, { run_id: 'run_a' })
  const replay = store.lookup('acme', 'u1', 'runs:generate', 'key-1')
  assert.deepEqual(replay, { run_id: 'run_a' }, 'a retry must return the ORIGINAL run, not start a second')
})

test('idempotency keys are scoped per tenant', () => {
  const store = new IdempotencyStore()
  store.remember('acme', 'u1', 'runs:generate', 'shared-key', { run_id: 'run_a' })
  assert.equal(store.lookup('globex', 'u1', 'runs:generate', 'shared-key'), null)
})

// N1 (final-gate fix round): tenant scoping alone let a same-tenant, DIFFERENT owner replay
// another owner's cached result verbatim — a tenant's API key is shared across an integrator's
// many end users (spec 27 §3.1), so this was a live, reproducible cross-owner data leak (a
// chat's private metadata, and a generation's real run id and streamed content). `owner` is now
// a mandatory positional component of the key, same discipline as `tenant`/`op`.
test('idempotency keys are scoped per owner within a tenant — a different owner reusing the same key gets a miss, not the other owner\'s cached data', () => {
  const store = new IdempotencyStore()
  store.remember('acme', 'owner-a', 'runs:generate', 'shared-key', { run_id: 'owner-a-run', secret: 'owner-a-only-data' })
  assert.equal(store.lookup('acme', 'owner-b', 'runs:generate', 'shared-key'), null,
    'a different owner within the SAME tenant must never see the other owner\'s cached value')
  // The original owner's own replay must still work — owner scoping must not have broken the
  // normal same-owner replay path.
  assert.deepEqual(store.lookup('acme', 'owner-a', 'runs:generate', 'shared-key'), { run_id: 'owner-a-run', secret: 'owner-a-only-data' })
})

test('idempotency keys are scoped per operation — the same key value used for two different operations never collides', () => {
  const store = new IdempotencyStore()
  store.remember('acme', 'u1', 'chats:create', 'shared-key', { id: 'chat_a' })
  assert.equal(store.lookup('acme', 'u1', 'runs:generate', 'shared-key'), null, 'a different op with the same tenant+owner+key must be a miss, not the other op\'s cached value')
})

test('expired idempotency entries are dropped', () => {
  const store = new IdempotencyStore({ ttlMs: 1 })
  store.remember('acme', 'u1', 'runs:generate', 'k', { run_id: 'r' })
  store.prune(Date.now() + 10)
  assert.equal(store.lookup('acme', 'u1', 'runs:generate', 'k'), null)
})
