import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import { registerExtChatRoutes, type ExtRouteDeps } from './routes.chats.js'
import { IdempotencyStore } from './idempotency.js'
import { TenantLimiter } from './limits.js'
import { AuditLog } from './audit.js'

const ACME = 'Bearer tllm-ext-acme'
const GLOBEX = 'Bearer tllm-ext-globex'
// A key scoped to chats:read ONLY — for the scope-refusal-still-gets-audited coverage below.
// Distinct from ACME/GLOBEX so it never affects any other test in this file.
const ACME_READONLY = 'Bearer tllm-ext-acme-readonly'

// resolveTenantFromKey (ext/auth.ts) always hashes the presented key with the real SHA-256
// derivation (hashKey) before comparing — stored keys hold only a hash, never the raw value
// (see auth.test.ts's identical convention). So the fixture below must store real hashes of
// the raw bearer values, not the raw strings themselves.
function keyHash(bearer: string): string {
  return createHash('sha256').update(bearer.slice('Bearer '.length)).digest('hex')
}

function harness(ext?: ExtRouteDeps) {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-routes-'))
  const conv = new ConversationStore(dir)
  // Both tenants are served by the same SQLite store here; scoping is what keeps them apart.
  const d = {
    db: conv,
    chatStore: new ChatStoreRouter(conv.chatStore, conv.chatStore),
    store: { snapshot: () => ({ apiKeys: [
      { hash: keyHash(ACME), tenant: 'acme' },
      { hash: keyHash(GLOBEX), tenant: 'globex' },
      { hash: keyHash(ACME_READONLY), tenant: 'acme', scopes: ['chats:read'] },
    ] }) },
  } as never
  const app = new Hono()
  registerExtChatRoutes(app, d, ext)
  return { app, db: conv, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
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
    db: conv,
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

// Idempotency (spec 27 §7.6), fix round: POST /chats is one of the two commit points the spec
// names. A key is opt-in (a request with no header behaves exactly as before, covered by
// "create and fetch a chat" above) — these cover the header actually being present.
test('a duplicate Idempotency-Key on POST /chats returns the same chat rather than creating a second one', async () => {
  const { app, cleanup } = harness()
  try {
    const post = (title: string) => ({
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-chat-1' },
      body: JSON.stringify({ title, owner: 'u1' }),
    })
    const first = await app.request('/api/ext/v1/chats', post('Hello'))
    assert.equal(first.status, 201)
    const firstBody = await first.json() as { id: string; title: string }

    // A retry with the SAME key but a DIFFERENT body — proving the replay returns the frozen
    // original result rather than re-running createChat with the new content.
    const second = await app.request('/api/ext/v1/chats', post('A different title'))
    assert.equal(second.status, 201)
    const secondBody = await second.json() as { id: string; title: string }
    assert.equal(secondBody.id, firstBody.id, 'the replay must return the SAME chat, not a new one')
    assert.equal(secondBody.title, firstBody.title, 'the replay returns the ORIGINAL result, not a re-execution')

    const list = await app.request('/api/ext/v1/chats?owner=u1', { headers: { Authorization: ACME } })
    const page = await list.json() as { data: unknown[] }
    assert.equal(page.data.length, 1, 'only one chat was actually created')
  } finally {
    cleanup()
  }
})

test('a fresh Idempotency-Key on POST /chats still creates a genuinely new chat', async () => {
  const { app, cleanup } = harness()
  try {
    const post = (key: string) => ({
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ title: 'X', owner: 'u1' }),
    })
    const first = await (await app.request('/api/ext/v1/chats', post('ik-a'))).json() as { id: string }
    const second = await (await app.request('/api/ext/v1/chats', post('ik-b'))).json() as { id: string }
    assert.notEqual(first.id, second.id, 'a different key must not be treated as a replay')
  } finally {
    cleanup()
  }
})

// The audit-log fix round (task-2-report.md's "Fix report" section): three defects a live
// review surfaced in the first pass — a refused mutation producing zero audit rows (scope
// refusal here, the blanket rate-limit refusal below), and create actions recording the wrong
// (or no) target id. `GET /api/ext/v1/audit` is the black-box way to check these: it's the
// same read path an integrator would use, so these tests exercise the real wire shape rather
// than reaching into AuditLog internals.
async function auditRows(app: Hono, auth = ACME): Promise<Array<{ action: string; target_id: string | null; status: number; request_id: string }>> {
  const res = await app.request('/api/ext/v1/audit', { headers: { Authorization: auth } })
  assert.equal(res.status, 200)
  return (await res.json() as { data: Array<{ action: string; target_id: string | null; status: number; request_id: string }> }).data
}

