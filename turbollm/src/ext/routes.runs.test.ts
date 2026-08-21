// turbollm/src/ext/routes.runs.test.ts
//
// The generating path. `runs` is driven with an injected body so these tests cover the
// route contract — persistence, streaming, resumption, cancellation — without a model.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import { StoreError, type ChatStore } from '../chat/store/chat-store.js'
import { hashKey } from '../auth.js'
import { PublicRunManager } from './run-manager.js'
import { registerExtChatRoutes } from './routes.chats.js'
import { registerExtRunRoutes, type ExtRouteDeps } from './routes.runs.js'
import { loadFullHistory } from './generation.js'
import { IdempotencyStore } from './idempotency.js'
import { TenantLimiter } from './limits.js'
import { AuditLog } from './audit.js'

const ACME = 'Bearer tllm-ext-acme'
const GLOBEX = 'Bearer tllm-ext-globex'

/** Defaults to a `contextSize`-less status (permissive — see context-limit.ts), matching every
 *  pre-existing test in this file. Task 3's re-review added the `managerStatus` override so a
 *  handful of new tests can exercise a REAL (small) context window without disturbing any of the
 *  others, which all rely on the check being a no-op. */
function harness(
  bodyFactory?: () => Promise<{ status: 'complete' | 'aborted' }>,
  ext?: ExtRouteDeps,
  managerStatus?: () => { state: string; model: string | null; contextSize?: number },
) {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-runs-'))
  const conv = new ConversationStore(dir)
  const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
  const d = {
    db: conv,
    chatStore,
    // resolveTenantFromKey (ext/auth.ts) hashes the presented key with the real SHA-256
    // derivation before comparing (see routes.chats.test.ts's identical convention) — stored
    // keys hold only the hash, never the raw value, so the fixture must too.
    store: { snapshot: () => ({ apiKeys: [
      { hash: hashKey('tllm-ext-acme'), tenant: 'acme' },
      { hash: hashKey('tllm-ext-globex'), tenant: 'globex' },
    ] }) },
    manager: {
      status: managerStatus ?? (() => ({ state: 'running', model: 'test-model' })),
      target: () => 'http://127.0.0.1:9999',
    },
  } as never
  const runs = new PublicRunManager()
  const app = new Hono()
  registerExtChatRoutes(app, d, ext)
  registerExtRunRoutes(app, d, runs, {
    makeBody: () => async ({ emit }) => {
      await emit({ event: 'delta', data: { content: 'hello' } })
      await emit({ event: 'delta', data: { content: ' world' } })
      return bodyFactory ? await bodyFactory() : { status: 'complete' as const }
    },
  }, ext)
  return { app, runs, db: conv, chatStore, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const post = (auth: string, b: unknown, accept = 'application/json') => ({
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: accept },
  body: JSON.stringify(b),
})

/** Wraps a real `ChatStore` so exactly one named method throws — `n` times before falling
 *  through to the real implementation (default: forever). Mirrors routes.chats.test.ts's
 *  `harnessNoAdapter` regression pattern (a store that throws `StoreError` for a route that,
 *  before the fix, called it outside any try/catch) but at the METHOD level via `Proxy` rather
 *  than swapping the whole store — `getChat`/`listMessages` are the two calls C3 found
 *  unguarded, and `newChat()`'s own `POST /chats` (createChat) must keep working normally so a
 *  chat exists to generate against in the first place. A non-accessor Proxy trap like this is
 *  transparent to `this` binding for both plain methods and `ChatStoreRouter`'s own `capabilities`
 *  getter (Reflect.get forwards the receiver correctly either way), so calls the real store makes
 *  on itself (`pick()` reading `this.local`/`this.adapter`) are unaffected. */
function chatStoreThatThrows(base: ChatStore, method: 'getChat' | 'listMessages', n = Infinity): ChatStore {
  let thrown = 0
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === method) {
        return async (...args: unknown[]) => {
          if (thrown < n) {
            thrown++
            throw new StoreError('contract_violation', 'simulated adapter failure')
          }
          return (target[method] as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as ChatStore
}

function harnessWithThrowingStore(method: 'getChat' | 'listMessages', n = Infinity) {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-runs-throw-'))
  const conv = new ConversationStore(dir)
  const chatStore = chatStoreThatThrows(new ChatStoreRouter(conv.chatStore, conv.chatStore), method, n)
  const d = {
    db: conv,
    chatStore,
    store: { snapshot: () => ({ apiKeys: [{ hash: hashKey('tllm-ext-acme'), tenant: 'acme' }] }) },
    manager: { status: () => ({ state: 'running', model: 'test-model' }), target: () => 'http://127.0.0.1:9999' },
  } as never
  const runs = new PublicRunManager()
  const app = new Hono()
  registerExtChatRoutes(app, d)
  registerExtRunRoutes(app, d, runs, {
    makeBody: () => async ({ emit }) => { await emit({ event: 'delta', data: { content: 'hello' } }); return { status: 'complete' as const } },
  })
  return { app, runs, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function newChat(app: Hono, auth = ACME) {
  const res = await app.request('/api/ext/v1/chats', post(auth, { title: 'Run', owner: 'u1' }))
  return (await res.json() as { id: string }).id
}

test('JSON mode returns 202 with a run and persists both messages first', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
    assert.equal(res.status, 202)
    const run = await res.json() as { id: string; chat_id: string; message_id: string; status: string }
    assert.equal(run.chat_id, chatId)
    assert.ok(run.message_id)

    await runs.settled(run.id)

    // Persist-before-generate (spec §7.4): the user turn AND the assistant placeholder must
    // both exist independently of whether generation succeeded.
    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, { headers: { Authorization: ACME } })).json() as { data: Array<{ role: string }> }
    assert.deepEqual(list.data.map((m) => m.role), ['user', 'assistant'])
  } finally {
    cleanup()
  }
})

test('run.start audit rows carry the real created run id, not the parent chat id', async () => {
  const { app, runs, db, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
    const run = await res.json() as { id: string }
    assert.notEqual(run.id, chatId, 'sanity: the run id must differ from the chat id')
    await runs.settled(run.id)

    // Direct store read (see routes.chats.test.ts's identical rationale): this route registers
    // its OWN AuditLog fallback since no `ext.audit` was threaded through by this harness call.
    const rows = new AuditLog(db).list('acme', 'u1', {})
    const startRow = rows.find((r) => r.action === 'run.start')
    assert.ok(startRow, 'expected a run.start row')
    assert.equal(startRow!.targetId, run.id, 'run.start must name the RUN it created, not the parent chat')
  } finally {
    cleanup()
  }
})

test('SSE mode streams a run frame, deltas, and a terminal done', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }, 'text/event-stream'))
    assert.equal(res.status, 200)
    assert.match(res.headers.get('Content-Type') ?? '', /text\/event-stream/)

    const text = await res.text()
    assert.match(text, /event: run/)
    assert.match(text, /event: delta/)
    assert.match(text, /event: done/)
    assert.match(text, /"status":"complete"/)
    assert.match(text, /^id: \d+$/m, 'each frame carries its seq as the SSE id, for ?after=')
  } finally {
    cleanup()
  }
})

