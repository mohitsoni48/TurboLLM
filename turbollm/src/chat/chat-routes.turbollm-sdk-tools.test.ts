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

// Vision on the SDK engine (plan D-11, Revision 2 G-2): it reads no images in this version, so a new image is refused
// before anything is stored or sent, and an image stored under another engine goes to it as a text placeholder.
const IMAGE = 'data:image/png;base64,AAAA'
const VISION_UNAVAILABLE = 'The in-app engine can\'t read images in this version. Switch to the bundled llama.cpp engine in Engines to use images.'
const IMAGE_OMITTED = { type: 'text', text: '[image omitted: this engine cannot read images]' }

/** POST /messages with an image in a new chat; `model` picks a remote one. */
async function sendImage(h: ReturnType<typeof routes>, model?: string) {
  const conv = h.store.createConversation({})
  const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'What is this?', images: [IMAGE], ...(model ? { model } : {}) }),
  })
  return { res, conv }
}

/** POST /continue on a chat whose question carries an image stored earlier. Its SSE text. */
async function answerStoredImageAgain(h: ReturnType<typeof routes>): Promise<string> {
  const conv = h.store.createConversation({})
  h.store.addMessage(conv.id, 'user', 'What is this?', { attachments: [IMAGE] })
  const res = await h.app.request(`/api/v1/conversations/${conv.id}/continue`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  return res.text()
}

const lastUserContent = (body: Record<string, unknown>) => (body.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'user').at(-1)?.content

test('an image sent on the SDK engine is refused with vision_unavailable, before anything is stored or sent (G-2)', async (t) => {
  const sent = textEngine(t)
  const h = routes(t, 'turbollm-sdk')
  const { res, conv } = await sendImage(h)
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: { code: 'vision_unavailable', message: VISION_UNAVAILABLE } })
  assert.equal(sent.length, 0, 'the engine was never called')
  assert.deepEqual(h.store.getMessages(conv.id), [], 'no question and no reply were stored')
})

test('an image sent on llama.cpp goes to the engine as an image part', async (t) => {
  const sent = textEngine(t)
  const { res } = await sendImage(routes(t, 'llama-server'))
  await res.text()
  assert.deepEqual(lastUserContent(sent[0]), [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: IMAGE } }])
})

test('an image sent to a Turbo Link host from a machine on the SDK engine goes to the host as an image part (G-2, ADR-376)', async (t) => {
  const sent = textEngine(t)
  const { res } = await sendImage(routes(t, 'turbollm-sdk'), `rig/${HOST.modelKey}`)
  await res.text()
  assert.equal(sent[0].model, HOST.modelKey, 'the turn went to the host')
  assert.deepEqual(lastUserContent(sent[0]), [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: IMAGE } }])
})

test('answering again a question whose image was stored earlier sends the SDK engine a placeholder in its place (G-2)', async (t) => {
  const sent = textEngine(t)
  const sse = await answerStoredImageAgain(routes(t, 'turbollm-sdk'))
  assert.deepEqual(lastUserContent(sent[0]), [{ type: 'text', text: 'What is this?' }, IMAGE_OMITTED])
  assert.match(sse, /event: done/)
})

test('answering again a question with a stored image on llama.cpp still sends the image', async (t) => {
  const sent = textEngine(t)
  await answerStoredImageAgain(routes(t, 'llama-server'))
  assert.deepEqual(lastUserContent(sent[0]), [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: IMAGE } }])
})
