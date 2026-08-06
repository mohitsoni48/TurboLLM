// Unit tests for the three query-backed daily rollups (spec 23 §3.4-3.6, ADR-333):
// chatDailyStats/gatewayDailyStats/codeDailyStats. All three read TODAY's window
// (created_at defaults to "now" — ConversationStore has no public way to backdate,
// same constraint db.code-stats.test.ts already documents), so these tests exercise
// aggregation correctness for the current calendar day, not day-boundary rollover
// (that's runtime/daily-query-rollups.test.ts's job).
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
  return new ConversationStore(tmp('tllm-dailyrollup-'))
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('chatDailyStats: no messages today → all zeros', () => {
  const store = makeStore()
  assert.deepEqual(store.chatDailyStats(today()), {
    conversations: 0, messages: 0, maxMessagesInConversation: 0, medianMessagesInConversation: 0,
    distinctModels: 0, toolCalls: 0, regenerates: 0, stops: 0,
  })
})

test('chatDailyStats: counts conversations/messages/distinctModels across two conversations', () => {
  const store = makeStore()
  const c1 = store.createConversation({ modelKey: 'model-a' })
  store.addMessage(c1.id, 'user', 'hi')
  store.addMessage(c1.id, 'assistant', 'hello', { stats: { model: 'model-a' } as never })

  const c2 = store.createConversation({ modelKey: 'model-b' })
  store.addMessage(c2.id, 'user', 'hey')

  const stats = store.chatDailyStats(today())
  assert.equal(stats.conversations, 2)
  assert.equal(stats.messages, 3)
  assert.equal(stats.maxMessagesInConversation, 2)
})

test('chatDailyStats: toolCalls sums json_array_length across every message, not just a presence count', () => {
  const store = makeStore()
  const c = store.createConversation({ modelKey: 'model-a' })
  store.addMessage(c.id, 'assistant', 'ok', { toolCalls: [{ name: 'bash' }, { name: 'edit' }] as never })
  store.addMessage(c.id, 'assistant', 'ok2', { toolCalls: [{ name: 'read' }] as never })
  assert.equal(store.chatDailyStats(today()).toolCalls, 3)
})

test('chatDailyStats: stops counts messages whose stats.aborted is true', () => {
  const store = makeStore()
  const c = store.createConversation({ modelKey: 'model-a' })
  store.addMessage(c.id, 'assistant', 'cut off', { stats: { aborted: true } as never })
  store.addMessage(c.id, 'assistant', 'finished fine', { stats: { aborted: false } as never })
  assert.equal(store.chatDailyStats(today()).stops, 1)
})

test('chatDailyStats: medianMessagesInConversation averages the two middle values on an even split', () => {
  const store = makeStore()
  const c1 = store.createConversation({ modelKey: 'model-a' })
  store.addMessage(c1.id, 'user', 'a')
  const c2 = store.createConversation({ modelKey: 'model-a' })
  for (let i = 0; i < 5; i++) store.addMessage(c2.id, 'user', `m${i}`)
  // Message counts per conversation: [1, 5] → median (1+5)/2 = 3.
  assert.equal(store.chatDailyStats(today()).medianMessagesInConversation, 3)
})

test('chatDailyStats: regenerates counts deactivated variant-group siblings, not the active reply', () => {
  const store = makeStore()
  const c = store.createConversation({ modelKey: 'model-a' })
  store.addMessage(c.id, 'user', 'question')
  const original = store.addMessage(c.id, 'assistant', 'first answer', { variantGroup: 'vg-1' })
  // A real regenerate deactivates the superseded reply and inserts a new active one
  // sharing the same variant_group — deactivateMessagesFrom is the same mechanism
  // the real regenerate route uses.
  store.deactivateMessagesFrom(c.id, original.id)
  store.addMessage(c.id, 'assistant', 'second answer', { variantGroup: 'vg-1' })

  const stats = store.chatDailyStats(today())
  assert.equal(stats.regenerates, 1, 'only the deactivated sibling counts, not the still-active reply')
  assert.equal(stats.messages, 2, 'is_active=1 excludes the deactivated original: user question + the active second answer')
})

test('gatewayDailyStats: no api_usage rows today → empty array', () => {
  const store = makeStore()
  assert.deepEqual(store.gatewayDailyStats(today()), [])
})

