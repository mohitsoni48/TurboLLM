import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProvisionState } from './provision-state'

test('startCount counts every start, so a caller can tell whether a run began', () => {
  const state = new ProvisionState()
  const before = state.startCount()
  state.start('github-release', 'user_update')
  state.fail('boom')
  state.start('github-release', 'user_update')
  assert.equal(state.startCount(), before + 2)
})
