import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  engineAcceptsFormat,
  engineModelAlias,
  engineWithholdsTools,
  engineWithholdsVision,
  modelIncompatibility,
} from './compat'

const SDK = 'turbollm-sdk'
const OTHER_KINDS = [
  'llama-server', 'llamafile', 'koboldcpp', 'mlx', 'rapid-mlx', 'mlx-vlm', 'vllm', 'sglang', 'litert-lm', 'laya',
]

test('engineAcceptsFormat: the in-app SDK engine takes GGUF and .litertlm, not MLX', () => {
  assert.equal(engineAcceptsFormat(SDK, 'gguf'), true)
  assert.equal(engineAcceptsFormat(SDK, 'litertlm'), true)
  assert.equal(engineAcceptsFormat(SDK, 'mlx'), false)
})

test('engineModelAlias: the SDK engine is addressed by the model file path', () => {
  assert.equal(engineModelAlias(SDK, '/models/qwen.gguf'), '/models/qwen.gguf')
  assert.equal(engineModelAlias(SDK), null)
})

test('engineWithholdsTools: only the SDK engine withholds tools', () => {
  assert.equal(engineWithholdsTools(SDK), true)
  for (const kind of OTHER_KINDS) assert.equal(engineWithholdsTools(kind), false, kind)
})

test('engineWithholdsVision: only the SDK engine withholds vision', () => {
  assert.equal(engineWithholdsVision(SDK), true)
  for (const kind of OTHER_KINDS) assert.equal(engineWithholdsVision(kind), false, kind)
})

test('a format refusal on the SDK engine names it TurboLLM SDK', () => {
  assert.equal(
    modelIncompatibility(SDK, { format: 'mlx', audio: false })?.message,
    "TurboLLM SDK can't run this safetensors model.",
  )
})