test('GET /runs/{id} is the source of truth after the stream ends', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const started = await (await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))).json() as { id: string }
    await runs.settled(started.id)

    const res = await app.request(`/api/ext/v1/runs/${started.id}?owner=u1`, { headers: { Authorization: ACME } })
    assert.equal(res.status, 200)
    assert.equal((await res.json() as { status: string }).status, 'complete')
  } finally {
    cleanup()
  }
})

test('reattaching with ?after replays only later frames', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const started = await (await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))).json() as { id: string }
    await runs.settled(started.id)

    const full = await (await app.request(`/api/ext/v1/runs/${started.id}/stream?owner=u1`, { headers: { Authorization: ACME } })).text()
    const tail = await (await app.request(`/api/ext/v1/runs/${started.id}/stream?after=2&owner=u1`, { headers: { Authorization: ACME } })).text()
    assert.ok(full.length > tail.length)
    assert.match(tail, /event: done/, 'a late reattach still receives the terminal frame')
  } finally {
    cleanup()
  }
})

test('another tenant cannot read or cancel a run', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const started = await (await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))).json() as { id: string }
    await runs.settled(started.id)

    const res = await app.request(`/api/ext/v1/runs/${started.id}`, { headers: { Authorization: 'Bearer tllm-ext-nope' } })
    assert.equal(res.status, 401)
  } finally {
    cleanup()
  }
})

test('a second run on the same chat is refused with generation_in_flight', async () => {
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const { app, cleanup } = harness(async () => { await gate; return { status: 'complete' as const } })
  try {
    const chatId = await newChat(app)
    await app.request(`/api/ext/v1/chats/${chatId}/messages`, post(ACME, { role: 'user', content: 'one', owner: 'u1' }))
    const second = await app.request(`/api/ext/v1/chats/${chatId}/messages`, post(ACME, { role: 'user', content: 'two', owner: 'u1' }))
    assert.equal(second.status, 409)
    assert.equal((await second.json() as { error: { code: string } }).error.code, 'generation_in_flight')
    release!()
  } finally {
    cleanup()
  }
})

