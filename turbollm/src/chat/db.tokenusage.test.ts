// Regression tests for tokenUsageStats' Overview totals including API/gateway usage
// (founder-directed, 2026-07-22): the headline "Total tokens" / "Lifetime tokens" / milestone
// ladder must reflect ALL usage, not just in-app chat — a heavy Claude Code / extension user was
// seeing a total that silently excluded most of their real usage, with the API figures only
// visible on a separate tab. sessions/messages/streak/peak-hour/favorite-model stay chat-only:
// those are chat-conversation-shaped concepts a gateway request doesn't participate in.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConversationStore } from './db'

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `turbollm-tokenusage-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('tokenUsageStats: Total tokens and Lifetime tokens are chat + API combined', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation()
    db.addMessage(conv.id, 'assistant', 'hi', { stats: { promptTokens: 100, genTokens: 50 } })
    db.recordApiUsage({ source: 'anthropic', modelKey: 'm1', promptTokens: 300, genTokens: 200 })

    const stats = db.tokenUsageStats('all')
    assert.equal(stats.totalTokens, 650, 'chat 150 + api 500')
    assert.equal(stats.lifetimeTotalTokens, 650)
    // The isolated API breakdown is still exposed separately, unchanged.
    assert.equal(stats.api.totalTokens, 500)
    assert.equal(stats.api.requests, 1)
  } finally {
    db.close() // node:sqlite keeps the file handle open — Windows can't rmSync while it's held
    rmSync(root, { recursive: true, force: true })
  }
})

test('tokenUsageStats: milestone reflects the COMBINED total, crossing a threshold chat alone would not', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation()
    // Chat alone (700) stays under the 1,000 milestone; API (400) pushes the combined total over it.
    db.addMessage(conv.id, 'assistant', 'hi', { stats: { promptTokens: 500, genTokens: 200 } })
    db.recordApiUsage({ source: 'openai', modelKey: 'm1', promptTokens: 300, genTokens: 100 })

    const stats = db.tokenUsageStats('all')
    assert.equal(stats.lifetimeTotalTokens, 1100)
    assert.equal(stats.milestone.achieved, 1_000, 'should have crossed 1,000 only once API is included')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('tokenUsageStats: zero in-app chat but real API traffic still gets a real milestone (not stuck at null)', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    db.recordApiUsage({ source: 'anthropic', modelKey: 'm1', promptTokens: 800, genTokens: 300 })

    const stats = db.tokenUsageStats('all')
    assert.equal(stats.firstMessageAt, null, 'no chat history')
    assert.equal(stats.totalTokens, 1100)
    assert.equal(stats.lifetimeTotalTokens, 1100)
    assert.equal(stats.milestone.achieved, 1_000)
    assert.equal(stats.sessions, 0, 'chat-only concept — a gateway request is not a session')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('tokenUsageStats: no chat and no API traffic stays fully empty', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const stats = db.tokenUsageStats('all')
    assert.equal(stats.firstMessageAt, null)
    assert.equal(stats.totalTokens, 0)
    assert.equal(stats.lifetimeTotalTokens, 0)
    assert.equal(stats.milestone.achieved, null)
    assert.equal(stats.api.requests, 0)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
