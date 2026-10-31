// Stop through POST /api/v1/chat/stop, against a real node:http stand-in engine read through the real fetch.
//
// The fetch doubles the other chat tests use ERROR the body on abort (chat-routes.persist.test.ts fakeUpstream), so
// they only ever exercise the turn whose read rejects with an AbortError. A real engine read does not always do that:
// with the developer request log on (the default) callChatUpstream hands the turn one branch of a tee'd body, and
// cancelling that branch on abort ENDS the pending read (done: true) instead of rejecting it; Node 18's fetch body (the
// Android app's runtime) ends the same way with the log off. The turn then took its normal end path: the stopped reply
// was saved as finished (`aborted: false`), auto-title ran on it, and a tool call it was streaming when Stop came still
// ran, a tool set to Allow included.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db.js'
import { RequestLog } from '../observability/request-log.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

interface EngineRequest { stream: boolean; lastUser: string }

/** A stand-in llama-server on a real port: a streaming request whose last user message says TOOL streams a run_code
 *  call whose arguments trickle in and never finish; any other streams `w1 w2 …` every 15 ms, 400 words in all. A
 *  non-streaming request (auto-title) gets a title. `gone` counts the streams the client hung up on. */
async function standInEngine() {
  const requests: EngineRequest[] = []
  let gone = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { stream?: boolean; messages?: Array<{ role: string; content: unknown }> }
      const lastUser = String((body.messages ?? []).filter((m) => m.role === 'user').at(-1)?.content ?? '')
      requests.push({ stream: !!body.stream, lastUser })
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'A Generated Title' }, finish_reason: 'stop' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      let ended = false
      let timer: NodeJS.Timeout
      if (lastUser.includes('TOOL')) {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_code', arguments: '' } }] } }] })
        const parts = ['{"code": ', '"6*7"', '}']
        let k = 0
        timer = setInterval(() => { if (k < parts.length) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: parts[k++] } }] } }] }) }, 15)
      } else {
        let i = 0
        timer = setInterval(() => {
          send({ choices: [{ index: 0, delta: { content: `w${++i} ` } }] })
          if (i >= 400) {
            clearInterval(timer)
            ended = true
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            res.end('data: [DONE]\n\n')
          }
        }, 15)
      }
      res.on('close', () => { clearInterval(timer); if (!ended) gone++ })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    gone: () => gone,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** The real chat routes over a real store, generating on `engineUrl`, with the request log on as config.ts's default
 *  has it. `run_code` is set to Allow; `executed` lists every tool call that started. */
function harness(engineUrl: string, opts: { requestLog?: boolean; titles?: boolean } = {}) {
  const dir = tmpDir('tllm-chat-stop-')
  // In memory: an on-disk store cost about a second per test, with multi-second stalls, on a hosted Windows runner, and
  // nothing here reads the file.
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const executed: string[] = []
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: opts.titles ?? false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: { run_code: 'allow' }, autoAllowAll: false },
    requestLog: { enabled: opts.requestLog ?? true, captureBodies: false, maxEntries: 500 },
  }
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    modelRouter: { resolveRemoteTarget: () => undefined },
    requestLog: new RequestLog(),
    manager: {
      status: () => ({ state: 'running', model: { key: 'gemma-27b', name: 'Gemma 27B', ctx: 8192 } }),
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
  return { app, store, executed, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** Polls `cond` until it holds — a precondition the test waits FOR, never a guessed duration. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Reads an SSE response frame by frame; `until` resolves once a frame matching `pred` has arrived. */
function sseFrames(res: Response) {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = []
  const waiters: Array<{ pred: (f: typeof frames[number]) => boolean; resolve: () => void }> = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const ended = (async () => {
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
        const data = /^data: (.*)$/m.exec(block)?.[1]
        const frame = { event, data: data ? JSON.parse(data) as Record<string, unknown> : {} }
        frames.push(frame)
        for (const w of [...waiters]) if (w.pred(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve() }
      }
    }
  })()
  return {
    frames,
    ended,
    /** The reply text streamed so far (the parser hands it on in pieces of its own). */
    text: () => frames.filter((f) => f.event === 'delta').map((f) => f.data.delta).join(''),
    until: (pred: (f: typeof frames[number]) => boolean) =>
      frames.some(pred) ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ pred, resolve }) }),
  }
}

// Only a guard against a hang. On a hosted Windows runner, with other test files competing for its few cores and slow
// disk, two tests in a row have stalled past 20 s; a real hang still fails, a minute on.
const GUARD_MS = 60_000

test('Stop mid-reply with the request log on saves the reply as stopped and gives it no title', { timeout: GUARD_MS }, async () => {
  const engine = await standInEngine()
  const h = harness(engine.url, { titles: true })
  try {
    const conv = h.store.createConversation()
    const sse = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'tell me a long story' })))
    await sse.until(() => sse.text().includes('w8 '))
    assert.equal((await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id }))).status, 200)
    await sse.ended

    const reply = h.store.getMessages(conv.id).find((m) => m.role === 'assistant')!
    assert.equal(reply.stats.aborted, true, 'the stopped reply is saved as stopped')
    assert.match(reply.content, /^w1 w2 w3 w4 w5 w6 w7 w8 /, 'with the text streamed before Stop')
    assert.ok(!reply.content.includes('w400'), 'not the whole reply')
    const done = sse.frames.find((f) => f.event === 'done')!.data.message as { stats: { aborted: boolean } }
    assert.equal(done.stats.aborted, true, 'the done frame says so too')
    await waitFor(() => engine.gone() === 1, 'the engine stream to be hung up on')

    // Auto-title starts 1 s after a finished reply. A stopped reply gets none.
    await new Promise((r) => setTimeout(r, 1300))
    assert.deepEqual(engine.requests.map((r) => r.stream), [true], 'no title request after a Stop')
    assert.equal(h.store.getConversation(conv.id)!.title, 'New chat')
  } finally {
    h.cleanup()
    await engine.close()
  }
})

test('Stop while the reply streams a tool call: the call does not run, though its tool is set to Allow', { timeout: GUARD_MS }, async () => {
  const engine = await standInEngine()
  const h = harness(engine.url)
  try {
    const conv = h.store.createConversation()
    const sse = sseFrames(await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'TOOL: compute 6*7' })))
    await sse.until((f) => f.event === 'tool_call' && f.data.status === 'pending')
    await new Promise((r) => setTimeout(r, 80)) // the call's arguments have all streamed; the stream stays open
    assert.equal((await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id }))).status, 200)
    await sse.ended

    assert.deepEqual(h.executed, [], 'no tool call starts after Stop')
    const reply = h.store.getMessages(conv.id).find((m) => m.role === 'assistant')!
    assert.equal(reply.stats.aborted, true)
    assert.deepEqual(reply.toolCalls ?? [], [], 'no tool result is recorded')
    assert.ok(!sse.frames.some((f) => f.event === 'tool_call' && f.data.status === 'done'), 'no tool result is streamed')
    assert.equal(engine.requests.length, 1, 'no second round is sent to the engine')
  } finally {
    h.cleanup()
    await engine.close()
  }
})
