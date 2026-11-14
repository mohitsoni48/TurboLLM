// The OpenAI streaming path drives its usage parsing from the client-bound stream (scalability review item 4.5).
// Before: `res.body.tee()` gave a second branch that drained the engine regardless of the client, so a client that
// stalled WITHOUT closing (stalled tunnel, paused reader) never fired an abort — the engine generated to max_tokens,
// the client's branch buffered the lot without bound, and the gate slot stayed held until the drain finished. Now the
// usage tap is fed only as fast as the client reads, so client backpressure reaches the engine.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway, type GatewayOptions } from './gateway'
import { EngineGates } from '../agents/gate'
import type { Deps } from '../deps'

const EVENTS = 4000
const PAD = 'y'.repeat(16 * 1024) // ~64 MB over the whole stream: far more than any socket/stream buffer chain holds

/** An engine that writes `EVENTS` fat SSE events, honouring socket backpressure, and reports how many it got out. */
async function withFloodingEngine(): Promise<{ url: string; written: () => number; closed: () => boolean; close: () => Promise<void> }> {
  let written = 0
  let closed = false
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', async () => {
      res.on('close', () => { closed = true })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (let i = 0; i < EVENTS && !closed; i++) {
        const ok = res.write(`data: {"choices":[{"index":0,"delta":{"content":"${PAD}"}}]}\n\n`)
        written++
        if (!ok) await new Promise<void>((r) => { res.once('drain', r); res.once('close', r) })
      }
      if (closed) return
      res.write('data: {"choices":[{"index":0,"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":4000}}\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`, written: () => written, closed: () => closed,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

function setup(target: string, opts: GatewayOptions = {}) {
  const logs: Array<Record<string, unknown>> = []
  const counts = { starts: 0, ends: 0, completions: 0 }
  const usage: Array<{ promptTokens: number; genTokens: number }> = []
  const completions: Array<{ inputTokens: number; outputTokens: number }> = []
  const manager = {
    status: () => ({ state: 'running', model: { name: 'Model', key: 'model' } }),
    target: () => target,
    currentOpts: () => null,
    parallelSlots: () => 1,
    generationStart: () => { counts.starts++ },
    generationEnd: () => { counts.ends++ },
    recordCompletion: (x: { inputTokens: number; outputTokens: number }) => { counts.completions++; completions.push(x) },
    setLiveGen: () => {},
  }
  const config = { modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false }, requestLog: { enabled: true, captureBodies: false, maxEntries: 500 } }
  const gates = new EngineGates()
  const deps = {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target }) },
    store: { snapshot: () => config, read: () => config },
    manager,
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: (u: { promptTokens: number; genTokens: number }) => { usage.push(u) } },
    requestLog: { start: () => 'log1', finalize: (_id: string, f: Record<string, unknown>) => { logs.push(f) }, config: () => ({ enabled: true, captureBodies: false }) },
    gate: gates.for(manager as never),
    gateFor: (e: never) => gates.for(e),
  } as unknown as Deps
  const app = new Hono()
  registerGateway(app, deps, opts)
  const inFlight = (): number => gates.for(manager as never).stats().inFlight
  return { app, counts, usage, completions, logs, inFlight }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`)
    await sleep(10)
  }
}
const request = (app: Hono) => app.request('/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
})

test('a client that stops reading without closing holds the engine back instead of letting it run to completion', async () => {
  const engine = await withFloodingEngine()
  const { app, counts, inFlight } = setup(engine.url)
  try {
    const res = await request(app)
    const reader = res.body!.getReader()
    await reader.read() // one chunk, then the client stalls: no more reads, no cancel
    await sleep(400)
    const stalledAt = engine.written()
    await sleep(400)
    assert.equal(engine.written(), stalledAt, 'the engine made no further progress while the client was not reading')
    assert.ok(stalledAt < EVENTS / 4, `engine wrote ${stalledAt} of ${EVENTS} events: backpressure reached it`)
    assert.equal(inFlight(), 1, 'the slot stays held by a live generation')
    assert.equal(counts.starts, 1)
    assert.equal(counts.ends, 0)
    await reader.cancel() // the client finally gives up: everything is released exactly once
    await waitUntil(() => counts.ends === 1 && inFlight() === 0)
    assert.equal(counts.starts, counts.ends)
    await waitUntil(engine.closed)
  } finally { await engine.close() }
})

test('a client that reads to the end still gets its usage recorded, and the accounting balances', async () => {
  const engine = await withFloodingEngine()
  const { app, counts, usage, inFlight } = setup(engine.url)
  try {
    const res = await request(app)
    const text = await res.text()
    assert.match(text, /\[DONE\]/)
    await waitUntil(() => counts.ends === 1 && inFlight() === 0)
    assert.equal(counts.starts, 1)
    assert.equal(counts.completions, 1)
    assert.deepEqual(usage.map((u) => [u.promptTokens, u.genTokens]), [[7, 4000]])
  } finally { await engine.close() }
})

// A client that closes early (Esc in Claude Code) is a normal end of a turn, not an engine fault: what was generated
// until then is recorded, and the request log says the client closed it.
test('a client that cancels mid-stream still records the partial usage and logs client_closed', async () => {
  const engine = await withFloodingEngine()
  const { app, counts, usage, completions, logs, inFlight } = setup(engine.url)
  try {
    const res = await request(app)
    const reader = res.body!.getReader()
    for (let i = 0; i < 3; i++) await reader.read()
    await reader.cancel()
    await waitUntil(() => counts.ends === 1 && inFlight() === 0 && logs.length > 0)
    assert.equal(usage.length, 1, 'one api_usage row for the interrupted turn')
    assert.ok(usage[0].genTokens >= 3 && usage[0].genTokens < EVENTS, "partial generated count")
    assert.equal(completions.length, 1)
    assert.equal(completions[0].outputTokens, usage[0].genTokens)
    const final = logs[logs.length - 1] as { error?: { code: string } }
    assert.equal(final.error?.code, 'client_closed')
  } finally { await engine.close() }
})

test('a client that stalls without closing past the idle window releases the engine slot and still records usage', async () => {
  const engine = await withFloodingEngine()
  const { app, counts, usage, logs, inFlight } = setup(engine.url, { clientIdleMs: 150 })
  try {
    const res = await request(app)
    const reader = res.body!.getReader()
    await reader.read() // then silence: no read, no cancel
    await waitUntil(() => counts.ends === 1 && inFlight() === 0, 3000)
    await waitUntil(engine.closed)
    await waitUntil(() => usage.length === 1 && logs.length > 0)
    assert.equal((logs[logs.length - 1] as { error?: { code: string } }).error?.code, 'client_closed')
    await assert.rejects(async () => { for (;;) { const r = await reader.read(); if (r.done) return } }, 'the client stream is errored')
  } finally { await engine.close() }
})

test('a client that keeps reading is never cut off by the idle window', async () => {
  const engine = await withFloodingEngine()
  const { app, usage } = setup(engine.url, { clientIdleMs: 150 })
  try {
    const res = await request(app)
    assert.match(await res.text(), /\[DONE\]/)
    await waitUntil(() => usage.length === 1)
    assert.equal(usage[0].genTokens, 4000)
  } finally { await engine.close() }
})
