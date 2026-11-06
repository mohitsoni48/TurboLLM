// The Android app's in-app engine (kind 'turbollm-sdk') answers only its own per-process bearer token, so every
// gateway request to it must carry that bearer instead of the client's credentials, and a TurboLLM API key must never
// reach its port (architecture §6.4, plan D-3). It serves no /tokenize in this version, so count_tokens estimates.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { ConfigStore, Engine } from '../config/config'
import type { Deps } from '../deps'
import type { Manager, StartOpts } from '../engines/manager'
import type { Registry } from '../engines/registry'
import type { ModelEntry, Scanner } from '../models/scanner'
import { registerGateway } from './gateway'
import { ModelRouter } from './model-router'

const ENGINE = 'http://engine.invalid'
const MODEL_PATH = '/models/qwen3-0.6b-Q4_K_M.gguf'
const KEY = 'qwen3 0.6b|Q4_K_M|400'
const ENTRY = { key: KEY, name: 'Qwen3 0.6B', format: 'gguf', path: MODEL_PATH } as unknown as ModelEntry
const SDK_TOKEN = 'sdk-process-token'
const CLIENT_KEY = 'Bearer turbollm-api-key'

function depsFor(engineKind: string): Deps {
  const byKeyOrName = (id: string) => (id === KEY || id === ENTRY.name ? ENTRY : undefined)
  return {
    scanner: { list: () => ({ models: [ENTRY], scanning: false, lastScanAt: '' }) },
    modelRouter: {
      route: async () => ({ target: ENGINE }),
      targetEntry: byKeyOrName,
      resolveRemoteTarget: () => undefined,
      resolveLocal: byKeyOrName,
      routeTo: async () => ({ target: ENGINE }),
      aliveSlots: () => [],
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'running', model: { key: KEY, name: ENTRY.name } }),
      target: () => ENGINE,
      currentOpts: () => ({ engine: { kind: engineKind }, modelPath: MODEL_PATH }),
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: engineKind }) },
  } as unknown as Deps
}

interface EngineCall { url: string; headers: Headers }

/** Swap in an engine that records each request's URL and headers, with the SDK token set, for `run` only. */
async function withRecordingEngine(run: (calls: EngineCall[]) => Promise<void>): Promise<void> {
  const calls: EngineCall[] = []
  const realFetch = globalThis.fetch
  const realToken = process.env.TURBOLLM_ANDROID_SDK_TOKEN
  process.env.TURBOLLM_ANDROID_SDK_TOKEN = SDK_TOKEN
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = realFetch
    if (realToken === undefined) delete process.env.TURBOLLM_ANDROID_SDK_TOKEN
    else process.env.TURBOLLM_ANDROID_SDK_TOKEN = realToken
  }
}

function gatewayFor(engineKind: string): Hono {
  const app = new Hono()
  registerGateway(app, depsFor(engineKind))
  return app
}

