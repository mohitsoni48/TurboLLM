// A chat reply runs in the daemon, not in the request that started it (the owner's rule: the web UI is a frontend, and
// closing, reloading or leaving the page, Android's Back or a dropped connection never stops a reply). Driven through
// the real routes against a node:http stand-in engine read through the real fetch, so "the engine saw the abort" is the
// engine's own connection closing, not a fetch double's signal.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { abortAllInFlightChats, chatHoldsEngine, inFlightChatIds, registerChatRoutes } from './chat-routes.js'
import { chatRuns } from './chat-runs.js'
import { ConversationStore, type Message } from './db.js'
import { activeWork } from '../api/active-work.js'
import { endLanTurns, endStaleStreams, hashKey, lanAuth, provisionRemoteApiKey } from '../auth.js'
import { defaultConfig, type Config } from '../config/config.js'
import { RemoteAccessManager } from '../remote/manager.js'
import type { PreflightState, RemoteProvider } from '../remote/types.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

/** Every test here talks to real sockets: one that waits on a frame that never comes fails instead of hanging. */
const it = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { timeout: 20_000 }, fn)

// ── a stand-in engine whose every streaming request the test drives by hand ───────────────────────────────────────

interface EngineCall {
  lastUser: string
  /** The daemon hung up before the reply was finished: the abort reached the engine. */
  gone: boolean
  word(text: string): void
  toolCall(id: string, name: string, args: string): void
  /** Ends the reply ('Done.' first when nothing was written: an empty reply gets an extra pass, BUG-001). */
  finish(reason?: string): void
}

async function standInEngine() {
  const calls: EngineCall[] = []
  const nonStream: string[] = []
  let holdNonStream: Promise<void> | null = null
  let nonStreamReply = 'A Generated Title'
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { stream?: boolean; messages?: Array<{ role: string; content: unknown }> }
      const lastUser = String((body.messages ?? []).filter((m) => m.role === 'user').at(-1)?.content ?? '')
      if (!body.stream) {
        nonStream.push(lastUser)
        void (async () => {
          await holdNonStream
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: nonStreamReply }, finish_reason: 'stop' }] }))
        })()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o: unknown) => { res.write(`data: ${JSON.stringify(o)}\n\n`) }
      let ended = false
      let wrote = false
      const call: EngineCall = {
        lastUser,
        gone: false,
        word: (text) => { wrote = true; send({ choices: [{ index: 0, delta: { content: text } }] }) },
        toolCall: (id, name, args) => { wrote = true; send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] }) },
        finish: (reason = 'stop') => {
          // A reply with no text at all gets the empty-reply extra pass (BUG-001), one more request.
          if (!wrote) call.word('Done.')
          send({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
          ended = true
          res.end('data: [DONE]\n\n')
        },
      }
      res.on('close', () => { if (!ended) call.gone = true })
      calls.push(call)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    nonStream,
    /** The `n`th streaming request (1-based), once it has arrived. */
    async call(n: number): Promise<EngineCall> {
      await waitFor(() => calls.length >= n, `engine request ${n}`)
      return calls[n - 1]
    },
    holdNonStreamReplies(reply: string): () => void {
      nonStreamReply = reply
      let release!: () => void
      holdNonStream = new Promise<void>((r) => { release = r })
      return release
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

// ── the routes ──────────────────────────────────────────────────────────────────────────────────────────────────

const executed: string[] = []

/** The real chat routes over a real store, generating on `engineUrl`. `run_code` is the one tool, with `toolPolicy`;
 *  `executed` lists every call that ran. */
function routes(engineUrl: string, opts: { titles?: boolean; toolPolicy?: 'ask' | 'allow'; remote?: { id: string; baseUrl: string } } = {}) {
  const dir = tmpDir('tllm-chat-detached-')
  const store = new ConversationStore(dir)
  executed.length = 0
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: opts.titles ?? false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: { run_code: opts.toolPolicy ?? 'allow' }, autoAllowAll: false },
  }
  const remote = opts.remote ? { linkId: 'lnk1', baseUrl: opts.remote.baseUrl, token: 'tllm-hostsecret', modelKey: 'qwen3' } : undefined
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    modelRouter: { resolveRemoteTarget: (id: string) => (remote && id === opts.remote!.id ? { target: remote.baseUrl, remote } : undefined) },
    remoteCatalog: { modelOn: () => ({ key: 'qwen3', name: 'Qwen3', quant: 'Q4', nativeCtx: 8192, vision: false, loaded: true }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'gemma-27b', name: 'Gemma 27B', ctx: 8192 } }),
      sessionStats: () => ({ activeRequests: 0 }),
      target: () => engineUrl,
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
  return { app, store, d, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Polls `cond` until it holds — a precondition the test waits FOR, never a guessed duration. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

interface Frame { id?: number; event: string; data: Record<string, unknown> }

/** Reads an SSE response frame by frame. */
function sseFrames(res: Response) {
  const frames: Frame[] = []
  let ended = false
  const waiters: Array<() => void> = []
  const wake = () => { for (const w of waiters.splice(0)) w() }
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const done = (async () => {
    let buf = ''
    try {
      for (;;) {
        const { done: end, value } = await reader.read()
        if (end) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (block.startsWith(':')) continue
          const id = /^id: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          frames.push({ id: id === undefined ? undefined : Number(id), event: /^event: (.*)$/m.exec(block)?.[1] ?? 'message', data: data ? JSON.parse(data) as Record<string, unknown> : {} })
          wake()
        }
      }
    } catch { /* cancelled */ }
    ended = true
    wake()
  })()
  return {
    frames,
    done,
    ended: () => ended,
    /** Resolves once a frame matching `pred` has arrived; rejects if the stream ends first. */
    async until(pred: (f: Frame) => boolean, what = 'a frame'): Promise<Frame> {
      for (;;) {
        const f = frames.find(pred)
        if (f) return f
        if (ended) throw new Error(`the stream ended before ${what}`)
        await new Promise<void>((r) => waiters.push(r))
      }
    },
    text: () => frames.filter((f) => f.event === 'delta').map((f) => f.data.delta).join(''),
    cancel: () => reader.cancel().catch(() => {}),
  }
}

