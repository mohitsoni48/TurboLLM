import type { ConversationStore } from '../chat/db'
import type { Routine, RoutineRun, RoutineRunStatus } from './schema'
import { computeNextFireTime } from './schedule'

export interface RoutineSchedulerDeps {
  store: ConversationStore
  now: () => Date
  /** Executes one fire of `routine`. The scheduler has already created `run` (status
   *  'running') and owns writing its terminal state, so an implementation only decides
   *  WHICH terminal status the fire reached and may enrich the row (result, error,
   *  pendingToolCall) along the way — it must not create a second row for the same fire.
   *
   *  CONCURRENCY (formerly a SPEC-GAP, closed by Task 9, hardened after a live-execution review
   *  found two Critical double-fire regressions in the first cut): resolving to a terminal
   *  RoutineRunStatus makes the run-row lifecycle structural, and 'needs_approval' now has
   *  correct concurrency semantics too — see `tick()`'s `.then()`/`.finally()` handlers. A run
   *  that parks awaiting a tool approval stays in `inFlight` (fix (a) from this doc comment's
   *  earlier draft) instead of being cleared like every other terminal status, so the overlap
   *  guard keeps protecting it from a second concurrent fire for as long as it is parked.
   *
   *  The parked state is RUN-scoped, not just routine-scoped (`private parked: Map<routineId,
   *  runId>`), specifically so `releaseParked(routineId, runId)` can only ever release the
   *  guard for the SAME run that parked it. A first cut kept parked state as routine-scoped only
   *  (`inFlight` alone), which a live-execution review confirmed reproduces the double-fire bug
   *  via two different paths: (1) a stale, duplicate, or wrong-run `/approve`/`/deny` call could
   *  release a DIFFERENT, currently-executing fire's guard, and (2) a `resumeRoutineRun` call
   *  that loses the idempotency race (`not_stalled`, because a concurrent call already claimed
   *  the SAME run) would still release the guard for the run the first, still-in-flight call is
   *  actively resolving. Run-scoping closes (1) structurally; `routine-routes.ts`'s
   *  `releaseParkedIfResolved` additionally never releases on a `not_stalled` result to close
   *  (2) (the run-scoped check alone can't distinguish "the winner already released it" from
   *  "the winner is still mid-flight," since both look identical from the loser's perspective).
   *
   *  The routine is released back into circulation by `releaseParked()`, which `routine-routes.ts`'s
   *  `/approve` and `/deny` handlers call once `resumeRoutineRun` (Task 8) settles AND the run's
   *  fresh-read status is no longer 'needs_approval' (a resume can itself re-park the run on a
   *  second/chained tool call, in which case it must stay parked, not be released). Relatedly,
   *  the scheduler no longer stamps `endedAt` when the terminal status is 'needs_approval' — a
   *  parked run hasn't actually ended, so writing `endedAt` there would misrepresent it as
   *  closed in the run history.
   *
   *  The parked state is in-memory only, so `start()` calls `reconcileParkedRuns()` to repopulate
   *  it from the DB before the first tick can run after a restart — see that method's own doc
   *  comment. */
  runRoutine: (routine: Routine, run: RoutineRun) => Promise<RoutineRunStatus>
  tickIntervalMs?: number
  /** Live check for `daemon.experimental.routines` (config.ts) — a getter, not a snapshot value,
   *  since Settings → Experimental can flip it without a restart. Consulted at the top of both
   *  `tick()` and `runNow()` so turning the feature off is a genuine kill switch: no due routine
   *  fires automatically, and a manual/tool-triggered run-now is refused too. Confirming, pausing,
   *  resuming and editing a routine are all left alone — none of them execute anything by
   *  themselves, and a routine armed while disabled simply sits there until the flag is back on,
   *  the same as a routine that came due while the daemon was merely busy with a longer-running
   *  fire (see `flaggedOverlap`'s doc comment for that same "stays due, fires on the next tick
   *  that can take it" shape). Defaults to always-enabled so every pre-existing test/call site
   *  that doesn't know about this experimental gate keeps its exact previous behavior. */
  isRoutinesEnabled?: () => boolean
}

