// A refused turn says why. LiteRT-LM's servers give the reason in the HTTP status line ("500 RuntimeError: Failed to
// create conversation: ...", what `litert-lm serve` answers every LFM2 request with, or "400 Invalid sampler
// parameters: ..."), `serve` with an HTML page for a body (engine-error.test.ts reads it over HTTP), and the chat read
// only the body. Here the reason comes in the status line alone, which is where it is read from.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

const MODEL = '/models/Qwen3-0.6B_dynamic.litertlm'

/** The engine refuses every request with the reason in its status line, as `litert-lm serve` does (no body here). */
function refusingEngine(t: TestContext, status: number, statusText: string): void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status, statusText })) as typeof fetch
  t.after(() => { globalThis.fetch = original })
}

/** The routes over MODEL, loaded on LiteRT-LM. */
function routes(t: TestContext) {
  const dir = tmpDir('tllm-chat-engine-error-')
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

test('a LiteRT-LM refusal\'s reason, which comes in its status line, reaches the chat', async (t) => {
  refusingEngine(t, 500, 'RuntimeError: Failed to create conversation: INTERNAL: Failed to create constraint.')
  const h = routes(t)
  const conv = h.store.createConversation()
  const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
  })
  const text = await res.text()
  const error = text.split('\n\n').find((b) => b.startsWith('event: error'))
  assert.ok(error, text)
  assert.match(error!, /Engine returned 500: RuntimeError: Failed to create conversation: INTERNAL: Failed to create constraint\./)
})