test('a 403 scope-refusal on a mutating route still produces an audit row with the real refused status', async () => {
  const { app, cleanup } = harness()
  try {
    const res = await app.request('/api/ext/v1/chats', {
      method: 'POST',
      headers: { Authorization: ACME_READONLY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Should be refused', owner: 'u1' }),
    })
    assert.equal(res.status, 403, 'a chats:read-only key must not be able to create a chat')

    const rows = await auditRows(app)
    assert.equal(rows.length, 1, 'the refused attempt itself must be recorded')
    assert.equal(rows[0].action, 'chat.create')
    assert.equal(rows[0].status, 403, 'the row must carry the REAL refused status, not a 2xx')
  } finally {
    cleanup()
  }
})

test('chat.create and message.create audit rows carry the real created resource id', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Audited', owner: 'u1' }))
    const chat = await made.json() as { id: string }

    const msgRes = await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'user', content: 'hi', owner: 'u1', generate: false }))
    const msg = await msgRes.json() as { id: string }
    assert.notEqual(msg.id, chat.id, 'sanity: the message id must differ from its parent chat id')

    const rows = await auditRows(app)
    const createRow = rows.find((r) => r.action === 'chat.create')
    const messageRow = rows.find((r) => r.action === 'message.create')
    assert.ok(createRow, 'expected a chat.create row')
    assert.ok(messageRow, 'expected a message.create row')
    assert.equal(createRow!.target_id, chat.id, 'chat.create must name the chat it actually created, not null')
    assert.equal(messageRow!.target_id, msg.id, 'message.create must name the MESSAGE it created, not the parent chat')
  } finally {
    cleanup()
  }
})

test('an audited row carries a real request id, never "unknown"', async () => {
  const { app, cleanup } = harness()
  try {
    await app.request('/api/ext/v1/chats', json(ACME, { title: 'X', owner: 'u1' }))
    const rows = await auditRows(app)
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0].request_id, 'unknown')
    assert.ok(rows[0].request_id.length > 0)
  } finally {
    cleanup()
  }
})

test('an inbound X-Request-Id is honored and shows up on the audit row for that request', async () => {
  const { app, cleanup } = harness()
  try {
    await app.request('/api/ext/v1/chats', {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'X-Request-Id': 'req_from_client' },
      body: JSON.stringify({ title: 'X', owner: 'u1' }),
    })
    const rows = await auditRows(app)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].request_id, 'req_from_client', 'the CLIENT-supplied request id must be the one recorded')
  } finally {
    cleanup()
  }
})

test('a rate-limited mutation (the blanket per-tenant budget) still produces an audit row', async () => {
  const ext: ExtRouteDeps = { idempotency: new IdempotencyStore(), limiter: new TenantLimiter({ maxInFlight: 100, ratePerMinute: 1 }) }
  const { app, db, cleanup } = harness(ext)
  try {
    const post = (title: string) => json(ACME, { title, owner: 'u1' })
    const first = await app.request('/api/ext/v1/chats', post('One'))
    assert.equal(first.status, 201, 'consumes the one-per-minute budget')

    const second = await app.request('/api/ext/v1/chats', post('Two'))
    assert.equal(second.status, 429, 'the budget is exhausted, before any route-specific middleware runs')

    // Read directly from the store rather than via GET /audit — that read endpoint is ITSELF
    // subject to the very same blanket per-tenant budget this test is deliberately exhausting
    // (a ratePerMinute:1 tenant has nothing left for a third call, audit read included).
    const rows = new AuditLog(db).list('acme', {})
    // One row for the successful create, one for the refused second attempt.
    assert.equal(rows.length, 2)
    const refusal = rows.find((r) => r.status === 429)
    assert.ok(refusal, 'the blanket rate-limit refusal must still be recorded')
    assert.equal(refusal!.action, 'request.rate_limited')
  } finally {
    cleanup()
  }
})

test('a tenant that exceeds its configured request rate gets 429, while a different tenant is unaffected', async () => {
  const ext: ExtRouteDeps = { idempotency: new IdempotencyStore(), limiter: new TenantLimiter({ maxInFlight: 100, ratePerMinute: 2 }) }
  const { app, cleanup } = harness(ext)
  try {
    const post = (auth: string, title: string) => ({
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, owner: 'u1' }),
    })
    const first = await app.request('/api/ext/v1/chats', post(ACME, 'One'))
    const second = await app.request('/api/ext/v1/chats', post(ACME, 'Two'))
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)

    const third = await app.request('/api/ext/v1/chats', post(ACME, 'Three'))
    assert.equal(third.status, 429, 'a third request within the same minute exceeds the configured budget')
    assert.equal((await third.json() as { error: { code: string } }).error.code, 'rate_limited')

    const otherTenant = await app.request('/api/ext/v1/chats', post(GLOBEX, 'Unaffected'))
    assert.equal(otherTenant.status, 201, 'a different tenant is unaffected by acme exhausting its own budget')
  } finally {
    cleanup()
  }
})
