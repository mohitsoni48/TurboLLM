// RoutineRepo over a handle it shares with the ConversationStore that owns the schema. The store's
// delegating methods are what the scheduler and routes call; these check the class on its own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { RoutineRepo } from './routine-repo'

function withRepo(fn: (repo: RoutineRepo, store: ConversationStore) => void): void {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  try { fn(new RoutineRepo(store.handle), store) } finally { store.close() }
}

const newRoutine = { flavor: 'chat' as const, prompt: 'p', scheduleDisplay: 'daily', scheduleRule: { kind: 'daily' as const, hour: 9, minute: 0 }, modelKey: 'm' }

test('a routine starts unconfirmed, becomes due once confirmed, and is visible through the store too', () => {
  withRepo((repo, store) => {
    const routine = repo.createRoutine(newRoutine)
    assert.equal(routine.status, 'pending_confirmation')
    assert.deepEqual(repo.listDueRoutines('2999-01-01T00:00:00.000Z'), [])
    repo.confirmRoutine(routine.id, '2026-01-01T00:00:00.000Z')
    assert.deepEqual(repo.listDueRoutines('2026-01-02T00:00:00.000Z').map((r) => r.id), [routine.id])
    assert.equal(store.getRoutine(routine.id)?.status, 'active')
  })
})

test('deleting a routine takes its runs with it', () => {
  withRepo((repo) => {
    const routine = repo.createRoutine(newRoutine)
    const run = repo.createRoutineRun({ routineId: routine.id, configSnapshot: '{}' })
    assert.equal(repo.countRoutineRuns(routine.id), 1)
    assert.equal(repo.deleteRoutine(routine.id), true)
    assert.equal(repo.getRoutineRun(run.id), null)
  })
})

test('run history pages newest first without repeating a run', () => {
  withRepo((repo) => {
    const routine = repo.createRoutine(newRoutine)
    for (let i = 0; i < 5; i++) repo.createRoutineRun({ routineId: routine.id, configSnapshot: String(i) })
    const first = repo.listRoutineRunsPage(routine.id, { limit: 2 })
    const second = repo.listRoutineRunsPage(routine.id, { limit: 2, cursor: first.nextCursor! })
    assert.equal(first.runs.length + second.runs.length, 4)
    assert.equal(new Set([...first.runs, ...second.runs].map((r) => r.id)).size, 4)
  })
})

test('retention lists only finished runs beyond the newest keep, and deleting them leaves the rest', () => {
  withRepo((repo) => {
    const routine = repo.createRoutine(newRoutine)
    const runs = Array.from({ length: 4 }, (_, i) => repo.createRoutineRun({ routineId: routine.id, configSnapshot: String(i) }))
    for (const r of runs.slice(0, 3)) repo.updateRoutineRun(r.id, { status: 'ok', endedAt: new Date().toISOString() })
    const prunable = repo.routineRunsBeyondNewest(routine.id, 2, 10)
    assert.ok(prunable.every((p) => repo.getRoutineRun(p.id)?.status === 'ok'))
    const { runs: deleted } = repo.deleteRoutineRuns(prunable)
    assert.equal(deleted, prunable.length)
    assert.equal(repo.countRoutineRuns(routine.id), 4 - prunable.length)
  })
})

test('runs a restart cut off are found by status', () => {
  withRepo((repo) => {
    const routine = repo.createRoutine(newRoutine)
    const running = repo.createRoutineRun({ routineId: routine.id, configSnapshot: '{}' })
    const parked = repo.createRoutineRun({ routineId: routine.id, configSnapshot: '{}' })
    repo.updateRoutineRun(parked.id, { status: 'needs_approval' })
    assert.deepEqual(repo.listRunningRoutineRuns().map((r) => r.id), [running.id])
    assert.deepEqual(repo.listParkedRoutineRuns().map((r) => r.id), [parked.id])
  })
})
