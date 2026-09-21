import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execListModels, formatModelLine, LIST_MODELS_TOOL, type ModelToolsStore } from './model-tools'

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

// ── Jev models are marked, never hidden (ADR-434 (f)) ──────────────────────────────────────────
// A Jev model labels text: it cannot chat and cannot be a routine's modelKey. It stays listed —
// a model asked to classify needs its key — but the line says what it is.

const JEV_ROW = {
  key: 'jev-fake-v2', name: 'jev fake v2', quant: 'mlx-fp16', sizeLabel: '4B',
  jev: { labels: ['contradiction', 'entailment', 'neutral'], architecture: 'Qwen3_5ForSequenceClassification', verified: true },
}
const CHAT_ROW = { key: 'qwen3-8b', name: 'Qwen3 8B', quant: 'Q4_K_M', sizeLabel: '8B' }

test('formatModelLine: a chat model line is byte-identical to the one shipped today', () => {
  assert.equal(formatModelLine(CHAT_ROW), '- qwen3-8b — Qwen3 8B (Q4_K_M, 8B)')
})

test('formatModelLine: a Jev model says so, in one suffix', () => {
  assert.equal(
    formatModelLine(JEV_ROW),
    '- jev-fake-v2 — jev fake v2 (mlx-fp16, 4B) — kind: jev (labels text; cannot chat or run a routine)',
  )
})

test('execListModels: a Jev model stays in the list, marked; the chat row is unchanged', () => {
  const out = execListModels({}, { list: () => ({ models: [CHAT_ROW, JEV_ROW] }) })

  assert.deepEqual(out.split('\n'), [formatModelLine(CHAT_ROW), formatModelLine(JEV_ROW)])
})

test('list_models tells the caller never to use a Jev model as a routine target', () => {
  assert.match(LIST_MODELS_TOOL.function.description, /kind: jev/)
  assert.match(LIST_MODELS_TOOL.function.description, /never use one as a routine modelKey/)
})
