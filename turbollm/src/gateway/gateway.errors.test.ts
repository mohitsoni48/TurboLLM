// Regression coverage for a real bug: the /v1/* OpenAI pass-through's engine fetch
// (gateway.ts) was unguarded — any throw (an unreachable engine, or fetch() rejecting
// immediately because the client's abort signal was already fired) escaped straight to
// Hono's default error handler: a bodyless 500 with no client-facing error envelope at
// all. Found live (2026-07-23) via a real /v1/chat/completions failure from an external
// tool while the Anthropic-protocol path and the engine itself both worked fine for the
// same model. Fixed by wrapping the fetch, mirroring the /v1/messages handler's guard.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'

const LIBRARY = [{ key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' }]

/** Minimal Deps double routing every request to `target` — a genuinely unreachable host
 *  by default, so the real fetch() call throws for real (no network mocking needed). */
function fakeDeps(target = 'http://engine.invalid.local:1'): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => target,
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
  } as unknown as Deps
}

test('POST /v1/chat/completions returns a structured error, not a bodyless 500, when the engine fetch throws', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string; code: string } }
  assert.ok(body.error, 'response must carry a structured error envelope, not an empty body')
  assert.equal(body.error!.type, 'api_error')
  assert.equal(body.error!.code, 'engine_unreachable')
  assert.ok(body.error!.message.length > 0, 'message must not be empty')
})

test('POST /v1/chat/completions with an already-aborted client signal reports client_disconnected, not a crash', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const ac = new AbortController()
  ac.abort() // simulate the client having already disconnected before the fetch fires

  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
    signal: ac.signal,
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string; code: string } }
  assert.ok(body.error, 'response must carry a structured error envelope, not an empty body')
  assert.equal(body.error!.code, 'client_disconnected')
})

test('GET /v1/models is unaffected by the fetch guard (no engine call on this path)', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const res = await app.request('/v1/models', { method: 'GET' })
  assert.equal(res.status, 200)
})

// ── /v1/messages (Anthropic protocol) — regression for a real bug: unlike the OpenAI
// pass-through above, this handler flattened EVERY engine failure to a hardcoded 500 +
// 'api_error', discarding the engine's real status and any structured error it returned. That
// made distinct failure classes (bad request, overload, crash) all read identically from a
// terminal-agent `claude` session, with no way to tell them apart. Fixed by forwarding the
// engine's real status/body when present, and by mirroring the OpenAI path's abort/unreachable
// distinction for the network-throw case.

/** A real, ephemeral HTTP server standing in for the engine target — the whole point of these
 *  tests is that the gateway now forwards the ENGINE's real status/body, so mocking fetch()
 *  would only test the mock, not the actual forwarding logic. */
async function withFakeEngine(
  respond: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(respond)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const messagesBody = JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], max_tokens: 100, stream: false })

test('POST /v1/messages forwards the engine\'s real status + structured error instead of a flattened 500', async () => {
  const engine = await withFakeEngine((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'the request exceeds the available context size', type: 'invalid_request_error' } }))
  })
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url))
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: messagesBody,
    })
    assert.equal(res.status, 400, "must forward the engine's real status, not a hardcoded 500")
    const body = (await res.json()) as { error?: { message: string; type: string } }
    assert.equal(body.error?.type, 'invalid_request_error')
    assert.equal(body.error?.message, 'the request exceeds the available context size')
  } finally {
    await engine.close()
  }
})

test('POST /v1/messages falls back to raw text + a status-mapped type when the engine error body is not JSON', async () => {
  const engine = await withFakeEngine((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('CUDA out of memory')
  })
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url))
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: messagesBody,
    })
    assert.equal(res.status, 503)
    const body = (await res.json()) as { error?: { message: string; type: string } }
    assert.equal(body.error?.type, 'overloaded_error')
    assert.equal(body.error?.message, 'CUDA out of memory')
  } finally {
    await engine.close()
  }
})

test('POST /v1/messages reports a structured error, not a bodyless 500, when the engine fetch throws', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps()) // default fakeDeps target is genuinely unreachable

  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: messagesBody,
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string } }
  assert.ok(body.error, 'response must carry a structured error envelope, not an empty body')
  assert.equal(body.error!.type, 'api_error')
  assert.ok(body.error!.message.length > 0, 'message must not be empty')
})

test('POST /v1/messages with an already-aborted client signal reports a clear disconnect message, not a crash', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const ac = new AbortController()
  ac.abort() // simulate the client having already disconnected before the fetch fires

  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: messagesBody,
    signal: ac.signal,
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string } }
  assert.equal(body.error?.message, 'Client disconnected before the engine responded.')
})
