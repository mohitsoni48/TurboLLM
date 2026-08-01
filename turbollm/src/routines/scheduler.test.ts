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

/** Lets every queued microtask (the runRoutine promise chain, including .finally) drain.
 *  setImmediate fires in the check phase, which is after the microtask queue is empty. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('a routine paused mid-run is not rescheduled when the run completes', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  let resolveRun!: () => void
  const runPromise = new Promise<void>((resolve) => { resolveRun = resolve })
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { await runPromise } })
  await scheduler.tick()
  // The user pauses while the fire is still in flight — this is the correct write.
  store.updateRoutine(r.id, { status: 'paused', nextFireAt: null })
  resolveRun()
  await flush()
  const after = store.getRoutine(r.id)
  assert.equal(after?.status, 'paused')
  assert.equal(after?.nextFireAt, null, 'a paused routine must not be handed a next fire time by the completing run')
})

test('a routine deleted mid-run does not resurrect a next fire time', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  let resolveRun!: () => void
  const runPromise = new Promise<void>((resolve) => { resolveRun = resolve })
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { await runPromise } })
  await scheduler.tick()
  store.deleteRoutine(r.id)
  resolveRun()
  await flush()
  assert.equal(store.getRoutine(r.id), null)
})

test('a long-running fire logs exactly one overlap row, not one per tick', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  let resolveRun!: () => void
  const runPromise = new Promise<void>((resolve) => { resolveRun = resolve })
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { await runPromise } })
  await scheduler.tick() // starts the slow run
  for (let i = 0; i < 9; i++) await scheduler.tick() // nine more ticks while it is still in flight
  const overlaps = store.listRoutineRuns(r.id).filter((x) => x.skipReason === 'overlap')
  assert.equal(overlaps.length, 1, 'one in-flight fire must produce at most one overlap row')
  resolveRun()
  await flush()
})

test('the overlap flag is cleared when a run finishes, so a later overlap is still logged', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  let resolveFirst!: () => void
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  let resolveSecond!: () => void
  const second = new Promise<void>((resolve) => { resolveSecond = resolve })
  let call = 0
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({
    store, now: () => now,
    runRoutine: async () => { await (call++ === 0 ? first : second) },
  })
  await scheduler.tick()
  await scheduler.tick() // overlap #1
  resolveFirst()
  await flush()
  // The completed run rescheduled to now + 1000ms; wind the routine back so it is due again.
  store.updateRoutine(r.id, { nextFireAt: '2020-01-01T00:00:00.000Z' })
  await scheduler.tick() // second fire starts
  await scheduler.tick() // overlap #2 — must be recorded, the flag was cleared
  assert.equal(store.listRoutineRuns(r.id).filter((x) => x.skipReason === 'overlap').length, 2)
  resolveSecond()
  await flush()
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
