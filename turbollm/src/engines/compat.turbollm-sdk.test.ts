import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  engineAcceptsFormat,
  engineModelAlias,
  engineWithholdsTools,
  engineWithholdsVision,
  modelIncompatibility,
  shapeForEngine,
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

test('shapeForEngine: the SDK engine is sent the first 4 stop strings, and the dropped ones are logged once', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const body = { stop: ['a', 'b', 'c', 'd', 'e'] }
  assert.deepEqual(shapeForEngine(SDK, body).stop, ['a', 'b', 'c', 'd'])
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /e/)
  shapeForEngine(SDK, { stop: ['a', 'b', 'c', 'd', 'e', 'f'] })
  assert.equal(warn.mock.callCount(), 1)
})

test('shapeForEngine: up to 4 stop strings reach the SDK engine unchanged', () => {
  assert.deepEqual(shapeForEngine(SDK, { stop: ['a', 'b', 'c'] }).stop, ['a', 'b', 'c'])
})

test('shapeForEngine: a single string stop reaches the SDK engine unchanged', () => {
  assert.equal(shapeForEngine(SDK, { stop: '</answer>' }).stop, '</answer>')
})

test('shapeForEngine: other engines keep every stop string', () => {
  for (const kind of OTHER_KINDS) {
    assert.deepEqual(shapeForEngine(kind, { stop: ['a', 'b', 'c', 'd', 'e'] }).stop, ['a', 'b', 'c', 'd', 'e'], kind)
  }
})
