import test from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay, MAX_CONSECUTIVE_FAILURES } from './backoff'

test('backoff: doubles from 1s', () => {
  assert.equal(backoffDelay(0), 1_000)
  assert.equal(backoffDelay(1), 2_000)
  assert.equal(backoffDelay(2), 4_000)
  assert.equal(backoffDelay(3), 8_000)
  assert.equal(backoffDelay(4), 16_000)
  assert.equal(backoffDelay(5), 32_000)
})

test('backoff: caps at 60s and never grows past it', () => {
  assert.equal(backoffDelay(6), 60_000)
  assert.equal(backoffDelay(50), 60_000)
})

test('backoff: gives up after 10 consecutive failures', () => {
  assert.equal(MAX_CONSECUTIVE_FAILURES, 10)
})
