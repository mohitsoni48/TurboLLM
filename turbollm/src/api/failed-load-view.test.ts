// The load-failure banner's Retry loads the model that failed. After a failed gateway auto-swap the config's
// lastLoaded still names the PREVIOUS model (it is recorded only once a load succeeds), so the failure carries the
// key of the model it tried itself.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failedLoadView } from './failed-load-view'

type ViewDeps = Parameters<typeof failedLoadView>[0]

function depsTrying(model: { key: string; name: string } | null): ViewDeps {
  return {
    manager: { restartOpts: () => (model ? { engine: { name: 'llama.cpp', kind: 'llama-server' }, model } : null) },
    scanner: { get: () => undefined },
  } as unknown as ViewDeps
}

test('a failed load names the key of the model it tried', () => {
  assert.equal(failedLoadView(depsTrying({ key: 'qwen3-35b', name: 'Qwen3 35B' })).modelKey, 'qwen3-35b')
})

test('with no load recorded the key is empty, like the names', () => {
  assert.deepEqual(failedLoadView(depsTrying(null)), { engineName: '', modelName: '', modelKey: '', expectedToLoad: true })
})
