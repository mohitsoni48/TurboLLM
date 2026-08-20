// Two code paths, one set of tables (Phase 1 amendment 1): the sync ConversationStore
// serves the web UI, the async SqliteChatStore serves the public API. They MUST agree
// about the same rows. If these fail, the two paths have diverged and one of them is
// now lying to its callers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'
import { LOCAL_SCOPE } from './chat-store.js'

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-xconsist-'))
  const conv = new ConversationStore(dir)
  return { conv, store: conv.chatStore, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('a message appended via ChatStore is visible to ConversationStore in order', async () => {
  const { conv, store, cleanup } = make()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Shared' })
    await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'first' })
    await store.addMessage(LOCAL_SCOPE, c.id, { role: 'assistant', content: 'second' })

    const legacy = conv.getMessages(c.id)
    assert.deepEqual(legacy.map((m) => m.content), ['first', 'second'])
    assert.deepEqual(legacy.map((m) => m.seq), [1, 2])
  } finally {
    cleanup()
  }
})

test('a message appended via ConversationStore is visible to ChatStore in order', async () => {
  const { conv, store, cleanup } = make()
  try {
    const legacy = conv.createConversation({ title: 'Legacy' })
    conv.addMessage(legacy.id, 'user', 'alpha')
    conv.addMessage(legacy.id, 'assistant', 'beta')

    const page = await store.listMessages(LOCAL_SCOPE, legacy.id, {})
    assert.deepEqual(page.data.map((m) => m.content), ['alpha', 'beta'])
    assert.deepEqual(page.data.map((m) => m.seq), [1, 2])
  } finally {
    cleanup()
  }
})

test('seq allocation stays gapless when both paths append to one chat', async () => {
  const { conv, store, cleanup } = make()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Interleaved' })
    await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'a' })
    conv.addMessage(c.id, 'assistant', 'b')
    await store.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'c' })
    conv.addMessage(c.id, 'assistant', 'd')

    assert.deepEqual(conv.getMessages(c.id).map((m) => m.seq), [1, 2, 3, 4])
  } finally {
    cleanup()
  }
})

test('regenerated-away siblings are hidden from ChatStore, matching the UI', async () => {
  const { conv, store, cleanup } = make()
  try {
    const c = await store.createChat(LOCAL_SCOPE, { title: 'Branched' })
    conv.addMessage(c.id, 'user', 'question')
    const first = conv.addMessage(c.id, 'assistant', 'answer one')
    conv.deactivateMessage(first.id)
    conv.addMessage(c.id, 'assistant', 'answer two')

    const page = await store.listMessages(LOCAL_SCOPE, c.id, {})
    const contents = page.data.map((m) => m.content)
    assert.ok(!contents.includes('answer one'), 'inactive variant must not surface')
    assert.ok(contents.includes('answer two'))
  } finally {
    cleanup()
  }
})

test('deleting a chat via ChatStore is invisible to ConversationStore afterwards', async () => {
  const { conv, store, cleanup } = make()
  try {
    const legacy = conv.createConversation({ title: 'Gone' })
    conv.addMessage(legacy.id, 'user', 'x')
    await store.deleteChat(LOCAL_SCOPE, legacy.id)
    assert.equal(conv.getConversation(legacy.id), null)
    assert.equal(conv.getMessages(legacy.id).length, 0)
  } finally {
    cleanup()
  }
})