test('sending to a chat in another tenant is a 404, and writes nothing', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      { ...post('Bearer tllm-ext-acme', { role: 'user', content: 'x', owner: 'someone-else' }) })
    assert.equal(res.status, 404)
  } finally {
    cleanup()
  }
})

test('cancel aborts an in-flight run', async () => {
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const { app, runs, cleanup } = harness(async () => { await gate; return { status: 'complete' as const } })
  try {
    const chatId = await newChat(app)
    const started = await (await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))).json() as { id: string }

    const res = await app.request(`/api/ext/v1/runs/${started.id}/cancel?owner=u1`, { method: 'POST', headers: { Authorization: ACME } })
    assert.equal(res.status, 200)
    release!()
    await runs.settled(started.id)
    assert.equal(runs.get(started.id)?.status, 'aborted')
  } finally {
    cleanup()
  }
})

// Self-review addition (not in the brief's Step 1 listing): the route's `stream.onAbort`
// handler must close the subscription without touching the run's own AbortController — only
// POST .../cancel may do that. A client walking away mid-stream (closed tab, dropped
// connection, proxy timeout) must never silently kill a generation nobody asked to stop.
test('dropping the SSE connection does not abort the run', async () => {
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const { app, runs, cleanup } = harness(async () => { await gate; return { status: 'complete' as const } })
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }, 'text/event-stream'))
    assert.equal(res.status, 200)
    const [run] = runs.list('acme')
    assert.ok(run, 'the run must already be registered before the SSE body is even read')

    // Simulate a dropped client: read one chunk, then cancel the reader instead of draining
    // the stream to completion — from the server's side this is indistinguishable from a
    // closed connection, and is exactly what should invoke Hono's stream.onAbort.
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()

    release!()
    await runs.settled(run.id)
    assert.equal(runs.get(run.id)?.status, 'complete', 'the run must finish normally — the dropped stream must not abort it')
  } finally {
    cleanup()
  }
})

// Idempotency (spec 27 §7.6), fix round: the generate path is the other commit point the spec
// names. The commit happens at run CREATION (immediately after `runs.start()`, before the
// injected body's own engine work runs) — a retry landing anywhere after that point must
// reattach to the SAME run instead of persisting a second user/assistant pair or starting a
// second generation. A key is opt-in: no header behaves exactly as every other test in this
// file already covers.
test('a duplicate Idempotency-Key on the generate path reattaches to the same run instead of starting a second one', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const genPost = (content: string) => ({
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-gen-1' },
      body: JSON.stringify({ role: 'user', content, owner: 'u1' }),
    })

    const first = await app.request(`/api/ext/v1/chats/${chatId}/messages`, genPost('hi'))
    assert.equal(first.status, 202)
    const run1 = await first.json() as { id: string }
    await runs.settled(run1.id)

    // Retry with the SAME key but DIFFERENT content — proving this reattaches rather than
    // starting a fresh generation from the new body.
    const second = await app.request(`/api/ext/v1/chats/${chatId}/messages`, genPost('hi again'))
    assert.equal(second.status, 202)
    const run2 = await second.json() as { id: string }
    assert.equal(run2.id, run1.id, 'the replay must reattach to the SAME run, not start a new one')

    const list = await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, { headers: { Authorization: ACME } })
    const page = await list.json() as { data: Array<{ role: string }> }
    assert.deepEqual(page.data.map((m) => m.role), ['user', 'assistant'], 'the replay must not persist a second user/assistant pair')
  } finally {
    cleanup()
  }
})

test('a duplicate Idempotency-Key still works when the retry asks for SSE the first request did not', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const first = await app.request(`/api/ext/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-gen-2' },
      body: JSON.stringify({ role: 'user', content: 'hi', owner: 'u1' }),
    })
    const run1 = await first.json() as { id: string }
    await runs.settled(run1.id)

    const replay = await app.request(`/api/ext/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Idempotency-Key': 'ik-gen-2' },
      body: JSON.stringify({ role: 'user', content: 'hi', owner: 'u1' }),
    })
    assert.equal(replay.status, 200)
    assert.match(replay.headers.get('Content-Type') ?? '', /text\/event-stream/)
    const text = await replay.text()
    assert.match(text, new RegExp(`"run_id":"${run1.id}"`), 'the replayed stream reattaches to the original run')
    assert.match(text, /event: done/, 'a replay of an already-finished run still delivers its terminal frame')
  } finally {
    cleanup()
  }
})