const CHAT = JSON.stringify({ model: KEY, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
const CLIENT_HEADERS = { 'content-type': 'application/json', authorization: CLIENT_KEY, 'x-api-key': 'turbollm-api-key' }

test('POST /v1/chat/completions to the SDK engine carries its bearer, not the client key', async () => {
  await withRecordingEngine(async (calls) => {
    await gatewayFor('turbollm-sdk').request('/v1/chat/completions', { method: 'POST', headers: CLIENT_HEADERS, body: CHAT })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${SDK_TOKEN}`)
    assert.equal(calls[0].headers.has('x-api-key'), false)
  })
})

// GET /v1/models is answered by the daemon itself; any other GET is passed through to the engine.
test('a passed-through GET to the SDK engine carries its bearer', async () => {
  await withRecordingEngine(async (calls) => {
    await gatewayFor('turbollm-sdk').request('/v1/props', { headers: { authorization: CLIENT_KEY } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${SDK_TOKEN}`)
  })
})

test('POST /v1/chat/completions to llama.cpp still forwards the client authorization', async () => {
  await withRecordingEngine(async (calls) => {
    await gatewayFor('llama-server').request('/v1/chat/completions', { method: 'POST', headers: CLIENT_HEADERS, body: CHAT })
    assert.equal(calls[0].headers.get('authorization'), CLIENT_KEY)
    assert.equal(calls[0].headers.get('x-api-key'), 'turbollm-api-key')
  })
})

test('POST /v1/messages to the SDK engine carries its bearer', async () => {
  await withRecordingEngine(async (calls) => {
    await gatewayFor('turbollm-sdk').request('/v1/messages', { method: 'POST', headers: CLIENT_HEADERS, body: CHAT })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${SDK_TOKEN}`)
  })
})

test('POST /v1/messages to llama.cpp sends no authorization, as before', async () => {
  await withRecordingEngine(async (calls) => {
    await gatewayFor('llama-server').request('/v1/messages', { method: 'POST', headers: CLIENT_HEADERS, body: CHAT })
    assert.equal(calls[0].headers.has('authorization'), false)
  })
})

test('count_tokens on the SDK engine estimates without calling /tokenize', async () => {
  await withRecordingEngine(async (calls) => {
    const res = await gatewayFor('turbollm-sdk').request('/v1/messages/count_tokens', {
      method: 'POST', headers: CLIENT_HEADERS, body: CHAT,
    })
    assert.equal(calls.length, 0)
    assert.equal(typeof ((await res.json()) as { input_tokens: unknown }).input_tokens, 'number')
  })
})

test('count_tokens on llama.cpp still asks the engine to tokenize', async () => {
  await withRecordingEngine(async (calls) => {
    await gatewayFor('llama-server').request('/v1/messages/count_tokens', { method: 'POST', headers: CLIENT_HEADERS, body: CHAT })
    assert.deepEqual(calls.map((c) => c.url), [`${ENGINE}/tokenize`])
  })
})

// QA F3 (B-08): the SDK serves no /v1/embeddings, and its unmatched-route reply is an empty 404. The daemon answers
// for it with the router's refusal of an embedding model on the SDK, so a client reads why in the OpenAI shape.
for (const [label, body] of [
  ['no model', JSON.stringify({ input: 'hi' })],
  ['the chat model', JSON.stringify({ model: KEY, input: 'hi' })],
] as const) {
  test(`POST /v1/embeddings naming ${label} on the SDK engine is refused by the daemon, not sent to the engine`, async () => {
    await withRecordingEngine(async (calls) => {
      const res = await gatewayFor('turbollm-sdk').request('/v1/embeddings', { method: 'POST', headers: CLIENT_HEADERS, body })
      assert.equal(calls.length, 0)
      assert.equal(res.status, 503)
      assert.equal(res.headers.get('x-should-retry'), 'false')
      const { error } = (await res.json()) as { error: { message: string; code: string } }
      assert.equal(error.message, 'The TurboLLM SDK engine runs one chat model at a time and has no embeddings in this version.')
      assert.equal(error.code, 'model_not_loaded')
    })
  })
}

test('POST /v1/embeddings to llama.cpp is still sent to the engine', async () => {
  await withRecordingEngine(async (calls) => {
    await gatewayFor('llama-server').request('/v1/embeddings', {
      method: 'POST', headers: CLIENT_HEADERS, body: JSON.stringify({ model: KEY, input: 'hi' }),
    })
    assert.deepEqual(calls.map((c) => c.url), [`${ENGINE}/v1/embeddings`])
  })
})

// QA fix round 2 (review M-1): an embeddings request naming another installed chat model is refused before routing.
// Routed first, the one-model SDK engine swapped the loaded chat model out for it, and only then was it refused.
function chatGguf(key: string): ModelEntry {
  return {
    key, name: key, quant: 'Q4_K_M', format: 'gguf', arch: 'qwen3', path: `/models/${key}.gguf`, nativeCtx: 4096,
    vision: false, embedding: false, incomplete: false, parseError: null,
  } as unknown as ModelEntry
}

/** The SDK engine active, `running` loaded in the primary, which records every model it is asked to load. */
function sdkGatewayWithLoadedModel(running: string, library: ModelEntry[]) {
  let loadedKey = running
  const loads: string[] = []
  const engine = { id: 'sdk', kind: 'turbollm-sdk', capabilities: { flags: [] } } as unknown as Engine
  const manager = {
    status: () => ({ state: 'running', err: null, port: 0, pid: 0, loadElapsedMs: 0, model: { key: loadedKey, name: loadedKey } }),
    currentOpts: () => ({ engine, modelPath: `/models/${loadedKey}.gguf`, model: { name: loadedKey } }),
    restartOpts: () => null,
    target: () => ENGINE,
    touch: () => {},
    load: async (opts: StartOpts) => { loads.push(opts.model.key); loadedKey = opts.model.key },
    generationStart: () => {},
    generationEnd: () => {},
  } as unknown as Manager
  const store = {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 1 }, modelDefaults: { maxTokens: 0 }, modelProfiles: {}, comfyui: {} }),
    update: (fn: (c: Record<string, unknown>) => void) => fn({}),
  } as unknown as ConfigStore
  const scanner = { list: () => ({ models: library }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => engine } as unknown as Registry
  const modelRouter = new ModelRouter(store, registry, manager, scanner, undefined)
  const app = new Hono()
  registerGateway(app, { scanner, modelRouter, store, manager, registry } as unknown as Deps)
  return { app, loads, loadedKey: () => loadedKey }
}

test('POST /v1/embeddings naming an unloaded chat model on the SDK engine keeps the loaded model and loads nothing', async () => {
  const { app, loads, loadedKey } = sdkGatewayWithLoadedModel('model-a', [chatGguf('model-a'), chatGguf('model-b')])
  await withRecordingEngine(async (calls) => {
    const res = await app.request('/v1/embeddings', {
      method: 'POST', headers: CLIENT_HEADERS, body: JSON.stringify({ model: 'model-b', input: 'hi' }),
    })
    assert.equal(res.status, 503)
    const { error } = (await res.json()) as { error: { message: string } }
    assert.equal(error.message, 'The TurboLLM SDK engine runs one chat model at a time and has no embeddings in this version.')
    assert.equal(calls.length, 0)
  })
  assert.deepEqual(loads, [], 'model-b was never loaded')
  assert.equal(loadedKey(), 'model-a', 'model-a is still loaded')
})

/** The SDK engine active, with the router's answers for `model` overridden. */
function sdkGatewayWithRouter(router: Partial<Deps['modelRouter']>): Hono {
  const deps = depsFor('turbollm-sdk')
  Object.assign(deps.modelRouter, router)
  const app = new Hono()
  registerGateway(app, deps)
  return app
}

test('POST /v1/embeddings naming an embedding model running in a llama.cpp pool slot is relayed with the SDK active', async () => {
  const app = sdkGatewayWithRouter({
    aliveSlots: () => [{ modelKey: KEY, state: 'running', primary: false, lastUsedMs: 0 }],
    route: async () => ({ target: ENGINE, engineKind: 'llama-server' }),
  })
  await withRecordingEngine(async (calls) => {
    await app.request('/v1/embeddings', { method: 'POST', headers: CLIENT_HEADERS, body: JSON.stringify({ model: KEY, input: 'hi' }) })
    assert.deepEqual(calls.map((c) => c.url), [`${ENGINE}/v1/embeddings`])
  })
})

test('POST /v1/embeddings naming a linked machine is left to Turbo Link with the SDK active', async () => {
  const remote = { linkId: 'l1', baseUrl: 'http://peer.invalid', token: 't', modelKey: 'm' }
  const app = sdkGatewayWithRouter({
    resolveRemoteTarget: () => ({ target: 'http://peer.invalid', remote }),
    route: async () => ({ target: 'http://peer.invalid', remote }),
  })
  const res = await app.request('/v1/embeddings', {
    method: 'POST', headers: CLIENT_HEADERS, body: JSON.stringify({ model: 'workstation/m', input: 'hi' }),
  })
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'link_embeddings_unsupported')
})
