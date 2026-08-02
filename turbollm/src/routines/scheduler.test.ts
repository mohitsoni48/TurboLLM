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

/** M1: the invariant that actually matters for the double-fire fix — not fire-counts or
 *  skip-row-counts alone (which a first-cut review found could stay green even with two live
 *  Critical regressions), but "at most one row is ever 'running' for a given routine at once." */
function assertAtMostOneRunning(store: ConversationStore, routineId: string, message?: string): void {
  const runningCount = store.listRoutineRuns(routineId).filter((run) => run.status === 'running').length
  assert.ok(runningCount <= 1, message ?? `expected at most one 'running' row for routine ${routineId}, found ${runningCount}`)
}

test('tick fires a due routine exactly once and reschedules it', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const fired: string[] = []
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async (routine) => { fired.push(routine.id); return 'ok' } })
  await scheduler.tick()
  await flush() // the reschedule lands in .finally(), after the run settles
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
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { await runPromise; return 'ok' } })
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
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { await runPromise; return 'ok' } })
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
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { await runPromise; return 'ok' } })
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
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { await runPromise; return 'ok' } })
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
    runRoutine: async () => { await (call++ === 0 ? first : second); return 'ok' },
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

// ── Scheduler-owned run rows (I6) ─────────────────────────────────────────────
// The scheduler creates the 'running' row and writes its terminal state, so
// "every fire has exactly one row" is structural rather than something each
// runRoutine implementation has to remember.

test('tick creates the running row itself and hands it to runRoutine', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const confirmed = store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  let seenRunId = ''
  let seenStatusDuringRun = ''
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({
    store, now: () => now,
    runRoutine: async (_routine, run) => {
      seenRunId = run.id
      seenStatusDuringRun = store.getRoutineRun(run.id)?.status ?? ''
      return 'ok'
    },
  })
  await scheduler.tick()
  await flush()
  const runs = store.listRoutineRuns(r.id)
  assert.equal(runs.length, 1, 'exactly one row per fire')
  assert.equal(runs[0].id, seenRunId)
  assert.equal(seenStatusDuringRun, 'running')
  // The snapshot is of the routine as it was WHEN IT FIRED, not as it is now (the
  // completing run has since advanced nextFireAt).
  assert.equal(runs[0].configSnapshot, JSON.stringify(confirmed))
})

test('tick writes the terminal status runRoutine resolved to, plus endedAt', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => 'ok' })
  await scheduler.tick()
  await flush()
  const [run] = store.listRoutineRuns(r.id)
  assert.equal(run.status, 'ok')
  assert.equal(run.endedAt, now.toISOString())
})

test('a rejecting runRoutine leaves the row errored, never stuck at running', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => { throw new Error('engine exploded') } })
  await scheduler.tick()
  await flush()
  const [run] = store.listRoutineRuns(r.id)
  assert.equal(run.status, 'errored')
  assert.match(run.error ?? '', /engine exploded/)
  assert.ok(run.endedAt)
  // The routine itself is still rescheduled — one bad run must not stall the schedule.
  assert.equal(store.getRoutine(r.id)?.nextFireAt, new Date(now.getTime() + 60_000).toISOString())
})

test('reconcileMissedRuns skips (never executes) a routine missed while offline', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2026-08-01T09:00:00.000Z')
  const fired: string[] = []
  const now = new Date('2026-08-01T18:00:00.000Z') // daemon "just started" hours later
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async (routine) => { fired.push(routine.id); return 'ok' } })
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
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async () => 'ok' })
  scheduler.reconcileMissedRuns()
  assert.equal(store.listRoutineRuns(r.id).length, 0)
})

// ── runNow (Task 9) ────────────────────────────────────────────────────────────

test('runNow fires an active routine immediately, bypassing next_fire_at', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2099-01-01T00:00:00.000Z') // far in the future — a normal tick would never fire this
  const fired: string[] = []
  const scheduler = new RoutineScheduler({ store, now: () => new Date(), runRoutine: async (routine) => { fired.push(routine.id); return 'ok' } })
  const result = scheduler.runNow(r.id)
  assert.deepEqual(result, { ok: true })
  await flush() // let the fire-and-forget runRoutine settle
  assert.deepEqual(fired, [r.id])
})

test('runNow rejects a routine that already has a run in flight (shares the tick overlap guard)', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2099-01-01T00:00:00.000Z')
  let resolveRun!: () => void
  const runPromise = new Promise<void>((resolve) => { resolveRun = resolve })
  const scheduler = new RoutineScheduler({ store, now: () => new Date(), runRoutine: async () => { await runPromise; return 'ok' } })
  scheduler.runNow(r.id)
  const second = scheduler.runNow(r.id)
  assert.deepEqual(second, { ok: false, reason: 'already_running' })
  resolveRun()
  await flush()
})

test('runNow rejects an unconfirmed (pending_confirmation) routine', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const scheduler = new RoutineScheduler({ store, now: () => new Date(), runRoutine: async () => 'ok' })
  assert.deepEqual(scheduler.runNow(r.id), { ok: false, reason: 'not_confirmed' })
})