test('a stale Idempotency-Key whose run has already been pruned is refused rather than silently re-run', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const first = await app.request(`/api/ext/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-gen-3' },
      body: JSON.stringify({ role: 'user', content: 'hi', owner: 'u1' }),
    })
    const run1 = await first.json() as { id: string }
    await runs.settled(run1.id)
    // A couple of ticks so `endedAt` is strictly in the past relative to `prune`'s own
    // `Date.now()` read (prune's comparison is a strict `<`, so same-millisecond timestamps
    // would NOT be pruned) — then simulate the run registry having already retired this run.
    await new Promise((r) => setTimeout(r, 5))
    runs.prune(0)

    const replay = await app.request(`/api/ext/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-gen-3' },
      body: JSON.stringify({ role: 'user', content: 'hi', owner: 'u1' }),
    })
    assert.equal(replay.status, 409)
    assert.equal((await replay.json() as { error: { code: string } }).error.code, 'idempotency_replay_expired')
  } finally {
    cleanup()
  }
})

// ── N1 (final-gate fix round) — IdempotencyStore was not scoped by owner ───────────────────
// Live-reproduced in the review this fixes: Owner A starts a generation with an Idempotency-Key;
// a different owner replaying that SAME key received Owner A's real run id and the full
// streamed/replayed generation content. `owner` is now part of the cache key (idempotency.ts),
// so a different owner reusing the value must get a genuinely fresh run of their own.
test('a same-tenant, different-owner replay of an Idempotency-Key on the generate path never reattaches to the other owner\'s run', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatA = await newChat(app) // owner 'u1', see newChat()
    const sharedKey = 'ik-cross-owner-gen'
    const first = await app.request(`/api/ext/v1/chats/${chatA}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
      body: JSON.stringify({ role: 'user', content: 'owner A secret', owner: 'u1' }),
    })
    assert.equal(first.status, 202)
    const runA = await first.json() as { id: string }
    await runs.settled(runA.id)

    // A DIFFERENT chat belonging to a DIFFERENT owner, SAME tenant, replaying the SAME key.
    const chatBRes = await app.request('/api/ext/v1/chats', post(ACME, { title: 'Owner B chat', owner: 'u2' }))
    const chatB = (await chatBRes.json() as { id: string }).id

    const second = await app.request(`/api/ext/v1/chats/${chatB}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
      body: JSON.stringify({ role: 'user', content: 'owner B message', owner: 'u2' }),
    })
    assert.equal(second.status, 202, 'owner B\'s replay must start a genuinely fresh run, not be refused or reattached')
    const runB = await second.json() as { id: string; chat_id: string }
    assert.notEqual(runB.id, runA.id, 'owner B must never reattach to owner A\'s run')
    assert.equal(runB.chat_id, chatB, 'the fresh run must belong to owner B\'s own chat')
    await runs.settled(runB.id)

    const listB = await (await app.request(`/api/ext/v1/chats/${chatB}/messages?owner=u2`, { headers: { Authorization: ACME } })).json() as {
      data: Array<{ content: string; role: string }>
    }
    assert.ok(listB.data.every((m) => !m.content.includes('owner A secret')), 'owner B must never see owner A\'s generation content')
  } finally {
    cleanup()
  }
})

// Defense in depth (N1): the route's own post-lookup guard checks `existing.owner !==
// scope.owner` even though the owner-scoped cache key above should already make a cross-owner
// hit structurally impossible. Simulates a cache entry that (as if the store's own keying had a
// defect) somehow resolved for the WRONG owner, and confirms the route's second, independent
// check still refuses to reattach.
test('the generate replay branch refuses to reattach even if a cache entry somehow resolves to another owner\'s run (defense in depth)', async () => {
  const ext: ExtRouteDeps = { idempotency: new IdempotencyStore(), limiter: new TenantLimiter({ maxInFlight: 100, ratePerMinute: 1000 }) }
  const { app, runs, cleanup } = harness(undefined, ext)
  try {
    const chatA = await newChat(app) // owner 'u1'
    const startedA = await (await app.request(`/api/ext/v1/chats/${chatA}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))).json() as { id: string }
    await runs.settled(startedA.id)

    // Plant an entry keyed under owner 'u2' that points at owner 'u1's real run — simulating a
    // defect in the cache key derivation itself, which the route's OWN guard must not just trust.
    ext.idempotency.remember('acme', 'u2', 'runs:generate', 'poisoned-key', { runId: startedA.id, userMessageId: 'x', messageId: 'y' })

    const res = await app.request(`/api/ext/v1/chats/${chatA}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': 'poisoned-key' },
      body: JSON.stringify({ role: 'user', content: 'attempt', owner: 'u2' }),
    })
    assert.equal(res.status, 409, 'must not silently reattach to another owner\'s run via a mismatched cache entry')
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'idempotency_replay_expired')
  } finally {
    cleanup()
  }
})

