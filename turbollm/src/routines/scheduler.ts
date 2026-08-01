import type { ConversationStore } from '../chat/db'
import type { Routine } from './schema'
import { computeNextFireTime } from './schedule'

export interface RoutineSchedulerDeps {
  store: ConversationStore
  now: () => Date
  runRoutine: (routine: Routine) => Promise<void>
  tickIntervalMs?: number
}

const DEFAULT_TICK_INTERVAL_MS = 30_000
const OFFLINE_GRACE_MS = 60_000

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = new Set<string>()
  /** Routine ids already given an "overlap" skip row for their CURRENT in-flight fire.
   *  Cleared alongside inFlight when the run settles, so a later overlap is logged again. */
  private flaggedOverlap = new Set<string>()

  constructor(private deps: RoutineSchedulerDeps) {}

  start(): void {
    if (this.timer) return
    this.reconcileMissedRuns()
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Runs once at start(): any active routine whose next_fire_at is more than
   *  OFFLINE_GRACE_MS in the past was clearly missed while the daemon was down — log it
   *  as skipped and reschedule, never execute it (spec 20 §4's "skip, don't catch up"). */
  reconcileMissedRuns(): void {
    const now = this.deps.now()
    const cutoff = new Date(now.getTime() - OFFLINE_GRACE_MS).toISOString()
    for (const r of this.deps.store.listDueRoutines(cutoff)) {
      const run = this.deps.store.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
      this.deps.store.updateRoutineRun(run.id, { status: 'skipped', skipReason: 'offline', endedAt: now.toISOString() })
      this.deps.store.updateRoutine(r.id, { nextFireAt: computeNextFireTime(r.scheduleRule, now).toISOString() })
    }
  }

  async tick(): Promise<void> {
    const now = this.deps.now()
    for (const r of this.deps.store.listDueRoutines(now.toISOString())) {
      if (this.inFlight.has(r.id)) {
        // At most ONE overlap row per in-flight fire. Because the reschedule happens in
        // .finally(), next_fire_at stays in the past for the whole duration of a run, so
        // every tick re-lists the routine as due and lands here — without this flag a
        // 30-minute Phase-2 run would write ~59 "skipped (overlap)" rows for a single
        // fire and bury the real entry in the user-visible run history.
        if (this.flaggedOverlap.has(r.id)) continue
        this.flaggedOverlap.add(r.id)
        const run = this.deps.store.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
        this.deps.store.updateRoutineRun(run.id, { status: 'skipped', skipReason: 'overlap', endedAt: now.toISOString() })
        continue
      }
      this.inFlight.add(r.id)
      // Reschedule in .finally() rather than here to get fixed-delay semantics: an interval
      // routine fires N ms after the previous run COMPLETES, not N ms after its original due
      // time, so a run that overruns its own interval never queues up back-to-back re-fires.
      // The cost is that next_fire_at stays stale for the run's duration and every tick sees
      // the routine as due — the flaggedOverlap set above is what keeps that from turning
      // into one junk skip row per tick.
      // Overlap detection works via inFlight set (not database state) — a concurrent tick can detect
      // overlap even though this tick has rescheduled the routine, because inFlight still contains r.id.
      // .catch() is essential: if runRoutine rejects (Phase 2/3 real I/O), .finally() re-throws;
      // unhandled rejection crashes daemon without it. .catch() before .finally() ensures logged, not escaped.
      void this.deps.runRoutine(r).finally(() => {
        this.inFlight.delete(r.id)
        this.flaggedOverlap.delete(r.id)
        // Re-read rather than reusing `r`: the routine may have been paused, edited or
        // deleted while this fire was in flight. "paused" means "no scheduled next fire",
        // so rescheduling unconditionally here would hand a paused routine a nextFireAt
        // the user just cleared (and Phase 3's UI would render a next-run time for it).
        // Deleted routines fall out the same way instead of issuing a 0-row UPDATE.
        // The re-read rule is also the current one, so an edit mid-run isn't overwritten.
        const current = this.deps.store.getRoutine(r.id)
        if (current?.status !== 'active') return
        const now = this.deps.now()
        this.deps.store.updateRoutine(r.id, { nextFireAt: computeNextFireTime(current.scheduleRule, now).toISOString() })
      }).catch((err) => {
        console.error(`[RoutineScheduler] runRoutine failed for routine ${r.id}:`, err)
      })
    }
  }
}