const reply = (store: ConversationStore, convId: string) => store.getMessages(convId).filter((m) => m.role === 'assistant').at(-1)!
const saved = (store: ConversationStore, convId: string) => () => reply(store, convId)?.stats.totalMs !== undefined
/** Sends a message and keeps the page only until the turn has started: then the page is gone. */
async function sendAndLeave(app: Hono, convId: string, content: string, extra: Record<string, unknown> = {}) {
  const page = sseFrames(await app.request(`/api/v1/conversations/${convId}/messages`, json({ content, ...extra })))
  const meta = await page.until((f) => f.event === 'meta', 'meta')
  await page.cancel()
  return meta.data as { userMessageId: string; assistantMessageId: string }
}
const LONG = 'a sentence long enough to clear the parser lookahead. '

// ── (a) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(a) the page closing mid-reply does not stop it: the reply finishes, is saved whole, and gets its title', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url, { titles: true })
  try {
    const conv = h.store.createConversation()
    const page = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'tell me a story' })))
    await page.until((f) => f.event === 'meta')
    const call = await engine.call(1)
    call.word('Once upon a time, ')
    await page.cancel() // the page closes, reloads or loses its WebView
    call.word('there was a daemon ')
    call.word('that kept going.')
    call.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    const r = reply(h.store, conv.id)
    assert.equal(call.gone, false, 'the engine request was never cut off')
    assert.equal(r.content, 'Once upon a time, there was a daemon that kept going.')
    assert.equal(r.stats.aborted, false)
    await waitFor(() => h.store.getConversation(conv.id)!.title === 'A Generated Title', 'the auto-title', 4000)
    assert.deepEqual(inFlightChatIds(), [])
  } finally {
    h.cleanup()
    await engine.close()
  }
})

// ── (b) (c) ──────────────────────────────────────────────────────────────────────────────────────────────────────