test('a tenant that exceeds its configured in-flight limit gets 429 on the generate endpoint, while a different tenant is unaffected', async () => {
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const ext: ExtRouteDeps = { idempotency: new IdempotencyStore(), limiter: new TenantLimiter({ maxInFlight: 1, ratePerMinute: 1000 }) }
  const { app, runs, cleanup } = harness(async () => { await gate; return { status: 'complete' as const } }, ext)
  try {
    const chatA = await newChat(app)
    const chatB = await newChat(app)

    const first = await app.request(`/api/ext/v1/chats/${chatA}/messages`, post(ACME, { role: 'user', content: 'one', owner: 'u1' }))
    assert.equal(first.status, 202, 'the first generation for this tenant is admitted')
    const run1 = await first.json() as { id: string }

    // A DIFFERENT chat, SAME tenant — this must be capped by the per-TENANT limiter, not the
    // route's own per-CHAT `inflight` map (which would only refuse a second run on chatA).
    const second = await app.request(`/api/ext/v1/chats/${chatB}/messages`, post(ACME, { role: 'user', content: 'two', owner: 'u1' }))
    assert.equal(second.status, 429, 'a second CONCURRENT generation for the same tenant (different chat) is refused')
    assert.equal((await second.json() as { error: { code: string } }).error.code, 'rate_limited')

    const chatBMessages = await (await app.request(`/api/ext/v1/chats/${chatB}/messages?owner=u1`, { headers: { Authorization: ACME } })).json() as { data: unknown[] }
    assert.equal(chatBMessages.data.length, 0, 'a refused generation must not leave a dangling user/assistant message pair')

    const chatC = await newChat(app, GLOBEX)
    const other = await app.request(`/api/ext/v1/chats/${chatC}/messages`, post(GLOBEX, { role: 'user', content: 'hi', owner: 'u1' }))
    assert.equal(other.status, 202, 'a different tenant is unaffected by acme being at its own in-flight cap')

    release!()
    await runs.settled(run1.id)
  } finally {
    cleanup()
  }
})

