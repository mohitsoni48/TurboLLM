// Regression coverage for a real bug: the /v1/* OpenAI pass-through's engine fetch
// (gateway.ts) was unguarded — any throw (an unreachable engine, or fetch() rejecting
// immediately because the client's abort signal was already fired) escaped straight to
// Hono's default error handler: a bodyless 500 with no client-facing error envelope at
// all. Found live (2026-07-23) via a real /v1/chat/completions failure from an external
// tool while the Anthropic-protocol path and the engine itself both worked fine for the
// same model. Fixed by wrapping the fetch, mirroring the /v1/messages handler's guard.
import assert from 'node:assert/strict'
import { test } from 'node:test'
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
