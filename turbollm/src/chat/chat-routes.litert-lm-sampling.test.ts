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
import { litertLmRequestSampling, rememberLitertLmModel, type LitertLmRequestInfo } from '../engines/litert-lm-request'

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

test('a thread\'s repeat penalty reaches a LiteRT-LM model as llama.cpp\'s repeat_penalty, and its Min P, which LiteRT-LM has not, is said as the thread\'s', async (t) => {
  // The Repeat penalty is llama.cpp's, and the Android server applies repeat_penalty as llama.cpp does, over the last 64
  // tokens (repetition_penalty over the whole reply). The thread settings show no Min P slider for LiteRT-LM: the note
  // says whose it is and where to clear it.
  const engine = textEngine(t)
  const frames = await turn(routes(t, { sampling: {}, sampler: QWEN3_OWN, native: true }), { repeatPenalty: 1.2, minP: 0.05 })
  assert.equal(engine.sent[0].repeat_penalty, 1.2)
  assert.equal('repetition_penalty' in engine.sent[0], false)
  assert.equal(String(frames.find((f) => f.event === 'notice')?.data.message),
    'LiteRT-LM has no Min P: this reply was sampled without this thread\'s Min P. Clear that Min P in Thread settings.')
})

test('a Min P the user saved on a LiteRT-LM model is said in an untouched chat, not dropped', async (t) => {
  // The model dialog no longer offers Min P for LiteRT-LM, but one saved before stays in the profile (the load carries
  // it, litertLmRequestSampling): it reached nothing and nothing said so, while a thread's Min P was named.
  const engine = textEngine(t)
  const frames = await turn(routes(t, { sampling: litertLmRequestSampling({ minP: 0.2 }), sampler: QWEN3_OWN, native: false }))
  assert.equal(engine.sent[0].min_p, 0.2)
  assert.match(String(frames.find((f) => f.event === 'notice')?.data.message), /does not apply the Min P saved in this model's settings: this reply was written without it\..* Clear that Min P under Models → the model's Load settings and reload the model\.$/)
})
