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

test('addMessage allocates seq from 1 and maintains chat counters', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Counting' })
    const m1 = await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'one' })
    const m2 = await store.addMessage(LOCAL_SCOPE, c.id, { role: 'assistant', content: 'two' })
    assert.equal(m1.seq, 1)
    assert.equal(m2.seq, 2)
    assert.equal(m1.status, 'complete')

    const after = await store.getChat(LOCAL_SCOPE, c.id)
    assert.equal(after?.messageCount, 2)
    assert.ok(after?.lastMessageAt)
  } finally {
    cleanup()
  }
})

test('addMessage allocates seq atomically under concurrent appends', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Race' })
    const made = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: `m${i}` })),
    )
    const seqs = made.map((m) => m.seq).sort((a, b) => a - b)
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1),
      'every append got a distinct, gapless seq')
  } finally {
    cleanup()
  }
})

test('addMessage to a missing chat throws not_found rather than orphaning a row', async () => {
  const { store, cleanup } = makeStore()
  try {
    await assert.rejects(
      () => store.addMessage(LOCAL_SCOPE, 'no-such-chat', { role: 'user', content: 'x' }),
      /not_found/,
    )
  } finally {
    cleanup()
  }
})

test('listMessages paginates in seq order', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Paged' })
    for (let i = 0; i < 5; i++) await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: `m${i}` })

    const p1 = await store.listMessages(LOCAL_SCOPE, c.id, { limit: 2 })
    assert.deepEqual(p1.data.map((m) => m.seq), [1, 2])
    const p2 = await store.listMessages(LOCAL_SCOPE, c.id, { limit: 2, cursor: p1.nextCursor! })
    assert.deepEqual(p2.data.map((m) => m.seq), [3, 4])
    const p3 = await store.listMessages(LOCAL_SCOPE, c.id, { limit: 2, cursor: p2.nextCursor! })
    assert.deepEqual(p3.data.map((m) => m.seq), [5])
    assert.equal(p3.hasMore, false)
  } finally {
    cleanup()
  }
})

test('updateMessage patches content and flags edited; getLastMessage tracks the tail', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Edit' })
    const m = await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'before' })
    const patched = await store.updateMessage(LOCAL_SCOPE, m.id, { content: 'after', edited: true })
    assert.equal(patched?.content, 'after')
    assert.equal(patched?.edited, true)

    await store.addMessage(LOCAL_SCOPE, c.id, { role: 'assistant', content: 'tail' })
    assert.equal((await store.getLastMessage(LOCAL_SCOPE, c.id))?.content, 'tail')
    assert.equal(await store.updateMessage(LOCAL_SCOPE, 'nope', { content: 'x' }), null)
  } finally {
    cleanup()
  }
})

test('deleteMessage removes only its own row', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Del' })
    const a = await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'keep' })
    const b = await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'drop' })
    assert.equal(await store.deleteMessage(LOCAL_SCOPE, b.id), true)
    assert.equal(await store.getMessage(LOCAL_SCOPE, b.id), null)
    assert.equal((await store.getMessage(LOCAL_SCOPE, a.id))?.content, 'keep')
  } finally {
    cleanup()
  }
})

const ACME = { tenant: 'acme', owner: 'u1' }
const ACME_OTHER = { tenant: 'acme', owner: 'u2' }
const GLOBEX = { tenant: 'globex', owner: 'u1' }

test('a chat is invisible to another tenant', async () => {
  const { store, cleanup } = makeStore()
  try {
    const mine = await store.createChat(ACME, { title: 'Acme secret' })
    assert.equal(await store.getChat(GLOBEX, mine.id), null)
    assert.equal((await store.listChats(GLOBEX, {})).data.length, 0)
  } finally {
    cleanup()
  }
})

test('a chat is invisible to another owner inside the same tenant', async () => {
  const { store, cleanup } = makeStore()
  try {
    const mine = await store.createChat(ACME, { title: 'U1 only' })
    assert.equal(await store.getChat(ACME_OTHER, mine.id), null)
    assert.equal((await store.listChats(ACME_OTHER, {})).data.length, 0)
  } finally {
    cleanup()
  }
})

