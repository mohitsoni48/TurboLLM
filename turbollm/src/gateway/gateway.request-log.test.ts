// Coverage for the developer request log's TWO gateway capture points (issue #211 follow-up):
// `/v1/chat/completions` (OpenAI protocol — external clients, Code sessions using an
// OpenAI-shaped harness) and `/v1/messages` (Anthropic protocol — Claude Code and other
// Anthropic-protocol harnesses), streaming and non-streaming each. Asserts the log entry a real
// request produces carries correct params/tokens/timings, and that response bodies are withheld
// unless `requestLog.captureBodies` is on. Route-level (list/detail/stream/clear) coverage lives
// in api/requests-routes.test.ts; the pure ring-buffer lives in
// observability/request-log.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { RequestLog } from '../observability/request-log'
import type { Deps } from '../deps'

const LIBRARY = [{ key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' }]

/** A real, ephemeral HTTP server standing in for the local engine, returning a genuine
 *  OpenAI-shaped SSE stream — same helper shape as gateway.queue-ping.test.ts's, reused here
 *  because `/v1/messages` ALSO sends an OpenAI-shaped request downstream (`mapToOpenAI`), so
 *  one fake engine covers both protocols' streaming tests. */
async function withFakeStreamingEngine(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n')
    res.write('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2},"timings":{"prompt_per_second":100,"predicted_per_second":50}}\n\n')
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

function fakeDeps(target: string, requestLog: RequestLog, captureBodies = false): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false }, requestLog: { enabled: true, captureBodies, maxEntries: 500 }, tools: { search: {} } }) },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Qwen3 8B', key: 'qwen3-8b|Q4|123' } }),
      target: () => target,
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
      setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
    requestLog,
  } as unknown as Deps
}

function engineResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function stubFetch(): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = (async () => engineResponse()) as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('POST /v1/chat/completions (non-streaming): captures params, tokens, status — no body unless captureBodies is on', async () => {
  const requestLog = new RequestLog()
  const deps = fakeDeps('http://engine.invalid.local:1', requestLog, false)
  const app = new Hono()
  registerGateway(app, deps)
  const fetchStub = stubFetch()
  try {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [{ role: 'user', content: 'hi' }], stream: false, temperature: 0.55, top_p: 0.9 }),
    })
    await res.text()
    await waitUntil(() => requestLog.list().length > 0)
  } finally { fetchStub.restore() }

  const [entry] = requestLog.list()
  assert.equal(entry.source, 'openai')
  assert.equal(entry.status, 200)
  assert.equal(entry.stream, false)
  assert.deepEqual(entry.params, { temperature: 0.55, top_p: 0.9 })
  assert.equal(entry.tokens.prompt, 12)
  assert.equal(entry.tokens.completion, 3)
  assert.equal(entry.finishReason, 'stop')
  assert.equal(entry.bodies, null, 'captureBodies was off — no bodies on the list entry')
  // Confirm bodies genuinely were never captured (not just stripped by list()) — get() would
  // also return null if start() had been called with a requestBody.
  assert.equal(requestLog.get(entry.id)!.bodies, null)
})

test('POST /v1/chat/completions (non-streaming): captureBodies on → request AND response bodies present', async () => {
  const requestLog = new RequestLog()
  const deps = fakeDeps('http://engine.invalid.local:1', requestLog, true)
  const app = new Hono()
  registerGateway(app, deps)
  const fetchStub = stubFetch()
  try {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    await res.text()
    await waitUntil(() => requestLog.list().length > 0)
  } finally { fetchStub.restore() }

  const entry = requestLog.get(requestLog.list()[0].id)!
  assert.ok(entry.bodies)
  assert.match(entry.bodies!.request, /"model":"qwen3-8b\|Q4\|123"/)
  assert.match(entry.bodies!.response, /"content":"hi"/)
})

test('POST /v1/chat/completions (streaming): captures tokens, TTFT, finish reason from the SSE drain', async () => {
  const requestLog = new RequestLog()
  const engine = await withFakeStreamingEngine()
  const deps = fakeDeps(engine.url, requestLog, true)
  const app = new Hono()
  registerGateway(app, deps)
  try {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 64 }),
    })
    await res.text() // drain the client-facing copy so the teed background drain also completes
    await waitUntil(() => {
      const [e] = requestLog.list()
      return !!e && e.status !== null
    })
  } finally { await engine.close() }

  const entry = requestLog.get(requestLog.list()[0].id)!
  assert.equal(entry.status, 200)
  assert.equal(entry.stream, true)
  assert.equal(entry.tokens.prompt, 7)
  assert.equal(entry.tokens.completion, 2)
  assert.equal(entry.tokens.promptTps, 100)
  assert.equal(entry.tokens.genTps, 50)
  assert.equal(entry.finishReason, 'stop')
  assert.ok(entry.timings.ttftMs !== null && entry.timings.ttftMs >= 0)
  assert.equal(entry.params.max_tokens, 64)
  assert.deepEqual(entry.bodies, { request: entry.bodies!.request, response: JSON.stringify({ content: 'hello' }) })
})

test('POST /v1/messages (non-streaming, Anthropic protocol): params extracted from the mapped OpenAI body', async () => {
  const requestLog = new RequestLog()
  const deps = fakeDeps('http://engine.invalid.local:1', requestLog, false)
  const app = new Hono()
  registerGateway(app, deps)
  const fetchStub = stubFetch()
  try {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', max_tokens: 200, temperature: 0.4, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await waitUntil(() => requestLog.list().length > 0)
  } finally { fetchStub.restore() }

  const [entry] = requestLog.list()
  assert.equal(entry.source, 'anthropic')
  assert.equal(entry.status, 200)
  assert.equal(entry.params.temperature, 0.4)
  assert.equal(entry.params.max_tokens, 200)
  assert.equal(entry.tokens.prompt, 12)
  assert.equal(entry.tokens.completion, 3)
})

test('POST /v1/messages (streaming, Anthropic protocol): captures tokens and an approximate TTFT', async () => {
  const requestLog = new RequestLog()
  const engine = await withFakeStreamingEngine()
  const deps = fakeDeps(engine.url, requestLog, false)
  const app = new Hono()
  registerGateway(app, deps)
  try {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()
    await waitUntil(() => {
      const [e] = requestLog.list()
      return !!e && e.status !== null
    })
  } finally { await engine.close() }

  const [entry] = requestLog.list()
  assert.equal(entry.source, 'anthropic')
  assert.equal(entry.status, 200)
  assert.equal(entry.tokens.prompt, 7)
  assert.equal(entry.tokens.completion, 2)
  assert.ok(entry.timings.ttftMs !== null && entry.timings.ttftMs >= 0)
  // The Anthropic streaming path deliberately does not capture response TEXT (see gateway.ts's
  // comment above `finalizeLog` in the onUsage callback) — only request-side bodies, and only
  // when captureBodies is on (off here).
  assert.equal(entry.bodies, null)
})

test('a request with no `d.requestLog` configured never throws (feature absent under some embeddings)', async () => {
  const deps = {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: 'http://engine.invalid.local:1' }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Qwen3 8B', key: 'qwen3-8b|Q4|123' } }),
      target: () => 'http://engine.invalid.local:1',
      currentOpts: () => null,
      generationStart: () => {}, generationEnd: () => {}, recordCompletion: () => {}, setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
    // requestLog deliberately absent
  } as unknown as Deps
  const app = new Hono()
  registerGateway(app, deps)
  const fetchStub = stubFetch()
  try {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
    })
    assert.equal(res.status, 200)
  } finally { fetchStub.restore() }
})
