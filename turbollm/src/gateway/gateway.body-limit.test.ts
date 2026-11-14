// The `/v1/*` gateway refuses a request body over `gateway.maxBodyMb` with a 413 BEFORE any handler buffers and
// JSON.parses it (scalability review item 4.4). Over LAN/remote access a 300 MB body was read whole and parsed
// synchronously; a few at once meant an OOM or a stalled event loop. Each protocol gets its own error envelope.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'

const MB = 1024 * 1024

/** A real engine socket on an ephemeral port that counts the requests that reach it. */
async function withEngine(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      hits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

function deps(target: string, maxBodyMb: number | undefined): Deps {
  const config = { modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false, ...(maxBodyMb === undefined ? {} : { maxBodyMb }) } }
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target }) },
    store: { snapshot: () => config, read: () => config },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Model', key: 'model' } }),
      target: () => target,
      currentOpts: () => null,
      generationStart: () => {}, generationEnd: () => {}, recordCompletion: () => {}, setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
  } as unknown as Deps
}

/** A JSON chat body padded to roughly `bytes`. */
const bodyOf = (bytes: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: 'model', max_tokens: 5, messages: [{ role: 'user', content: 'x'.repeat(bytes) }], ...extra })

const post = (app: Hono, path: string, body: RequestInit['body'], init: RequestInit = {}) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, ...init })

const OVER: Array<{ path: string; envelope: (b: any) => void }> = [
  { path: '/v1/chat/completions', envelope: (b) => { assert.equal(b.error.type, 'invalid_request_error'); assert.equal(b.error.code, 'request_too_large'); assert.match(b.error.message, /1 MB/) } },
  { path: '/v1/embeddings', envelope: (b) => { assert.equal(b.error.code, 'request_too_large') } },
  { path: '/v1/messages', envelope: (b) => { assert.equal(b.type, 'error'); assert.equal(b.error.type, 'request_too_large'); assert.match(b.error.message, /1 MB/) } },
  { path: '/v1/messages/count_tokens', envelope: (b) => { assert.equal(b.type, 'error'); assert.equal(b.error.type, 'request_too_large') } },
]

for (const o of OVER) {
  test(`${o.path}: a body over the cap is a 413 in the protocol's own envelope, and never reaches the engine`, async () => {
    const engine = await withEngine()
    try {
      const app = new Hono()
      registerGateway(app, deps(engine.url, 1))
      const res = await post(app, o.path, bodyOf(2 * MB))
      assert.equal(res.status, 413)
      o.envelope(await res.json())
      assert.equal(engine.hits(), 0)
    } finally { await engine.close() }
  })
}

test('a chunked body (no Content-Length) cannot bypass the cap', async () => {
  const engine = await withEngine()
  try {
    const app = new Hono()
    registerGateway(app, deps(engine.url, 1))
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) { if (sent++ < 16) ctl.enqueue(chunk); else ctl.close() }, // 4 MB, no length announced
    })
    const res = await post(app, '/v1/chat/completions', stream, { duplex: 'half' } as RequestInit)
    assert.equal(res.status, 413)
    assert.equal(engine.hits(), 0)
  } finally { await engine.close() }
})

test('a body under the cap is served as before', async () => {
  const engine = await withEngine()
  try {
    const app = new Hono()
    registerGateway(app, deps(engine.url, 1))
    const res = await post(app, '/v1/chat/completions', bodyOf(200 * 1024))
    assert.equal(res.status, 200)
    assert.equal(engine.hits(), 1)
  } finally { await engine.close() }
})

test('the cap is read without cloning the config: every request passes through it (scalability 1.6)', async () => {
  const engine = await withEngine()
  try {
    const app = new Hono()
    const d = deps(engine.url, 1)
    d.store.snapshot = () => { throw new Error('the body cap must read the config through read(), not snapshot()') }
    registerGateway(app, d)
    const res = await post(app, '/v1/chat/completions', bodyOf(2 * MB))
    assert.equal(res.status, 413)
  } finally { await engine.close() }
})

test('without a configured cap the default (128 MB) applies: a few MB pass', async () => {
  const engine = await withEngine()
  try {
    const app = new Hono()
    registerGateway(app, deps(engine.url, undefined))
    const res = await post(app, '/v1/chat/completions', bodyOf(3 * MB))
    assert.equal(res.status, 200)
  } finally { await engine.close() }
})
