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
    const rows = new AuditLog(db).list('acme', {})
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

    const res = await app.request(`/api/ext/v1/runs/${started.id}`, { headers: { Authorization: ACME } })
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

    const full = await (await app.request(`/api/ext/v1/runs/${started.id}/stream`, { headers: { Authorization: ACME } })).text()
    const tail = await (await app.request(`/api/ext/v1/runs/${started.id}/stream?after=2`, { headers: { Authorization: ACME } })).text()
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

    const res = await app.request(`/api/ext/v1/runs/${started.id}/cancel`, { method: 'POST', headers: { Authorization: ACME } })
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
