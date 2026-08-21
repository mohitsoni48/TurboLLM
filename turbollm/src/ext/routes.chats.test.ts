import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import type { ChatStore } from '../chat/store/chat-store.js'
import { registerExtChatRoutes, type ExtRouteDeps } from './routes.chats.js'
import { registerExtRunRoutes } from './routes.runs.js'
import { PublicRunManager } from './run-manager.js'
import { IdempotencyStore } from './idempotency.js'
import { TenantLimiter, MAX_BODY_BYTES, MAX_ATTACHMENTS } from './limits.js'
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

// A second harness, mirroring what mount.ts actually wires in production: both
// registerExtChatRoutes AND registerExtRunRoutes on the SAME app, sharing the SAME
// PublicRunManager instance — required for I3 (the chat routes need a live run registry to
// check `run_active` against) and I6 (the generate-forward request-id fix can only be observed
// end-to-end through both route sets together). `bodyFactory` lets a test hold a run open
// (gate it on an unresolved promise) to exercise the in-flight-guard tests. Mirrors
// routes.runs.test.ts's own `harness()`.
function harnessWithRuns(bodyFactory?: () => Promise<{ status: 'complete' | 'aborted' }>, ext?: ExtRouteDeps) {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-routes-runs-'))
  const conv = new ConversationStore(dir)
  const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
  const d = {
    db: conv,
    chatStore,
    store: { snapshot: () => ({ apiKeys: [
      { hash: keyHash(ACME), tenant: 'acme' },
      { hash: keyHash(GLOBEX), tenant: 'globex' },
    ] }) },
    manager: {
      status: () => ({ state: 'running', model: 'test-model' }),
      target: () => 'http://127.0.0.1:9999',
    },
  } as never
  const runs = new PublicRunManager()
  const app = new Hono()
  registerExtChatRoutes(app, d, ext, runs)
  registerExtRunRoutes(app, d, runs, {
    makeBody: () => async ({ emit }) => {
      await emit({ event: 'delta', data: { content: 'hello' } })
      return bodyFactory ? await bodyFactory() : { status: 'complete' as const }
    },
  }, ext)
  return { app, runs, db: conv, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

// N4 (final-gate fix round) regression fixture: wraps a real ChatStore so `getChat` awaits
// `gate` before proceeding, so a test can park a generate request precisely in the window
// between routes.runs.ts's synchronous chat reservation (`runs.reserveChat`, held before ANY
// `await`) and `runs.start()` actually creating a `PublicRun` record. Before the fix,
// `hasActiveRun()` only consulted `runs.list()` and so could not see the chat as active until
// several real `await`s later — a mutation racing this exact window was wrongly admitted
// (live-reproduced: a DELETE succeeded with 204 here). Mirrors routes.runs.test.ts's
// `chatStoreThatThrows` Proxy pattern, but delays instead of throwing.
function chatStoreThatDelaysGetChat(base: ChatStore, gate: Promise<void>): ChatStore {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'getChat') {
        return async (...args: unknown[]) => {
          await gate
          return (target.getChat as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as ChatStore
}

function harnessWithRunsDelayedGetChat(gate: Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-routes-delay-'))
  const conv = new ConversationStore(dir)
  const chatStore = chatStoreThatDelaysGetChat(new ChatStoreRouter(conv.chatStore, conv.chatStore), gate)
  const d = {
    db: conv,
    chatStore,
    store: { snapshot: () => ({ apiKeys: [{ hash: keyHash(ACME), tenant: 'acme' }] }) },
    manager: {
      status: () => ({ state: 'running', model: 'test-model' }),
      target: () => 'http://127.0.0.1:9999',
    },
  } as never
  const runs = new PublicRunManager()
  const app = new Hono()
  registerExtChatRoutes(app, d, undefined, runs)
  registerExtRunRoutes(app, d, runs, {
    makeBody: () => async ({ emit }) => {
      await emit({ event: 'delta', data: { content: 'hello' } })
      return { status: 'complete' as const }
    },
  })
  return { app, runs, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function newChat(app: Hono, title = 'X'): Promise<string> {
  const res = await app.request('/api/ext/v1/chats', json(ACME, { title, owner: 'u1' }))
  return (await res.json() as { id: string }).id
}

/** Starts a generate run whose body never settles until released, so a test can exercise the
 *  "a mutation while a generation is in flight" guard (I3) with a real, live run — not a
 *  stubbed check. Exposes `settle()` (release the gate, await the run actually ending — leaves
 *  the app/db usable afterward, for a test that wants to check post-settlement behavior too)
 *  and `finish()` (settle, then tear the whole harness down) — always call exactly one of them,
 *  success or failure, mirroring routes.runs.test.ts's own gate/release pattern ("a second run
 *  on the same chat is refused...", "cancel aborts an in-flight run"). */
async function startInFlightGeneration() {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const { app, runs, cleanup } = harnessWithRuns(async () => { await gate; return { status: 'complete' as const } })
  const chatId = await newChat(app, 'InFlight')
  const genRes = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
    json(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
  assert.equal(genRes.status, 202, 'setup: the generate call itself must succeed')
  const run = await genRes.json() as { id: string; message_id: string }
  const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, json(ACME))).json() as {
    data: Array<{ id: string; role: string }>
  }
  const userMessageId = list.data.find((m) => m.role === 'user')!.id
  const settle = async () => { release(); await runs.settled(run.id) }
  return {
    app, runs, chatId, runId: run.id, userMessageId, assistantMessageId: run.message_id,
    settle, cleanup,
    finish: async () => { await settle(); cleanup() },
  }
}

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

// ── N1 (final-gate fix round) — IdempotencyStore was not scoped by owner ───────────────────
// Live-reproduced in the review this fixes: Owner A creates a chat with a shared
// Idempotency-Key and private metadata; Owner B (SAME tenant, SAME key, different body) replays
// that key and got back Owner A's exact chat object, private metadata included. `owner` is now
// part of the cache key (idempotency.ts), so a different owner reusing the value must get a
// genuinely fresh result, never the other owner's cached data.
test('a same-tenant, different-owner replay of an Idempotency-Key on POST /chats gets a fresh chat, never the other owner\'s', async () => {
  const { app, cleanup } = harness()
  try {
    const sharedKey = 'ik-cross-owner'
    const ownerARes = await app.request('/api/ext/v1/chats', {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
      body: JSON.stringify({ title: 'Owner A private chat', owner: 'owner-a', metadata: { secret: 'owner-A-only-data' } }),
    })
    assert.equal(ownerARes.status, 201)
    const ownerAChat = await ownerARes.json() as { id: string; title: string; metadata?: Record<string, unknown> }
    assert.equal(ownerAChat.metadata?.secret, 'owner-A-only-data', 'sanity: owner A\'s private metadata was actually stored')

    // Owner B: SAME tenant, SAME Idempotency-Key VALUE, different owner and different body.
    const ownerBRes = await app.request('/api/ext/v1/chats', {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
      body: JSON.stringify({ title: 'Owner B chat', owner: 'owner-b' }),
    })
    assert.equal(ownerBRes.status, 201)
    const ownerBChat = await ownerBRes.json() as { id: string; title: string; owner: string; metadata?: Record<string, unknown> }

    assert.notEqual(ownerBChat.id, ownerAChat.id, 'owner B must get a genuinely fresh chat, not owner A\'s replayed result')
    assert.equal(ownerBChat.title, 'Owner B chat', 'owner B\'s own request must actually execute, not return owner A\'s cached data')
    assert.equal(ownerBChat.owner, 'owner-b')
    assert.notEqual(ownerBChat.metadata?.secret, 'owner-A-only-data', 'owner B must never see owner A\'s private metadata')
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

// ── C4 — attachments on POST /chats/:id/messages ───────────────────────────────────────────
// Final-gate finding C4 (this route's portion — the generate-path portion was already fixed on
// routes.runs.ts by a sibling task). Before this fix: `attachments`/`metadata` were never read
// off the body at all, and validation rejected empty `content` unconditionally, so an
// attachments-only message could never be created through this route in either the
// `generate:false` or the default (forwarding) path.
test('an attachments-only message (no content) is accepted with generate:false, and the attachment round-trips', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await (async () => {
      const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Attach', owner: 'u1' }))
      return (await made.json() as { id: string }).id
    })()
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', owner: 'u1', generate: false, attachments: ['data:image/png;base64,AAA='] }))
    assert.equal(res.status, 201, 'attachments alone must satisfy "type a message or attach a file"')
    const msg = await res.json() as { id: string }

    const got = await app.request(`/api/ext/v1/messages/${msg.id}?owner=u1&include=attachments`, json(ACME))
    const full = await got.json() as { attachments: string[]; content: string }
    assert.deepEqual(full.attachments, ['data:image/png;base64,AAA='])
    assert.equal(full.content, '')
  } finally {
    cleanup()
  }
})

test('metadata is also forwarded into addMessage on the generate:false path', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Meta', owner: 'u1' }))
    const chat = await made.json() as { id: string }
    const res = await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'user', content: 'hi', owner: 'u1', generate: false, metadata: { source: 'import' } }))
    assert.equal(res.status, 201)
    const msg = await res.json() as { id: string }

    const got = await app.request(`/api/ext/v1/messages/${msg.id}?owner=u1&include=metadata`, json(ACME))
    const full = await got.json() as { metadata: Record<string, unknown> }
    assert.deepEqual(full.metadata, { source: 'import' })
  } finally {
    cleanup()
  }
})

// The default path (`generate` omitted) forwards internally to .../messages/generate via
// app.fetch — this covers that attachments survive THAT forward too, not just the
// generate:false direct-write path above.
test('an attachments-only message survives the internal forward to the generate route', async () => {
  const { app, runs, cleanup } = harnessWithRuns()
  try {
    const chatId = await newChat(app, 'ForwardAttach')
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', owner: 'u1', attachments: ['data:image/png;base64,BBB='] }))
    assert.equal(res.status, 202, 'attachments alone must also satisfy the generating path')
    const run = await res.json() as { id: string }
    await runs.settled(run.id)

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1&include=attachments`, json(ACME))).json() as {
      data: Array<{ role: string; attachments: string[] }>
    }
    const user = list.data.find((m) => m.role === 'user')!
    const assistant = list.data.find((m) => m.role === 'assistant')!
    assert.deepEqual(user.attachments, ['data:image/png;base64,BBB='], 'the USER turn keeps the attachment')
    assert.deepEqual(assistant.attachments, [], 'the assistant placeholder never receives attachments')
  } finally {
    cleanup()
  }
})

// ── C5 — body/attachment limits on POST /chats/:id/messages ────────────────────────────────
test('a message body over the byte limit is refused with 413 payload_too_large, and nothing is persisted', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await (async () => {
      const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'TooBig', owner: 'u1' }))
      return (await made.json() as { id: string }).id
    })()
    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', content: oversized, owner: 'u1', generate: false }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, json(ACME))).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'the oversized write must not have been persisted')
  } finally {
    cleanup()
  }
})

test('a message with more attachments than the limit is refused with 413 payload_too_large', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await (async () => {
      const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'TooMany', owner: 'u1' }))
      return (await made.json() as { id: string }).id
    })()
    const tooMany = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `data:x/${i}`)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', owner: 'u1', generate: false, attachments: tooMany }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')
  } finally {
    cleanup()
  }
})

// ── N5 (final-gate fix round) — 413 enforcement checked attachment COUNT, never byte SIZE ──
test('attachments whose total byte size exceeds the limit are refused with 413, even with only a few of them', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await (async () => {
      const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'BigAttach', owner: 'u1' }))
      return (await made.json() as { id: string }).id
    })()
    // Two attachments, well under MAX_ATTACHMENTS, but their combined byte size exceeds
    // MAX_BODY_BYTES — the count check alone would have admitted this.
    const huge = 'x'.repeat(Math.ceil(MAX_BODY_BYTES / 2) + 1)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', owner: 'u1', generate: false, attachments: [huge, huge] }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, json(ACME))).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'the oversized write must not have been persisted')
  } finally {
    cleanup()
  }
})

test('a metadata blob over the byte limit is refused with 413, even with tiny content', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await (async () => {
      const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'BigMeta', owner: 'u1' }))
      return (await made.json() as { id: string }).id
    })()
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', content: 'hi', owner: 'u1', generate: false, metadata: { blob: 'x'.repeat(MAX_BODY_BYTES + 1) } }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, json(ACME))).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'the oversized write must not have been persisted')
  } finally {
    cleanup()
  }
})

// ── N6 (final-gate fix round) — PATCH /messages/:id had no body-size enforcement at all ────
test('PATCH /messages/:id refuses an over-limit content edit with 413, and does not persist it', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'EditLimit', owner: 'u1' }))
    const chat = await made.json() as { id: string }
    const created = await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'user', content: 'small', owner: 'u1', generate: false }))
    const msg = await created.json() as { id: string; content: string }

    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1)
    const res = await app.request(`/api/ext/v1/messages/${msg.id}`, {
      method: 'PATCH',
      headers: { Authorization: ACME, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: oversized, owner: 'u1' }),
    })
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')

    const got = await (await app.request(`/api/ext/v1/messages/${msg.id}?owner=u1`, json(ACME))).json() as { content: string }
    assert.equal(got.content, 'small', 'the edit must not have been persisted — the original content stands')
  } finally {
    cleanup()
  }
})

test('PATCH /messages/:id refuses an over-limit metadata edit with 413', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'EditMetaLimit', owner: 'u1' }))
    const chat = await made.json() as { id: string }
    const created = await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'user', content: 'small', owner: 'u1', generate: false }))
    const msg = await created.json() as { id: string }

    const res = await app.request(`/api/ext/v1/messages/${msg.id}`, {
      method: 'PATCH',
      headers: { Authorization: ACME, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { blob: 'x'.repeat(MAX_BODY_BYTES + 1) }, owner: 'u1' }),
    })
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')
  } finally {
    cleanup()
  }
})

test('PATCH /messages/:id still succeeds normally for an in-limit edit', async () => {
  const { app, cleanup } = harness()
  try {
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'EditOk', owner: 'u1' }))
    const chat = await made.json() as { id: string }
    const created = await app.request(`/api/ext/v1/chats/${chat.id}/messages`,
      json(ACME, { role: 'user', content: 'small', owner: 'u1', generate: false }))
    const msg = await created.json() as { id: string }

    const res = await app.request(`/api/ext/v1/messages/${msg.id}`, {
      method: 'PATCH',
      headers: { Authorization: ACME, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'edited', owner: 'u1' }),
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json() as { content: string }).content, 'edited')
  } finally {
    cleanup()
  }
})

test('GET /capabilities reports the exact limits enforced on message creation — they cannot drift', async () => {
  const { app, cleanup } = harness()
  try {
    const res = await app.request('/api/ext/v1/capabilities', { headers: { Authorization: ACME } })
    const caps = await res.json() as { limits: { max_body_bytes: number; max_attachments: number } }
    assert.equal(caps.limits.max_body_bytes, MAX_BODY_BYTES)
    assert.equal(caps.limits.max_attachments, MAX_ATTACHMENTS)
  } finally {
    cleanup()
  }
})

// ── I3 — run_active 409 guard on chat/message mutation ──────────────────────────────────────
test('PATCH /chats/:id is refused with 409 run_active while a generation is in flight', async () => {
  const ctx = await startInFlightGeneration()
  try {
    const res = await ctx.app.request(`/api/ext/v1/chats/${ctx.chatId}`, {
      method: 'PATCH',
      headers: { Authorization: ACME, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Changed mid-run', owner: 'u1' }),
    })
    assert.equal(res.status, 409)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'run_active')
  } finally {
    await ctx.finish()
  }
})

test('DELETE /chats/:id is refused with 409 run_active while a generation is in flight', async () => {
  const ctx = await startInFlightGeneration()
  try {
    const res = await ctx.app.request(`/api/ext/v1/chats/${ctx.chatId}?owner=u1`, {
      method: 'DELETE',
      headers: { Authorization: ACME },
    })
    assert.equal(res.status, 409)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'run_active')
  } finally {
    await ctx.finish()
  }
})

test('PATCH /messages/:id is refused with 409 run_active while a generation is in flight for its chat', async () => {
  const ctx = await startInFlightGeneration()
  try {
    const res = await ctx.app.request(`/api/ext/v1/messages/${ctx.assistantMessageId}`, {
      method: 'PATCH',
      headers: { Authorization: ACME, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'edited mid-run', owner: 'u1' }),
    })
    assert.equal(res.status, 409)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'run_active')
  } finally {
    await ctx.finish()
  }
})

test('DELETE /messages/:id is refused with 409 run_active while a generation is in flight for its chat', async () => {
  const ctx = await startInFlightGeneration()
  try {
    const res = await ctx.app.request(`/api/ext/v1/messages/${ctx.userMessageId}?owner=u1`, {
      method: 'DELETE',
      headers: { Authorization: ACME },
    })
    assert.equal(res.status, 409)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'run_active')
  } finally {
    await ctx.finish()
  }
})

test('once the run ends, the same mutation that was refused with run_active succeeds', async () => {
  const ctx = await startInFlightGeneration()
  try {
    const duringRun = await ctx.app.request(`/api/ext/v1/chats/${ctx.chatId}`, {
      method: 'PATCH',
      headers: { Authorization: ACME, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Changed mid-run', owner: 'u1' }),
    })
    assert.equal(duringRun.status, 409, 'sanity: still in flight at this point')

    // Runs SETTLED (endedAt set) are no longer "active" — hasActiveRun filters on !endedAt —
    // so the identical mutation must now succeed rather than being permanently blocked.
    await ctx.settle()
    const after = await ctx.app.request(`/api/ext/v1/chats/${ctx.chatId}`, {
      method: 'PATCH',
      headers: { Authorization: ACME, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Changed after run', owner: 'u1' }),
    })
    assert.equal(after.status, 200, 'a settled run must not permanently block mutation of its chat')
  } finally {
    ctx.cleanup()
  }
})

// ── N4 (final-gate fix round) — hasActiveRun() and the generate route's own reservation used
// to be two independent, disagreeing mechanisms ───────────────────────────────────────────────
// Before the fix, routes.runs.ts reserved its private `inflight` map slot synchronously (I5),
// but `hasActiveRun()` only consulted `PublicRunManager.list()`, which gained an entry several
// real `await`s later (once `runs.start()` actually ran, past `getChat`/`loadFullHistory`/two
// `addMessage` calls). Live-reproduced: with `getChat` delayed, a DELETE fired in that window
// succeeded with 204 instead of being blocked by `run_active`. Both routes now consult the same
// `PublicRunManager.isChatActive`/`reserveChat`, so this window cannot exist any more.
test('DELETE /chats/:id is refused with 409 run_active in the window before runs.start() completes (N4 regression)', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const { app, runs, cleanup } = harnessWithRunsDelayedGetChat(gate)
  try {
    // Chat creation does not go through the delayed `getChat`, so this resolves immediately.
    const made = await app.request('/api/ext/v1/chats', json(ACME, { title: 'Race', owner: 'u1' }))
    const chat = await made.json() as { id: string }

    // Fire the generate request — it reserves the chat SYNCHRONOUSLY, then blocks inside the
    // delayed `getChat`, well before `runs.start()` creates any `PublicRun` record.
    const genPromise = app.request(`/api/ext/v1/chats/${chat.id}/messages/generate`,
      json(ACME, { role: 'user', content: 'hi', owner: 'u1' }))

    // Give the generate request's synchronous prefix (through the reservation) a chance to run
    // before we fire the racing mutation — the gate is not released yet, so however long this
    // waits, the generate request cannot have progressed past it.
    await new Promise((r) => setTimeout(r, 20))

    const del = await app.request(`/api/ext/v1/chats/${chat.id}?owner=u1`, { method: 'DELETE', headers: { Authorization: ACME } })
    assert.equal(del.status, 409, 'the chat must be seen as active from the moment the generate route reserves it, not only once a PublicRun record exists')
    assert.equal((await del.json() as { error: { code: string } }).error.code, 'run_active')

    release()
    const genRes = await genPromise
    assert.equal(genRes.status, 202, 'sanity: the generate request itself must still have succeeded once unblocked')
    const run = await genRes.json() as { id: string }
    await runs.settled(run.id)
  } finally {
    cleanup()
  }
})

// ── I6 — generate-forward request-id correlation ────────────────────────────────────────────
test('the generate-forward preserves the request id: message.create and run.start audit rows correlate even when the client sends none', async () => {
  const { app, runs, cleanup } = harnessWithRuns()
  try {
    const chatId = await newChat(app, 'Correlate')
    // Deliberately no X-Request-Id header — this is the exact case that was broken: without a
    // client-supplied id, the outer request minted one and the re-entered forwarded request
    // independently minted a SECOND, uncorrelated one.
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
    assert.equal(res.status, 202)
    const run = await res.json() as { id: string }
    await runs.settled(run.id)

    const rows = await auditRows(app)
    const createRow = rows.find((r) => r.action === 'message.create')
    const startRow = rows.find((r) => r.action === 'run.start')
    assert.ok(createRow, 'expected a message.create row')
    assert.ok(startRow, 'expected a run.start row')
    assert.ok(createRow!.request_id.length > 0 && createRow!.request_id !== 'unknown')
    assert.equal(createRow!.request_id, startRow!.request_id,
      'both audit rows for one logical call must share the same request id')
  } finally {
    cleanup()
  }
})

test('the generate-forward still honors a CLIENT-supplied X-Request-Id end to end', async () => {
  const { app, runs, cleanup } = harnessWithRuns()
  try {
    const chatId = await newChat(app, 'CorrelateClient')
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'X-Request-Id': 'req_client_supplied' },
      body: JSON.stringify({ role: 'user', content: 'hi', owner: 'u1' }),
    })
    assert.equal(res.status, 202)
    const run = await res.json() as { id: string }
    await runs.settled(run.id)

    const rows = await auditRows(app)
    const createRow = rows.find((r) => r.action === 'message.create')
    const startRow = rows.find((r) => r.action === 'run.start')
    assert.equal(createRow!.request_id, 'req_client_supplied')
    assert.equal(startRow!.request_id, 'req_client_supplied', 'the forward must carry the CLIENT id through, not mint its own')
  } finally {
    cleanup()
  }
})

// ── N7 (final-gate fix round) — generate-forward double-charged the rate limit and
// mis-attributed the message.create audit row ──────────────────────────────────────────────
// `POST /chats/:id/messages` (the documented primary use case) forwards internally via
// `app.fetch(new Request(...))`, which re-enters the full middleware stack — including the
// blanket per-tenant rate limiter — a SECOND time for one client-visible call. Separately, the
// outer route's own `message.create` audit row never got `auditTargetId` set on this branch, so
// it fell back to the chat id instead of the real created message id.
test('the forwarding path (default POST /chats/:id/messages) consumes exactly ONE rate-limit unit, not two', async () => {
  // Budget of 3: `newChat` below itself makes a `POST /chats` call that consumes one unit of
  // the SAME shared per-tenant budget (the blanket limiter covers the whole surface, not just
  // the forwarding route) — accounted for here so the remaining math isolates exactly what the
  // forwarding call itself consumes.
  const ext: ExtRouteDeps = { idempotency: new IdempotencyStore(), limiter: new TenantLimiter({ maxInFlight: 100, ratePerMinute: 3 }) }
  const { app, runs, cleanup } = harnessWithRuns(undefined, ext)
  try {
    const chatId = await newChat(app, 'RateForward')   // consumes 1 of 3
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
    assert.equal(res.status, 202, 'the one logical call itself must be admitted')
    const run = await res.json() as { id: string }
    await runs.settled(run.id)

    // If the forward had double-charged (the N7 bug), this ONE logical call would have consumed
    // 2 of the remaining 2 units (newChat's 1 + the forward's 2 = 3 total), exhausting the
    // budget — and this THIRD, entirely separate request would be refused. A correctly
    // single-charged forward leaves exactly one unit for it.
    const third = await app.request('/api/ext/v1/capabilities', { headers: { Authorization: ACME } })
    assert.equal(third.status, 200, 'a single logical forwarding call must consume exactly one rate-limit unit, not two')
  } finally {
    cleanup()
  }
})

test('a direct external request cannot spoof the internal-forward marker to dodge the rate limit', async () => {
  const ext: ExtRouteDeps = { idempotency: new IdempotencyStore(), limiter: new TenantLimiter({ maxInFlight: 100, ratePerMinute: 1 }) }
  const { app, cleanup } = harness(ext)
  try {
    const first = await app.request('/api/ext/v1/chats', json(ACME, { title: 'One', owner: 'u1' }))
    assert.equal(first.status, 201, 'consumes the one-per-minute budget')

    // A client guessing the header's NAME (it cannot know the per-process random token value)
    // and attaching an arbitrary value must not bypass the budget.
    const spoofed = await app.request('/api/ext/v1/chats', {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'X-Ext-Internal-Forward': 'guessed-or-empty' },
      body: JSON.stringify({ title: 'Spoofed', owner: 'u1' }),
    })
    assert.equal(spoofed.status, 429, 'a spoofed internal-forward header must not exempt an external request from the budget')
  } finally {
    cleanup()
  }
})

test('the forwarding path\'s message.create audit row targets the real created message id, not the chat id', async () => {
  const { app, runs, cleanup } = harnessWithRuns()
  try {
    const chatId = await newChat(app, 'AuditForward')
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      json(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
    assert.equal(res.status, 202)
    const run = await res.json() as { id: string }
    await runs.settled(run.id)

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, json(ACME))).json() as {
      data: Array<{ id: string; role: string }>
    }
    const userMessageId = list.data.find((m) => m.role === 'user')!.id

    const rows = await auditRows(app)
    const createRow = rows.find((r) => r.action === 'message.create')
    assert.ok(createRow, 'expected a message.create row')
    assert.equal(createRow!.target_id, userMessageId, 'the forwarding-path message.create row must target the real created message, not the chat id')
    assert.notEqual(createRow!.target_id, chatId, 'sanity: must not have fallen back to the chat id')
  } finally {
    cleanup()
  }
})
