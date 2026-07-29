// Regression coverage for the v37/v38 migrations (terminal-agent auto-resume across a daemon
// restart): agent_runs.terminal_launched_once lets terminal-routes.ts tell a genuinely
// first-ever terminal launch apart from a restart-reconnect, so the CLI's own --session-id/
// --resume flag is only ever the latter kind on a later launch. v38 is a same-day follow-up
// data fix — see its own comment in db.ts and the test below for the live bug it closes.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConversationStore } from './db'

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `turbollm-terminal-launched-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('terminalLaunchedOnce: defaults to false on a freshly created Code session', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ kind: 'code', modelKey: 'model-a' })
    const run = db.createAgentRun({ convId: conv.id, title: 'test session', allowedTools: [], repoRoot: 'D:/scratch', codeAgent: 'claude' })
    assert.equal(run.terminalLaunchedOnce, false)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminalLaunchedOnce: set via updateAgentRun and survives a fresh getAgentRun read', () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ kind: 'code', modelKey: 'model-a' })
    const run = db.createAgentRun({ convId: conv.id, title: 'test session', allowedTools: [], repoRoot: 'D:/scratch', codeAgent: 'claude' })

    const ok = db.updateAgentRun(run.id, { terminalLaunchedOnce: true })
    assert.equal(ok, true)

    const reloaded = db.getAgentRun(run.id)
    assert.ok(reloaded)
    assert.equal(reloaded!.terminalLaunchedOnce, true, 'must persist across a fresh read, not just the in-memory object')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ── v38: a row flagged true under the OLD --continue-based scheme must reset ────────────────
// Regression for the actual live bug this migration fixes: v37 set terminal_launched_once=true
// meaning "a terminal existed before" and the next launch sent claude's --continue. That was
// replaced with --session-id/--resume keyed on run.id — but a row already flagged true under
// the OLD scheme was never registered with the CLI under that exact id via --session-id, so
// --resume <that-id> would fail outright ("No conversation found with session ID: ..."). v38
// must reset every row unconditionally so its next launch re-registers cleanly.
test('v38 migration: resets a row already flagged true under the pre-v38 --continue scheme', () => {
  const root = makeTmpRoot()
  let runId: string
  {
    const db = new ConversationStore(root)
    const conv = db.createConversation({ kind: 'code', modelKey: 'model-a' })
    const run = db.createAgentRun({ convId: conv.id, title: 'test session', allowedTools: [], repoRoot: 'D:/scratch', codeAgent: 'claude' })
    runId = run.id
    db.updateAgentRun(run.id, { terminalLaunchedOnce: true })
    // Simulate "this row was flagged true back when the schema was only at v37" by rolling
    // the stored user_version back down — migrate() re-runs v38's block on the next open.
    const raw = (db as unknown as { db: { exec: (sql: string) => void } }).db
    raw.exec('PRAGMA user_version = 37;')
    db.close()
  }
  const db2 = new ConversationStore(root) // re-opens the same file — migrate() runs v38 now
  try {
    const reloaded = db2.getAgentRun(runId)
    assert.ok(reloaded)
    assert.equal(reloaded!.terminalLaunchedOnce, false, 'a pre-v38 true must reset — the CLI never saw --session-id for this id')
  } finally {
    db2.close()
    rmSync(root, { recursive: true, force: true })
  }
})
