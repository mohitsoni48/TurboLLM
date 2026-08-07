// Regression coverage for ADR-347: gate.acquire() (up to 600s) and the engine fetch() both ran
// BEFORE the client's SSE connection was ever opened, so a Task-tool sub-agent queued behind a
// busy `--parallel 1` engine got zero bytes for the whole wait — invisible to the keep-alive ping
// fix (ADR-342), which only covered the read loop AFTER the engine had already accepted the
// request. Caught in review on the PR that shipped ADR-342, before it tagged. Fixed by opening the
// SSE stream and sending message_start FIRST, then pinging through the queue wait and fetch() too.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { GenerationGate } from '../agents/gate'
import type { Deps } from '../deps'

const LIBRARY = [{ key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' }]

/** A real, ephemeral HTTP server standing in for the engine target, responding with a genuine
 *  OpenAI-shaped SSE stream — the point of these tests is the CLIENT-facing ordering/pinging
 *  around the queue wait, not the engine translation itself (already covered elsewhere). */
async function withFakeStreamingEngine(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
    res.write('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function fakeDeps(target: string, gate?: GenerationGate): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => target,
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
      setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    gate,
  } as unknown as Deps
}

/** Polls `check()` until it's true or `timeoutMs` elapses. Needed because the streamSSE callback
 *  runs fire-and-forget (Hono's own `run()` helper doesn't await it) — reading the FIRST SSE
 *  event only proves the write happened, not that the callback has reached its NEXT await yet,
 *  so a synchronous check right after can race ahead of it. */
async function waitUntil(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Reads SSE `event: ...` lines off a Response body as they arrive, decoded incrementally —
 *  needed here specifically because the whole point is ORDERING (message_start must arrive
 *  before the queued gate releases), which `res.text()` (waits for the full body) can't observe. */
function sseEventReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  return {
    /** Resolves with the next `event:` name once a full SSE frame has arrived, or null at EOF. */
    async next(): Promise<string | null> {
      while (true) {
        const m = buf.match(/^event: (.+)\n/m)
        if (m) {
          buf = buf.slice(buf.indexOf('\n\n') + 2)
          return m[1]
        }
        const { done, value } = await reader.read()
        if (done) return null
        buf += dec.decode(value, { stream: true })
      }
    },
  }
}

const messagesBody = JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], max_tokens: 100, stream: true })

test('POST /v1/messages (streaming): message_start arrives while still queued behind a busy gate, before the engine is ever contacted', async () => {
  const engine = await withFakeStreamingEngine()
  const gate = new GenerationGate(() => 1)
  const release = await gate.acquire('bg') // occupy the one slot so the real request must queue
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url, gate))

    const resPromise = app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: messagesBody,
    })

    // The response (and its message_start) must be observable while the gate is STILL held —
    // if this hangs, message_start is (wrongly) waiting on the queue instead of preceding it.
    const res = await resPromise
    assert.ok(res.body)
    const events = sseEventReader(res.body!)
    const first = await events.next()
    assert.equal(first, 'message_start', 'message_start must be sent before queueing for the engine slot')

    // The streamSSE callback runs fire-and-forget (Hono's `run()` doesn't await it), so it may
    // not have reached its own gate.acquire() call the instant message_start's write is observed
    // on this end — poll rather than assume synchronous ordering across the two coroutines.
    await waitUntil(() => gate.stats().queued === 1)

    release() // let the queued request proceed

    const seen = [first]
    for (;;) {
      const evt = await events.next()
      if (evt === null) break
      seen.push(evt)
    }
    assert.equal(seen.filter((e) => e === 'message_start').length, 1, 'message_start must never be sent twice')
    assert.ok(seen.includes('content_block_start'), 'the real engine content must still arrive once the queue clears')
    assert.ok(seen.includes('message_stop'))
  } finally {
    release()
    await engine.close()
  }
})

test('POST /v1/messages (streaming): a queue-wait failure (client already gone) surfaces as an SSE error event, not a bodyless/JSON one', async () => {
  const engine = await withFakeStreamingEngine()
  const gate = new GenerationGate(() => 1)
  const release = await gate.acquire('bg') // occupy the slot so the real request queues and checks the signal
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url, gate))

    const ac = new AbortController()
    ac.abort() // client already disconnected before this request would even start queueing

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: messagesBody,
      signal: ac.signal,
    })

    // SSE streams always answer 200 — the failure has to show up as an `error` event in the body,
    // not a 4xx/5xx status the way the non-streaming path reports the same failure class.
    assert.equal(res.status, 200)
    assert.ok(res.body)
    const events = sseEventReader(res.body!)
    const first = await events.next()
    assert.equal(first, 'message_start')
    const second = await events.next()
    assert.equal(second, 'error', 'the aborted queue wait must surface as an SSE error event')
  } finally {
    release()
    await engine.close()
  }
})
