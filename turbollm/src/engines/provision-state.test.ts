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

// The web banner keys a dismissed failure to the run's start time: a retry can fail the same way between two of its
// 2 s /status polls, and with nothing else to tell the two failures apart it stayed hidden.
test('each run carries its own startedAt, kept on its failure and cleared when it ends', (t) => {
  const state = new ProvisionState()
  assert.equal(state.get().startedAt, 0)
  t.mock.method(Date, 'now', () => 1000)
  state.start('vllm', 'runtime_env')
  assert.equal(state.get().startedAt, 1000)
  state.fail('Could not install vLLM: pip failed')
  assert.equal(state.get().startedAt, 1000, 'the failure names its run')
  t.mock.method(Date, 'now', () => 1500)
  state.start('vllm', 'runtime_env')
  state.fail('Could not install vLLM: pip failed')
  assert.deepEqual([state.get().error, state.get().startedAt], ['Could not install vLLM: pip failed', 1500], 'the same failure, another run')
  state.start('vllm', 'runtime_env')
  state.done()
  assert.equal(state.get().startedAt, 0)
})
