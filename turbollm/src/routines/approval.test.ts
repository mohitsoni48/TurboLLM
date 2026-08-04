// turbollm/src/routines/approval.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { stallRoutineRun, parsePendingToolCall, type PendingRoutineToolCall } from './approval'

test('stallRoutineRun marks needs_approval and round-trips the pending call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routine-approval-test-'))
  const store = new ConversationStore(dir)
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const run = store.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const pending: PendingRoutineToolCall = {
    convId: 'conv-1', assistantContent: 'looking that up', precedingCalls: [],
    call: { id: 'call-1', name: 'run_code', args: { code: 'ls' } },
  }
  const stalled = stallRoutineRun(store, run.id, pending)
  assert.equal(stalled?.status, 'needs_approval')
  const parsed = parsePendingToolCall(stalled?.pendingToolCall)
  assert.deepEqual(parsed, pending)
})

test('a stalled run survives a simulated daemon restart (fresh ConversationStore over the same dir)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routine-approval-restart-test-'))
  const before = new ConversationStore(dir)
  const r = before.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/tmp/repo', codingAgent: 'pi' })
  const run = before.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  stallRoutineRun(before, run.id, {
    convId: 'conv-2', sessionId: run.id, assistantContent: '', precedingCalls: [],
    call: { id: 'call-2', name: 'bash', args: { command: 'rm -rf /' } },
  })

  // Simulate a daemon restart: open a NEW ConversationStore instance over the same data dir
  // (ConversationStore's constructor just re-opens turbollm.db in that dir — db.ts:562-565).
  const after = new ConversationStore(dir)
  const reloaded = after.getRoutineRun(run.id)
  assert.equal(reloaded?.status, 'needs_approval')
  const parsed = parsePendingToolCall(reloaded?.pendingToolCall)
  assert.equal(parsed?.call.name, 'bash')
  assert.equal(parsed?.sessionId, run.id)
})

test('parsePendingToolCall returns null for malformed/absent input', () => {
  assert.equal(parsePendingToolCall(undefined), null)
  assert.equal(parsePendingToolCall('not json'), null)
  assert.equal(parsePendingToolCall('{"convId":"x"}'), null) // missing `call`
})
