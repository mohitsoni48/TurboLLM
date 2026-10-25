// A chat's past reasoning on a LiteRT-LM model. With "Preserve thinking" on (a new chat's default) every past turn's
// reasoning was folded into its text as <think>…</think>, Qwen's markup, which most LiteRT-LM bundle templates put in
// verbatim (Qwen3-0.6B's, Gemma's, LFM2.5-VL's), so it filled their 4096-token contexts. It now goes as the message's
// reasoning_content, where the template decides (LFM2.5's reads it). Driven through the real routes; the engine is a
// fetch double.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

const MODEL = '/models/Qwen3-0.6B_dynamic.litertlm'

function textEngine(t: TestContext): { sent: Array<Record<string, unknown>> } {
  const original = globalThis.fetch
  const sent: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const chunks = [{ choices: [{ index: 0, delta: { content: 'Rome.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return { sent }
}

/** The routes with a model loaded on `kind`. */
function routes(t: TestContext, kind: string) {
  const dir = tmpDir('tllm-chat-litert-reasoning-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const engine = { kind, id: kind, capabilities: {} }
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

/** A second turn of a chat whose first answer came with reasoning; returns the history the engine was sent. */
async function secondTurn(t: TestContext, kind: string, preserveThinking?: boolean) {
  const { sent } = textEngine(t)
  const h = routes(t, kind)
  const conv = h.store.createConversation(preserveThinking === undefined ? {} : { preserveThinking })
  h.store.addMessage(conv.id, 'user', 'What is the capital of France?')
  h.store.addMessage(conv.id, 'assistant', 'Paris.', { reasoning: 'France is in western Europe; its capital is Paris.' })
  const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'And of Italy?' }),
  })
  await res.text()
  assert.equal(sent.length, 1)
  return sent[0].messages as Array<Record<string, unknown>>
}

test('a LiteRT-LM chat sends past reasoning as reasoning_content, not <think> text in the answer; preserve off sends none', async (t) => {
  // A new chat's default: Preserve thinking on.
  const history = await secondTurn(t, 'litert-lm')
  const answer = history.find((m) => m.role === 'assistant')
  assert.deepEqual(answer, { role: 'assistant', content: 'Paris.', reasoning_content: 'France is in western Europe; its capital is Paris.' })
  assert.ok(!history.some((m) => String(m.content).includes('<think>')))
  const off = await secondTurn(t, 'litert-lm', false)
  assert.deepEqual(off.find((m) => m.role === 'assistant'), { role: 'assistant', content: 'Paris.' })
})

test('llama.cpp keeps the fold its templates parse (<think> in the answer\'s text)', async (t) => {
  const history = await secondTurn(t, 'llama.cpp')
  assert.deepEqual(history.find((m) => m.role === 'assistant'), {
    role: 'assistant', content: '<think>\nFrance is in western Europe; its capital is Paris.\n</think>\n\nParis.',
  })
})
