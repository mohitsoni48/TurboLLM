import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execListModels, type ModelToolsStore } from './model-tools'

function fakeStore(models: Array<{ key: string; name: string; quant: string; sizeLabel: string }> = []): ModelToolsStore {
  return { list: () => ({ models }) }
}

test('execListModels: empty library points at the Models screen instead of showing nothing', () => {
  assert.equal(execListModels({}, fakeStore()), 'No models in the library yet — add one in TurboLLM\'s Models screen first.')
})

test('execListModels: lists the exact compound modelKey, not just a display name', () => {
  const store = fakeStore([{ key: 'gemma 4 26b a4b qat|Q4_0|14439362752', name: 'Gemma 4 26B A4B QAT', quant: 'Q4_0', sizeLabel: '26B-A4B' }])
  const out = execListModels({}, store)
  assert.equal(out, '- gemma 4 26b a4b qat|Q4_0|14439362752 — Gemma 4 26B A4B QAT (Q4_0, 26B-A4B)')
})

test('execListModels: multiple models, one row each', () => {
  const store = fakeStore([
    { key: 'a', name: 'Model A', quant: 'Q4_0', sizeLabel: '8B' },
    { key: 'b', name: 'Model B', quant: 'Q6_K', sizeLabel: '35B' },
  ])
  const out = execListModels({}, store)
  assert.equal(out, '- a — Model A (Q4_0, 8B)\n- b — Model B (Q6_K, 35B)')
})
