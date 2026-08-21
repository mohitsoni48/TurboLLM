import { test } from 'node:test'
import assert from 'node:assert/strict'
import { negotiateVersion, LINK_API_VERSIONS } from './protocol'

test('picks the highest version both sides speak', () => {
  assert.equal(negotiateVersion([1, 2, 3], [2, 3]), 3)
  assert.equal(negotiateVersion([1, 2], [2, 3]), 2)
})

test('returns null when there is no overlap — the incompatible state', () => {
  assert.equal(negotiateVersion([3, 4], [1, 2]), null)
})

test('returns null rather than throwing when the peer sends nothing usable', () => {
  // An older host, or a URL that is not a TurboLLM daemon at all, must land in
  // "incompatible" with a diagnosable message — never a 500 or an exception.
  assert.equal(negotiateVersion([1], undefined), null)
  assert.equal(negotiateVersion([1], []), null)
  assert.equal(negotiateVersion([1], ['x'] as never), null)
})

test('ignores non-integer and negative junk in the peer list', () => {
  assert.equal(negotiateVersion([1], [1.5, -1, 1] as never), 1)
})

test('this build advertises at least version 1', () => {
  assert.ok(LINK_API_VERSIONS.includes(1))
})
