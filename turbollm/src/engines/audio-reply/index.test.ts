// Which engine kinds have a spoken-reply runtime: only upstream llama.cpp's llama-server kind, nothing guessed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { audioReplyRuntimeFor } from './index'

test('llama-server has the realtime runtime', () => {
  assert.equal(typeof audioReplyRuntimeFor('llama-server')?.reply, 'function')
})

test('every other kind, an empty one and an undefined one have none', () => {
  for (const kind of ['vllm', 'mlx', 'mlx-vlm', 'rapid-mlx', 'sglang', 'litert-lm', 'llamafile', 'koboldcpp', 'laya', 'turbollm-sdk', '', 'llama.cpp', 'toString', '__proto__', undefined]) {
    assert.equal(audioReplyRuntimeFor(kind), null, String(kind))
  }
})
