// A chat's sampling on a LiteRT-LM model. LiteRT-LM takes sampling only per request, so the Sampling the user saved on
// the model's settings never reached it, and a thread's temperature alone made `litert-lm serve` fill the rest with
// top_k 1 (greedy), top_p 0.95 and temperature 1.0, throwing the bundle's own sampler away (Qwen3-0.6B: 20 / 0.95 /
// 0.6). Now each request carries the model's saved sampling under the thread's, the rest from the bundle's own; and a
// temperature a model ignores (no sampler of its own, no top_k: greedy) is said. Driven through the real routes; the
// engine is a fetch double.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'
import { rememberLitertLmModel, type LitertLmRequestInfo } from '../engines/litert-lm-request'

const MODEL = '/models/Qwen3-0.6B_dynamic.litertlm'

function textEngine(t: TestContext): { sent: Array<Record<string, unknown>> } {
  const original = globalThis.fetch
  const sent: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const chunks = [{ choices: [{ index: 0, delta: { content: 'Hello.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return { sent }
}

/** The routes over MODEL, loaded on LiteRT-LM with `info` recorded at its load (as Manager.start records it). */
function routes(t: TestContext, info: LitertLmRequestInfo & { native: boolean }) {
  rememberLitertLmModel(MODEL, info)
  const dir = tmpDir('tllm-chat-litert-sampling-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const engine = { kind: 'litert-lm', id: 'lrt', capabilities: {} }
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => engine },
    manager: {
      status: () => ({ state: 'running', model: { key: 'qwen3', name: 'Qwen3', ctx: 4096 } }),
      sessionStats: () => ({ activeRequests: 0 }),
      target: () => 'http://engine.invalid',
      currentOpts: () => ({ engine, modelPath: MODEL }),
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
    tools: { buildToolDefinitions: async () => [], executeTool: async () => '' },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { app, store }
}

async function turn(h: ReturnType<typeof routes>, threadSampling?: Record<string, number>) {
  const conv = h.store.createConversation(threadSampling ? { sampling: threadSampling } : {})
  const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Write one sentence about the sea.' }),
  })
  const text = await res.text()
  return text.split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => ({
    event: /^event: (.*)$/m.exec(b)![1],
    data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
  }))
}

const sampling = (b: Record<string, unknown>) => Object.fromEntries(['temperature', 'top_p', 'top_k'].filter((k) => k in b).map((k) => [k, b[k]]))
const QWEN3_OWN = { topK: 20, topP: 0.95, temp: 0.6 }

test('a thread\'s temperature alone reaches a LiteRT-LM model with the rest of the bundle\'s own sampler, not greedy', async (t) => {
  const engine = textEngine(t)
  await turn(routes(t, { sampling: {}, sampler: QWEN3_OWN, native: false }), { temp: 0.7 })
  assert.equal(engine.sent[0].model, MODEL)
  assert.deepEqual(sampling(engine.sent[0]), { temperature: 0.7, top_k: 20, top_p: 0.95 })
})

test('the sampling the user saved for a LiteRT-LM model reaches every chat request; the thread\'s wins', async (t) => {
  const engine = textEngine(t)
  const h = routes(t, { sampling: { temperature: 0.3, top_k: 64 }, sampler: QWEN3_OWN, native: false })
  await turn(h)
  await turn(h, { temp: 0.9 })
  assert.deepEqual(sampling(engine.sent[0]), { temperature: 0.3, top_k: 64, top_p: 0.95 })
  assert.deepEqual(sampling(engine.sent[1]), { temperature: 0.9, top_k: 64, top_p: 0.95 })
})

test('a temperature a LiteRT-LM model ignores is said in the chat; a chat that sets nothing sends nothing', async (t) => {
  const engine = textEngine(t)
  const h = routes(t, { sampling: {}, native: false })
  const frames = await turn(h, { temp: 0.7 })
  assert.deepEqual(sampling(engine.sent[0]), { temperature: 0.7 })
  assert.match(String(frames.find((f) => f.event === 'notice')?.data.message), /decodes it greedily \(Top K 1\)/)
  const plain = await turn(h)
  assert.deepEqual(sampling(engine.sent[1]), {})
  assert.equal(plain.some((f) => f.event === 'notice'), false)
})
