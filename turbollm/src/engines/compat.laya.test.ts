import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineAcceptsFormat, engineModelAlias, modelIncompatibility } from './compat'

const LAYA_ENTRY = { format: 'mlx' as const, audio: false, laya: { checkpoints: ['english', 'multilingual'] } }
const PLAIN_GGUF = { format: 'gguf', audio: false } as const
const PLAIN_MLX = { format: 'mlx', audio: false } as const

test('modelIncompatibility: a Laya model on the Laya engine is loadable', () => {
  assert.equal(modelIncompatibility('laya', LAYA_ENTRY), null)
})

for (const engineKind of ['llama-server', 'mlx', 'vllm', 'sglang', 'koboldcpp']) {
  test(`modelIncompatibility: a Laya model on ${engineKind} needs the Laya engine`, () => {
    assert.deepEqual(modelIncompatibility(engineKind, LAYA_ENTRY), {
      code: 'needs_laya',
      label: 'Needs the Laya engine',
      message: 'This is a Laya model — it runs only on the Laya engine. Install Laya from Engines to load it.',
    })
  })
}

test('modelIncompatibility: the Laya engine loads nothing but Laya models', () => {
  for (const entry of [PLAIN_GGUF, PLAIN_MLX]) {
    const inc = modelIncompatibility('laya', entry)
    assert.equal(inc?.code, 'format')
    assert.equal(inc?.message, 'The Laya engine runs only Laya models — load this one on another engine.')
  }
})

test('engineAcceptsFormat: no plain format belongs to the Laya engine', () => {
  assert.equal(engineAcceptsFormat('laya', 'gguf'), false)
  assert.equal(engineAcceptsFormat('laya', 'mlx'), false)
})

test('engineModelAlias: laya-serve ignores the model field, so the caller keeps its own', () => {
  assert.equal(engineModelAlias('laya'), null)
})

// The Laya GGUF conversions on Hugging Face (mys/laya-GGUF and friends) use the `ggmlc` architecture, a separate
// runtime llama.cpp cannot load ("unknown model architecture: 'ggmlc'"), found live on 6996, 2026-09-25.
const GGMLC_GGUF = { format: 'gguf' as const, audio: false, arch: 'ggmlc' }

test('modelIncompatibility: a ggmlc GGUF is refused on every engine, pointing at the Laya repo that runs', () => {
  for (const engineKind of ['llama-server', 'koboldcpp', 'llamafile', 'laya', 'vllm']) {
    assert.deepEqual(modelIncompatibility(engineKind, GGMLC_GGUF), {
      code: 'format',
      label: 'ggmlc GGUF — not loadable',
      message:
        "This GGUF uses the ggmlc architecture, which llama.cpp can't load. For Laya, download " +
        'convaiinnovations/laya instead: it runs on the Laya engine.',
    }, engineKind)
  }
})

test('modelIncompatibility: an ordinary GGUF on llama.cpp is still loadable', () => {
  assert.equal(modelIncompatibility('llama-server', { format: 'gguf', audio: false, arch: 'qwen3' }), null)
})
