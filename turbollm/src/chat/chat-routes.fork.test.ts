// POST /api/v1/conversations/:id/fork (GitHub #323): the route over ConversationStore.forkConversation, with what it
// refuses (db.fork.test.ts covers what a fork copies).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db.js'
import type { Deps } from '../deps.js'
import { chatRegistries } from '../test-support/chat-registries'

function harness() {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const registries = chatRegistries()
  const cfg = { daemon: { experimental: {} }, tools: { toolPolicies: {} } }
  const d = {
    ...registries,
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, update: () => {}, dir: () => '' },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  const fork = (convId: string, messageId?: unknown) =>
    app.request(`/api/v1/conversations/${convId}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) })
  return { store, chatTurns: registries.chatTurns, fork, close: () => store.close() }
}

test('forking answers 201 with the new chat, which holds the history up to the message', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation({ title: 'Ideas' })
    h.store.addMessage(conv.id, 'user', 'q1')
    const a1 = h.store.addMessage(conv.id, 'assistant', 'a1')
    h.store.addMessage(conv.id, 'user', 'q2')

    const res = await h.fork(conv.id, a1.id)
    assert.equal(res.status, 201)
    const forked = await res.json() as { id: string; title: string }
    assert.equal(forked.title, 'Ideas (fork)')
    assert.deepEqual(h.store.getMessages(forked.id).map((m) => m.content), ['q1', 'a1'])
    assert.equal(h.store.getMessages(conv.id).length, 3)
  } finally {
    h.close()
  }
})

test('forking needs a messageId, a chat that exists and a message in it', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation()
    const other = h.store.createConversation()
    const elsewhere = h.store.addMessage(other.id, 'user', 'x')
    assert.equal((await h.fork(conv.id)).status, 400)
    assert.equal((await h.fork(conv.id, 42)).status, 400)
    assert.equal((await h.fork('nope', elsewhere.id)).status, 404)
    const wrong = await h.fork(conv.id, elsewhere.id)
    assert.equal(wrong.status, 404)
    assert.match((await wrong.json() as { error: { message: string } }).error.message, /not in this chat/)
  } finally {
    h.close()
  }
})

test('a Code session is forked from the Code routes, not here', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation({ kind: 'code' })
    const u = h.store.addMessage(conv.id, 'user', 'task')
    assert.equal((await h.fork(conv.id, u.id)).status, 400)
  } finally {
    h.close()
  }
})

test('the reply being written cannot be forked, but an earlier message can', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation()
    const q = h.store.addMessage(conv.id, 'user', 'q')
    const running = h.store.addMessage(conv.id, 'assistant', '')
    const ac = new AbortController()
    h.chatTurns.claim(conv.id, ac, running.id)

    const refused = await h.fork(conv.id, running.id)
    assert.equal(refused.status, 409)
    assert.equal((await refused.json() as { error: { code: string } }).error.code, 'generation_in_flight')
    assert.equal((await h.fork(conv.id, q.id)).status, 201)
    h.chatTurns.release(conv.id, ac)
  } finally {
    h.close()
  }
})
