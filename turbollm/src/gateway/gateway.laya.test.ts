// A Laya model, like a Jev one, can neither chat nor embed, and the chat gateway must say so before route() could
// auto-swap the whole Laya engine in for a request that cannot be answered (found by the v1.14.1 Opus review).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { registerGateway } from './gateway'

const LAYA_KEY = 'laya|laya|1486444724'
const GGUF_KEY = 'qwen3-8b|Q4|123'
const ENGINE = 'http://engine.local'

const LAYA = { key: LAYA_KEY, name: 'laya', laya: { checkpoints: ['english', 'multilingual'] } } as unknown as ModelEntry
const GGUF = { key: GGUF_KEY, name: 'Qwen3 8B' } as unknown as ModelEntry
const LIBRARY = [LAYA, GGUF]

function deps(routed: string[] = []): Deps {
  const byKeyOrName = (id: string) => LIBRARY.find((e) => e.key === id || e.name === id)
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: {
      route: async (model: string) => { routed.push(model); return { target: ENGINE } },
      targetEntry: byKeyOrName,
      resolveRemoteTarget: () => undefined,
      resolveLocal: byKeyOrName,
      routeTo: async () => ({ target: ENGINE }),
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'running', model: { key: GGUF_KEY, name: 'Qwen3 8B' } }),
      target: () => ENGINE,
      currentOpts: () => undefined,
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'llama-server' }) },
  } as unknown as Deps
}

function app(d: Deps): Hono {
  const a = new Hono()
  registerGateway(a, d)
  return a
}

function post(a: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

const CANNOT_CHAT = "'laya' is a Laya model: it answers System One questions and cannot chat. Call POST /v1/systemone instead."
const CANNOT_EMBED = "'laya' is a Laya model: it answers System One questions and cannot produce embeddings. Call POST /v1/systemone instead."

test('POST /v1/chat/completions on a Laya model → 400 laya_model_wrong_endpoint, nothing routed or loaded', async () => {
  const routed: string[] = []
  const res = await post(app(deps(routed)), '/v1/chat/completions', { model: LAYA_KEY, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), {
    error: { type: 'invalid_request_error', code: 'laya_model_wrong_endpoint', message: CANNOT_CHAT },
  })
  assert.deepEqual(routed, [], 'route() must not run: it would auto-swap the Laya engine in')
})

test('POST /v1/embeddings on a Laya model → 400 laya_model_wrong_endpoint naming embeddings', async () => {
  const routed: string[] = []
  const res = await post(app(deps(routed)), '/v1/embeddings', { model: 'laya', input: 'hello' })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), {
    error: { type: 'invalid_request_error', code: 'laya_model_wrong_endpoint', message: CANNOT_EMBED },
  })
  assert.deepEqual(routed, [])
})

test('POST /v1/messages on a Laya model → 400 in the Anthropic error envelope', async () => {
  const routed: string[] = []
  const res = await post(app(deps(routed)), '/v1/messages', {
    model: `claude-${LAYA_KEY}`, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { type: 'error', error: { type: 'invalid_request_error', message: CANNOT_CHAT } })
  assert.deepEqual(routed, [])
})

test('chat on an ordinary model still routes exactly as before', async () => {
  const routed: string[] = []
  await post(app(deps(routed)), '/v1/chat/completions', { model: GGUF_KEY, messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual(routed, [GGUF_KEY])
})

test('GET /v1/models marks a Laya model kind "laya" with no claude- alias; other rows are unchanged', async () => {
  const res = await app(deps()).request('/v1/models')
  const body = (await res.json()) as { data: Array<Record<string, unknown>> }
  assert.deepEqual(body.data, [
    { id: LAYA_KEY, object: 'model', owned_by: 'turbollm', kind: 'laya' },
    { id: GGUF_KEY, object: 'model', owned_by: 'turbollm' },
    { id: `claude-${GGUF_KEY}`, object: 'model', display_name: 'Qwen3 8B — TurboLLM' },
  ])
})
