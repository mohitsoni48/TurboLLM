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
import { registerExtRunRoutes } from './routes.runs.js'

const ACME = 'Bearer tllm-ext-acme'

function harness(bodyFactory?: () => Promise<{ status: 'complete' | 'aborted' }>) {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-runs-'))
  const conv = new ConversationStore(dir)
  const d = {
    chatStore: new ChatStoreRouter(conv.chatStore, conv.chatStore),
    // resolveTenantFromKey (ext/auth.ts) hashes the presented key with the real SHA-256
    // derivation before comparing (see routes.chats.test.ts's identical convention) — stored
    // keys hold only the hash, never the raw value, so the fixture must too.
    store: { snapshot: () => ({ apiKeys: [{ hash: hashKey('tllm-ext-acme'), tenant: 'acme' }] }) },
    manager: { status: () => ({ state: 'running', model: 'test-model' }), target: () => 'http://127.0.0.1:9999' },
  } as never
  const runs = new PublicRunManager()
  const app = new Hono()
  registerExtChatRoutes(app, d)
  registerExtRunRoutes(app, d, runs, {
    makeBody: () => async ({ emit }) => {
      await emit({ event: 'delta', data: { content: 'hello' } })
      await emit({ event: 'delta', data: { content: ' world' } })
      return bodyFactory ? await bodyFactory() : { status: 'complete' as const }
    },
  })
  return { app, runs, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const post = (auth: string, b: unknown, accept = 'application/json') => ({
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: accept },
  body: JSON.stringify(b),
})

async function newChat(app: Hono) {
  const res = await app.request('/api/ext/v1/chats', post(ACME, { title: 'Run', owner: 'u1' }))
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