test('cross-scope writes cannot mutate or delete another scope rows', async () => {
  const { store, cleanup } = makeStore()
  try {
    const mine = await store.createChat(ACME, { title: 'Untouchable' })
    assert.equal(await store.updateChat(GLOBEX, mine.id, { title: 'hijacked' }), null)
    assert.equal(await store.deleteChat(GLOBEX, mine.id), false)
    assert.equal((await store.getChat(ACME, mine.id))?.title, 'Untouchable')
  } finally {
    cleanup()
  }
})

test('messages are scoped too, and cannot be appended across scopes', async () => {
  const { store, cleanup } = makeStore()
  try {
    const mine = await store.createChat(ACME, { title: 'Scoped msgs' })
    const m = await store.addMessage(ACME, mine.id, { role: 'user', content: 'private' })
    assert.equal(await store.getMessage(GLOBEX, m.id), null)
    await assert.rejects(
      () => store.addMessage(GLOBEX, mine.id, { role: 'user', content: 'intruder' }),
      /not_found/,
    )
  } finally {
    cleanup()
  }
})

test('the local scope still sees rows written by ConversationStore', async () => {
  const { store, conv, cleanup } = makeStore()
  try {
    const legacy = conv.createConversation({ title: 'UI chat' })
    assert.equal((await store.getChat(LOCAL_SCOPE, legacy.id))?.title, 'UI chat')
    assert.equal(await store.getChat(ACME, legacy.id), null)
  } finally {
    cleanup()
  }
})

test('version is a real stored counter that increments on each update', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(ACME, { title: 'v' })
    assert.equal(c.version, 1)
    const a = await store.updateChat(ACME, c.id, { title: 'v2' })
    assert.equal(a?.version, 2)
    const b = await store.updateChat(ACME, c.id, { title: 'v3' })
    assert.equal(b?.version, 3)
  } finally {
    cleanup()
  }
})

test('metadata and status now round-trip', async () => {
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(ACME, { title: 'meta', metadata: { app: 'x' } })
    assert.equal((await store.getChat(ACME, c.id))?.metadata.app, 'x')

    const m = await store.addMessage(ACME, c.id, { role: 'assistant', content: '', status: 'streaming' })
    assert.equal(m.status, 'streaming')
    const done = await store.updateMessage(ACME, m.id, { content: 'final', status: 'complete' })
    assert.equal(done?.status, 'complete')
  } finally {
    cleanup()
  }
})

test('updateChat can actually change a chat\'s metadata', async () => {
  // Review finding: updateChat's SET clause wired title/systemPrompt/model/sampling
  // but not metadata, so a metadata-only patch looked successful (a Chat came back)
  // while silently never touching the row. This pins that metadata patches land.
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(ACME, { title: 'meta patch', metadata: { app: 'a' } })
    assert.equal((await store.getChat(ACME, c.id))?.metadata.app, 'a')

    const updated = await store.updateChat(ACME, c.id, { metadata: { app: 'b' } })
    assert.equal(updated?.metadata.app, 'b')
    assert.equal((await store.getChat(ACME, c.id))?.metadata.app, 'b')
  } finally {
    cleanup()
  }
})

test('a stale ifVersion on updateMessage is rejected after a real version bump', async () => {
  // Regression check for the Phase 1 lost-update bug: Message.version used to be derived
  // from the immutable created_at column, so it never changed across updates and a stale
  // ifVersion was silently accepted. With a real version column bumped on every write,
  // the second call here must see a version that has already moved past what it holds.
  const { store, cleanup } = makeStore()
  try {
    const c = await store.createChat(ACME, { title: 'race' })
    const m = await store.addMessage(ACME, c.id, { role: 'user', content: 'v1' })
    const staleVersion = m.version

    const first = await store.updateMessage(ACME, m.id, { content: 'v2' }, staleVersion)
    assert.equal(first?.content, 'v2')
    assert.notEqual(first?.version, staleVersion)

    await assert.rejects(
      () => store.updateMessage(ACME, m.id, { content: 'v3' }, staleVersion),
      /version_conflict/,
    )
    assert.equal((await store.getMessage(ACME, m.id))?.content, 'v2')
  } finally {
    cleanup()
  }
})
