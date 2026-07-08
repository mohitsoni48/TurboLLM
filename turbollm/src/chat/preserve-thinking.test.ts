// Per-conversation "preserve thinking across turns" toggle (GitHub #52 item 1).
// Covers the db-layer round trip; the actual chat_template_kwargs merge and
// content-folding logic live in chat-routes.ts and are exercised via live
// verification (no HTTP harness in this test suite).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from './db.js'

function tempStore(): { store: ConversationStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-preserve-thinking-'))
  return { store: new ConversationStore(dir), dir }
}

test('a fresh conversation defaults to preserveThinking: false', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    assert.equal(conv.preserveThinking, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateConversation persists preserveThinking: true and it survives a re-read', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const ok = store.updateConversation(conv.id, { preserveThinking: true })
    assert.equal(ok, true)
    assert.equal(store.getConversation(conv.id)!.preserveThinking, true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateConversation can turn preserveThinking back off', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    store.updateConversation(conv.id, { preserveThinking: true })
    store.updateConversation(conv.id, { preserveThinking: false })
    assert.equal(store.getConversation(conv.id)!.preserveThinking, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateConversation omitting preserveThinking leaves the existing value untouched', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    store.updateConversation(conv.id, { preserveThinking: true })
    store.updateConversation(conv.id, { title: 'renamed, unrelated field' })
    assert.equal(store.getConversation(conv.id)!.preserveThinking, true, 'an unrelated PATCH must not silently reset the toggle')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
