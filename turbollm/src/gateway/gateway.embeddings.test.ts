// Regression coverage for the embeddings-routing bug: `POST /v1/embeddings` must route on
// the `model` field in its own request body, the same way `/v1/chat/completions` does — not
// fall back to whatever the primary chat engine has loaded. Before this fix, `requestedModel`
// was hardcoded to '' for every non-chat-completions endpoint, so an embeddings call for a
// model loaded in its own pool slot silently reached the chat engine instead (which was never
// started with `--embeddings`) and 501'd.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'

const EMBEDDING_KEY = 'qwen3-embedding-0.6b|Q8_0|639150592'

/** Minimal Deps double: only the members the tested gateway path touches. Mirrors the
 *  fakeDeps helper in gateway.models.test.ts. */
function fakeDeps(routed: { model: string | null }): Deps {
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: {
      targetEntry: () => undefined,
      route: async (m: string) => {
        routed.model = m
        return { target: 'http://engine.local' }
      },
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => 'http://engine.local',
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
  } as unknown as Deps
}

test('POST /v1/embeddings routes on the model field in its own body', async () => {
  const routed = { model: null as string | null }
  const app = new Hono()
  registerGateway(app, fakeDeps(routed))

  // The engine fetch will fail (no real server) — we only assert on what the router saw,
  // the same pattern gateway.models.test.ts uses for /v1/messages.
  await app.request('/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_KEY, input: 'hello world' }),
  })

  assert.equal(routed.model, EMBEDDING_KEY, 'router must see the embeddings request\'s own model, not an empty string')
})

// Live regression (found only once actually forwarded to a real engine, not this suite's stub
// target): forwarding the request's ORIGINAL content-length header alongside the re-read body
// text made undici reject the outbound fetch with "invalid content-length header" — the same
// reason the isChat branch already deletes it before setting its own re-serialised body.
test('POST /v1/embeddings drops the original content-length header and forwards the exact body text', async () => {
  const routed = { model: null as string | null }
  const app = new Hono()
  registerGateway(app, fakeDeps(routed))

  const requestBody = JSON.stringify({ model: EMBEDDING_KEY, input: 'hello world' })
  const seen: { headers: Headers; body: unknown } = { headers: new Headers(), body: undefined }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    seen.headers = new Headers(init.headers)
    seen.body = init.body
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  try {
    await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(requestBody.length) },
      body: requestBody,
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(seen.headers.has('content-length'), false, 'the stale content-length must be dropped, not forwarded')
  assert.equal(seen.body, requestBody, 'the original body text is forwarded byte-for-byte, not re-serialised')
})

// Regression (Opus release review, v1.13.4): making /v1/embeddings read its own `model`
// field also made a QUALIFIED `<machine>/<model>` Turbo Link id resolve for it — before
// this fix, every non-chat endpoint routed with an empty id and could never reach the
// remote branch at all, which a load-bearing comment above this test's target function
// (gateway.ts, the "Links do not chain" section) explicitly relied on ("only a chat request
// ever resolves a remote target"). Turbo Link is chat-only by design (ADR-376) — an
// embeddings request naming a linked machine must be refused, never silently proxied to it.
test('POST /v1/embeddings never proxies to a linked machine — Turbo Link is chat-only', async () => {
  const REMOTE = { linkId: 'lnk1', baseUrl: 'https://rig.trycloudflare.com', token: 'tllm-hostsecret', modelKey: 'bge-m3' }
  const app = new Hono()
  const d = {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target: REMOTE.baseUrl, remote: REMOTE }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: { status: () => ({ state: 'stopped', model: null }), target: () => null },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
  } as unknown as Deps
  registerGateway(app, d)

  const realFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = (async () => { fetchCalled = true; return new Response('{}', { status: 200 }) }) as typeof fetch

  let res: Response
  try {
    res = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'Rig/bge-m3', input: 'hello world' }),
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(fetchCalled, false, 'the request must never leave for the linked machine')
  assert.equal(res!.status, 400)
  const body = await res!.json() as { error: { code: string } }
  assert.equal(body.error.code, 'link_embeddings_unsupported')
})