test('runNow rejects an unknown routine id', () => {
  const store = freshStore()
  const scheduler = new RoutineScheduler({ store, now: () => new Date(), runRoutine: async () => 'ok' })
  assert.deepEqual(scheduler.runNow('missing'), { ok: false, reason: 'not_found' })
})

test('runNow creates a run row, just like a normal tick fire, so a manual trigger shows up in run history', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2099-01-01T00:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => new Date(), runRoutine: async (_routine, run) => { assert.equal(store.getRoutineRun(run.id)?.status, 'running'); return 'ok' } })
  scheduler.runNow(r.id)
  await flush()
  const runs = store.listRoutineRuns(r.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'ok')
  assert.ok(runs[0].endedAt)
})

// ── needs_approval double-fire fix (Task 9) ────────────────────────────────────
// scheduler.ts's own doc comment on RoutineSchedulerDeps.runRoutine used to flag a confirmed,
// live gap: once a fire can resolve to 'needs_approval', the scheduler cleared `inFlight`
// unconditionally, so a routine parked awaiting approval could be fired again by the very next
// tick, producing two independent concurrent runs for the same routine. These tests prove the
// fix: a parked routine cannot be fired again while parked, and CAN fire again once released
// (what routine-routes.ts's /approve and /deny handlers do via `releaseParked` once
// resumeRoutineRun resolves the stall).

test('a routine that parks on needs_approval is not fired again by a later tick (no double-fire)', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const fired: string[] = []
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async (routine) => { fired.push(routine.id); return 'needs_approval' } })
  await scheduler.tick()
  await flush()
  assert.deepEqual(fired, [r.id], 'first tick fires the routine and it parks')
  const [run] = store.listRoutineRuns(r.id)
  assert.equal(run.status, 'needs_approval')
  assert.equal(run.endedAt, undefined, 'a parked run has not actually ended')
  assertAtMostOneRunning(store, r.id)
  // The routine's next_fire_at was never advanced while parked, so it is STILL "due" — proving
  // the guard is the inFlight set, not next_fire_at, exactly like the ordinary overlap case.
  await scheduler.tick()
  await scheduler.tick()
  await flush()
  assert.deepEqual(fired, [r.id], 'a parked routine must not be fired a second time by a later tick')
  // It behaves exactly like any other in-flight overlap: at most one skip row, not one per tick.
  const overlapRuns = store.listRoutineRuns(r.id).filter((x) => x.skipReason === 'overlap')
  assert.equal(overlapRuns.length, 1)
  assert.equal(store.listRoutineRuns(r.id).length, 2, 'the parked run row plus exactly one overlap row')
  assertAtMostOneRunning(store, r.id)
})

test('releaseParked(routineId, runId) lets a routine parked on needs_approval fire again', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const fired: string[] = []
  let call = 0
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({
    store, now: () => now,
    runRoutine: async (routine) => { fired.push(routine.id); call++; return call === 1 ? 'needs_approval' : 'ok' },
  })
  await scheduler.tick()
  await flush()
  assert.deepEqual(fired, [r.id])
  const [parkedRun] = store.listRoutineRuns(r.id)
  // Simulate what routine-routes.ts's /approve or /deny handler does once resumeRoutineRun
  // has resolved the stall (the run is no longer 'needs_approval') — passing the SPECIFIC run
  // id that parked the routine, per the run-scoped release contract.
  scheduler.releaseParked(r.id, parkedRun.id)
  const released = store.getRoutine(r.id)
  assert.ok(released?.nextFireAt, 'release reschedules the routine like a normal completion would')
  assert.notEqual(released?.nextFireAt, '2020-01-01T00:00:00.000Z')
  // Wind the clock back so the routine is due again, then prove a tick can now fire it.
  store.updateRoutine(r.id, { nextFireAt: '2020-01-01T00:00:00.000Z' })
  await scheduler.tick()
  await flush()
  assert.deepEqual(fired, [r.id, r.id], 'the routine can fire again after being released')
  const overlapRuns = store.listRoutineRuns(r.id).filter((x) => x.skipReason === 'overlap')
  assert.equal(overlapRuns.length, 0, 'no spurious overlap row once properly released')
  assertAtMostOneRunning(store, r.id)
})

test('releaseParked on a routine that is not currently parked is a safe no-op', () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const before = store.getRoutine(r.id)
  const scheduler = new RoutineScheduler({ store, now: () => new Date(), runRoutine: async () => 'ok' })
  scheduler.releaseParked(r.id, 'some-run-id') // never fired via this scheduler — must not throw or mutate anything
  assert.deepEqual(store.getRoutine(r.id), before)
  scheduler.releaseParked('totally-unknown-id', 'some-run-id') // must not throw even for a nonexistent routine
})

