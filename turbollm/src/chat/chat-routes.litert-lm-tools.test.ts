// The chat's tools on a LiteRT-LM model. Both of its servers take a request's tools, and a bundle whose template reads
// them shows them to the model (LFM2.5, Qwen3, Gemma 4). The chat withheld them from every LiteRT-LM model, so the
// thread's tools, MCP and skill tools and the Research persona's web_search never reached one. Now: sent to a model
// that calls tools when they fit; none, with a note the chat shows, to one whose template cannot show them or whose
// context they do not fit; and the Research persona's forced first searches, which neither server can force, are the
// model's choice, with a note. Driven through the real routes; the engine is a fetch double.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'
import { LITERT_LM_NO_TOOL_CALLING_NOTE, LITERT_LM_RESEARCH_NOTE } from '../engines/litert-lm-request'

const TOOLS = ['web_search', 'run_code'].map((name) => ({ type: 'function', function: { name, description: 'd', parameters: { type: 'object', properties: {} } } }))

/** The engine: answers every round in text, and records what each round was sent. */
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

/** The routes over a loaded model 'm' served by `engineKind`, whose library entry says `toolCalls`. */
function routes(t: TestContext, engineKind: string, toolCalls: boolean | undefined, opts: { ctx?: number; tools?: unknown[] } = {}) {
  const dir = tmpDir('tllm-chat-litert-tools-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: {
      list: () => ({ models: [], scanning: false, lastScanAt: '' }),
      get: (key: string) => (key === 'm' && toolCalls !== undefined ? { key: 'm', toolCalls } : undefined),
    },
    registry: { active: () => ({ kind: engineKind, id: engineKind, capabilities: {} }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx: opts.ctx ?? 32768 } }),
      sessionStats: () => ({ activeRequests: 0 }),
      target: () => 'http://engine.invalid',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
    tools: { buildToolDefinitions: async () => opts.tools ?? TOOLS, executeTool: async () => '' },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { app, store }
}

/** One turn: the SSE frames the page got, once the turn is done. */
async function turn(h: ReturnType<typeof routes>, toolPolicy?: string): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const conv = h.store.createConversation(toolPolicy ? { toolPolicy } : {})
  const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'What is new in Rust?' }),
  })
  const text = await res.text()
  return text.split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => ({
    event: /^event: (.*)$/m.exec(b)![1],
    data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
  }))
}

const names = (body: Record<string, unknown>) => (body.tools as Array<{ function: { name: string } }> | undefined)?.map((t) => t.function.name)
const notices = (frames: Array<{ event: string; data: Record<string, unknown> }>) => frames.filter((f) => f.event === 'notice').map((f) => f.data.message)

test('a LiteRT-LM model that calls tools is sent the chat\'s tools, as llama.cpp is', async (t) => {
  for (const toolCalls of [true, undefined]) {
    const engine = textEngine(t)
    const frames = await turn(routes(t, 'litert-lm', toolCalls))
    assert.deepEqual(names(engine.sent[0]), ['web_search', 'run_code'], `toolCalls ${toolCalls}`)
    assert.deepEqual(notices(frames), [])
    assert.ok(frames.some((f) => f.event === 'done'))
  }
})

test('a LiteRT-LM model whose template cannot show tools is sent none, and the chat says so', async (t) => {
  const engine = textEngine(t)
  const frames = await turn(routes(t, 'litert-lm', false))
  assert.equal(engine.sent[0].tools, undefined)
  assert.deepEqual(notices(frames), [LITERT_LM_NO_TOOL_CALLING_NOTE])
  assert.ok(frames.some((f) => f.event === 'done'), 'the reply goes on without them')
})

test('tools that do not fit in a LiteRT-LM model\'s context are not sent, and the chat says so', async (t) => {
  const engine = textEngine(t)
  const big = Array.from({ length: 12 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: 'x'.repeat(1200), parameters: { type: 'object' } } }))
  const frames = await turn(routes(t, 'litert-lm', true, { ctx: 4096, tools: big }))
  assert.equal(engine.sent[0].tools, undefined)
  const [note] = notices(frames)
  assert.match(String(note), /^The tools \(about [\d,]+ tokens\) do not fit in this model's 4,096-token context/)
})

test('the Research persona on LiteRT-LM leaves the search to the model, and says so; llama.cpp\'s first searches stay forced', async (t) => {
  const litert = textEngine(t)
  const frames = await turn(routes(t, 'litert-lm', true), 'force_web_search')
  assert.deepEqual(names(litert.sent[0]), ['web_search', 'run_code'])
  assert.equal(litert.sent[0].tool_choice, undefined)
  assert.deepEqual(notices(frames), [LITERT_LM_RESEARCH_NOTE])
  const llama = textEngine(t)
  const llamaFrames = await turn(routes(t, 'llama.cpp', undefined), 'force_web_search')
  assert.deepEqual(llama.sent[0].tool_choice, { type: 'function', function: { name: 'web_search' } })
  assert.deepEqual(notices(llamaFrames), [])
})
