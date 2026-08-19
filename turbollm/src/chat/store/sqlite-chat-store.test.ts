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
    assert.equal(c.version, 1)
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