// ── C2 regression: releaseParked is RUN-scoped, not just routine-scoped ────────────────────
// A live-execution review found that a routine-scoped-only check (`inFlight.has(routineId)`)
// lets a stale, duplicate, or wrong-run approve/deny release the guard for a COMPLETELY
// DIFFERENT, currently-parked fire of the same routine. These tests prove releaseParked ignores
// a call naming the wrong run, and only releases when the run id actually matches what is
// currently parked.

test('releaseParked with the WRONG run id for a currently-parked routine is a no-op — the real parked fire stays guarded', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const fired: string[] = []
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({ store, now: () => now, runRoutine: async (routine) => { fired.push(routine.id); return 'needs_approval' } })
  await scheduler.tick()
  await flush()
  const [parkedRun] = store.listRoutineRuns(r.id)
  assert.equal(parkedRun.status, 'needs_approval')

  // A stale/duplicate/wrong-run release attempt — e.g. a caller retrying approve on an OLD,
  // already-resolved (or never-actually-parked) run id for the same routine.
  scheduler.releaseParked(r.id, 'some-other-stale-run-id')

  // The REAL parked fire must still be guarded: a later tick cannot fire the routine again.
  await scheduler.tick()
  await flush()
  assert.deepEqual(fired, [r.id], 'the wrong-run release must not have freed the real parked fire')
  assert.equal(store.listRoutineRuns(r.id).filter((x) => x.skipReason === 'overlap').length, 1)
  assertAtMostOneRunning(store, r.id)

  // Releasing with the CORRECT run id, though, does work.
  scheduler.releaseParked(r.id, parkedRun.id)
  store.updateRoutine(r.id, { nextFireAt: '2020-01-01T00:00:00.000Z' })
  await scheduler.tick()
  await flush()
  assert.deepEqual(fired, [r.id, r.id], 'the correct-run release does free the routine to fire again')
})

test('a duplicate release with the SAME (already-released) run id is a safe no-op', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  let call = 0
  const fired: string[] = []
  const now = new Date('2026-08-01T10:00:00.000Z')
  const scheduler = new RoutineScheduler({
    store, now: () => now,
    runRoutine: async (routine) => { fired.push(routine.id); call++; return call === 1 ? 'needs_approval' : 'ok' },
  })
  await scheduler.tick()
  await flush()
  const [parkedRun] = store.listRoutineRuns(r.id)
  scheduler.releaseParked(r.id, parkedRun.id) // first release — succeeds
  const afterFirstRelease = store.getRoutine(r.id)
  scheduler.releaseParked(r.id, parkedRun.id) // duplicate release of the SAME run — must be a no-op
  assert.deepEqual(store.getRoutine(r.id), afterFirstRelease, 'a duplicate release must not touch anything a second time')
})

// ── I1 regression: the parked guard must survive a daemon restart ─────────────────────────
// The guard is in-memory only (`inFlight`/`parked`), so without reconciliation at start(), a
// restart would silently lose it — letting a routine whose approval is still outstanding fire
// again with zero protection. start() must repopulate the guard from the DB's still-correct
// 'needs_approval' rows before the first tick or reconcileMissedRuns() can run.

test('start() repopulates the parked guard from any run still needs_approval in the DB (restart survival)', async () => {
  const store = freshStore()
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  // Simulate a run that was parked before a restart: still 'needs_approval' in the DB, but no
  // scheduler instance has ever tracked it (it's in-memory state is gone).
  store.confirmRoutine(r.id, '2020-01-01T00:00:00.000Z')
  const parkedRun = store.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  store.updateRoutineRun(parkedRun.id, { status: 'needs_approval' })

  const fired: string[] = []
  const scheduler = new RoutineScheduler({ store, now: () => new Date(), runRoutine: async (routine) => { fired.push(routine.id); return 'ok' }, tickIntervalMs: 3_600_000 })
  try {
    scheduler.start()
    // reconcileMissedRuns() must not have treated the still-parked routine as "missed while
    // offline" either — it should get neither a bogus offline-skip row nor a premature reschedule.
    assert.equal(store.listRoutineRuns(r.id).filter((x) => x.skipReason === 'offline').length, 0)
    assert.equal(store.getRoutine(r.id)?.nextFireAt, '2020-01-01T00:00:00.000Z', 'a parked routine\'s schedule must not be touched by reconcileMissedRuns()')

    // The guard must be live: a tick must not be able to fire the routine while it's still
    // (from the DB's perspective) parked.
    await scheduler.tick()
    await flush()
    assert.deepEqual(fired, [], 'still parked post-restart — a tick must not fire it')
    assert.equal(store.listRoutineRuns(r.id).filter((x) => x.skipReason === 'overlap').length, 1)

    // Releasing with the correct (rediscovered) run id frees it again, same as any other park.
    scheduler.releaseParked(r.id, parkedRun.id)
    store.updateRoutine(r.id, { nextFireAt: '2020-01-01T00:00:00.000Z' })
    await scheduler.tick()
    await flush()
    assert.deepEqual(fired, [r.id])
  } finally {
    scheduler.stop()
  }
})
