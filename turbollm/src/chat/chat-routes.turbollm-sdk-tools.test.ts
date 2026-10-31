// The chat's tools on the in-app SDK engine (plan D-4, ADR-447 point 7). The SDK refuses a request's tools with a 400,
// so a local turn there is sent none and the reply goes on without them. A turn this machine sends to a Turbo Link host
// keeps them (Revision 2, G-6): the host's engine runs them, whatever this machine's own engine is. Driven through the
// real routes; the engine and the host are a fetch double.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

const TOOLS = ['web_search', 'run_code'].map((name) => ({ type: 'function', function: { name, description: 'd', parameters: { type: 'object', properties: {} } } }))
const HOST = { linkId: 'lnk1', baseUrl: 'https://rig.trycloudflare.com', token: 'tllm-hostsecret', modelKey: 'qwen3-35b' }

/** The engine (or the host): answers every round in text, and records what each round was sent. */
function textEngine(t: TestContext): Array<Record<string, unknown>> {
  const original = globalThis.fetch
  const sent: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const chunks = [{ choices: [{ index: 0, delta: { content: 'Hello.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return sent
}

/** The routes over a loaded model 'm' served locally by `engineKind`, with a Turbo Link host that serves HOST.modelKey. */
function routes(t: TestContext, engineKind: string) {
  const dir = tmpDir('tllm-chat-sdk-tools-')
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
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: engineKind, id: engineKind, capabilities: {} }) },
    remoteCatalog: {
      modelOn: (linkId: string, key: string) => (linkId === HOST.linkId && key === HOST.modelKey
        ? { key, name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded: true }
        : undefined),
    },
    modelRouter: {
      route: async () => ({ target: 'http://engine.invalid' }),
      resolveRemoteTarget: (id: string) => (id === `rig/${HOST.modelKey}` ? { target: HOST.baseUrl, remote: HOST } : undefined),
    },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx: 32768 } }),
      sessionStats: () => ({ activeRequests: 0 }),
      target: () => 'http://engine.invalid',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
    tools: { buildToolDefinitions: async () => TOOLS, executeTool: async () => '' },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  t.after(() => store.close())
  return { app, store }
}

/** One turn, on the Research persona so a forced first search would show; `model` picks a remote one. Its SSE text. */
async function turn(h: ReturnType<typeof routes>, model?: string): Promise<string> {
  const conv = h.store.createConversation({ toolPolicy: 'force_web_search' })
  const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'What is new in Rust?', ...(model ? { model } : {}) }),
  })
  return res.text()
}

const names = (body: Record<string, unknown>) => (body.tools as Array<{ function: { name: string } }> | undefined)?.map((t) => t.function.name)

test('a local turn on the SDK engine is sent no tools and no forced search, and the reply goes on', async (t) => {
  const sent = textEngine(t)
  const sse = await turn(routes(t, 'turbollm-sdk'))
  assert.equal(sent[0].tools, undefined)
  assert.equal(sent[0].tool_choice, undefined)
  assert.match(sse, /event: done/)
})

test('a local turn on llama.cpp keeps the chat\'s tools and its forced first search', async (t) => {
  const sent = textEngine(t)
  await turn(routes(t, 'llama-server'))
  assert.deepEqual(names(sent[0]), ['web_search', 'run_code'])
  assert.deepEqual(sent[0].tool_choice, { type: 'function', function: { name: 'web_search' } })
})

test('a turn sent to a Turbo Link host from a machine on the SDK engine keeps its tools (G-6)', async (t) => {
  const sent = textEngine(t)
  await turn(routes(t, 'turbollm-sdk'), `rig/${HOST.modelKey}`)
  assert.equal(sent[0].model, HOST.modelKey, 'the turn went to the host')
  assert.deepEqual(names(sent[0]), ['web_search', 'run_code'])
})
