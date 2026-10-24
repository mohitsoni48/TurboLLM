import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampMaxTokens } from '../config/config'
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

// The refusal names the selected engine and the format, never another engine: it said "activate the LiteRT-LM engine
// to load it", advice the owner's rule forbids (a model loads only on the engine the user selected).
const LITERT_REFUSALS: Record<string, string> = {
  'llama-server': "llama.cpp can't run this .litertlm model.",
  koboldcpp: "KoboldCpp can't run this .litertlm model.",
  mlx: "MLX can't run this .litertlm model.",
  vllm: "vLLM can't run this .litertlm model.",
  sglang: "SGLang can't run this .litertlm model.",
}
for (const [kind, message] of Object.entries(LITERT_REFUSALS)) {
  test(`modelIncompatibility: a .litertlm model on ${kind} is refused in that engine's name, naming no other`, () => {
    assert.deepEqual(modelIncompatibility(kind, LITERT), { code: 'format', label: 'needs LiteRT-LM', message })
  })
}

test('modelIncompatibility: GGUF and safetensors models on LiteRT-LM are refused in its name, naming no other engine', () => {
  assert.equal(modelIncompatibility('litert-lm', GGUF)?.message, "LiteRT-LM can't run this GGUF model.")
  assert.equal(modelIncompatibility('litert-lm', MLX)?.message, "LiteRT-LM can't run this safetensors model.")
  for (const entry of [GGUF, MLX]) assert.equal(modelIncompatibility('litert-lm', entry)?.code, 'format')
})

test('engineModelAlias: LiteRT-LM sends the model path, or null without one', () => {
  assert.equal(engineModelAlias('litert-lm', '/models/m.litertlm'), '/models/m.litertlm')
  assert.equal(engineModelAlias('litert-lm', null), null)
  assert.equal(engineModelAlias('litert-lm'), null)
})

test('applyEngineTokenLimit: LiteRT-LM gets max_completion_tokens instead of max_tokens', () => {
  assert.deepEqual(applyEngineTokenLimit('litert-lm', { model: 'm', max_tokens: 256 }), { model: 'm', max_completion_tokens: 256 })
})

test('applyEngineTokenLimit: an explicit max_completion_tokens ABOVE the cap is clamped to it (the cap cannot be bypassed)', () => {
  // The regression (PR #271 review): the gateway clamps `max_tokens` against the daemon's
  // max-token limit, then this function used to let an explicit client
  // `max_completion_tokens` win and DELETED the clamped value — so a client could send
  // max_completion_tokens: 1000000 and run uncapped on litert-lm. The merged value must
  // respect the clamped `max_tokens`.
  assert.deepEqual(
    applyEngineTokenLimit('litert-lm', { max_tokens: 4096, max_completion_tokens: 1_000_000 }),
    { max_completion_tokens: 4096 },
  )
})

test('applyEngineTokenLimit: a smaller explicit max_completion_tokens is honoured, and no cap stays no cap', () => {
  // Both keys name the same cap, so the SMALLER wins — never more than what the clamped
  // max_tokens allows, but also never less than the caller explicitly asked for.
  assert.deepEqual(
    applyEngineTokenLimit('litert-lm', { max_tokens: 4096, max_completion_tokens: 50 }),
    { max_completion_tokens: 50 },
  )
  assert.deepEqual(
    applyEngineTokenLimit('litert-lm', { max_tokens: 10, max_completion_tokens: 20 }),
    { max_completion_tokens: 10 },
  )
  assert.deepEqual(applyEngineTokenLimit('litert-lm', { model: 'm' }), { model: 'm' })
})

test('applyEngineTokenLimit: non-numeric values pass through untouched rather than becoming NaN', () => {
  assert.deepEqual(
    applyEngineTokenLimit('litert-lm', { max_tokens: 4096, max_completion_tokens: 'weird' }),
    { max_completion_tokens: 'weird' },
  )
})

test('applyEngineTokenLimit: every other engine is left untouched', () => {
  for (const kind of ['llama-server', 'mlx', 'vllm', 'sglang', 'mlx-vlm', 'koboldcpp']) {
    assert.deepEqual(applyEngineTokenLimit(kind, { max_tokens: 5 }), { max_tokens: 5 }, kind)
  }
})

test('applyEngineTokenLimit ordering: a client max_completion_tokens cannot exceed the clamped max_tokens (the shape every route produces)', () => {
  // PR #271 re-review: the min() inside applyEngineTokenLimit enforces the daemon's
  // max-token cap ONLY because every caller runs clampMaxTokens on `max_tokens` immediately
  // before it — with a limit configured, clampMaxTokens ALWAYS leaves a numeric max_tokens
  // in the body (the limit itself when the request sent none). This locks that exact
  // two-step shape end to end: a client that sent max_completion_tokens: 1e6 with no
  // max_tokens of its own still lands on the 8192 cap, and only max_completion_tokens —
  // the one key litert-lm's server reads — goes out.
  const limit = 8192
  const reqBody: Record<string, unknown> = { model: 'm', max_completion_tokens: 1_000_000 }
  const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, limit)
  if (cappedMax != null) reqBody.max_tokens = cappedMax
  else delete reqBody.max_tokens
  applyEngineTokenLimit('litert-lm', reqBody)
  assert.equal(reqBody.max_completion_tokens, 8192)
  assert.equal('max_tokens' in reqBody, false)
})
