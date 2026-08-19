// turbollm/src/chat/store/sqlite-chat-store.test.ts
//
// SqliteChatStore runs over the SAME tables and the SAME handle as ConversationStore
// (spec 27 §4.3 / Phase 1 amendment 1): nothing is rerouted, so these tests construct a
// ConversationStore for its migrations and then exercise the store hanging off it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'
import { LOCAL_SCOPE } from './chat-store.js'
import type { SqliteChatStore } from './sqlite-chat-store.js'

function makeStore(): { store: SqliteChatStore; conv: ConversationStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-chatstore-test-'))
  const conv = new ConversationStore(dir)
  return {
    store: conv.chatStore,
    conv,
    cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('rejects any scope other than local/default while tenancy is inert', async () => {
  const { store, cleanup } = makeStore()
  try {
    await assert.rejects(
      () => store.createChat({ tenant: 'acme', owner: 'u1' }, { title: 'X' }),
      /invalid_scope/,
    )
  } finally {
    cleanup()
  }
})

test('createChat returns a fully populated Chat', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Quarterly', model: 'qwen' })
    assert.ok(c.id)
    assert.equal(c.title, 'Quarterly')
    assert.equal(c.model, 'qwen')
    assert.equal(c.owner, 'default')
    assert.equal(c.messageCount, 0)
    assert.equal(c.lastMessageAt, null)
    // version is derived from updated_at (Phase 1 has no version column), so it's a
    // positive epoch-millis token, not the literal 1 — and it must match what a
    // fresh read of the same row computes.
    assert.ok(typeof c.version === 'number' && c.version > 0)
    const fetched = await store.getChat(LOCAL_SCOPE, c.id)
    assert.equal(c.version, fetched?.version)
    assert.ok(c.createdAt)
  } finally {
    cleanup()
  }
})

test('getChat round-trips; unknown id is null', async () => {
  const { store, cleanup } = makeStore()
  try {
    const made = await store.createChat(LOCAL_SCOPE, { title: 'Kept' })
    const got = await store.getChat(LOCAL_SCOPE, made.id)
    assert.equal(got?.title, 'Kept')
    assert.equal(await store.getChat(LOCAL_SCOPE, 'nope'), null)
  } finally {
    cleanup()
  }
})

test('a chat created through ConversationStore is visible through ChatStore', async () => {
  const { store, conv, cleanup } = makeStore()
  try {
    const legacy = conv.createConversation({ title: 'From the UI' })
    const seen = await store.getChat(LOCAL_SCOPE, legacy.id)
    assert.equal(seen?.title, 'From the UI')
  } finally {
    cleanup()
  }
})

test('listChats returns newest-first and paginates by cursor without gaps or repeats', async () => {
  const { store, cleanup } = makeStore()
  try {
    const titles = ['a', 'b', 'c', 'd', 'e']
    for (const t of titles) await store.createChat(LOCAL_SCOPE, { title: t })

    const first = await store.listChats(LOCAL_SCOPE, { limit: 2 })
    assert.equal(first.data.length, 2)
    assert.equal(first.hasMore, true)
    assert.ok(first.nextCursor)

    const second = await store.listChats(LOCAL_SCOPE, { limit: 2, cursor: first.nextCursor! })
    const third = await store.listChats(LOCAL_SCOPE, { limit: 2, cursor: second.nextCursor! })

    const seen = [...first.data, ...second.data, ...third.data].map((c) => c.title)
    assert.equal(seen.length, 5)
    assert.equal(new Set(seen).size, 5, 'no chat appears on two pages')
    assert.equal(third.hasMore, false)
    assert.equal(third.nextCursor, null)
  } finally {
    cleanup()
  }
})

test('listChats honours the search capability over title', async () => {
  const { store, cleanup } = makeStore()
  try {
    await store.createChat(LOCAL_SCOPE, { title: 'Quarterly analysis' })
    await store.createChat(LOCAL_SCOPE, { title: 'Grocery list' })
    const hits = await store.listChats(LOCAL_SCOPE, { q: 'quarter' })
    assert.equal(hits.data.length, 1)
    assert.equal(hits.data[0].title, 'Quarterly analysis')
  } finally {
    cleanup()
  }
})

test('listChats rejects a malformed cursor rather than silently returning page one', async () => {
  const { store, cleanup } = makeStore()
  try {
    await assert.rejects(
      () => store.listChats(LOCAL_SCOPE, { cursor: 'not-base64-json' }),
      /invalid_cursor|contract_violation/,
    )
  } finally {
    cleanup()
  }
})

test('updateChat applies a patch and bumps version', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Before' })
    const updated = await store.updateChat(LOCAL_SCOPE, c.id, { title: 'After' })
    assert.equal(updated?.title, 'After')
    assert.notEqual(updated?.version, c.version)
    assert.equal(await store.updateChat(LOCAL_SCOPE, 'nope', { title: 'X' }), null)
  } finally {
    cleanup()
  }
})

test('updateChat succeeds when ifVersion is exactly the version createChat just returned', async () => {
  // Regression test: createChat used to cosmetically override its returned version to
  // the literal 1, while every other read (chatById/getChat/updateChat) derives version
  // from updated_at — so the most natural caller pattern (create, then update passing
  // the version you were just handed) threw version_conflict 100% of the time.
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Fresh' })
    const updated = await store.updateChat(LOCAL_SCOPE, c.id, { title: 'Edited' }, c.version)
    assert.equal(updated?.title, 'Edited')
  } finally {
    cleanup()
  }
})

test('updateChat with a stale ifVersion throws version_conflict', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Guarded' })
    const fresh = await store.updateChat(LOCAL_SCOPE, c.id, { title: 'First' })
    await assert.rejects(
      () => store.updateChat(LOCAL_SCOPE, c.id, { title: 'Second' }, (fresh!.version) - 1000),
      /version_conflict/,
    )
  } finally {
    cleanup()
  }
})

test('deleteChat removes the chat and cascades to its messages', async () => {
  const { store, conv, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Doomed' })
    conv.addMessage(c.id, 'user', 'hello')
    assert.equal(await store.deleteChat(LOCAL_SCOPE, c.id), true)
    assert.equal(await store.getChat(LOCAL_SCOPE, c.id), null)
    assert.equal(conv.getMessages(c.id).length, 0)
    assert.equal(await store.deleteChat(LOCAL_SCOPE, c.id), false)
  } finally {
    cleanup()
  }
})
