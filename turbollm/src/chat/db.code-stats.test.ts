// Unit tests for db.ts's codeStats() — the Code launchpad's real "Coding activity" numbers,
// replacing code-mock.ts's always-fake CODE_STATS. Deliberately doesn't test the lifetime-streak
// math (tokenUsageStats, the pattern this mirrors, has no dedicated test coverage either — both
// would need backdated created_at timestamps ConversationStore has no public way to set) — this
// focuses on the aggregation correctness that doesn't need date control: counts, kind filtering,
// and the real diff-line math now that ADR-199 persists tool-call diffs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from './db'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeStore(): ConversationStore {
  return new ConversationStore(tmp('tllm-codestats-'))
}

test('codeStats: no code runs at all → all zeros, empty heatmap', () => {
  const store = makeStore()
  const stats = store.codeStats('all')
  assert.deepEqual(stats, {
    range: 'all', sessions: 0, tasksShipped: 0, filesTouched: 0, diffAdded: 0, diffRemoved: 0,
    activeDays: 0, currentStreak: 0, longestStreak: 0, favoriteModel: null, heatmap: [],
  })
})

test('codeStats: counts a code session, ignores chat/agent conversations entirely', () => {
  const store = makeStore()
  const codeConv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  store.createAgentRun({ convId: codeConv.id, title: 'code task', allowedTools: [], repoRoot: '/repo' })

  const chatConv = store.createConversation({ kind: 'chat', modelKey: 'model-a' })
  store.addMessage(chatConv.id, 'user', 'hello')

  const agentConv = store.createConversation({ kind: 'agent', modelKey: 'model-a' })
  store.createAgentRun({ convId: agentConv.id, title: 'agent task', allowedTools: [] })

  const stats = store.codeStats('all')
  assert.equal(stats.sessions, 1, 'only the code-kind run counts')
})

test('codeStats: tasksShipped only counts status=done runs', () => {
  const store = makeStore()
  const conv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  const r1 = store.createAgentRun({ convId: conv.id, title: 't1', allowedTools: [], repoRoot: '/repo' })
  const r2 = store.createAgentRun({ convId: conv.id, title: 't2', allowedTools: [], repoRoot: '/repo' })
  const r3 = store.createAgentRun({ convId: conv.id, title: 't3', allowedTools: [], repoRoot: '/repo' })
  store.updateAgentRun(r1.id, { status: 'done' })
  store.updateAgentRun(r2.id, { status: 'interrupted' })
  store.updateAgentRun(r3.id, { status: 'failed' })

  const stats = store.codeStats('all')
  assert.equal(stats.sessions, 3)
  assert.equal(stats.tasksShipped, 1)
})

test('codeStats: filesTouched counts DISTINCT paths from edit/write calls, ignores read/bash/grep', () => {
  const store = makeStore()
  const conv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/repo' })
  store.addMessage(conv.id, 'assistant', 'did stuff', {
    toolCalls: [
      { id: '1', name: 'edit', args: { path: 'src/a.ts' }, result: 'ok', diff: 'Index: src/a.ts\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' },
      { id: '2', name: 'write', args: { path: 'src/b.ts' }, result: 'ok' },
      { id: '3', name: 'edit', args: { path: 'src/a.ts' }, result: 'ok', diff: 'Index: src/a.ts\n--- a\n+++ b\n@@ -1 +1 @@\n-new\n+newer' },
      { id: '4', name: 'read', args: { path: 'src/c.ts' }, result: 'contents' },
      { id: '5', name: 'bash', args: { command: 'ls' }, result: '' },
    ],
  })

  const stats = store.codeStats('all')
  assert.equal(stats.filesTouched, 2, 'src/a.ts (edited twice, counted once) + src/b.ts — read/bash never count')
})

test('codeStats: diffAdded/diffRemoved sum real +/- lines from every edit call\'s stored patch', () => {
  const store = makeStore()
  const conv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/repo' })
  store.addMessage(conv.id, 'assistant', 'did stuff', {
    toolCalls: [
      // +2/-1
      { id: '1', name: 'edit', args: { path: 'a.ts' }, result: 'ok', diff: 'Index: a.ts\n--- a\n+++ b\n@@ -1,1 +1,2 @@\n-old\n+new1\n+new2' },
      // +1/-0 — a write call is NOT counted even though it happens to carry a diff-shaped field (writes create whole files, no natural single reverse/diff semantics for this aggregation)
      { id: '2', name: 'write', args: { path: 'b.ts' }, result: 'ok', diff: '+++ b\n+ignored' },
      // +0/-3
      { id: '3', name: 'edit', args: { path: 'c.ts' }, result: 'ok', diff: 'Index: c.ts\n--- a\n+++ b\n@@ -1,3 +0,0 @@\n-l1\n-l2\n-l3' },
    ],
  })

  const stats = store.codeStats('all')
  assert.equal(stats.diffAdded, 2)
  assert.equal(stats.diffRemoved, 4)
})

test('codeStats: favoriteModel is the model_key used by the most code runs, title-cased', () => {
  const store = makeStore()
  const convA = store.createConversation({ kind: 'code', modelKey: 'qwen3-coder-30b|Q4|123' })
  store.createAgentRun({ convId: convA.id, title: 't1', allowedTools: [], repoRoot: '/repo' })
  store.createAgentRun({ convId: convA.id, title: 't2', allowedTools: [], repoRoot: '/repo' })
  const convB = store.createConversation({ kind: 'code', modelKey: 'gemma-4-e4b|Q6|456' })
  store.createAgentRun({ convId: convB.id, title: 't3', allowedTools: [], repoRoot: '/repo' })

  const stats = store.codeStats('all')
  assert.equal(stats.favoriteModel, 'Qwen3-Coder-30b')
})

test('codeStats: today\'s run counts toward a same-day heatmap cell and activeDays', () => {
  const store = makeStore()
  const conv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/repo' })

  const stats = store.codeStats('all')
  assert.equal(stats.activeDays, 1)
  const todayCell = stats.heatmap.at(-1)
  assert.ok(todayCell, 'heatmap has at least one cell')
  assert.equal(todayCell!.sessions, 1)
  assert.equal(stats.currentStreak, 1)
  assert.equal(stats.longestStreak, 1)
})
