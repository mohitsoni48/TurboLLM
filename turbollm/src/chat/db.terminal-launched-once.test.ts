// Regression coverage for the v37 migration (terminal-agent auto-resume across a daemon
// restart): agent_runs.terminal_launched_once lets terminal-routes.ts tell a genuinely
// first-ever terminal launch apart from a restart-reconnect, so the CLI's own continue flag is
// only ever added on the latter.
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