it('(b) a page opened mid-reply gets its meta, every frame so far in order, then the rest live, through done', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  try {
    const conv = h.store.createConversation()
    const meta = await sendAndLeave(h.app, conv.id, 'hi')
    const call = await engine.call(1)
    call.word(LONG)
    call.word(LONG)
    await waitFor(() => (chatRuns.latestRun(conv.id)?.buffer.head() ?? 0) >= 3, 'two deltas in the run')
    const viewer = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
    await viewer.until((f) => f.id === 2)
    call.word('The end.')
    call.finish()
    await viewer.done
    const [synth, ...numbered] = viewer.frames
    assert.deepEqual(synth, { id: undefined, event: 'meta', data: meta }, 'the run\'s meta, un-id\'d, first')
    assert.deepEqual(numbered[0], { id: 0, event: 'meta', data: meta }, 'then frame 0')
    assert.deepEqual(numbered.map((f) => f.id), numbered.map((_, i) => i), 'every frame, in order, ids rising')
    assert.equal(numbered.at(-1)!.event, 'done')
    assert.equal(viewer.text(), `${LONG}${LONG}The end.`)
    const conversation = await (await h.app.request(`/api/v1/conversations/${conv.id}`)).json() as { messages: Message[] }
    assert.deepEqual(numbered.at(-1)!.data.message, conversation.messages.find((m) => m.id === meta.assistantMessageId), 'done carries the saved row')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

it('(c) a resume with run and fromSeq gets only what follows its cursor; a cursor past the head gets the whole run; another reply gets nothing', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  try {
    const conv = h.store.createConversation()
    const { assistantMessageId: run } = await sendAndLeave(h.app, conv.id, 'hi')
    const call = await engine.call(1)
    for (let i = 0; i < 4; i++) call.word(LONG)
    await waitFor(() => (chatRuns.latestRun(conv.id)?.buffer.head() ?? 0) >= 5, 'four deltas in the run')
    const base = `/api/v1/conversations/${conv.id}/stream`
    const resumed = sseFrames(await h.app.request(`${base}?run=${run}&fromSeq=3`))
    const pastHead = sseFrames(await h.app.request(`${base}?run=${run}&fromSeq=999`))
    const other = sseFrames(await h.app.request(`${base}?run=not-this-reply&fromSeq=3`))
    await other.done
    assert.deepEqual(other.frames, [], 'a reply the daemon does not have: an empty stream')
    call.finish()
    await Promise.all([resumed.done, pastHead.done])
    const ids = (v: ReturnType<typeof sseFrames>) => v.frames.filter((f) => f.id !== undefined).map((f) => f.id)
    const last = chatRuns.find(conv.id, run)!.buffer.head() - 1
    assert.deepEqual(ids(pastHead), Array.from({ length: last + 1 }, (_, i) => i), 'a cursor past the head replays the whole run')
    assert.deepEqual(ids(resumed), ids(pastHead).slice(3), 'from the cursor, through done')
    assert.equal(resumed.frames.at(-1)!.event, 'done')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

// ── (d) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(d) a finished run: a new viewer gets nothing; one naming it gets the rest, through done, until it is dropped 30 s on', async (t) => {
  // The engine is a fetch double here: the retention timer is mocked, and the real fetch's own timers must not be.
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'all done' } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as typeof fetch
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = routes('http://engine.invalid')
  try {
    const conv = h.store.createConversation()
    const whole = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'hi' })))
    await whole.done
    const run = whole.frames[0].data.assistantMessageId as string
    const base = `/api/v1/conversations/${conv.id}/stream`
    const fresh = sseFrames(await h.app.request(base))
    await fresh.done
    assert.deepEqual(fresh.frames, [], 'the reply is in the conversation already')
    const rest = sseFrames(await h.app.request(`${base}?run=${run}&fromSeq=1`))
    await rest.done
    assert.deepEqual(rest.frames.map((f) => [f.id, f.event]), whole.frames.slice(1).map((f) => [f.id, f.event]), 'no synthesized meta: the run has ended')
    assert.equal(rest.frames.at(-1)!.event, 'done')
    t.mock.timers.tick(30_000)
    const late = sseFrames(await h.app.request(`${base}?run=${run}&fromSeq=1`))
    await late.done
    assert.deepEqual(late.frames, [], 'dropped once retention is over')
  } finally {
    globalThis.fetch = original
    h.cleanup()
  }
})

// ── (e) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(e) Stop names the reply: it reaches the engine, saves the partial as stopped, ends every viewer with done, and frees the chat', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  try {
    const conv = h.store.createConversation()
    const { assistantMessageId } = await sendAndLeave(h.app, conv.id, 'hi')
    const call = await engine.call(1)
    call.word(LONG)
    await waitFor(() => (chatRuns.latestRun(conv.id)?.buffer.head() ?? 0) >= 2, 'a delta in the run')
    const viewer = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
    await viewer.until((f) => f.event === 'delta')

    const stale = await (await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id, messageId: 'an-older-reply' }))).json()
    assert.deepEqual(stale, { ok: true, stopped: false }, 'a reply that does not hold the chat is not stopped')
    assert.deepEqual(inFlightChatIds(), [conv.id])
    assert.equal(call.gone, false)

    const stop = await (await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id, messageId: assistantMessageId }))).json()
    assert.deepEqual(stop, { ok: true, stopped: true })
    assert.deepEqual(inFlightChatIds(), [], 'the chat is free at once')
    await waitFor(() => call.gone, 'the engine to see the abort')
    const done = await viewer.until((f) => f.event === 'done')
    assert.equal((done.data.message as Message).stats.aborted, true)
    await viewer.done
    const r = reply(h.store, conv.id)
    assert.equal(r.stats.aborted, true)
    assert.equal(r.content, LONG)

    const next = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'and now?' }))
    assert.equal(next.status, 200, 'a send right after Stop is taken')
    ;(await engine.call(2)).finish()
    await next.text()
  } finally {
    h.cleanup()
    await engine.close()
  }
})

// ── (f) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(f) a call waiting for approval keeps waiting with the page gone; a page opened later shows it, and Allow runs it', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url, { toolPolicy: 'ask' })
  try {
    const conv = h.store.createConversation()
    await sendAndLeave(h.app, conv.id, 'compute 6*7')
    const round1 = await engine.call(1)
    round1.toolCall('call_1', 'run_code', '{"code":"6*7"}')
    round1.finish('tool_calls')
    const first = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
    await first.until((f) => f.event === 'tool_call' && f.data.status === 'awaiting_approval')
    await first.cancel() // that page goes too
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(executed, [], 'still waiting: no page is no answer')
    assert.deepEqual(inFlightChatIds(), [conv.id])

    const reopened = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
    await reopened.until((f) => f.event === 'tool_call' && f.data.status === 'awaiting_approval', 'the replayed approval request')
    const approve = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_code', decision: 'allow' }))
    assert.equal(approve.status, 200)
    const round2 = await engine.call(2)
    round2.word('The answer is 42.')
    round2.finish()
    await reopened.until((f) => f.event === 'done')
    assert.deepEqual(executed, ['run_code'])
    const r = reply(h.store, conv.id)
    assert.equal(r.content, 'The answer is 42.')
    assert.equal(r.toolCalls[0].result, '42')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

it('(f) a Stop while a call waits for approval records it as denied, and the call does not run', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url, { toolPolicy: 'ask' })
  try {
    const conv = h.store.createConversation()
    const { assistantMessageId } = await sendAndLeave(h.app, conv.id, 'compute 6*7')
    const round1 = await engine.call(1)
    round1.toolCall('call_1', 'run_code', '{"code":"6*7"}')
    round1.finish('tool_calls')
    const viewer = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
    await viewer.until((f) => f.event === 'tool_call' && f.data.status === 'awaiting_approval')
    await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id, messageId: assistantMessageId }))
    await viewer.until((f) => f.event === 'done')
    const r = reply(h.store, conv.id)
    assert.equal(r.toolCalls[0].result, 'Denied by user.')
    assert.equal(r.stats.aborted, true)
    assert.deepEqual(executed, [])
    assert.equal(engine.calls.length, 1, 'no second round')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

