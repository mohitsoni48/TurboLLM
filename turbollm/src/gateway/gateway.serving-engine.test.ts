// A request routed to a keep-N pool slot (ADR-060) is accounted on, and gated by, THAT slot's engine — scalability
// review items 1.1 and 1.5. Before: one daemon-wide GenerationGate sized from the primary's `--parallel` was taken for
// every request whatever model it routed to, so a pool model queued behind the primary's traffic (and, with an
// unbounded vLLM/MLX primary, a `--parallel 1` pool slot was not gated at all); and generationStart/End,
// recordCompletion and setLiveGen always went to the primary, so a generating pool slot read as idle to its own
// idle-TTL watchdog (which could stop it mid-stream) while the primary was kept alive by work it was not doing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { EngineGates } from '../agents/gate'
import type { Deps } from '../deps'

/** A real engine socket on an ephemeral port: SSE for a streaming request, one JSON body otherwise. */
async function withEngine(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as { stream?: boolean }
      const usage = '"usage":{"prompt_tokens":5,"completion_tokens":1}'
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')
        res.write(`data: {"choices":[{"index":0,"finish_reason":"stop","delta":{}}],${usage}}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(`{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"hi"}}],${usage}}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** A Manager double that counts what the gateway accounts on it. */
function countingEngine(slots: number) {
  const counts = { starts: 0, ends: 0, completions: 0, live: 0 }
  const manager = {
    status: () => ({ state: 'running', model: { name: 'Model', key: 'model' } }),
    currentOpts: () => null,
    parallelSlots: () => slots,
    generationStart: () => { counts.starts++ },
    generationEnd: () => { counts.ends++ },
    recordCompletion: () => { counts.completions++ },
    setLiveGen: () => { counts.live++ },
  }
  return { manager, counts }
}

const CONFIG = { modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }

