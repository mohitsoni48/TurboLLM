// UsageStatsQueries over a handle it shares with the ConversationStore that owns the schema.
// The behaviors themselves are pinned through the store (db.tokenusage, db.daily-rollups,
// db.code-stats, db.apiusage-session, retention tests); these check the class on its own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { UsageStatsQueries } from './usage-stats'

function withUsage(fn: (usage: UsageStatsQueries, store: ConversationStore) => void): void {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  try { fn(new UsageStatsQueries(store.handle), store) } finally { store.close() }
}

test('gateway requests recorded on the class are what the store reads back, through the same handle', () => {
  withUsage((usage, store) => {
    usage.recordApiUsage({ source: 'anthropic', modelKey: 'm', promptTokens: 10, genTokens: 5 })
    assert.equal(store.apiUsageStats('all').totalTokens, 15)
    assert.equal(usage.apiUsageStats('all').totalTokens, 15)
  })
})

test('a Code session reports the peak context it ever sent, and a ctx update lowers the gauge', () => {
  withUsage((usage) => {
    usage.recordApiUsage({ source: 'openai', modelKey: 'm', promptTokens: 900, genTokens: 1, codeSessionId: 's1' })
    usage.recordApiUsage({ source: 'openai', modelKey: 'm', promptTokens: 40, genTokens: 1, codeSessionId: 's1' })
    assert.equal(usage.getLastApiUsageForSession('s1')?.ctxUsed, 900)
    usage.setCodeSessionCtxUsed('s1', 123)
    assert.equal(usage.getLastApiUsageForSession('s1')?.ctxUsed, 123)
    assert.equal(usage.getLastApiUsageForSession('none'), null)
  })
})

test('an empty database reads as zeros, never an error', () => {
  withUsage((usage) => {
    const stats = usage.tokenUsageStats('7d')
    assert.equal(stats.messages, 0)
    assert.equal(stats.totalTokens, 0)
    assert.equal(usage.codeStats('all').sessions, 0)
    assert.deepEqual(usage.codeDailyStats('2026-01-01'), { sessions: 0, turns: 0, toolCalls: 0 })
  })
})

test('rolling up old gateway rows keeps the totals the dashboard reports', () => {
  withUsage((usage) => {
    usage.recordApiUsage({ source: 'anthropic', modelKey: 'm', promptTokens: 7, genTokens: 3 })
    const before = usage.apiUsageStats('all').totalTokens
    const { rolledUp } = usage.rollUpApiUsageBatch(new Date(Date.now() + 60_000).toISOString(), 100)
    assert.equal(rolledUp, 1)
    assert.equal(usage.apiUsageStats('all').totalTokens, before)
  })
})
