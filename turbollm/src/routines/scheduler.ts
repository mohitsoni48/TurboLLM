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
        const run = this.deps.store.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
        this.deps.store.updateRoutineRun(run.id, { status: 'skipped', skipReason: 'overlap', endedAt: now.toISOString() })
        continue
      }
      this.inFlight.add(r.id)
      void this.deps.runRoutine(r).finally(() => {
        this.inFlight.delete(r.id)
        const now = this.deps.now()
        this.deps.store.updateRoutine(r.id, { nextFireAt: computeNextFireTime(r.scheduleRule, now).toISOString() })
      })
    }
  }
}