function deps(target: string, primary: object, pool: object, gates: EngineGates): Deps {
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    // The route names the pool slot's Manager, as ModelRouter.served() does for a model in a pool slot.
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target, manager: pool }) },
    // `read` too: a concurrent change moves some config reads to ConfigStore.read(); same view here.
    store: { snapshot: () => CONFIG, read: () => CONFIG },
    manager: primary,
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
    gate: gates.for(primary as never),
    gateFor: (engine: never) => gates.for(engine),
  } as unknown as Deps
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const REQUESTS: Array<{ name: string; path: string; body: Record<string, unknown> }> = [
  { name: 'Anthropic streaming', path: '/v1/messages', body: { model: 'pool-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, stream: true } },
  { name: 'Anthropic non-streaming', path: '/v1/messages', body: { model: 'pool-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } },
  { name: 'OpenAI streaming', path: '/v1/chat/completions', body: { model: 'pool-model', messages: [{ role: 'user', content: 'hi' }], stream: true } },
  { name: 'OpenAI non-streaming', path: '/v1/chat/completions', body: { model: 'pool-model', messages: [{ role: 'user', content: 'hi' }] } },
]

for (const r of REQUESTS) {
  test(`${r.name}: a pool-slot request takes the pool engine's gate and is counted on it, never on the primary`, async () => {
    const engine = await withEngine()
    const primary = countingEngine(1)
    const pool = countingEngine(1)
    const gates = new EngineGates()
    // The primary's only slot is busy: under one shared gate this request would queue behind it.
    const primaryHeld = await gates.for(primary.manager).acquire('bg')
    try {
      const app = new Hono()
      registerGateway(app, deps(engine.url, primary.manager, pool.manager, gates), { gateAcquireTimeoutMs: 1000 })
      const res = await app.request(r.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.doesNotMatch(text, /free engine slot/, 'not queued behind the primary\'s gate')
      // The OpenAI drain releases its slot and ends its generation after the client's copy is relayed.
      await waitUntil(() => pool.counts.ends === 1 && gates.for(pool.manager).stats().inFlight === 0)
      assert.equal(pool.counts.starts, 1, 'the generation is counted on the engine that ran it')
      assert.ok(pool.counts.completions >= 1, 'its stats land on the pool engine')
      assert.deepEqual(primary.counts, { starts: 0, ends: 0, completions: 0, live: 0 }, 'nothing is counted on the primary')
      assert.equal(gates.for(primary.manager).stats().queued, 0)
    } finally {
      primaryHeld()
      await engine.close()
    }
  })
}

test('a pool slot with one slot gates its own traffic even when the primary is unbounded (vLLM/MLX)', async () => {
  const engine = await withEngine()
  const primary = countingEngine(Infinity)
  const pool = countingEngine(1)
  const gates = new EngineGates()
  const poolHeld = await gates.for(pool.manager).acquire('bg')
  try {
    const app = new Hono()
    registerGateway(app, deps(engine.url, primary.manager, pool.manager, gates), { gateAcquireTimeoutMs: 50 })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REQUESTS[1].body),
    })
    assert.equal(res.status, 503, 'queued on the pool engine\'s own full gate, then timed out')
    assert.equal(pool.counts.starts, 0)
  } finally {
    poolHeld()
    await engine.close()
  }
})

/** An engine that holds every reply until `release()`, as llama-server holds a non-stream reply's headers until it has
 *  generated the whole thing; `status` is what it answers with then. */
async function withHeldEngine(status = 200): Promise<{ url: string; received: () => number; release: () => void; close: () => Promise<void> }> {
  let received = 0
  const pending: Array<() => void> = []
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      received++
      pending.push(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(status === 200
          ? '{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"hi"}}]}'
          : '{"error":{"message":"boom"}}')
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    received: () => received,
    release: () => { for (const send of pending.splice(0)) send() },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

const OPENAI_NON_STREAM = { model: 'pool-model', messages: [{ role: 'user', content: 'hi' }] }

async function postOpenAi(app: Hono): Promise<Response> {
  return app.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(OPENAI_NON_STREAM) })
}

// Review H1: generationStart ran only once fetch() resolved, and llama-server sends no headers until a non-stream reply
// is generated whole (or prefill ends, streaming), so for that whole window the engine read idle to keep-N eviction,
// the pool idle-TTL watchdog and hostIdleState.
test('OpenAI: a request the engine has not answered yet already counts as generating on its engine', async () => {
  const engine = await withHeldEngine()
  const primary = countingEngine(1)
  const pool = countingEngine(1)
  try {
    const app = new Hono()
    registerGateway(app, deps(engine.url, primary.manager, pool.manager, new EngineGates()))
    const pending = postOpenAi(app)
    await waitUntil(() => engine.received() === 1)
    assert.equal(pool.counts.starts - pool.counts.ends, 1, 'in flight before the engine sent a header')
    engine.release()
    const res = await pending
    assert.equal(res.status, 200)
    await res.text() // the usage tap is fed as the client reads (scalability review 4.5)
    await waitUntil(() => pool.counts.ends === 1)
    assert.equal(pool.counts.starts, 1, 'started once, not again when the reply arrived')
  } finally {
    await engine.close()
  }
})

for (const outcome of ['an engine error status', 'an unreachable engine'] as const) {
  test(`OpenAI: a generation started before the fetch is ended on ${outcome}`, async () => {
    const engine = await withHeldEngine(500)
    const primary = countingEngine(1)
    const pool = countingEngine(1)
    const gates = new EngineGates()
    try {
      if (outcome === 'an unreachable engine') await engine.close()
      const app = new Hono()
      registerGateway(app, deps(engine.url, primary.manager, pool.manager, gates))
      const pending = postOpenAi(app)
      if (outcome === 'an engine error status') {
        await waitUntil(() => engine.received() === 1)
        engine.release()
      }
      const res = await pending
      assert.equal(res.status, 500)
      await res.text()
      assert.deepEqual([pool.counts.starts, pool.counts.ends], [1, 1], 'every start is balanced by an end')
      assert.equal(gates.for(pool.manager).stats().inFlight, 0, 'and the slot is given back')
    } finally {
      if (outcome === 'an engine error status') await engine.close()
    }
  })
}