// ── (g) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(g) a turn\'s auto-compaction is in its run: a page that attaches meanwhile is told it is compacting', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  const release = engine.holdNonStreamReplies('The user asked twice about x.')
  try {
    const conv = h.store.createConversation()
    const long = 'x'.repeat(6000)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long, { stats: { ctxUsed: 7500, ctxMax: 8192 } }) // 92% of the window
    await sendAndLeave(h.app, conv.id, 'q3')
    await waitFor(() => engine.nonStream.length === 1, 'the summary call')
    const viewer = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
    await viewer.until((f) => f.event === 'compaction' && f.data.phase === 'start', 'compaction start')
    release()
    await viewer.until((f) => f.event === 'compaction' && f.data.phase === 'end', 'compaction end')
    const call = await engine.call(1)
    call.word('a3')
    call.finish()
    await viewer.until((f) => f.event === 'done')
    assert.equal(h.store.getConversation(conv.id)!.compactionSummary, 'The user asked twice about x.')
  } finally {
    release()
    h.cleanup()
    await engine.close()
  }
})

// ── (h) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(h) a Turbo Link turn\'s leg to the host lives with the run: the page going away does not cut it, Stop does', async () => {
  const host = await standInEngine()
  const h = routes('http://engine.invalid', { remote: { id: 'rig/qwen3', baseUrl: host.url } })
  try {
    const conv = h.store.createConversation()
    const { assistantMessageId } = await sendAndLeave(h.app, conv.id, 'hi', { model: 'rig/qwen3' })
    const leg = await host.call(1)
    leg.word(LONG)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(leg.gone, false, 'the host is still generating for the run')
    await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id, messageId: assistantMessageId }))
    await waitFor(() => leg.gone, 'the host to see the abort')
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    assert.equal(reply(h.store, conv.id).stats.aborted, true)
  } finally {
    h.cleanup()
    await host.close()
  }
})

// ── (i) (j) (l) ──────────────────────────────────────────────────────────────────────────────────────────────────

