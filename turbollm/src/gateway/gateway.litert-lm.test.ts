// The Anthropic-shaped /v1/messages path maps the request to OpenAI with `max_tokens`, which a LiteRT-LM
// server ignores (compat.ts applyEngineTokenLimit). The v1.14.5 release review found this path never
// renamed it, so a Claude Code CLI pointed at a LiteRT-LM model generated to the context limit whatever
// cap the client or the daemon set. A Turbo Link host shapes its own request, so a remote turn is left
// alone.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { registerGateway } from './gateway'

const ENGINE = 'http://engine.invalid'
const MODEL_PATH = '/models/gemma-3n-E2B-it-int4.litertlm'
const KEY = 'gemma 3n e2b it int4|INT4|3000'
const ENTRY = { key: KEY, name: 'gemma 3n E2B it int4', format: 'litertlm', path: MODEL_PATH } as unknown as ModelEntry

function litertDeps(): Deps {
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
    registry: { active: () => ({ kind: 'litert-lm' }) },
  } as unknown as Deps
}

/** Swap in an engine that records each JSON body it receives, for the duration of `run` only. */
async function withRecordingEngine(run: (bodies: Array<Record<string, unknown>>) => Promise<void>): Promise<void> {
  const bodies: Array<Record<string, unknown>> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await run(bodies)
  } finally {
    globalThis.fetch = realFetch
  }
}

test('POST /v1/messages on LiteRT-LM sends the client cap as max_completion_tokens', async () => {
  const app = new Hono()
  registerGateway(app, litertDeps())
  await withRecordingEngine(async (bodies) => {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: KEY, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(bodies.length, 1, 'exactly one engine request')
    assert.equal(bodies[0].max_completion_tokens, 64)
    assert.equal('max_tokens' in bodies[0], false)
  })
})

// The router can send a request to an extra pool slot (keepN ≥ 2, or a chat model beside an embedding model in
// the primary). A .litertlm model there runs on LiteRT-LM whatever the primary runs, and the request used to be shaped
// and labelled from the PRIMARY: llama.cpp's shape (no path in `model`, `max_tokens`) and the primary model's name.

function slotDeps(): Deps {
  const d = litertDeps() as unknown as Record<string, unknown>
  return {
    ...d,
    modelRouter: {
      ...(d.modelRouter as object),
      route: async () => ({ target: ENGINE, engineKind: 'litert-lm', modelPath: MODEL_PATH, modelName: ENTRY.name }),
    },
    manager: {
      status: () => ({ state: 'running', model: { key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' } }),
      target: () => 'http://primary.invalid',
      currentOpts: () => ({ engine: { kind: 'llama.cpp' }, modelPath: '/models/qwen3-8b-Q4.gguf' }),
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
  } as unknown as Deps
}

test('a request routed to a LiteRT-LM pool slot is shaped for that slot, not the llama.cpp primary', async () => {
  const app = new Hono()
  registerGateway(app, slotDeps())
  await withRecordingEngine(async (bodies) => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: KEY, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(((await res.json()) as { model: string }).model, ENTRY.name, "labelled with the slot's model")
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: KEY, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(bodies.length, 2)
    for (const [i, cap] of [[0, 64], [1, 32]] as const) {
      assert.equal(bodies[i].model, MODEL_PATH, 'LiteRT-LM resolves `model` as the file path of the model it serves')
      assert.equal(bodies[i].max_completion_tokens, cap)
      assert.equal('max_tokens' in bodies[i], false)
    }
  })
})
