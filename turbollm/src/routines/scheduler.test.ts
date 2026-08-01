import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { RoutineScheduler } from './scheduler'

function freshStore(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-sched-test-')))
}

test('tick fires a due routine exactly once and reschedules it', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const fired: string[] = []
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async (routine) => { fired.push(routine.id) } })
  await scheduler.tick()
  assert.deepEqual(fired, [r.id])
  const after = store.getRoutine(r.id)
  assert.equal(after?.nextFireAt, new Date(now.getTime() + 60_000).toISOString())
})

test('tick skips a routine still running from a previous tick, logging overlap', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  let resolveRun!: () => void
  const runPromise = new Promise<void>((resolve) => { resolveRun = resolve })
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => runPromise })
  await scheduler.tick() // starts the slow run without awaiting completion
  await scheduler.tick() // second tick while the first is still in flight
  const runs = store.listRoutineRuns(r.id)
  assert.equal(runs.filter((x) => x.skipReason === 'overlap').length, 1)
  resolveRun()
})

test('reconcileMissedRuns skips (never executes) a routine missed while offline', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2026-08-01T09:00:00.000Z')
  const fired: string[] = []
  const now = new Date('2026-08-01T18:00:00.000Z') // daemon "just started" hours later
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async (routine) => { fired.push(routine.id) } })
  scheduler.reconcileMissedRuns()
  assert.deepEqual(fired, [])
  const runs = store.listRoutineRuns(r.id)
  assert.equal(runs[0].status, 'skipped')
  assert.equal(runs[0].skipReason, 'offline')
})

test('reconcileMissedRuns leaves a routine due only slightly in the past for the normal tick path', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const now = new Date('2026-08-01T10:00:00.000Z')
  store.confirmRoutine(r.id, new Date(now.getTime() - 5000).toISOString()) // 5s ago, well inside grace
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => {} })
  scheduler.reconcileMissedRuns()
  assert.equal(store.listRoutineRuns(r.id).length, 0)
})
