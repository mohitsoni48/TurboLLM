import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEngineTokenLimit, engineAcceptsFormat, engineModelAlias, modelIncompatibility } from './compat'

const LITERT = { format: 'litertlm', audio: false } as const
const GGUF = { format: 'gguf', audio: false } as const
const MLX = { format: 'mlx', audio: false } as const

test('engineAcceptsFormat: LiteRT-LM takes .litertlm and nothing else', () => {
  assert.equal(engineAcceptsFormat('litert-lm', 'litertlm'), true)
  assert.equal(engineAcceptsFormat('litert-lm', 'gguf'), false)
  assert.equal(engineAcceptsFormat('litert-lm', 'mlx'), false)
})

test('engineAcceptsFormat: no other engine takes .litertlm', () => {
  for (const kind of ['llama-server', 'llamafile', 'koboldcpp', 'mlx', 'rapid-mlx', 'mlx-vlm', 'vllm', 'sglang', 'laya']) {
    assert.equal(engineAcceptsFormat(kind, 'litertlm'), false, kind)
  }
})

test('modelIncompatibility: a .litertlm model on LiteRT-LM is loadable', () => {
  assert.equal(modelIncompatibility('litert-lm', LITERT), null)
})

for (const kind of ['llama-server', 'koboldcpp', 'mlx', 'vllm', 'sglang']) {
  test(`modelIncompatibility: a .litertlm model on ${kind} points at the LiteRT-LM engine`, () => {
    assert.deepEqual(modelIncompatibility(kind, LITERT), {
      code: 'format',
      label: 'needs LiteRT-LM',
      message: 'This is a LiteRT-LM model (.litertlm) — activate the LiteRT-LM engine to load it.',
    })
  })
}

test('modelIncompatibility: GGUF and safetensors models on LiteRT-LM say which engine they need', () => {
  for (const entry of [GGUF, MLX]) {
    const inc = modelIncompatibility('litert-lm', entry)
    assert.equal(inc?.code, 'format')
    assert.match(inc?.message ?? '', /active engine is LiteRT-LM/)
  }
})

test('engineModelAlias: LiteRT-LM sends the model path, or null without one', () => {
  assert.equal(engineModelAlias('litert-lm', '/models/m.litertlm'), '/models/m.litertlm')
  assert.equal(engineModelAlias('litert-lm', null), null)
  assert.equal(engineModelAlias('litert-lm'), null)
})

test('applyEngineTokenLimit: LiteRT-LM gets max_completion_tokens instead of max_tokens', () => {
  assert.deepEqual(applyEngineTokenLimit('litert-lm', { model: 'm', max_tokens: 256 }), { model: 'm', max_completion_tokens: 256 })
})

test('applyEngineTokenLimit: an explicit max_completion_tokens wins, and no cap stays no cap', () => {
  assert.deepEqual(applyEngineTokenLimit('litert-lm', { max_tokens: 10, max_completion_tokens: 20 }), { max_completion_tokens: 20 })
  assert.deepEqual(applyEngineTokenLimit('litert-lm', { model: 'm' }), { model: 'm' })
})

test('applyEngineTokenLimit: every other engine is left untouched', () => {
  for (const kind of ['llama-server', 'mlx', 'vllm', 'sglang', 'mlx-vlm', 'koboldcpp']) {
    assert.deepEqual(applyEngineTokenLimit(kind, { max_tokens: 5 }), { max_tokens: 5 }, kind)
  }
})
