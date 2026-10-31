// The Android app's in-app engine (kind 'turbollm-sdk') answers only its own per-process bearer token, so every
// gateway request to it must carry that bearer instead of the client's credentials, and a TurboLLM API key must never
// reach its port (architecture §6.4, plan D-3). It serves no /tokenize in this version, so count_tokens estimates.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { registerGateway } from './gateway'

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