it('(i) the engine kill switches and deleting the chat stop a turn no page is watching', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  try {
    const a = h.store.createConversation()
    await sendAndLeave(h.app, a.id, 'one')
    const callA = await engine.call(1)
    assert.equal(abortAllInFlightChats(), 1)
    await waitFor(() => callA.gone, 'a kill switch to reach the engine')
    await waitFor(saved(h.store, a.id), 'the stopped reply to be saved')
    assert.equal(reply(h.store, a.id).stats.aborted, true)

    const b = h.store.createConversation()
    await sendAndLeave(h.app, b.id, 'two')
    const callB = await engine.call(2)
    assert.equal((await h.app.request(`/api/v1/conversations/${b.id}`, { method: 'DELETE' })).status, 200)
    await waitFor(() => callB.gone, 'deleting the chat to reach the engine')
    await waitFor(() => inFlightChatIds().length === 0, 'the deleted chat\'s turn to unwind')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

it('(j) a second send while a reply runs with no page watching is refused (409), and so is a Regenerate', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  try {
    const conv = h.store.createConversation()
    await sendAndLeave(h.app, conv.id, 'one')
    const call = await engine.call(1)
    const again = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'two' }))
    assert.equal(again.status, 409)
    assert.equal(((await again.json()) as { error: { code: string } }).error.code, 'generation_in_flight')
    assert.equal((await h.app.request(`/api/v1/conversations/${conv.id}/continue`, json({ regenerate: true }))).status, 409)
    assert.equal(engine.calls.length, 1, 'neither reached the engine')
    call.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

it('(l) the activity probe keeps listing the chat after its page has gone, until the turn has unwound', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  try {
    const conv = h.store.createConversation()
    await sendAndLeave(h.app, conv.id, 'hi')
    const call = await engine.call(1)
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(activeWork(h.d).items.map((i) => [i.kind, i.id]), [['chat', conv.id]], 'Android\'s busy signal holds the wake lock and the model')
    call.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    await waitFor(() => activeWork(h.d).items.length === 0, 'the chat to leave the probe')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

it('(l) a call waiting for approval moves the chat from the probe\'s items to waiting, and back once answered', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url, { toolPolicy: 'ask' })
  // The engine's generation count, as the manager keeps it: a local turn holds one from its first request to its end.
  let generations = 0
  Object.assign(h.d.manager, { generationStart: () => { generations++ }, generationEnd: () => { generations-- }, sessionStats: () => ({ activeRequests: generations }) })
  try {
    const conv = h.store.createConversation()
    await sendAndLeave(h.app, conv.id, 'compute 6*7')
    const round1 = await engine.call(1)
    assert.deepEqual(activeWork(h.d).items.map((i) => [i.kind, i.id]), [['chat', conv.id]], 'generating: an item')
    assert.equal(activeWork(h.d).engineGenerating, true)
    round1.toolCall('call_1', 'run_code', '{"code":"6*7"}')
    round1.finish('tool_calls')
    await waitFor(() => activeWork(h.d).waiting.length === 1, 'the chat to be waiting')
    // Waiting on a person: Android's EngineService (items and engineGenerating only) lets the phone sleep.
    assert.deepEqual(activeWork(h.d).items, [])
    assert.equal(activeWork(h.d).engineGenerating, false, 'nor an engine generation, though its turn holds the count')
    assert.equal(generations, 1)
    assert.deepEqual(activeWork(h.d).waiting.map((i) => [i.kind, i.id]), [['chat', conv.id]])
    assert.deepEqual(inFlightChatIds(), [conv.id], 'still in flight: a load or Stop ends it')
    const approve = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_code', decision: 'allow' }))
    assert.equal(approve.status, 200)
    const round2 = await engine.call(2)
    assert.deepEqual(activeWork(h.d).items.map((i) => [i.kind, i.id]), [['chat', conv.id]], 'answered: an item again')
    assert.deepEqual(activeWork(h.d).waiting, [])
    assert.equal(activeWork(h.d).engineGenerating, true)
    round2.word('The answer is 42.')
    round2.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    await waitFor(() => activeWork(h.d).items.length === 0, 'the chat to leave the probe')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

it('(l) a reply whose auto-title call is still pending keeps the chat in the probe\'s items until the call settles', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url, { titles: true })
  const release = engine.holdNonStreamReplies('A Generated Title')
  try {
    const conv = h.store.createConversation()
    await sendAndLeave(h.app, conv.id, 'tell me a story')
    const call = await engine.call(1)
    call.word('Once upon a time.')
    call.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    assert.deepEqual(inFlightChatIds(), [], 'the turn has ended')
    // From done, before the title call has even started (1 s on), and while the engine answers it.
    assert.deepEqual(activeWork(h.d).items.map((i) => [i.kind, i.id]), [['chat', conv.id]], 'still busy: the title call needs the model')
    await waitFor(() => engine.nonStream.length === 1, 'the title call', 4000)
    assert.deepEqual(activeWork(h.d).items.map((i) => [i.kind, i.id]), [['chat', conv.id]])
    release()
    await waitFor(() => h.store.getConversation(conv.id)!.title === 'A Generated Title', 'the auto-title')
    await waitFor(() => activeWork(h.d).items.length === 0, 'the chat to leave the probe once the title settled')
  } finally {
    release()
    h.cleanup()
    await engine.close()
  }
})

/** Counts the engine's generations on `h`'s manager double, as the real Manager does (generationStart/End). */
function countGenerations(h: ReturnType<typeof routes>): () => number {
  let generations = 0
  Object.assign(h.d.manager, { generationStart: () => { generations++ }, generationEnd: () => { generations-- } })
  return () => generations
}

it('(l) the idle unload\'s hold covers a turn\'s auto-compaction, which the engine\'s generation count does not', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url)
  const generations = countGenerations(h)
  const release = engine.holdNonStreamReplies('The user asked twice about x.')
  try {
    const conv = h.store.createConversation()
    const long = 'x'.repeat(6000)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long, { stats: { ctxUsed: 7500, ctxMax: 8192 } }) // 92% of the window
    assert.equal(chatHoldsEngine(), false)
    await sendAndLeave(h.app, conv.id, 'q3')
    await waitFor(() => engine.nonStream.length === 1, 'the summary call')
    assert.equal(generations(), 0, 'the summary call holds no generation')
    assert.equal(chatHoldsEngine(), true, 'the compaction needs the model')
    release()
    const call = await engine.call(1)
    assert.equal(chatHoldsEngine(), true)
    call.word('a3')
    call.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    await waitFor(() => !chatHoldsEngine(), 'the hold to end with the turn')
  } finally {
    release()
    h.cleanup()
    await engine.close()
  }
})