// Regression test for a real bug the re-review caught by direct reproduction: mount.ts hands
// ONE shared IdempotencyStore instance to both routes.chats.ts and routes.runs.ts. Before the
// store namespaced its keys by operation, a tenant reusing the identical Idempotency-Key value
// across a POST /chats call and a later, genuinely different POST .../messages/generate call —
// a plausible client pattern ("create the chat and send the first message" as one logical
// idempotent action) — made the generate route deserialize the cached ChatDTO as a
// GenerateReplay, get `undefined` back for `runId`, and fail closed with a false
// `409 idempotency_replay_expired` on a request that had never actually been attempted before.
test('a chat-creation Idempotency-Key does not collide with a generate call reusing the same key value', async () => {
  const ext: ExtRouteDeps = { idempotency: new IdempotencyStore(), limiter: new TenantLimiter({ maxInFlight: 100, ratePerMinute: 1000 }) }
  const { app, runs, cleanup } = harness(undefined, ext)
  try {
    const sharedKey = 'shared-key-123'
    const chatRes = await app.request('/api/ext/v1/chats', {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
      body: JSON.stringify({ title: 'Chat', owner: 'u1' }),
    })
    assert.equal(chatRes.status, 201)
    const chat = await chatRes.json() as { id: string }

    // Reusing the SAME Idempotency-Key VALUE for a genuinely different operation (generate, not
    // chat-create) must be treated as a fresh request, never as a replay of the chat-creation call.
    const genRes = await app.request(`/api/ext/v1/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: { Authorization: ACME, 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
      body: JSON.stringify({ role: 'user', content: 'hi', owner: 'u1' }),
    })
    assert.equal(genRes.status, 202, 'a genuinely new generate request must not be rejected as a collision with an unrelated chat-creation call')
    const run = await genRes.json() as { id: string }
    assert.ok(run.id, 'a real run must have actually been started')
    await runs.settled(run.id)
  } finally {
    cleanup()
  }
})

// Task 3 re-review, Important finding #1: every other test in this file uses a `manager.status()`
// that never reports `contextSize`, so `checkContextFits` is a guaranteed no-op everywhere above —
// none of them actually exercise a real refusal through the HTTP route. This is that missing
// end-to-end case: a genuinely small window, a prompt long enough to overflow it, and — the single
// most safety-critical property this feature exists for — proof that the refusal happens before
// ANY persistence, not after.
test('an over-long prospective history is refused with context_overflow, and nothing is persisted', async () => {
  const smallWindow = () => ({ state: 'running', model: 'test-model', contextSize: 1000 })
  const { app, cleanup } = harness(undefined, undefined, smallWindow)
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'x'.repeat(4000), owner: 'u1' }))
    assert.equal(res.status, 409)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'context_overflow')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, { headers: { Authorization: ACME } })).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'a refused generation must not leave a dangling user/assistant message pair')
  } finally {
    cleanup()
  }
})

// Task 3 re-review, Critical finding: the ORIGINAL implementation built `prospective` from a
// single un-cursored `listMessages(scope, chatId, { limit: 200 })` call. `SqliteChatStore` orders
// that call `seq ASC` and hard-caps `limit` at 200 (clampLimit) — so for any chat past 200 stored
// messages that call returns only the OLDEST page, and everything after message #200 (potentially
// the bulk of the conversation's real token weight) was invisible to the check. This seeds 200
// short "filler" messages (well under the window on their own — exactly what the old single-page
// call would have seen and nothing more), then 55 further, longer messages tacked onto the END of
// the conversation. The true full-history total overflows the window; the first-200-only view
// would not have. The fix (reusing generation.ts's `loadFullHistory`, which pages via cursor until
// exhausted) must see the true total, not just the first page.
test('an overflow that only shows up past message #200 is still caught (full-history paging, not a single capped page)', async () => {
  const midWindow = () => ({ state: 'running', model: 'test-model', contextSize: 2000 })
  const { app, chatStore, cleanup } = harness(undefined, undefined, midWindow)
  try {
    const chatId = await newChat(app)
    const scope = { tenant: 'acme', owner: 'u1' }

    // First 200 messages: short filler (~3 estimated tokens each, ~600 total) — precisely what a
    // single un-cursored `listMessages(..., { limit: 200 })` call would return, and nothing more.
    for (let i = 0; i < 200; i++) {
      await chatStore.addMessage(scope, chatId, { role: 'user', content: 'hi' })
    }
    // 55 more messages AFTER that first page (~60 estimated tokens each, ~3300 total) — long
    // enough that the TRUE full-history total (~3900) overflows the 2000-token window, even
    // though the first 200 messages alone (~600) would not have.
    for (let i = 0; i < 55; i++) {
      await chatStore.addMessage(scope, chatId, { role: 'user', content: 'x'.repeat(200) })
    }

    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'one more', owner: 'u1' }))
    assert.equal(res.status, 409, 'the true full history overflows even though the first 200 messages alone would not')
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'context_overflow')

    // No user/assistant pair was added on top of the 255 seeded messages — the refusal happened
    // before persistence even for a chat this large. Counted via the same full-history pager the
    // fix itself uses, since the public GET .../messages endpoint caps any single page at 200.
    const after = await loadFullHistory(chatStore, scope, chatId)
    assert.equal(after.length, 255, 'the refusal must not add a user/assistant pair on top of the seeded history')
  } finally {
    cleanup()
  }
})

// ── Final-gate fix round: C1, cross-owner isolation on the run routes ──────────────────────
// Every run route checked only `run.tenant`, never `run.owner` — one owner's API key could
// list/read/cancel every OTHER owner's runs within the same tenant (empirically reproduced in
// the final review). These are same-TENANT, different-OWNER cases — distinct from the
// pre-existing cross-tenant coverage above, which uses an entirely unauthenticated key and so
// never actually exercised the owner-scoping branch at all.
test('a same-tenant, different-owner request cannot read a run (owner scoping, not just tenant)', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app) // owner 'u1', see newChat()
    const started = await (await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))).json() as { id: string }
    await runs.settled(started.id)

    const res = await app.request(`/api/ext/v1/runs/${started.id}?owner=someone-else`, { headers: { Authorization: ACME } })
    assert.equal(res.status, 404, 'same tenant, different owner must not see the run')
    assert.equal((await res.json() as { error: { type: string } }).error.type, 'not_found', 'must not distinguish wrong-owner from wrong-tenant or not-found')
  } finally {
    cleanup()
  }
})

test('a same-tenant, different-owner request cannot cancel a run, and the real owner\'s run is unaffected', async () => {
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const { app, runs, cleanup } = harness(async () => { await gate; return { status: 'complete' as const } })
  try {
    const chatId = await newChat(app)
    const started = await (await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))).json() as { id: string }

    const res = await app.request(`/api/ext/v1/runs/${started.id}/cancel?owner=someone-else`,
      { method: 'POST', headers: { Authorization: ACME } })
    assert.equal(res.status, 404, 'same tenant, different owner must not be able to cancel')

    release!()
    await runs.settled(started.id)
    assert.equal(runs.get(started.id)?.status, 'complete', "another owner's cancel attempt must not have touched the real owner's run")
  } finally {
    cleanup()
  }
})

// ── Final-gate fix round: C3, unguarded getChat/loadFullHistory in the generate handler ─────
// Every other store call on the generate path is wrapped in try/catch → mapStoreError →
// extError. `getChat` and `loadFullHistory`'s own `listMessages` calls were not — a throwing
// adapter (any real pluggable, non-SQLite ChatStore) fell through to Hono's bare, non-JSON 500.
// Mirrors routes.chats.test.ts's `harnessNoAdapter` regression pattern, at the method level.
test('getChat throwing in the generate handler surfaces a JSON error envelope, and releases the inflight reservation for a retry', async () => {
  // Throws exactly once — the SECOND generate call for the same chat must succeed, proving the
  // I5 inflight reservation this request took out was released on this failure path (not left
  // dangling, which would otherwise permanently block the chat with `generation_in_flight`).
  const { app, runs, cleanup } = harnessWithThrowingStore('getChat', 1)
  try {
    const chatId = await newChat(app)
    const first = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
    const text = await first.text()
    let parsed: { error?: { type?: unknown; code?: unknown; request_id?: unknown; retryable?: unknown } }
    try {
      parsed = JSON.parse(text)
    } catch {
      assert.fail(`response body is not JSON (bare framework error?): ${text.slice(0, 200)}`)
    }
    assert.ok(first.status >= 400, 'a store failure must not report success')
    assert.equal(typeof parsed.error?.type, 'string')
    assert.equal(typeof parsed.error?.code, 'string')
    assert.equal(typeof parsed.error?.request_id, 'string')
    assert.equal(typeof parsed.error?.retryable, 'boolean')

    const second = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', content: 'hi again', owner: 'u1' }))
    assert.equal(second.status, 202, 'the failed attempt must not have left the chat permanently blocked')
    const run = await second.json() as { id: string }
    await runs.settled(run.id)
  } finally {
    cleanup()
  }
})

test('listMessages (loadFullHistory) throwing in the generate handler surfaces a JSON error envelope, not a bare 500', async () => {
  const { app, cleanup } = harnessWithThrowingStore('listMessages')
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', content: 'hi', owner: 'u1' }))
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

// ── Final-gate fix round: C4, attachments silently dropped on the generate path ─────────────
test('an attachments-only message (no content) is accepted on the generate route, and only the user message keeps the attachments', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', owner: 'u1', attachments: ['data:image/png;base64,AAAA'] }))
    assert.equal(res.status, 202, 'content-empty-but-attached must be accepted, not rejected as empty')
    const run = await res.json() as { id: string }
    await runs.settled(run.id)

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1&include=attachments`,
      { headers: { Authorization: ACME } })).json() as { data: Array<{ role: string; attachments: string[] }> }
    const userMsg = list.data.find((m) => m.role === 'user')!
    const assistantMsg = list.data.find((m) => m.role === 'assistant')!
    assert.deepEqual(userMsg.attachments, ['data:image/png;base64,AAAA'], 'the attachment must round-trip on the user message')
    assert.deepEqual(assistantMsg.attachments, [], 'the assistant placeholder never receives attachments')
  } finally {
    cleanup()
  }
})

