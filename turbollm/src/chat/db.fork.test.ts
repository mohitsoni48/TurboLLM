// ConversationStore.forkConversation (GitHub #323): a new conversation with the source's settings and a copy of its
// shown history up to a message, leaving the source untouched.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { ConversationStore } from './db'
import { tmpDir } from '../test-support/tmp'

function withStore(fn: (db: ConversationStore) => void): void {
  const root = tmpDir('turbollm-fork-db-test-')
  const db = new ConversationStore(root)
  try {
    fn(db)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('a fork copies the history up to and including the message, with new ids, and leaves the source alone', () => {
  withStore((db) => {
    const src = db.createConversation({ title: 'Plan', systemPrompt: 'Be brief.', modelKey: 'm|Q4|1', sampling: { temp: 0.2 }, skillIds: ['web'], allowedTools: ['web_search'], preserveThinking: false })
    db.setToolOverride(src.id, 'run_code', 'allow')
    const u1 = db.addMessage(src.id, 'user', 'first', { attachments: ['attachment:abc'] })
    const a1 = db.addMessage(src.id, 'assistant', 'one', { reasoning: 'thinking', toolCalls: [{ id: 't1', name: 'run_code', args: { code: '1' }, result: '1' }] })
    db.addMessage(src.id, 'user', 'second')
    db.addMessage(src.id, 'assistant', 'two')

    const r = db.forkConversation(src.id, a1.id)
    assert.equal(r.ok, true)
    if (!r.ok) return
    const fork = db.getConversation(r.conversation.id, true)!
    assert.notEqual(fork.id, src.id)
    assert.equal(fork.title, 'Plan (fork)')
    assert.equal(fork.systemPrompt, 'Be brief.')
    assert.equal(fork.modelKey, 'm|Q4|1')
    assert.deepEqual(fork.sampling, { temp: 0.2 })
    assert.deepEqual(fork.skillIds, ['web'])
    assert.deepEqual(fork.allowedTools, ['web_search'])
    assert.equal(fork.preserveThinking, false)
    assert.deepEqual(fork.toolOverrides, { run_code: 'allow' })
    assert.equal(fork.kind, 'chat')

    const msgs = fork.messages!
    assert.deepEqual(msgs.map((m) => [m.seq, m.role, m.content]), [[1, 'user', 'first'], [2, 'assistant', 'one']])
    assert.ok(msgs.every((m) => m.convId === fork.id && m.id !== u1.id && m.id !== a1.id))
    assert.deepEqual(msgs[0].attachments, ['attachment:abc'], 'attachment references are shared, not copied')
    assert.equal(msgs[1].reasoning, 'thinking')
    assert.equal(msgs[1].toolCalls?.[0]?.name, 'run_code')

    assert.equal(db.getMessages(src.id).length, 4, 'the source keeps every message')
    assert.equal(db.getConversation(src.id)!.title, 'Plan')
  })
})

test('a fork takes only the shown branch, not a hidden variant', () => {
  withStore((db) => {
    const src = db.createConversation()
    db.addMessage(src.id, 'user', 'q')
    const old = db.addMessage(src.id, 'assistant', 'old answer', { variantGroup: 'g1' })
    db.deactivateMessage(old.id)
    const shown = db.addMessage(src.id, 'assistant', 'new answer', { variantGroup: 'g1' })

    const r = db.forkConversation(src.id, shown.id)
    assert.equal(r.ok, true)
    if (!r.ok) return
    const msgs = db.getMessages(r.conversation.id)
    assert.deepEqual(msgs.map((m) => m.content), ['q', 'new answer'])
    assert.equal(msgs[1].variantGroup ?? null, null, 'the fork has no variants to switch between')
  })
})

test('a fork keeps the compaction summary only when its cut is among the copied messages', () => {
  withStore((db) => {
    const src = db.createConversation()
    const u1 = db.addMessage(src.id, 'user', 'a')
    const a1 = db.addMessage(src.id, 'assistant', 'b')
    const u2 = db.addMessage(src.id, 'user', 'c')
    db.setConversationCompaction(src.id, { summary: 'Earlier: a and b.', upToMessageId: a1.id, tokensBefore: 99 })

    const after = db.forkConversation(src.id, u2.id)
    assert.equal(after.ok, true)
    if (!after.ok) return
    const kept = db.getConversation(after.conversation.id, true)!
    assert.equal(kept.compactionSummary, 'Earlier: a and b.')
    assert.equal(kept.compactionTokensBefore, 99)
    assert.equal(kept.compactionUpToMessageId, kept.messages![1].id, 'the cut points at the copy, not the source message')

    const before = db.forkConversation(src.id, u1.id)
    assert.equal(before.ok, true)
    if (!before.ok) return
    assert.equal(db.getConversation(before.conversation.id)!.compactionSummary, undefined)
  })
})

// The fork's files are not the files a copied edit was made against, so revert-with-files in the fork must never
// reverse-apply a copied patch. The diff stays for display.
test('copied tool calls lose their edit patch and keep their diff', () => {
  withStore((db) => {
    const src = db.createConversation({ kind: 'code' })
    db.addMessage(src.id, 'user', 'edit it')
    const a = db.addMessage(src.id, 'assistant', 'edited', {
      toolCalls: [
        { id: 'e1', name: 'edit', args: { path: 'a.ts' }, result: 'ok', diff: '-a\n+b', patch: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b\n' },
        { id: 'r1', name: 'read', args: { path: 'a.ts' }, result: 'b' },
      ],
    })
    const r = db.forkConversation(src.id, a.id)
    assert.equal(r.ok, true)
    if (!r.ok) return
    const [edit, read] = db.getMessages(r.conversation.id)[1].toolCalls!
    assert.equal(edit.patch, undefined)
    assert.equal(edit.diff, '-a\n+b')
    assert.equal(edit.result, 'ok')
    assert.deepEqual(read, { id: 'r1', name: 'read', args: { path: 'a.ts' }, result: 'b' })
    assert.ok(db.getMessages(src.id)[1].toolCalls![0].patch, 'the source keeps its patch')
  })
})

test('a fork of a fork is "<title> (fork)", and the copied ids are handed back', () => {
  withStore((db) => {
    const src = db.createConversation({ title: 'Ideas' })
    const u = db.addMessage(src.id, 'user', 'q')
    const first = db.forkConversation(src.id, u.id)
    assert.equal(first.ok, true)
    if (!first.ok) return
    const copy = db.getMessages(first.conversation.id)[0]
    assert.deepEqual([...first.copiedIds], [[u.id, copy.id]])
    const second = db.forkConversation(first.conversation.id, copy.id)
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.conversation.title, 'Ideas (fork)')
  })
})

test('deleting the source leaves the fork whole', () => {
  withStore((db) => {
    const src = db.createConversation()
    const u = db.addMessage(src.id, 'user', 'keep me')
    const r = db.forkConversation(src.id, u.id)
    assert.equal(r.ok, true)
    if (!r.ok) return
    db.deleteConversation(src.id)
    assert.deepEqual(db.getMessages(r.conversation.id).map((m) => m.content), ['keep me'])
  })
})

test('a fork keeps a voice message\'s transcript', () => {
  withStore((db) => {
    const src = db.createConversation()
    const spoken = db.addMessage(src.id, 'user', '', { attachments: ['attachment:clip'] })
    db.setMessageTranscript(spoken.id, 'what is the weather')

    const r = db.forkConversation(src.id, spoken.id)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(db.getMessages(r.conversation.id)[0].transcript, 'what is the weather')
  })
})

test('a fork names what it could not find, and creates nothing', () => {
  withStore((db) => {
    const src = db.createConversation()
    const hidden = db.addMessage(src.id, 'assistant', 'hidden')
    db.deactivateMessage(hidden.id)
    const other = db.createConversation()
    const elsewhere = db.addMessage(other.id, 'user', 'not in src')
    const before = db.listConversations().length

    assert.deepEqual(db.forkConversation('nope', hidden.id), { ok: false, reason: 'conversation_not_found' })
    assert.deepEqual(db.forkConversation(src.id, 'nope'), { ok: false, reason: 'message_not_found' })
    assert.deepEqual(db.forkConversation(src.id, hidden.id), { ok: false, reason: 'message_not_found' }, 'not a hidden message')
    assert.deepEqual(db.forkConversation(src.id, elsewhere.id), { ok: false, reason: 'message_not_found' }, 'not another chat\'s message')
    assert.equal(db.listConversations().length, before)
  })
})
