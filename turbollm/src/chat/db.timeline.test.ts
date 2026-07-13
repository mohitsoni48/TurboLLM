// Unit tests for db.ts's `timeline` column (v31 migration) — the real data-model change behind
// Code item 6 (2026-07-13): a message's ordered text/tool-call interleave, persisted so a
// completed turn can render in TRUE chronological order instead of the old fixed
// "reasoning → all tool calls grouped → final text" layout.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore, type MessageTimelineBlock } from './db'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeStore(): ConversationStore {
  return new ConversationStore(tmp('tllm-timeline-'))
}

test('timeline: absent by default on a freshly added message (no backfill)', () => {
  const store = makeStore()
  const conv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  const msg = store.addMessage(conv.id, 'assistant', '')
  assert.equal(msg.timeline, undefined)
})

test('timeline: round-trips a real text/tool/text interleave through updateMessage + getMessage', () => {
  const store = makeStore()
  const conv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  const msg = store.addMessage(conv.id, 'assistant', '')

  const timeline: MessageTimelineBlock[] = [
    { type: 'text', text: 'Reading the file first.' },
    { type: 'tool', id: 'call-1' },
    { type: 'text', text: 'Now applying the fix.' },
    { type: 'tool', id: 'call-2' },
    { type: 'tool', id: 'call-3' },
    { type: 'text', text: 'Done.' },
  ]
  const ok = store.updateMessage(msg.id, {
    content: 'Reading the file first.Now applying the fix.Done.',
    toolCalls: [
      { id: 'call-1', name: 'read', args: { path: 'a.ts' }, result: 'ok' },
      { id: 'call-2', name: 'edit', args: { path: 'a.ts' }, result: 'ok' },
      { id: 'call-3', name: 'bash', args: { command: 'npm test' }, result: 'ok' },
    ],
    timeline,
  })
  assert.ok(ok)

  const reloaded = store.getMessage(msg.id)!
  assert.deepEqual(reloaded.timeline, timeline)
  // A tool call AFTER a text block (call-2/call-3 after "Now applying the fix.") must stay
  // distinct from an EARLIER tool block (call-1) once round-tripped — the exact founder-reported
  // regression this fix targets: two separate runs, not one merged run of all three calls.
  const toolBlocks = reloaded.timeline!.filter((b) => b.type === 'tool')
  assert.deepEqual(toolBlocks.map((b) => (b as { type: 'tool'; id: string }).id), ['call-1', 'call-2', 'call-3'])
  assert.equal(reloaded.timeline!.indexOf(reloaded.timeline!.find((b) => b.type === 'tool' && b.id === 'call-2')!) >
    reloaded.timeline!.findIndex((b) => b.type === 'text' && b.text === 'Now applying the fix.'), true)
})

test('timeline: an existing message with no timeline (pre-migration row) stays undefined after an unrelated update', () => {
  const store = makeStore()
  const conv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  const msg = store.addMessage(conv.id, 'assistant', '')
  store.updateMessage(msg.id, { content: 'plain reply', stats: { ctxUsed: 10, ctxMax: 100 } })
  const reloaded = store.getMessage(msg.id)!
  assert.equal(reloaded.content, 'plain reply')
  assert.equal(reloaded.timeline, undefined)
})
