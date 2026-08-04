import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'

function freshStore(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-store-test-')))
}

test('createRoutine starts pending_confirmation with no next_fire_at', () => {
  const store = freshStore()
  const r = store.createRoutine({
    flavor: 'chat', prompt: 'Summarize my inbox', scheduleDisplay: 'Runs daily at 9:00 AM',
    scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'qwen3-coder-32b', agentId: 'agent-1',
  })
  assert.equal(r.status, 'pending_confirmation')
  assert.equal(r.nextFireAt, null)
})

test('confirmRoutine activates and sets next_fire_at', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const confirmed = store.confirmRoutine(r.id, '2026-08-02T09:00:00.000Z')
  assert.equal(confirmed?.status, 'active')
  assert.equal(confirmed?.nextFireAt, '2026-08-02T09:00:00.000Z')
})

test('listDueRoutines only returns active routines at or past next_fire_at', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const due = store.listDueRoutines(new Date().toISOString())
  assert.equal(due.length, 1)
  assert.equal(due[0].id, r.id)
})

test('listDueRoutines excludes pending_confirmation and paused routines', () => {
  const store = freshStore()
  store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const due = store.listDueRoutines(new Date().toISOString())
  assert.equal(due.length, 0)
})

test('updateRoutine only touches provided fields', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'old', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const updated = store.updateRoutine(r.id, { prompt: 'new' })
  assert.equal(updated?.prompt, 'new')
  assert.equal(updated?.scheduleDisplay, 'd')
})

test('deleteRoutine cascades to its runs', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  assert.equal(store.listRoutineRuns(r.id).length, 1)
  store.deleteRoutine(r.id)
  assert.equal(store.listRoutineRuns(r.id).length, 0)
})

test('updateRoutineRun updates status and endedAt', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const run = store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  const updated = store.updateRoutineRun(run.id, { status: 'ok', endedAt: '2026-08-01T00:00:00.000Z' })
  assert.equal(updated?.status, 'ok')
  assert.equal(updated?.endedAt, '2026-08-01T00:00:00.000Z')
})

// listParkedRoutineRuns: added for RoutineScheduler.start()'s I1 fix (a live-execution review of
// the Task 9 double-fire fix found the scheduler's parked guard is in-memory only and silently
// lost across a restart) — this is what lets start() rediscover any run still 'needs_approval'.
test('a fresh run has no conversationId/codeSessionId, and updateRoutineRun can set either independently', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const run = store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  assert.equal(run.conversationId, undefined)
  assert.equal(run.codeSessionId, undefined)

  const withConv = store.updateRoutineRun(run.id, { conversationId: 'conv-1' })
  assert.equal(withConv?.conversationId, 'conv-1')
  assert.equal(withConv?.codeSessionId, undefined, 'setting one must not touch the other')

  const withBoth = store.updateRoutineRun(run.id, { codeSessionId: 'sess-1' })
  assert.equal(withBoth?.conversationId, 'conv-1', 'a later unrelated patch must not clobber an already-set field')
  assert.equal(withBoth?.codeSessionId, 'sess-1')

  // Round-trips through a fresh read too, not just the patch's own return value.
  assert.deepEqual(
    { conversationId: store.getRoutineRun(run.id)?.conversationId, codeSessionId: store.getRoutineRun(run.id)?.codeSessionId },
    { conversationId: 'conv-1', codeSessionId: 'sess-1' },
  )
})

test('listParkedRoutineRuns returns only needs_approval rows, across all routines', () => {
  const store = freshStore()
  const r1 = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const r2 = store.createRoutine({ flavor: 'chat', prompt: 'y', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const parkedRun = store.createRoutineRun({ routineId: r1.id, configSnapshot: '{}' })
  store.updateRoutineRun(parkedRun.id, { status: 'needs_approval' })
  const okRun = store.createRoutineRun({ routineId: r2.id, configSnapshot: '{}' })
  store.updateRoutineRun(okRun.id, { status: 'ok', endedAt: '2026-08-01T00:00:00.000Z' })

  const parked = store.listParkedRoutineRuns()
  assert.equal(parked.length, 1)
  assert.equal(parked[0].id, parkedRun.id)
  assert.equal(parked[0].routineId, r1.id)
})

test('listParkedRoutineRuns is empty when nothing is parked', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
  assert.equal(store.listParkedRoutineRuns().length, 0)
})
