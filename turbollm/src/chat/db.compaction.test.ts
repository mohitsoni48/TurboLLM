// Coverage for the three compaction columns added to `conversations` (ADR-420): the
// migration itself, and the two dedicated accessors (setConversationCompaction /
// clearConversationCompaction) — deliberately NOT folded into updateConversation's
// Pick-patch pattern, because that pattern can't null a column back out (its
// `!== undefined` guards treat `undefined` as "leave alone", and the Conversation type's
// compaction fields are `string | undefined`, never `| null`).
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConversationStore } from './db'

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `turbollm-compaction-db-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('a fresh conversation has no compaction fields set', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test' })
    assert.equal(conv.compactionSummary, undefined)
    assert.equal(conv.compactionUpToMessageId, undefined)
    assert.equal(conv.compactionTokensBefore, undefined)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('setConversationCompaction persists all three fields and getConversation reads them back', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test' })
    const msg = db.addMessage(conv.id, 'user', 'hello')
    const ok = db.setConversationCompaction(conv.id, { summary: 'The user said hello.', upToMessageId: msg.id, tokensBefore: 42 })
    assert.equal(ok, true)
    const updated = db.getConversation(conv.id)!
    assert.equal(updated.compactionSummary, 'The user said hello.')
    assert.equal(updated.compactionUpToMessageId, msg.id)
    assert.equal(updated.compactionTokensBefore, 42)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('setConversationCompaction returns false for a nonexistent conversation', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const ok = db.setConversationCompaction('does-not-exist', { summary: 'x', upToMessageId: 'y', tokensBefore: 1 })
    assert.equal(ok, false)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('clearConversationCompaction nulls all three fields back out (undo)', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test' })
    const msg = db.addMessage(conv.id, 'user', 'hello')
    db.setConversationCompaction(conv.id, { summary: 'summary', upToMessageId: msg.id, tokensBefore: 10 })
    const ok = db.clearConversationCompaction(conv.id)
    assert.equal(ok, true)
    const updated = db.getConversation(conv.id)!
    assert.equal(updated.compactionSummary, undefined)
    assert.equal(updated.compactionUpToMessageId, undefined)
    assert.equal(updated.compactionTokensBefore, undefined)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a conversation created on an already-migrated (older) DB file still gets the new columns', () => {
  // Regression guard for the hasColumn-guarded migration style this codebase uses
  // (db.ts's own doc comment on hasColumn explains why): opening the SAME data dir twice
  // must not throw "duplicate column" on the second open.
  const root = makeTmpRoot()
  const db1 = new ConversationStore(root)
  const conv = db1.createConversation({ title: 'Test' })
  db1.close()
  const db2 = new ConversationStore(root) // re-opens the same turbollm.db, re-runs migrate()
  try {
    const ok = db2.setConversationCompaction(conv.id, { summary: 's', upToMessageId: 'm', tokensBefore: 1 })
    assert.equal(ok, true)
  } finally {
    db2.close()
    rmSync(root, { recursive: true, force: true })
  }
})
