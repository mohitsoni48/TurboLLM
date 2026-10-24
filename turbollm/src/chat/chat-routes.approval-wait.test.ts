// A chat's tool call set to Ask waits a set time for its answer (Settings → Tool permissions → "Wait
// for an answer", tools.chatApprovalWaitMinutes): past it the call is not run, it is recorded like a
// deny with its own text, and the turn goes on. The wait is the reply's, shared by its calls. Driven
// through the real routes; the engine is a fetch double here, as the wait's timer is mocked and the
// real fetch's own timers must not be.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { inFlightChatIds, registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

const MINUTE = 60_000

/** The engine: rounds 1 to `askRounds` each ask for run_code (call_1, call_2, ...), every later round answers in text.
 *  Records what each round was sent. */
function scriptedEngine(t: TestContext, askRounds = 1) {
  const original = globalThis.fetch
  const sent: Array<Array<{ role: string; content: unknown }>> = []
  const sse = (...chunks: unknown[]) => new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    // As the real fetch: a request whose signal has aborted is never sent.
    init?.signal?.throwIfAborted()
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: unknown }> }
    sent.push(body.messages ?? [])
    if (sent.length <= askRounds) {
      return sse(
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${sent.length}`, type: 'function', function: { name: 'run_code', arguments: '{"code":"6*7"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      )
    }
    return sse({ choices: [{ index: 0, delta: { content: 'I could not run it, so here is my best guess: 42.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return { sent }
}

const executed: string[] = []

function routes(t: TestContext, waitMinutes: number | undefined) {
  const dir = tmpDir('tllm-chat-approval-wait-')
  const store = new ConversationStore(dir)
  executed.length = 0
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: { run_code: 'ask' }, autoAllowAll: false, chatApprovalWaitMinutes: waitMinutes },
  }
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'gemma-27b', name: 'Gemma 27B', ctx: 8192 } }),
      sessionStats: () => ({ activeRequests: 0 }),
      target: () => 'http://engine.invalid',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
    tools: {
      buildToolDefinitions: async () => [{ type: 'function', function: { name: 'run_code', description: '', parameters: { type: 'object', properties: {} } } }],
      executeTool: async (call: { name: string }) => { executed.push(call.name); return '42' },
    },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { app, store, cfg }
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

interface Frame { event: string; data: Record<string, unknown> }

/** Reads an SSE response frame by frame (setTimeout is mocked here: it waits on setImmediate). */
function sseFrames(res: Response) {
  const frames: Frame[] = []
  let ended = false
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  void (async () => {
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (block.startsWith(':')) continue
          const data = /^data: (.*)$/m.exec(block)?.[1]
          frames.push({ event: /^event: (.*)$/m.exec(block)?.[1] ?? 'message', data: data ? JSON.parse(data) as Record<string, unknown> : {} })
        }
      }
    } catch { /* cancelled */ }
    ended = true
  })()
  return {
    frames,
    async until(pred: (f: Frame) => boolean, what: string): Promise<Frame> {
      for (let i = 0; i < 20_000; i++) {
        const f = frames.find(pred)
        if (f) return f
        if (ended) throw new Error(`the stream ended before ${what}`)
        await new Promise((r) => setImmediate(r))
      }
      throw new Error(`timed out waiting for ${what}`)
    },
  }
}

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)) }
const awaiting = (f: Frame) => f.event === 'tool_call' && f.data.status === 'awaiting_approval'
const answered = (f: Frame) => f.event === 'tool_call' && f.data.status === 'done'
const reply = (store: ConversationStore, convId: string) => store.getMessages(convId).filter((m) => m.role === 'assistant').at(-1)!

test('a call nobody answers within the wait is not run, is saved with its own result, and the reply goes on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const engine = scriptedEngine(t)
  const h = routes(t, 3)
  const conv = h.store.createConversation()
  const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'compute 6*7' })))
  await page.until(awaiting, 'the approval request')
  // Read when the reply's first wait starts: a change now is the next reply's.
  h.cfg.tools.chatApprovalWaitMinutes = 1
  t.mock.timers.tick(3 * MINUTE - 1)
  await settle()
  assert.ok(!page.frames.some(answered), 'still waiting a moment before the wait runs out')
  assert.deepEqual(inFlightChatIds(), [conv.id])
  t.mock.timers.tick(1)
  const text = 'No answer within 3 minutes; the call was not run.'
  const frame = await page.until(answered, 'the call answered')
  assert.equal(frame.data.result, text)
  await page.until((f) => f.event === 'done', 'done')
  assert.deepEqual(executed, [], 'the call never ran')
  assert.equal(engine.sent.length, 2, 'the turn went on to a second round')
  assert.deepEqual(engine.sent[1].at(-1), { role: 'tool', content: text, tool_call_id: 'call_1' }, 'the model read the result as the call\'s')
  const r = reply(h.store, conv.id)
  assert.equal(r.toolCalls[0].result, text)
  assert.equal(r.content, 'I could not run it, so here is my best guess: 42.')
  assert.equal(r.stats.aborted, false)
  assert.deepEqual(inFlightChatIds(), [])
  const late = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_code', decision: 'allow' }))
  assert.equal(late.status, 404, 'an answer after the wait finds nothing to answer')
})

test('a wait of 0 waits until answered, however long that takes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  scriptedEngine(t)
  const h = routes(t, 0)
  const conv = h.store.createConversation()
  const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'compute 6*7' })))
  await page.until(awaiting, 'the approval request')
  t.mock.timers.tick(48 * 60 * MINUTE)
  await settle()
  assert.ok(!page.frames.some(answered), 'two days on, still waiting')
  const approve = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_code', decision: 'allow' }))
  assert.equal(approve.status, 200)
  await page.until((f) => f.event === 'done', 'done')
  assert.deepEqual(executed, ['run_code'])
  assert.equal(reply(h.store, conv.id).toolCalls[0].result, '42')
})

test('an answer before the wait runs out wins, and the wait running out later changes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  scriptedEngine(t)
  const h = routes(t, 1)
  const conv = h.store.createConversation()
  const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'compute 6*7' })))
  await page.until(awaiting, 'the approval request')
  t.mock.timers.tick(MINUTE / 2)
  const approve = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_code', decision: 'allow' }))
  assert.equal(approve.status, 200)
  await page.until((f) => f.event === 'done', 'done')
  t.mock.timers.tick(5 * MINUTE)
  await settle()
  assert.deepEqual(executed, ['run_code'])
  assert.deepEqual(page.frames.filter(answered).map((f) => f.data.result), ['42'], 'one answer, the human\'s')
  assert.equal(reply(h.store, conv.id).toolCalls[0].result, '42')
})

test('a Stop before the wait runs out is a deny, as before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const engine = scriptedEngine(t)
  const h = routes(t, 1)
  const conv = h.store.createConversation()
  const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'compute 6*7' })))
  const meta = await page.until((f) => f.event === 'meta', 'meta')
  await page.until(awaiting, 'the approval request')
  t.mock.timers.tick(MINUTE / 2)
  await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id, messageId: meta.data.assistantMessageId }))
  await page.until((f) => f.event === 'done', 'done')
  t.mock.timers.tick(5 * MINUTE)
  await settle()
  const r = reply(h.store, conv.id)
  assert.equal(r.toolCalls[0].result, 'Denied by user.')
  assert.equal(r.stats.aborted, true)
  assert.deepEqual(executed, [])
  assert.equal(engine.sent.length, 1, 'no second round')
})

test('a config with no wait set (a test double, or a store not yet normalized) waits the default 30 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  scriptedEngine(t)
  const h = routes(t, undefined)
  const conv = h.store.createConversation()
  const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'compute 6*7' })))
  await page.until(awaiting, 'the approval request')
  t.mock.timers.tick(30 * MINUTE - 1)
  await settle()
  assert.ok(!page.frames.some(answered))
  t.mock.timers.tick(1)
  assert.equal((await page.until(answered, 'the call answered')).data.result, 'No answer within 30 minutes; the call was not run.')
  await page.until((f) => f.event === 'done', 'done')
})

// The wait is the reply's: a model that asked again after a call nobody answered waited again each time (up to 16
// rounds), holding the chat, its engine slot and, on Android, the model for that many times the setting.
test('a reply whose calls nobody answers waits once: its later calls are answered at once with the timeout result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const engine = scriptedEngine(t, 3)
  const h = routes(t, 3)
  const conv = h.store.createConversation()
  const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'compute 6*7, three ways' })))
  await page.until(awaiting, 'the first approval request')
  t.mock.timers.tick(3 * MINUTE)
  await page.until((f) => f.event === 'done', 'done')
  const text = 'No answer within 3 minutes; the call was not run.'
  assert.deepEqual(page.frames.filter(awaiting).map((f) => f.data.id), ['call_1'], 'only the first call waited')
  assert.deepEqual(page.frames.filter(answered).map((f) => [f.data.id, f.data.result]), [['call_1', text], ['call_2', text], ['call_3', text]])
  assert.deepEqual(executed, [], 'none of them ran')
  assert.equal(engine.sent.length, 4, 'the reply went on to its answer')
  assert.deepEqual(reply(h.store, conv.id).toolCalls.map((c) => c.result), [text, text, text])
  assert.deepEqual(inFlightChatIds(), [])
})

test('an answered call leaves the rest of the reply\'s wait for its next call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  scriptedEngine(t, 2)
  const h = routes(t, 3)
  const conv = h.store.createConversation()
  const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'compute 6*7, twice' })))
  await page.until(awaiting, 'the first approval request')
  t.mock.timers.tick(MINUTE)
  const approve = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_code', decision: 'allow' }))
  assert.equal(approve.status, 200)
  await page.until((f) => awaiting(f) && f.data.id === 'call_2', 'the second approval request')
  // 1 of the 3 minutes went on the first call's wait; the answer resets nothing.
  t.mock.timers.tick(2 * MINUTE - 1)
  await settle()
  assert.ok(!page.frames.some((f) => answered(f) && f.data.id === 'call_2'), 'still waiting a moment before the rest runs out')
  t.mock.timers.tick(1)
  const second = await page.until((f) => answered(f) && f.data.id === 'call_2', 'the second call answered')
  assert.equal(second.data.result, 'No answer within 3 minutes; the call was not run.')
  await page.until((f) => f.event === 'done', 'done')
  assert.deepEqual(executed, ['run_code'], 'the first, answered call ran; the second did not')
})
