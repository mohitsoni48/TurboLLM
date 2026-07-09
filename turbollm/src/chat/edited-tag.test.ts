// "Edited" tag on assistant replies — set only by an explicit in-place edit
// (PUT /messages/:msgId's assistant-role path in chat-routes.ts), never by the normal
// generation-completion save.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from './db.js'

function tempStore(): { store: ConversationStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-edited-'))
  return { store: new ConversationStore(dir), dir }
}

test('a fresh message defaults to edited: false', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const msg = store.addMessage(conv.id, 'assistant', 'hello')
    assert.equal(msg.edited, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateMessage with edited: true persists and survives a re-read', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const msg = store.addMessage(conv.id, 'assistant', 'hello')
    store.updateMessage(msg.id, { content: 'hello, fixed', edited: true })
    const reread = store.getMessage(msg.id)!
    assert.equal(reread.edited, true)
    assert.equal(reread.content, 'hello, fixed')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a normal generation-completion-style updateMessage call (no edited field) leaves edited false', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const msg = store.addMessage(conv.id, 'assistant', '')
    // Mirrors the real call shape in chat-routes.ts/generation.ts: content/reasoning/
    // toolCalls/stats, but never `edited` — that field is exclusive to the edit route.
    store.updateMessage(msg.id, { content: 'final answer', reasoning: 'thinking...', stats: { tps: 42 } })
    assert.equal(store.getMessage(msg.id)!.edited, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setting edited: true does not disturb other fields left unset', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const msg = store.addMessage(conv.id, 'assistant', 'original', { reasoning: 'original thinking' })
    store.updateMessage(msg.id, { content: 'edited text', edited: true })
    const reread = store.getMessage(msg.id)!
    assert.equal(reread.reasoning, 'original thinking', 'unrelated fields must be untouched by the edit')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