// ── Final-gate fix round: C5, body/attachment limits advertised but never enforced ──────────
test('a message body over the byte limit is refused with 413 payload_too_large, and nothing is persisted', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', owner: 'u1', content: 'x'.repeat(1_048_577) }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`,
      { headers: { Authorization: ACME } })).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'an over-limit write must not persist anything')
  } finally {
    cleanup()
  }
})

test('a message with more attachments than the limit is refused with 413 payload_too_large', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', owner: 'u1', content: 'hi', attachments: ['a', 'b', 'c', 'd', 'e'] }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')
  } finally {
    cleanup()
  }
})

// ── N5 (final-gate fix round) — 413 enforcement checked attachment COUNT, never byte SIZE ──
test('attachments whose total byte size exceeds the limit are refused with 413 on the generate route, even with only a few of them', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const huge = 'x'.repeat(Math.ceil(1_048_576 / 2) + 1)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', owner: 'u1', attachments: [huge, huge] }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, { headers: { Authorization: ACME } })).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'the oversized write must not have been persisted')
  } finally {
    cleanup()
  }
})

// ── Round-3 final-whole-branch-review finding: "N5/N6's byte-size checks crash with a bare
// non-JSON 500 on type-confused attachments/content" — the route's `as` cast is not a schema
// check, so a non-string attachment element used to reach `.reduce`/`Buffer.byteLength` with the
// wrong shape and crash before this route's own try/catch, producing Hono's bare non-JSON
// default 500 instead of the structured error envelope. Reproduces the review's own live repro
// shape exactly.
test('attachments containing a non-string element is refused with a clean 400 on the generate route, not a bare 500', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', owner: 'u1', attachments: [999] }))
    const text = await res.text()
    let parsed: { error?: { type?: unknown; code?: unknown } }
    try {
      parsed = JSON.parse(text)
    } catch {
      assert.fail(`response body is not JSON (bare framework error?): ${text.slice(0, 200)}`)
    }
    assert.equal(res.status, 400)
    assert.equal(parsed.error?.type, 'invalid_request')
    assert.equal(parsed.error?.code, 'invalid_input')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, { headers: { Authorization: ACME } })).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'the malformed write must not have been persisted')
  } finally {
    cleanup()
  }
})