test('gatewayDailyStats: groups by protocol (source), sums tokens, counts distinct models', () => {
  const store = makeStore()
  store.recordApiUsage({ source: 'anthropic', modelKey: 'model-a', promptTokens: 100, genTokens: 50 })
  store.recordApiUsage({ source: 'anthropic', modelKey: 'model-b', promptTokens: 200, genTokens: 20 })
  store.recordApiUsage({ source: 'openai', modelKey: 'model-a', promptTokens: 10, genTokens: 5 })

  const rows = store.gatewayDailyStats(today())
  const anthropic = rows.find((r) => r.protocol === 'anthropic')
  const openai = rows.find((r) => r.protocol === 'openai')
  assert.equal(anthropic?.requests, 2)
  assert.equal(anthropic?.promptTokens, 300)
  assert.equal(anthropic?.genTokens, 70)
  assert.equal(anthropic?.distinctModels, 2)
  assert.equal(openai?.requests, 1)
})

test('gatewayDailyStats: rows with no harness column value group as unknown, not their own row per request', () => {
  const store = makeStore()
  store.recordApiUsage({ source: 'anthropic', modelKey: 'model-a', promptTokens: 100, genTokens: 50 })
  store.recordApiUsage({ source: 'anthropic', modelKey: 'model-a', promptTokens: 100, genTokens: 50 })

  const rows = store.gatewayDailyStats(today())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].harness, 'unknown')
  assert.equal(rows[0].requests, 2)
})

test('gatewayDailyStats: groups by (protocol, harness) — spec 23 §3.5, telemetry Phase 5', () => {
  const store = makeStore()
  store.recordApiUsage({ source: 'anthropic', modelKey: 'model-a', promptTokens: 100, genTokens: 50, harness: 'claude_code' })
  store.recordApiUsage({ source: 'anthropic', modelKey: 'model-b', promptTokens: 200, genTokens: 20, harness: 'claude_code' })
  store.recordApiUsage({ source: 'openai', modelKey: 'model-a', promptTokens: 10, genTokens: 5, harness: 'opencode' })
  store.recordApiUsage({ source: 'openai', modelKey: 'model-a', promptTokens: 30, genTokens: 15, harness: 'cline' })

  const rows = store.gatewayDailyStats(today())
  assert.equal(rows.length, 3, 'claude_code/anthropic, opencode/openai, and cline/openai are three distinct groups')

  const claude = rows.find((r) => r.harness === 'claude_code')
  assert.equal(claude?.protocol, 'anthropic')
  assert.equal(claude?.requests, 2)
  assert.equal(claude?.promptTokens, 300)
  assert.equal(claude?.distinctModels, 2)

  const opencode = rows.find((r) => r.harness === 'opencode')
  assert.equal(opencode?.requests, 1)
  assert.equal(opencode?.promptTokens, 10)

  const cline = rows.find((r) => r.harness === 'cline')
  assert.equal(cline?.requests, 1)
  assert.equal(cline?.promptTokens, 30)
})

test('codeDailyStats: no code sessions today → all zeros', () => {
  const store = makeStore()
  assert.deepEqual(store.codeDailyStats(today()), { sessions: 0, turns: 0, toolCalls: 0 })
})

test('codeDailyStats: counts a code session and its assistant turns, ignoring chat/agent conversations', () => {
  const store = makeStore()
  const codeConv = store.createConversation({ kind: 'code', modelKey: 'model-a' })
  store.createAgentRun({ convId: codeConv.id, title: 'task', allowedTools: [], repoRoot: '/repo' })
  store.addMessage(codeConv.id, 'user', 'do the thing')
  store.addMessage(codeConv.id, 'assistant', 'done', { toolCalls: [{ name: 'bash' }] as never })

  const chatConv = store.createConversation({ kind: 'chat', modelKey: 'model-a' })
  store.addMessage(chatConv.id, 'assistant', 'hi', { toolCalls: [{ name: 'bash' }] as never })

  const stats = store.codeDailyStats(today())
  assert.equal(stats.sessions, 1, 'only the code-kind run counts')
  assert.equal(stats.turns, 1, 'only the code conversation\'s assistant message counts as a turn')
  assert.equal(stats.toolCalls, 1, 'the chat conversation\'s tool call must not leak into code_daily')
})
