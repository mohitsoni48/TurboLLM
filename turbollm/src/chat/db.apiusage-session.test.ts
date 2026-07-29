// Regression coverage for ADR-284's api_usage session attribution (v36 migration):
// code_session_id/duration_ms let TerminalToolbar.tsx show real token/tps stats for a
// terminal-agent session's most recent gateway request, the same way lastRealStats already
// does for a 'turbollm' chat session's last turn.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConversationStore } from './db'

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `turbollm-apiusage-session-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('getLastApiUsageForSession: null for a session with no recorded usage yet', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    assert.equal(db.getLastApiUsageForSession('never-recorded'), null)
  } finally {
    db.close() // node:sqlite keeps the file handle open — Windows can't rmSync while it's held
    rmSync(root, { recursive: true, force: true })
  }
})

test('getLastApiUsageForSession: returns tokens + computed tps from prompt/gen tokens and duration', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    db.recordApiUsage({
      source: 'anthropic', modelKey: 'm1', promptTokens: 1000, genTokens: 200,
      codeSessionId: 'sess-1', durationMs: 2000, // 2s → 500 prompt tok/s, 100 gen tok/s
    })
    const usage = db.getLastApiUsageForSession('sess-1')
    assert.ok(usage)
    assert.equal(usage!.promptTokens, 1000)
    assert.equal(usage!.genTokens, 200)
    assert.equal(usage!.promptTps, 500)
    assert.equal(usage!.genTps, 100)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('getLastApiUsageForSession: null tps when no duration was recorded (e.g. Anthropic streaming path callers that predate timing)', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    db.recordApiUsage({ source: 'anthropic', modelKey: 'm1', promptTokens: 50, genTokens: 10, codeSessionId: 'sess-2' })
    const usage = db.getLastApiUsageForSession('sess-2')
    assert.ok(usage)
    assert.equal(usage!.promptTps, null)
    assert.equal(usage!.genTps, null)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('getLastApiUsageForSession: only ever returns the MOST RECENT row for that session', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    db.recordApiUsage({ source: 'anthropic', modelKey: 'm1', promptTokens: 100, genTokens: 10, codeSessionId: 'sess-3', durationMs: 1000 })
    db.recordApiUsage({ source: 'anthropic', modelKey: 'm1', promptTokens: 200, genTokens: 20, codeSessionId: 'sess-3', durationMs: 1000 })
    const usage = db.getLastApiUsageForSession('sess-3')
    assert.equal(usage!.promptTokens, 200, 'must be the second (later) row, not the first')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('getLastApiUsageForSession: rows from a DIFFERENT session are never mixed in', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    db.recordApiUsage({ source: 'anthropic', modelKey: 'm1', promptTokens: 999, genTokens: 999, codeSessionId: 'sess-other' })
    assert.equal(db.getLastApiUsageForSession('sess-4'), null)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('recordApiUsage: rows with no codeSessionId (every non-terminal-agent gateway client) never attribute to a session', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    db.recordApiUsage({ source: 'openai', modelKey: 'm1', promptTokens: 5, genTokens: 5 }) // no codeSessionId at all
    assert.equal(db.getLastApiUsageForSession('sess-5'), null, 'a session-less row must not show up under any session id')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('v36 migration: re-opening an existing DB is idempotent (no error, columns already present)', () => {
  const root = makeTmpRoot()
  const db1 = new ConversationStore(root)
  db1.recordApiUsage({ source: 'anthropic', modelKey: 'm1', promptTokens: 1, genTokens: 1, codeSessionId: 'sess-6', durationMs: 1000 })
  db1.close()
  // Re-open against the SAME on-disk DB — migration must be a no-op, not throw
  // "duplicate column" or similar.
  const db2 = new ConversationStore(root)
  try {
    const usage = db2.getLastApiUsageForSession('sess-6')
    assert.ok(usage, 'data survives a re-open')
  } finally {
    db2.close()
    rmSync(root, { recursive: true, force: true })
  }
})