const DEFAULT_TICK_INTERVAL_MS = 30_000
const OFFLINE_GRACE_MS = 60_000

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = new Set<string>()
  /** Routine ids already given an "overlap" skip row for their CURRENT in-flight fire.
   *  Cleared alongside inFlight when the run settles, so a later overlap is logged again. */
  private flaggedOverlap = new Set<string>()
  /** routineId -> the SPECIFIC runId currently parked awaiting an approval decision. RUN-scoped
   *  (not just "is this routine parked?") so `releaseParked(routineId, runId)` can only ever
   *  release the guard for the exact run that parked it — see `RoutineSchedulerDeps.runRoutine`'s
   *  doc comment for the double-fire regression this closes. */
  private parked = new Map<string, string>()

  constructor(private deps: RoutineSchedulerDeps) {}

  start(): void {
    if (this.timer) return
    this.reconcileParkedRuns()
    this.reconcileMissedRuns()
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Runs once at start(), BEFORE reconcileMissedRuns(): the parked guard (`inFlight`/`parked`)
   *  is in-memory only, so a daemon restart silently drops it even though the DB still correctly
   *  shows a stalled run as 'needs_approval'. Without this, a restart would let a normal tick (or
   *  reconcileMissedRuns() itself, see the guard added there below) fire a routine again — or
   *  wrongly reschedule it — while an old approval is still outstanding, with zero protection.
   *
   *  N1 hardening (latent, not reachable today — cli.ts calls start() exactly once and only
   *  stop()s right before process exit, so there is no start-after-stop path currently): skip a
   *  routine that is ALREADY in `inFlight` rather than adopting its parked row unconditionally.
   *  At a genuine cold start `inFlight` is always empty, so this is a no-op today. But if start()
   *  were ever called again on an already-running instance (a future soft-restart, or a
   *  defensive re-call), adopting a parked row over a routine whose `inFlight` entry actually
   *  belongs to a different, currently-running (non-parked) fire would let a later `/approve` on
   *  the adopted row release that live fire's guard out from under it — the exact class of bug
   *  this whole park/release mechanism exists to prevent. Also makes multi-row adoption for the
   *  same routine id deterministic (first row wins), though that's not expected to occur. */
  private reconcileParkedRuns(): void {
    for (const run of this.deps.store.listParkedRoutineRuns()) {
      if (this.inFlight.has(run.routineId)) continue
      this.inFlight.add(run.routineId)
      this.parked.set(run.routineId, run.id)
    }
  }

  /** Runs once at start(): any active routine whose next_fire_at is more than
   *  OFFLINE_GRACE_MS in the past was clearly missed while the daemon was down — log it
   *  as skipped and reschedule, never execute it (spec 20 §4's "skip, don't catch up").
   *  Skips any routine `reconcileParkedRuns()` just re-parked: it isn't "missed", it's still
   *  actively awaiting an approval decision, and writing a bogus 'offline' skip row plus
   *  rescheduling its next_fire_at out from under it would corrupt run history and the
   *  schedule for no reason — the parked guard already fully covers it. */
  reconcileMissedRuns(): void {
    const now = this.deps.now()
    const cutoff = new Date(now.getTime() - OFFLINE_GRACE_MS).toISOString()
    for (const r of this.deps.store.listDueRoutines(cutoff)) {
      if (this.inFlight.has(r.id)) continue
      const run = this.deps.store.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
      this.deps.store.updateRoutineRun(run.id, { status: 'skipped', skipReason: 'offline', endedAt: now.toISOString() })
      this.deps.store.updateRoutine(r.id, { nextFireAt: computeNextFireTime(r.scheduleRule, now).toISOString() })
    }
  }

  async tick(): Promise<void> {
    // Kill switch: while Routines is disabled, no due routine fires — not even a code-flavor one
    // that was armed before the flag was turned off. `next_fire_at` is left untouched, so a
    // routine that comes due mid-disable simply stays due and fires on the first tick after
    // re-enabling, same "stays due until a tick can take it" shape as an overlapping fire.
    if (this.deps.isRoutinesEnabled?.() === false) return
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
      // The scheduler creates the run row (see RoutineSchedulerDeps.runRoutine): one row per
      // fire, written here, finalized below — never split with the injectee. Created BEFORE
      // inFlight so a throw (e.g. an FK violation because the routine was deleted between
      // listDueRoutines and now) can't strand the id in the set.
      let run: RoutineRun
      try {
        run = this.deps.store.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
      } catch (e) {
        console.error(`[RoutineScheduler] could not open a run row for routine ${r.id}:`, e)
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
      // an unhandled rejection crashes the daemon without it. It sits LAST in the chain so it
      // catches a rejecting runRoutine AND a throw from inside .then()/.finally() themselves
      // (e.g. the DB being closed mid-run during shutdown) — nothing escapes.
      //
      // 'needs_approval' is deliberately NOT treated like the other four terminal statuses:
      // the run is parked, not finished, so (1) `endedAt` is left unset — writing it would
      // misrepresent a parked run as closed in the history — and (2) `parkedForApproval` tells
      // .finally() below to leave this routine in `inFlight`/`flaggedOverlap` instead of
      // clearing them, so the tick loop's overlap guard keeps protecting it from a second
      // concurrent fire for as long as it stays parked. `releaseParked()` is the only way back
      // out of that state (called by routine-routes.ts's /approve and /deny once the run is no
      // longer 'needs_approval').
      let parkedForApproval = false
      void this.deps.runRoutine(r, run).then((terminalStatus) => {
        parkedForApproval = this.writeTerminalStatus(r.id, run.id, terminalStatus)
      }).finally(() => {
        if (parkedForApproval) return
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
        // A rejection is still a terminal outcome, and the scheduler owns the row — close it
        // out here so a failed fire is never left advertising 'running' forever.
        this.writeErrored(run.id, r.id, err)
      })
    }
  }

  /** Writes a fire's terminal outcome to its run row. 'needs_approval' is the one status that
   *  does NOT get `endedAt` — the run is parked, not finished (see `RoutineSchedulerDeps.
   *  runRoutine`'s doc comment) — and records EXACTLY which run parked this routine in `parked`
   *  (run-scoped, not just routine-scoped: see the double-fire regression that closes). The
   *  return value tells the caller whether that happened, so it knows to leave the routine's
   *  `inFlight`/`flaggedOverlap` entries in place instead of clearing them. Shared by `tick()`
   *  and `runNow()` so both fire paths behave identically. */
  private writeTerminalStatus(routineId: string, runId: string, terminalStatus: RoutineRunStatus): boolean {
    if (terminalStatus === 'needs_approval') {
      this.deps.store.updateRoutineRun(runId, { status: terminalStatus })
      this.parked.set(routineId, runId)
      return true
    }
    this.deps.store.updateRoutineRun(runId, { status: terminalStatus, endedAt: this.deps.now().toISOString() })
    return false
  }

  /** Closes out a run row after its `runRoutine` promise rejected outright (as opposed to
   *  resolving to 'errored') — a rejection is still a terminal outcome, and the scheduler owns
   *  the row, so it must not be left advertising 'running' forever. Shared by `tick()` and
   *  `runNow()`. */
  private writeErrored(runId: string, routineId: string, err: unknown): void {
    console.error(`[RoutineScheduler] runRoutine failed for routine ${routineId}:`, err)
    try {
      this.deps.store.updateRoutineRun(runId, {
        status: 'errored',
        error: err instanceof Error ? err.message : String(err),
        endedAt: this.deps.now().toISOString(),
      })
    } catch { /* the DB may be closed mid-shutdown — the log above is the record */ }
  }

  /** Immediately fire a routine, bypassing its next_fire_at check, but through the SAME overlap
   *  guard (`inFlight`) a normal tick uses, and calling the exact same injected `runRoutine` with
   *  a freshly-created run row (mirroring tick()'s "one row per fire, created before inFlight"
   *  pattern) — so whatever model-swap/skip-busy logic that function implements applies
   *  identically here, and a manual trigger shows up in run history exactly like a scheduled one.
   *  Returns synchronously (00-conventions.md §3: never block a request >10s) — the run itself
   *  proceeds in the background exactly like a normal tick's fire. A run that parks awaiting
   *  approval shares the same `inFlight` guard (and the same `releaseParked()` exit) a tick-fired
   *  parked run does — nothing about the concurrency fix cares which path started the fire. */
  runNow(routineId: string): { ok: true } | { ok: false; reason: 'not_found' | 'not_confirmed' | 'already_running' | 'routines_disabled' } {
    if (this.deps.isRoutinesEnabled?.() === false) return { ok: false, reason: 'routines_disabled' }
    const routine = this.deps.store.getRoutine(routineId)
    if (!routine) return { ok: false, reason: 'not_found' }
    if (routine.status === 'pending_confirmation') return { ok: false, reason: 'not_confirmed' }
    if (this.inFlight.has(routine.id)) return { ok: false, reason: 'already_running' }
    let run: RoutineRun
    try {
      run = this.deps.store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
    } catch (e) {
      console.error(`[RoutineScheduler] runNow could not open a run row for routine ${routine.id}:`, e)
      return { ok: false, reason: 'not_found' }
    }
    this.inFlight.add(routine.id)
    let parkedForApproval = false
    void this.deps.runRoutine(routine, run).then((terminalStatus) => {
      parkedForApproval = this.writeTerminalStatus(routine.id, run.id, terminalStatus)
    }).finally(() => {
      if (parkedForApproval) return
      this.inFlight.delete(routine.id)
      this.flaggedOverlap.delete(routine.id)
    }).catch((err) => {
      this.writeErrored(run.id, routine.id, err)
    })
    return { ok: true }
  }

  /** Releases a routine from its "parked" state (see `RoutineSchedulerDeps.runRoutine`'s doc
   *  comment) once ITS SPECIFIC parked run (`runId`) is no longer 'needs_approval' — i.e. it was
   *  approved and ran to a genuine terminal status, denied, or failed to resume outright. Must be
   *  called by whoever resolves the approval (routine-routes.ts's `/approve` and `/deny`
   *  handlers, via `resumeRoutineRun`) — the scheduler has no other way to learn that a parked
   *  run's fate was decided, since `resumeRoutineRun` is invoked directly by those REST routes
   *  and never through `tick()`/`runRoutine`.
   *
   *  RUN-scoped, not just routine-scoped: only releases when `parked.get(routineId) === runId`.
   *  This is deliberate, not incidental — a live-execution review found that a routine-scoped-only
   *  check (`inFlight.has(routineId)`) lets a stale, duplicate, or wrong-run `/approve`/`/deny`
   *  call release the guard for a COMPLETELY DIFFERENT, currently-executing fire of the same
   *  routine (e.g. a caller retrying `/approve` on an old run whose `pendingToolCall` could never
   *  be parsed, while a fresh fire of the same routine is legitimately in flight). Requiring an
   *  exact match makes that structurally impossible, and makes a duplicate release of the SAME
   *  run a safe no-op too (the map entry is gone after the first one succeeds).
   *
   *  A no-op whenever `routineId`/`runId` don't match the currently-parked pair — never
   *  parked via this scheduler, already released, or a stale/wrong run id — so it is always safe
   *  to call unconditionally. Callers must NOT call this when the resume itself re-parked the
   *  SAME run (a resumed run can stall again on a second/chained tool-call approval): check the
   *  run's fresh status first and only release when it has actually left 'needs_approval'. */
  releaseParked(routineId: string, runId: string): void {
    if (this.parked.get(routineId) !== runId) return
    this.parked.delete(routineId)
    this.inFlight.delete(routineId)
    this.flaggedOverlap.delete(routineId)
    const current = this.deps.store.getRoutine(routineId)
    if (current?.status !== 'active') return
    const now = this.deps.now()
    this.deps.store.updateRoutine(routineId, { nextFireAt: computeNextFireTime(current.scheduleRule, now).toISOString() })
  }
}
