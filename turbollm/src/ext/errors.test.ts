import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StoreError } from '../chat/store/chat-store.js'
import { mapStoreError, EXT_ERROR_TYPES } from './errors.js'

test('the frozen type list is exactly the nine spec types', () => {
  assert.deepEqual([...EXT_ERROR_TYPES].sort(), [
    'auth', 'capacity', 'conflict', 'engine', 'internal',
    'invalid_request', 'not_found', 'storage', 'unsupported',
  ])
})

test('store not_found maps to a 404', () => {
  const m = mapStoreError(new StoreError('not_found', 'chat gone'))
  assert.equal(m.status, 404)
  assert.equal(m.type, 'not_found')
  assert.equal(m.retryable, false)
})

test('store version_conflict maps to a retryable 409', () => {
  const m = mapStoreError(new StoreError('version_conflict', 'stale'))
  assert.equal(m.status, 409)
  assert.equal(m.code, 'version_conflict')
  assert.equal(m.retryable, true)
})

test('store not_supported maps to 501 unsupported, NOT invalid_request', () => {
  const m = mapStoreError(new StoreError('not_supported', 'no branching'))
  assert.equal(m.status, 501)
  assert.equal(m.type, 'unsupported', 'a server capability gap must not read as a malformed request')
})

test('store contract_violation maps to a non-retryable 500 storage error', () => {
  const m = mapStoreError(new StoreError('contract_violation', 'garbage row'))
  assert.equal(m.status, 500)
  assert.equal(m.type, 'storage')
  assert.equal(m.code, 'storage_contract_violation')
  assert.equal(m.retryable, false)
})

// I3 (release-gate finding): a malformed pagination cursor is a CALLER mistake, not the
// adapter violating its own contract — it was previously indistinguishable from
// contract_violation (500 storage), which reads as an operator-facing incident and makes
// retryable:false hand a well-behaved client no way to recover other than giving up.
test('store invalid_cursor maps to a non-retryable 400 invalid_request, distinct from contract_violation', () => {
  const m = mapStoreError(new StoreError('invalid_cursor', 'invalid_cursor: not decodable'))
  assert.equal(m.status, 400)
  assert.equal(m.type, 'invalid_request')
  assert.equal(m.code, 'invalid_cursor')
  assert.equal(m.retryable, false)
})

test('an unknown error maps to internal and never leaks its message', () => {
  const m = mapStoreError(new Error('SELECT * FROM secrets failed at /home/user/db'))
  assert.equal(m.status, 500)
  assert.equal(m.type, 'internal')
  assert.ok(!m.message.includes('/home/user'), 'internal errors must not leak paths or SQL to a tenant')
})
