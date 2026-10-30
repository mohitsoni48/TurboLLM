// Sampling through the gateway to a LiteRT-LM engine, as llama.cpp's launch flags give it to every client: the sampling
// the user saved for the model fills what a client leaves out, and a client that sets part of the sampler (a
// temperature alone) gets the rest from the bundle's own, not `serve`'s top_k 1 (greedy). llama.cpp is unchanged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { rememberLitertLmModel } from '../engines/litert-lm-request'

const ENGINE = 'http://engine.invalid'
const MODEL_PATH = '/models/Qwen3-0.6B.litertlm'
const KEY = 'qwen3 0.6b|?|3000'
const ENTRY = { key: KEY, name: 'Qwen3 0.6B', format: 'litertlm', path: MODEL_PATH } as unknown as ModelEntry

function deps(kind: string): Deps {
  const byKeyOrName = (id: string) => (id === KEY || id === ENTRY.name ? ENTRY : undefined)
  return {
    scanner: { list: () => ({ models: [ENTRY], scanning: false, lastScanAt: '' }) },
    modelRouter: {
      route: async () => ({ target: ENGINE }),
      targetEntry: byKeyOrName,
      resolveRemoteTarget: () => undefined,
      resolveLocal: byKeyOrName,
      routeTo: async () => ({ target: ENGINE }),
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'running', model: { key: KEY, name: ENTRY.name } }),
      target: () => ENGINE,
      currentOpts: () => ({ modelPath: MODEL_PATH }),
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind }) },
    db: { recordApiUsage: () => {} },
  } as unknown as Deps
}

async function engineBody(kind: string, path: '/v1/chat/completions' | '/v1/messages', body: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
  const app = new Hono()
  registerGateway(app, deps(kind))
  const bodies: Array<Record<string, unknown>> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: KEY, messages: [{ role: 'user', content: 'hi' }], ...(path === '/v1/messages' ? { max_tokens: 4000 } : {}), ...body }),
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(bodies.length, 1)
  return bodies[0]
}

const pick = (b: Record<string, unknown>) => Object.fromEntries(['temperature', 'top_p', 'top_k'].filter((k) => k in b).map((k) => [k, b[k]]))

test('an API client\'s temperature alone reaches a LiteRT-LM model with the rest of the bundle\'s own sampler', async () => {
  rememberLitertLmModel(MODEL_PATH, { sampling: {}, sampler: { topK: 20, topP: 0.95, temp: 0.6 }, native: false })
  assert.deepEqual(pick(await engineBody('litert-lm', '/v1/chat/completions', { temperature: 0.7 })), { temperature: 0.7, top_k: 20, top_p: 0.95 })
  assert.deepEqual(pick(await engineBody('litert-lm', '/v1/messages', { temperature: 0.7 })), { temperature: 0.7, top_k: 20, top_p: 0.95 })
  assert.deepEqual(pick(await engineBody('litert-lm', '/v1/chat/completions', {})), {}, 'nothing set: the model\'s own, as it is')
})

test('the sampling the user saved for a LiteRT-LM model fills what an API client leaves out; the client\'s wins', async () => {
  rememberLitertLmModel(MODEL_PATH, { sampling: { temperature: 0.3 }, sampler: { topK: 20, topP: 0.95, temp: 0.6 }, native: false })
  assert.deepEqual(pick(await engineBody('litert-lm', '/v1/chat/completions', {})), { temperature: 0.3, top_k: 20, top_p: 0.95 })
  assert.deepEqual(pick(await engineBody('litert-lm', '/v1/chat/completions', { temperature: 1.1 })), { temperature: 1.1, top_k: 20, top_p: 0.95 })
  assert.deepEqual(pick(await engineBody('llama-server', '/v1/chat/completions', { temperature: 0.7 })), { temperature: 0.7 }, 'llama.cpp: as before')
})
