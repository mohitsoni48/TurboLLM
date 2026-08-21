import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LINK_CAPABILITIES } from './types'

// Design invariant 2 (README): engines is NOT grantable. ADR-139 settled that engine
// add/scan executes a caller-supplied binary path and no remote caller ever gets it,
// valid key or not. This test exists so a future "just add engines:read" cannot land
// quietly — it must come with an ADR that reverses ADR-139.
test('engines is not a grantable capability, in any spelling', () => {
  for (const cap of LINK_CAPABILITIES) {
    assert.ok(!cap.startsWith('engines'), `engines must never be grantable, found: ${cap}`)
  }
})

test('the capability set is exactly the eight the spec defines', () => {
  assert.deepEqual([...LINK_CAPABILITIES].sort(), [
    'config:read', 'config:write',
    'downloads:read', 'downloads:write',
    'models:load', 'models:unload', 'models:use', 'models:wake',
  ])
})
