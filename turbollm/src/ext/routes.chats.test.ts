import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import { registerExtChatRoutes } from './routes.chats.js'

const ACME = 'Bearer tllm-ext-acme'
const GLOBEX = 'Bearer tllm-ext-globex'

// resolveTenantFromKey (ext/auth.ts) always hashes the presented key with the real SHA-256
// derivation (hashKey) before comparing — stored keys hold only a hash, never the raw value
// (see auth.test.ts's identical convention). So the fixture below must store real hashes of
// the raw bearer values, not the raw strings themselves.
function keyHash(bearer: string): string {
  return createHash('sha256').update(bearer.slice('Bearer '.length)).digest('hex')
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-routes-'))
  const conv = new ConversationStore(dir)
  // Both tenants are served by the same SQLite store here; scoping is what keeps them apart.
  const d = {
    chatStore: new ChatStoreRouter(conv.chatStore, conv.chatStore),
    store: { snapshot: () => ({ apiKeys: [
      { hash: keyHash(ACME), tenant: 'acme' },
      { hash: keyHash(GLOBEX), tenant: 'globex' },
    ] }) },
  } as never
  const app = new Hono()
  registerExtChatRoutes(app, d)
  return { app, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

// ChatStoreRouter.pick() throws StoreError('not_supported', ...) SYNCHRONOUSLY-then-rejected
// for ANY method call on a non-local tenant when no adapter is configured (router.test.ts:
// "with no adapter configured, a non-local tenant is refused rather than silently served
// locally") — a real production configuration, not a hypothetical. A handler that calls the
// store without a try/catch lets that rejection escape as an uncaught exception, which Hono
// turns into a bare, non-JSON 500 — exactly the regression this harness exercises.
function harnessNoAdapter() {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-routes-noadapter-'))
  const conv = new ConversationStore(dir)
  const d = {
    chatStore: new ChatStoreRouter(conv.chatStore, null),
    store: { snapshot: () => ({ apiKeys: [
      { hash: keyHash(ACME), tenant: 'acme' },
    ] }) },
  } as never
  const app = new Hono()
  registerExtChatRoutes(app, d)
  return { app, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const json = (auth: string, body?: unknown) => ({
  method: body ? 'POST' : 'GET',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

test('create and fetch a chat', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Hello', owner: 'u1' }))
    assert.equal(made.status, 201)
    const chat = await made.json() as { id: string; title: string; owner: string }
    assert.equal(chat.title, 'Hello')
    assert.equal(chat.owner, 'u1')

    const got = await app.request(`/api/ext/v1/chats/${chat.id}?owner=u1`, json(ACME))
    assert.equal(got.status, 200)
  } finally {
    cleanup()
  }
})

test('the response never echoes tenant', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'X', owner: 'u1' }))
    const body = await made.json() as Record<string, unknown>
    assert.ok(!('tenant' in body), 'tenant must not appear on the wire')
  } finally {
    cleanup()
  }
})

test('another tenant gets 404, not 403 — existence must not leak', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Secret', owner: 'u1' }))
    const chat = await made.json() as { id: string }

    const stolen = await app.request(`/api/ext/v1/chats/${chat.id}?owner=u1`, json(GLOBEX))
    assert.equal(stolen.status, 404)
    const body = await stolen.json() as { error: { type: string } }
    assert.equal(body.error.type, 'not_found')
  } finally {
    cleanup()
  }
})

test('an unauthenticated request is rejected', async () => {
  const { app, cleanup } = harness()
  try {
    const res = await app.request('/api/ext/v1/chats')
    assert.equal(res.status, 401)
  } finally {
    cleanup()
  }
})

test('appending with generate:false stores the message without a run', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Backfill', owner: 'u1' }))
    const chat = await made.json() as { id: string }

    const res = await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'user', content: 'imported', owner: 'u1', generate: false }))
    assert.equal(res.status, 201)
    const msg = await res.json() as { content: string; seq: number }
    assert.equal(msg.content, 'imported')
    assert.equal(msg.seq, 1)

    const list = await app.request(`/api/ext/v1/chats/${chat.id}/messages?owner=u1`, json(ACME))
    const page = await list.json() as { data: unknown[]; has_more: boolean }
    assert.equal(page.data.length, 1)
    assert.equal(page.has_more, false)
  } finally {
    cleanup()
  }
})

test('heavy fields are omitted unless requested via include', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Include', owner: 'u1' }))
    const chat = await made.json() as { id: string }
    await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'assistant', content: 'x', reasoning: 'deep thought', owner: 'u1', generate: false }))

    const lean = await (await app.request(`/api/ext/v1/chats/${chat.id}/messages?owner=u1`, json(ACME))).json() as { data: Array<Record<string, unknown>> }
    assert.ok(!('reasoning' in lean.data[0]), 'reasoning must be omitted by default')

    const rich = await (await app.request(`/api/ext/v1/chats/${chat.id}/messages?owner=u1&include=reasoning`, json(ACME))).json() as { data: Array<Record<string, unknown>> }
    assert.equal(rich.data[0].reasoning, 'deep thought')
  } finally {
    cleanup()
  }
})

test('an empty message with no attachment is a 400 invalid_input', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Empty', owner: 'u1' }))
    const chat = await made.json() as { id: string }
    const res = await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'user', content: '   ', owner: 'u1', generate: false }))
    assert.equal(res.status, 400)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'invalid_input')
  } finally {
    cleanup()
  }
})

// Regression test for a live-reproduced bug: with no adapter configured, ChatStoreRouter
// throws StoreError('not_supported', ...) for a non-local tenant on EVERY method — including
// the four routes (GET/DELETE chats, GET/DELETE messages) that, before this fix, called the
// store directly with no try/catch. That let the rejection escape Hono's handler and fall
// through to the framework's bare, non-JSON 500 — a shape no integrator's error-envelope
// parser can read. Each of the four must instead surface the same JSON error envelope every
// other route in this file already produces.
for (const [label, req] of [
  ['GET /chats/:id', () => ({ method: 'GET', path: '/api/ext/v1/chats/some-id?owner=u1' })],
  ['DELETE /chats/:id', () => ({ method: 'DELETE', path: '/api/ext/v1/chats/some-id?owner=u1' })],
  ['GET /messages/:id', () => ({ method: 'GET', path: '/api/ext/v1/messages/some-id?owner=u1' })],
  ['DELETE /messages/:id', () => ({ method: 'DELETE', path: '/api/ext/v1/messages/some-id?owner=u1' })],
] as const) {
  test(`${label} on a tenant with no adapter surfaces a JSON error envelope, not a bare 500`, async () => {
    const { app, cleanup } = harnessNoAdapter()
    try {
      const { method, path } = req()
      const res = await app.request(path, { method, headers: { Authorization: ACME } })
      // The response body MUST be parseable JSON with the standard envelope shape — this is
      // exactly what an integrator's client does, and exactly what crashed before the fix.
      const text = await res.text()
      let parsed: { error?: { type?: unknown; code?: unknown; request_id?: unknown; retryable?: unknown } }
      try {
        parsed = JSON.parse(text)
      } catch {
        assert.fail(`response body is not JSON (bare framework error?): ${text.slice(0, 200)}`)
      }
      assert.ok(res.status >= 400, 'a store failure must not report success')
      assert.equal(typeof parsed.error?.type, 'string')
      assert.equal(typeof parsed.error?.code, 'string')
      assert.equal(typeof parsed.error?.request_id, 'string')
      assert.equal(typeof parsed.error?.retryable, 'boolean')
    } finally {
      cleanup()
    }
  })
}