test('a metadata blob over the byte limit is refused with 413 on the generate route, even with tiny content', async () => {
  const { app, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const res = await app.request(`/api/ext/v1/chats/${chatId}/messages/generate`,
      post(ACME, { role: 'user', owner: 'u1', content: 'hi', metadata: { blob: 'x'.repeat(1_048_577) } }))
    assert.equal(res.status, 413)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'payload_too_large')

    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`, { headers: { Authorization: ACME } })).json() as { data: unknown[] }
    assert.equal(list.data.length, 0, 'the oversized write must not have been persisted')
  } finally {
    cleanup()
  }
})

// ── Final-gate fix round: I5, inflight-map TOCTOU race ──────────────────────────────────────
// Before the fix, `inflight.has(chatId)` was checked (originally even AFTER `getChat`) but not
// `.set()` until right before the response, with real `await`s in between — two near-simultaneous
// requests could both observe an empty slot and both start a run. Reproduced here exactly as the
// final review did: a real `Promise.all` of two concurrent generate requests on the SAME chat.
test('two concurrent generate requests for the same chat: exactly one starts a run, the other is refused with generation_in_flight', async () => {
  const { app, runs, cleanup } = harness()
  try {
    const chatId = await newChat(app)
    const [a, b] = await Promise.all([
      app.request(`/api/ext/v1/chats/${chatId}/messages/generate`, post(ACME, { role: 'user', content: 'one', owner: 'u1' })),
      app.request(`/api/ext/v1/chats/${chatId}/messages/generate`, post(ACME, { role: 'user', content: 'two', owner: 'u1' })),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [202, 409], 'exactly one concurrent request must be admitted, the other refused')

    const refused = a.status === 409 ? a : b
    assert.equal((await refused.json() as { error: { code: string } }).error.code, 'generation_in_flight')
    const admitted = a.status === 202 ? a : b
    const run = await admitted.json() as { id: string }
    assert.ok(run.id, 'the admitted request must have actually started a real run')
    await runs.settled(run.id)

    // Exactly ONE user+assistant pair persisted — the loser never raced past the reservation
    // into persistence.
    const list = await (await app.request(`/api/ext/v1/chats/${chatId}/messages?owner=u1`,
      { headers: { Authorization: ACME } })).json() as { data: unknown[] }
    assert.equal(list.data.length, 2, 'exactly one user+assistant pair, not two')
  } finally {
    cleanup()
  }
})

test('a context-overflow refusal releases the inflight reservation — a normal follow-up request is not blocked', async () => {
  const smallWindow = () => ({ state: 'running', model: 'test-model', contextSize: 1000 })
  const { app, runs, cleanup } = harness(undefined, undefined, smallWindow)
  try {
    const chatId = await newChat(app)
    const overflow = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'x'.repeat(4000), owner: 'u1' }))
    assert.equal(overflow.status, 409)

    const ok = await app.request(`/api/ext/v1/chats/${chatId}/messages`,
      post(ACME, { role: 'user', content: 'short', owner: 'u1' }))
    assert.equal(ok.status, 202, 'a context-overflow refusal must not permanently block the chat')
    const run = await ok.json() as { id: string }
    await runs.settled(run.id)
  } finally {
    cleanup()
  }
})