it('(l) the idle unload\'s hold covers an approval wait and the reply\'s title call, and ends once the title settles', async () => {
  const engine = await standInEngine()
  const h = routes(engine.url, { titles: true, toolPolicy: 'ask' })
  const generations = countGenerations(h)
  const release = engine.holdNonStreamReplies('A Generated Title')
  try {
    const conv = h.store.createConversation()
    await sendAndLeave(h.app, conv.id, 'compute 6*7')
    const round1 = await engine.call(1)
    assert.equal(chatHoldsEngine(), true, 'generating')
    round1.toolCall('call_1', 'run_code', '{"code":"6*7"}')
    round1.finish('tool_calls')
    await waitFor(() => activeWork(h.d).waiting.length === 1, 'the approval wait')
    assert.equal(chatHoldsEngine(), true, 'waiting for an approval within its wait')
    const approve = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_code', decision: 'allow' }))
    assert.equal(approve.status, 200)
    const round2 = await engine.call(2)
    round2.word('The answer is 42.')
    round2.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    await waitFor(() => engine.nonStream.length === 1, 'the title call', 4000)
    assert.equal(generations(), 0, 'the turn has ended: no generation')
    assert.equal(chatHoldsEngine(), true, 'the title call needs the model')
    release()
    await waitFor(() => h.store.getConversation(conv.id)!.title === 'A Generated Title', 'the auto-title')
    await waitFor(() => !chatHoldsEngine(), 'the hold to end once the title settled')
  } finally {
    release()
    h.cleanup()
    await engine.close()
  }
})

// ── (p) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(p) a viewer gets an SSE keepalive comment every 20 s while nothing else is sent', async (t) => {
  const original = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  globalThis.fetch = (async () => {
    await held
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  t.mock.timers.enable({ apis: ['setInterval'] })
  // Mocked timers keep nothing alive, and the held fetch is no I/O: hold the event loop open meanwhile.
  const alive = setTimeout(() => {}, 60_000)
  const h = routes('http://engine.invalid')
  try {
    const conv = h.store.createConversation()
    const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'hi' }))
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    const readUntil = async (s: string) => { while (!text.includes(s)) text += dec.decode((await reader.read()).value) }
    await readUntil('event: meta')
    assert.ok(!text.includes(': keepalive'))
    const settle = () => new Promise((r) => setImmediate(r)) // the meta write settles a few microtasks after its read
    await settle()
    t.mock.timers.tick(20_000)
    await readUntil(': keepalive\n\n')
    await settle()
    t.mock.timers.tick(20_000)
    await readUntil(': keepalive\n\n: keepalive\n\n')
    release()
    await readUntil('event: done')
    await reader.cancel()
  } finally {
    release()
    clearTimeout(alive)
    globalThis.fetch = original
    h.cleanup()
  }
})

// ── (q) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

it('(q) a reply\'s text is saved while it streams: a kill leaves it, the restart marks it stopped, and the end replaces it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }) // the partial saves' 10 s
  const engine = await standInEngine()
  const h = routes(engine.url)
  const dir = (h.d.store as unknown as { dir(): string }).dir()
  try {
    const conv = h.store.createConversation()
    const { assistantMessageId } = await sendAndLeave(h.app, conv.id, 'write an essay')
    const viewer = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
    const call = await engine.call(1)
    call.word(`Paragraph one, ${LONG}`)
    await viewer.until((f) => f.event === 'delta' && viewer.text().includes('Paragraph one'), 'the first words')
    assert.equal(reply(h.store, conv.id).content, '', 'nothing saved before the interval')

    t.mock.timers.tick(10_000)
    assert.ok(reply(h.store, conv.id).content.startsWith('Paragraph one'), 'saved while it streams')
    assert.deepEqual(reply(h.store, conv.id).stats, { aborted: false }, 'still the placeholder\'s stats')
    call.word(`Paragraph two, ${LONG}`)
    await viewer.until(() => viewer.text().includes('Paragraph two'), 'more words')
    t.mock.timers.tick(10_000)
    assert.ok(reply(h.store, conv.id).content.includes('Paragraph two'), 'the next save has the newer text')

    // What a daemon killed now leaves, read as the next process does: its startup reconcile marks the reply stopped and
    // keeps the text.
    const restarted = new ConversationStore(dir)
    try {
      const log = console.log
      console.log = () => {}
      try {
        registerChatRoutes(new Hono(), { db: restarted, store: h.d.store } as unknown as Deps)
      } finally {
        console.log = log
      }
      const left = restarted.getMessage(assistantMessageId)!
      assert.deepEqual(left.stats, { aborted: true })
      assert.ok(left.content.startsWith('Paragraph one') && left.content.includes('Paragraph two'))
    } finally {
      restarted.close()
    }

    // This process's turn goes on, and its end-of-turn save replaces the partial one.
    call.word('The end.')
    call.finish()
    await waitFor(saved(h.store, conv.id), 'the reply to be saved')
    const final = reply(h.store, conv.id)
    assert.ok(final.content.endsWith('The end.'))
    assert.equal(final.stats.aborted, false)
    assert.equal(typeof final.stats.totalMs, 'number')
    await viewer.cancel()
  } finally {
    h.cleanup()
    await engine.close()
  }
})

// ── (k) (m): through lanAuth, as the daemon judges callers ───────────────────────────────────────────────────────

const RAW_A = 'tllm-detachedturnsdetachedturnsdetachedta1'
const RAW_B = 'tllm-detachedturnsdetachedturnsdetachedtb2'
type Socket = { localPort: number; remoteAddress: string }
const LAN: Socket = { localPort: 6996, remoteAddress: '192.168.1.50' }
const LOOPBACK: Socket = { localPort: 6996, remoteAddress: '127.0.0.1' }

class FakeProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'none' as const
  async preflight(): Promise<PreflightState> { return { kind: 'off' } }
  async start(): Promise<{ url: string }> { return { url: 'https://phone.example.test' } }
  async stop(): Promise<void> {}
  alive(): boolean { return true }
}

/** A LAN-exposed daemon with keys A and B, lanAuth in front of the chat routes, and remote access on (a real
 *  RemoteAccessManager on an ephemeral ingress port, with a provider that only records a URL). DELETE /api/v1/keys/:id
 *  does what api/routes.ts's does: drop the key and end what it held (endStaleStreams). */
async function gatedRoutes(engineUrl: string, opts: { requireApiKey?: boolean } = {}) {
  const dir = tmpDir('tllm-chat-detached-gated-')
  const store = new ConversationStore(dir)
  const cfg: Config = defaultConfig()
  cfg.daemon.lanBind = true
  cfg.daemon.requireApiKey = opts.requireApiKey ?? cfg.daemon.requireApiKey
  cfg.daemon.autoGenerateTitles = false
  cfg.apiKeys.push(
    { id: 'kA', name: 'a', hash: hashKey(RAW_A), prefix: RAW_A.slice(0, 12), createdAt: '', lastUsedAt: null },
    { id: 'kB', name: 'b', hash: hashKey(RAW_B), prefix: RAW_B.slice(0, 12), createdAt: '', lastUsedAt: null },
  )
  const app = new Hono()
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    modelRouter: { resolveRemoteTarget: () => undefined },
    manager: {
      status: () => ({ state: 'running', model: { key: 'gemma-27b', name: 'Gemma 27B', ctx: 8192 } }),
      target: () => engineUrl,
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
  } as unknown as Deps
  const remote = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => new FakeProvider(), probe: async () => true })
  ;(d as { remote: unknown }).remote = remote
  app.use('*', lanAuth(d))
  app.delete('/api/v1/keys/:id', (c) => {
    cfg.apiKeys = cfg.apiKeys.filter((k) => k.id !== c.req.param('id'))
    endStaleStreams(d)
    return c.json({ ok: true })
  })
  registerChatRoutes(app, d)
  await remote.enable()
  const ingress: Socket = { localPort: remote.ingressPort()!, remoteAddress: '127.0.0.1' }
  const send = (socket: Socket, method: string, path: string, opts: { key?: string; body?: unknown } = {}) =>
    app.request(path, {
      method,
      headers: { ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
  /** Starts a turn from `socket` with `key`, keeps the page only until it started, and returns the engine's call. */
  const startTurn = async (socket: Socket, key: string | undefined, engine: Awaited<ReturnType<typeof standInEngine>>, n: number) => {
    const conv = store.createConversation()
    const res = await send(socket, 'POST', `/api/v1/conversations/${conv.id}/messages`, { key, body: { content: `turn ${n}` } })
    assert.equal(res.status, 200, `turn ${n} admitted`)
    const page = sseFrames(res)
    await page.until((f) => f.event === 'meta')
    await page.cancel()
    return { conv, call: await engine.call(n) }
  }
  const remoteToken = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  const remoteKeyId = cfg.apiKeys.find((k) => k.hash === hashKey(remoteToken))!.id
  return {
    store, cfg, d, send, startTurn, remote, ingress, remoteToken, remoteKeyId,
    cleanup: async () => { await remote.disable(); store.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

it('(k) revoking the key a viewer opened its stream with ends that viewer; the host\'s turn runs on', async () => {
  const engine = await standInEngine()
  const g = await gatedRoutes(engine.url)
  try {
    const { conv, call } = await g.startTurn(LOOPBACK, undefined, engine, 1)
    call.word(LONG)
    const viewer = sseFrames(await g.send(LAN, 'GET', `/api/v1/conversations/${conv.id}/stream`, { key: RAW_A }))
    await viewer.until((f) => f.event === 'delta')
    assert.equal((await g.send(LOOPBACK, 'DELETE', '/api/v1/keys/kA')).status, 200)
    await viewer.done
    assert.ok(!viewer.frames.some((f) => f.event === 'done'), 'the viewer was ended, not the turn')
    call.word('more.')
    call.finish()
    await waitFor(saved(g.store, conv.id), 'the host\'s reply to be saved')
    assert.equal(call.gone, false)
    assert.equal(reply(g.store, conv.id).stats.aborted, false)
  } finally {
    await g.cleanup()
    await engine.close()
  }
})

it('(m) revoking a remote-access token mid-reply stops the reply it started; a host turn and a LAN-key turn run on', async () => {
  const engine = await standInEngine()
  const g = await gatedRoutes(engine.url)
  try {
    const phone = await g.startTurn(g.ingress, g.remoteToken, engine, 1)
    const host = await g.startTurn(LOOPBACK, undefined, engine, 2)
    const lan = await g.startTurn(LAN, RAW_B, engine, 3)
    // The token's key, revoked from the host's Keys list.
    assert.equal((await g.send(LOOPBACK, 'DELETE', `/api/v1/keys/${g.remoteKeyId}`)).status, 200)
    await waitFor(() => phone.call.gone, 'the phone\'s reply to be stopped')
    await waitFor(saved(g.store, phone.conv.id), 'the stopped reply to be saved')
    assert.equal(reply(g.store, phone.conv.id).stats.aborted, true)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(host.call.gone, false, 'the host\'s turn runs on')
    assert.equal(lan.call.gone, false, 'the LAN key\'s turn runs on')
    host.call.finish()
    lan.call.finish()
  } finally {
    await g.cleanup()
    await engine.close()
  }
})

it('(m) stopping remote access mid-reply stops the replies that came through it; a host turn and a LAN-key turn run on', async () => {
  const engine = await standInEngine()
  const g = await gatedRoutes(engine.url)
  try {
    const phone = await g.startTurn(g.ingress, g.remoteToken, engine, 1)
    const host = await g.startTurn(LOOPBACK, undefined, engine, 2)
    const lan = await g.startTurn(LAN, RAW_B, engine, 3)
    await g.remote.disable()
    await waitFor(() => phone.call.gone, 'the phone\'s reply to be stopped')
    await waitFor(saved(g.store, phone.conv.id), 'the stopped reply to be saved')
    assert.equal(reply(g.store, phone.conv.id).stats.aborted, true)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(host.call.gone, false, 'the host\'s turn runs on')
    assert.equal(lan.call.gone, false, 'the LAN key\'s turn runs on')
    host.call.finish()
    lan.call.finish()
    await waitFor(saved(g.store, host.conv.id), 'the host\'s reply to be saved')
    assert.equal(reply(g.store, host.conv.id).stats.aborted, false)
  } finally {
    await g.cleanup()
    await engine.close()
  }
})

it('(m) turning LAN access off mid-reply stops the replies LAN peers sent; a host turn and a remote-access turn run on', async () => {
  const engine = await standInEngine()
  const g = await gatedRoutes(engine.url)
  try {
    const lan = await g.startTurn(LAN, RAW_B, engine, 1)
    const host = await g.startTurn(LOOPBACK, undefined, engine, 2)
    const phone = await g.startTurn(g.ingress, g.remoteToken, engine, 3)
    // A bind that is still LAN-exposed stops nothing: a port change with LAN on, or LAN off under an --addr 0.0.0.0.
    assert.equal(endLanTurns(g.d), 0)
    g.cfg.daemon.lanBind = false
    g.d.bindHost = '0.0.0.0'
    assert.equal(endLanTurns(g.d), 0)
    // LAN access turned off: PATCH /api/v1/settings rebinds onto loopback, and cli.ts listen() calls this on the bind.
    g.d.bindHost = '127.0.0.1'
    assert.equal(endLanTurns(g.d), 1)
    await waitFor(() => lan.call.gone, 'the LAN peer\'s reply to be stopped')
    await waitFor(saved(g.store, lan.conv.id), 'the stopped reply to be saved')
    assert.equal(reply(g.store, lan.conv.id).stats.aborted, true)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(host.call.gone, false, 'the host\'s turn runs on')
    assert.equal(phone.call.gone, false, 'the remote-access turn runs on (the ingress is still up)')
    host.call.finish()
    phone.call.finish()
    await waitFor(saved(g.store, host.conv.id), 'the host\'s reply to be saved')
    assert.equal(reply(g.store, host.conv.id).stats.aborted, false)
    await waitFor(saved(g.store, phone.conv.id), 'the phone\'s reply to be saved')
    assert.equal(reply(g.store, phone.conv.id).stats.aborted, false)
  } finally {
    await g.cleanup()
    await engine.close()
  }
})

it('(m) a keyless turn from an open LAN is stopped once a key is required; a LAN turn whose key is still accepted and a host turn run on', async () => {
  const engine = await standInEngine()
  const g = await gatedRoutes(engine.url, { requireApiKey: false })
  try {
    const open = await g.startTurn(LAN, undefined, engine, 1)
    const keyed = await g.startTurn(LAN, RAW_B, engine, 2)
    const host = await g.startTurn(LOOPBACK, undefined, engine, 3)
    // "Require an API key" turned on: PATCH /api/v1/settings ends what an open LAN let in (api/routes.ts).
    g.cfg.daemon.requireApiKey = true
    endStaleStreams(g.d)
    await waitFor(() => open.call.gone, 'the keyless reply to be stopped')
    await waitFor(saved(g.store, open.conv.id), 'the stopped reply to be saved')
    assert.equal(reply(g.store, open.conv.id).stats.aborted, true)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(keyed.call.gone, false, 'the turn that sent a key still accepted runs on')
    assert.equal(host.call.gone, false, 'the host\'s turn runs on')
    keyed.call.finish()
    host.call.finish()
    await waitFor(saved(g.store, keyed.conv.id), 'the keyed reply to be saved')
    assert.equal(reply(g.store, keyed.conv.id).stats.aborted, false)
  } finally {
    await g.cleanup()
    await engine.close()
  }
})
