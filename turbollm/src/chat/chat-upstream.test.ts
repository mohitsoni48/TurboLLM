// resolveChatUpstream while a Jev model is the primary (ADR-434 (f)). The in-app
// chat — the standalone /chat view and routine runs — gets a clear 409 instead of the engine's
// opaque 404, because a Jev model labels premise/hypothesis pairs and cannot chat. Everything else
// resolveChatUpstream decides stays exactly as it was.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { resolveChatUpstream } from './chat-upstream'

const ENGINE = 'http://engine.invalid'
const JEV_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const GGUF_KEY = 'qwen3-8b|Q4|123'

/** The OpenJev checkpoint as the scanner lists it. */
const OPENJEV_ENTRY = {
  key: JEV_KEY,
  name: 'qwen3.5 4b nli v2',
  jev: {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
  },
} as unknown as ModelEntry
const GGUF_ENTRY = { key: GGUF_KEY, name: 'Qwen3 8B' } as unknown as ModelEntry
const LAYA_KEY = 'laya|laya|1455'
const LAYA_ENTRY = { key: LAYA_KEY, name: 'laya', laya: { checkpoints: ['english'] } } as unknown as ModelEntry
const LIBRARY = [OPENJEV_ENTRY, GGUF_ENTRY, LAYA_ENTRY]
const CANNOT_CHAT = {
  ok: false,
  status: 409,
  code: 'jev_model_loaded',
  message: 'A text classification model is loaded — it cannot chat. Switch to a chat model, or use the text classification playground.',
}

const REMOTE = { linkId: 'lnk1', baseUrl: 'https://rig.invalid', token: 'tllm-hostsecret', modelKey: GGUF_KEY }

interface PrimaryState {
  state: 'running' | 'stopped'
  modelKey?: string
  audio?: boolean
}

/** The members resolveChatUpstream reads, with the primary engine in the given state. */
function chatDeps(primary: PrimaryState): Deps {
  const loaded = LIBRARY.find((e) => e.key === primary.modelKey)
  return {
    manager: {
      status: () => ({ state: primary.state, model: loaded ? { key: loaded.key, name: loaded.name, ctx: 8192, ...(primary.audio !== undefined ? { audio: primary.audio } : {}) } : null }),
      target: () => (primary.state === 'running' ? ENGINE : null),
      currentOpts: () => undefined,
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    scanner: { get: (key: string) => LIBRARY.find((e) => e.key === key) },
    modelRouter: {
      resolveRemoteTarget: (id: string) => (id === `Rig/${GGUF_KEY}` ? { target: REMOTE.baseUrl, remote: REMOTE } : undefined),
    },
  } as unknown as Deps
}

test('a Jev model loaded as the primary → 409 jev_model_loaded instead of an upstream to chat with', () => {
  assert.deepEqual(resolveChatUpstream(chatDeps({ state: 'running', modelKey: JEV_KEY })), CANNOT_CHAT)
})

test('a Laya model in the primary would get the same refusal: one rule for every text classification model', () => {
  assert.deepEqual(resolveChatUpstream(chatDeps({ state: 'running', modelKey: LAYA_KEY })), CANNOT_CHAT)
})

test('a chat model loaded as the primary resolves exactly as before', () => {
  assert.deepEqual(resolveChatUpstream(chatDeps({ state: 'running', modelKey: GGUF_KEY })), {
    ok: true,
    upstream: { modelField: GGUF_KEY, modelName: 'Qwen3 8B', ctxMax: 8192, target: ENGINE, engineKind: 'llama.cpp' },
  })
})

test('no model running is still model_not_loaded', () => {
  assert.deepEqual(resolveChatUpstream(chatDeps({ state: 'stopped' })), {
    ok: false, status: 409, code: 'model_not_loaded', message: 'Load a model first.',
  })
})

test('a Turbo Link turn is untouched by a local Jev primary', () => {
  const result = resolveChatUpstream(chatDeps({ state: 'running', modelKey: JEV_KEY }), `Rig/${GGUF_KEY}`)
  assert.deepEqual(result, {
    ok: true,
    upstream: { modelField: GGUF_KEY, modelName: GGUF_KEY, ctxMax: 4096, remote: REMOTE, target: '' },
  })
})

test('hearsAudio is set only when the primary engine\'s loaded model reports audio', () => {
  const hears = resolveChatUpstream(chatDeps({ state: 'running', modelKey: GGUF_KEY, audio: true }))
  assert.ok(hears.ok && hears.upstream.hearsAudio === true)
  for (const audio of [false, undefined]) {
    const r = resolveChatUpstream(chatDeps({ state: 'running', modelKey: GGUF_KEY, audio }))
    assert.ok(r.ok && !('hearsAudio' in r.upstream), `audio ${audio}`)
  }
})

test('a Turbo Link upstream never hears audio, even when the local primary does', () => {
  const r = resolveChatUpstream(chatDeps({ state: 'running', modelKey: GGUF_KEY, audio: true }), `Rig/${GGUF_KEY}`)
  assert.ok(r.ok && !('hearsAudio' in r.upstream))
})
