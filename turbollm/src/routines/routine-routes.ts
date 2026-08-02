import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { isLocalRequest, verifyPresentedKey } from '../auth'
import { computeNextFireTime } from './schedule'
import { resumeRoutineRun } from './execute'
import type { ScheduleRule, RoutineFlavor, Routine, RoutineRun } from './schema'

type Status = 200 | 201 | 400 | 401 | 404 | 409 | 500 | 503

function err(c: Context, status: Status, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

async function body<T>(c: Context): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

/** Exported (Phase 4) so `routine-tools.ts` can type its tool arguments against the exact same
 *  request shape the REST layer accepts, rather than declaring a parallel copy that can drift. */
export interface RoutineBody {
  flavor?: RoutineFlavor
  prompt?: string
  scheduleDisplay?: string
  scheduleRule?: ScheduleRule
  modelKey?: string
  agentId?: string
  workspacePath?: string
  codingAgent?: 'pi' | 'claude_cli'
  permissionMode?: 'auto' | 'plan' | 'ask'
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/** Structural validation of the client-supplied `scheduleRule` JSON. Nothing downstream
 *  (`computeNextFireTime`, the scheduler tick loop) re-checks these, so this is the only
 *  layer standing between request JSON and the schedule math: an unrecognised `kind`
 *  reaches `new Date(NaN).toISOString()` and throws a `RangeError` out of the handler
 *  (a 500, which breaks the error-envelope convention), and `everyMs <= 0` yields a
 *  routine whose `next_fire_at` is permanently in the past — it fires on every tick,
 *  forever. Exported so both POST and PUT go through the identical check. */
export function validateScheduleRule(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'scheduleRule must be an object.'
  const r = rule as { kind?: unknown; everyMs?: unknown; hour?: unknown; minute?: unknown; daysOfWeek?: unknown }
  if (r.kind !== 'interval' && r.kind !== 'daily' && r.kind !== 'weekly') {
    return 'scheduleRule.kind must be "interval", "daily" or "weekly".'
  }
  if (r.kind === 'interval') {
    if (typeof r.everyMs !== 'number' || !Number.isFinite(r.everyMs) || r.everyMs <= 0) {
      return 'scheduleRule.everyMs must be a positive number of milliseconds.'
    }
    return null
  }
  if (!isInt(r.hour) || r.hour < 0 || r.hour > 23) return 'scheduleRule.hour must be an integer between 0 and 23.'
  if (!isInt(r.minute) || r.minute < 0 || r.minute > 59) return 'scheduleRule.minute must be an integer between 0 and 59.'
  if (r.kind === 'weekly') {
    if (!Array.isArray(r.daysOfWeek) || r.daysOfWeek.length === 0) {
      return 'scheduleRule.daysOfWeek must be a non-empty array of weekday numbers.'
    }
    if (!r.daysOfWeek.every((day) => isInt(day) && day >= 0 && day <= 6)) {
      return 'scheduleRule.daysOfWeek entries must be integers between 0 (Sunday) and 6 (Saturday).'
    }
  }
  return null
}

/** The field checks that apply identically on create and update. Neither `permission_mode`
 *  nor `coding_agent` has a column-level CHECK constraint (unlike `flavor`/`status`), so
 *  this is the only thing keeping junk out of two fields Phase 2 will branch on. */
function validateCommonFields(b: RoutineBody): string | null {
  if (b.permissionMode !== undefined && b.permissionMode !== 'auto' && b.permissionMode !== 'plan' && b.permissionMode !== 'ask') {
    return 'permissionMode must be "auto", "plan" or "ask".'
  }
  if (b.codingAgent !== undefined && b.codingAgent !== 'pi' && b.codingAgent !== 'claude_cli') {
    return 'codingAgent must be "pi" or "claude_cli".'
  }
  if (b.scheduleRule !== undefined) return validateScheduleRule(b.scheduleRule)
  return null
}

/** Exported (Phase 4) so the `create_routine` tool executor runs the IDENTICAL create-time
 *  validation this route does — flavor-dependent invariants included — instead of a second copy. */
export function validateCreate(b: RoutineBody): string | null {
  if (b.flavor !== 'chat' && b.flavor !== 'code') return 'flavor must be "chat" or "code".'
  if (!b.prompt?.trim()) return 'prompt is required.'
  if (!b.scheduleDisplay?.trim()) return 'scheduleDisplay is required.'
  if (!b.scheduleRule) return 'scheduleRule is required.'
  if (!b.modelKey?.trim()) return 'modelKey is required.'
  if (b.flavor === 'chat' && !b.agentId?.trim()) return 'agentId is required for a chat-flavor routine.'
  if (b.flavor === 'code' && !b.workspacePath?.trim()) return 'workspacePath is required for a code-flavor routine.'
  if (b.flavor === 'code' && b.codingAgent !== 'pi' && b.codingAgent !== 'claude_cli') return 'codingAgent must be "pi" or "claude_cli" for a code-flavor routine.'
  return validateCommonFields(b)
}

/** Update-time counterpart of {@link validateCreate}. Only fields actually present in the
 *  PUT body are checked; flavor-dependent invariants are re-checked against the routine's
 *  CURRENT flavor (which PUT cannot change) rather than the request body alone.
 *
 *  Exported (Phase 4) for the same reason as {@link validateCreate}: the `update_routine` tool
 *  executor applies the same patch this route does, so it must clear the same bar — notably
 *  `validateCommonFields`'s `scheduleRule` check, without which a tool-supplied malformed rule
 *  would reach `computeNextFireTime` and throw out of the scheduler tick. */
export function validateUpdate(b: RoutineBody, current: Routine): string | null {
  if (b.prompt !== undefined && !b.prompt.trim()) return 'prompt cannot be empty.'
  if (current.flavor === 'code' && b.workspacePath !== undefined && !b.workspacePath.trim()) {
    return 'workspacePath cannot be empty for a code-flavor routine.'
  }
  return validateCommonFields(b)
}

/** codeAuth's decision (auth.ts), applied inline instead of as middleware. `/api/v1/code/*`
 *  is mounted behind `codeAuth` because it runs real bash/edit/write against the user's
 *  filesystem; a `flavor: 'code'` routine schedules exactly that capability, unattended and
 *  on a timer, so creating or editing one has to clear the same bar. It cannot be a mounted
 *  middleware here: `/api/v1/routines*` also serves chat routines, which stay on the
 *  baseline lanAuth gate — only the code-flavor requests are gated, hence a handler-level
 *  branch over the identical `isLocalRequest || verifyPresentedKey` check (the same shape
 *  terminal-routes.ts uses for its raw WebSocket upgrade, for the same reason).
 *
 *  SCOPE (was a SPEC-GAP, 00-conventions.md §8 — now CLOSED, X2). This gate used to cover
 *  create/update only, and this comment deferred confirm/resume on one explicit condition:
 *  "none of that executes anything in Phase 1 (there is no execution yet), but Phase 2 turns
 *  `active` into real unattended code execution … an open decision for whoever ships Phase 2's
 *  execution". That condition is no longer true — Phase 2/3 shipped execution (`execute.ts`,
 *  wired into the scheduler with the real `executeRoutine` in `cli.ts`), and `scheduler.tick()`
 *  fires every due `active` routine with NO authorization check of any kind. So arming a
 *  host-authored code routine is now equivalent to firing it, delayed by at most one tick, and
 *  the deferred decision is resolved: /confirm, /pause and /resume all carry the identical gate,
 *  alongside POST /routines, PUT /:id, POST /:id/run-now and the run /approve + /deny pair.
 *  Still deliberately ungated: DELETE /:id (destructive, but it executes nothing) and the GETs
 *  (they disclose `workspacePath`; gating them is a separate, still-open decision — and if it is
 *  ever taken, the 404-before-401 ordering here and in `routine-tools.ts` has to be flipped in
 *  the same pass or the gating buys nothing, since the lookup itself is an existence oracle).
 *
 *  Exported (Phase 4) so chat's tool surface enforces the IDENTICAL decision rather than a
 *  hand-copied `isLocalRequest || verifyPresentedKey` that could silently drift from this one:
 *  `POST /api/v1/conversations/:id/messages` is behind `lanAuth` only, so without it a keyless
 *  LAN caller refused at the REST route could just ask the chat model to author the code routine
 *  for them instead. chat-routes.ts inverts it (`!codeGateBlocks(c, d)`) into the
 *  `isCodeAuthorized` boolean routine-tools.ts's executors take. */
export function codeGateBlocks(c: Context, d: Deps): boolean {
  return !isLocalRequest(c, d) && !verifyPresentedKey(c, d)
}

/** Exported (Phase 4) so `routine-tools.ts`'s code-flavor gate refuses with the IDENTICAL wording
 *  this route does — one message for one security property, on both the REST and the tool surface. */
export const CODE_GATE_MESSAGE = 'A valid API key is required to schedule a Code routine from a non-host device.'

export function registerRoutineRoutes(app: Hono, d: Deps): void {
  app.get('/api/v1/routines', (c) => c.json(d.db.listRoutines()))

  app.get('/api/v1/routines/:id', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    return c.json(routine)
  })

  app.get('/api/v1/routines/:id/runs', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    return c.json(d.db.listRoutineRuns(routine.id))
  })

  app.post('/api/v1/routines', async (c) => {
    const b = await body<RoutineBody>(c)
    // Auth before validation, so an ungated caller learns nothing about the request shape.
    if (b.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    const problem = validateCreate(b)
    if (problem) return err(c, 400, 'invalid_routine', problem)
    const routine = d.db.createRoutine({
      flavor: b.flavor!, prompt: b.prompt!.trim(), scheduleDisplay: b.scheduleDisplay!.trim(),
      scheduleRule: b.scheduleRule!, modelKey: b.modelKey!.trim(), agentId: b.agentId,
      workspacePath: b.workspacePath, codingAgent: b.codingAgent, permissionMode: b.permissionMode,
    })
    return c.json(routine, 201)
  })

  app.put('/api/v1/routines/:id/confirm', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    // X2: /confirm is the door INTO 'active', and an active code routine is fired by the very
    // next scheduler tick with no authorization check anywhere in scheduler.ts — so arming one is
    // the same capability /run-now already gates, just deferred by up to DEFAULT_TICK_INTERVAL_MS.
    // Same ordering as /run-now: 404 before 401, gate before the status check.
    if (routine.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    if (routine.status !== 'pending_confirmation') return err(c, 409, 'not_pending', 'Routine is not awaiting confirmation.')
    const nextFireAt = computeNextFireTime(routine.scheduleRule, new Date()).toISOString()
    return c.json(d.db.confirmRoutine(routine.id, nextFireAt))
  })

  app.put('/api/v1/routines/:id', async (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    const b = await body<RoutineBody>(c)
    // PUT cannot change `flavor` today, so the stored one decides; `b.flavor` is checked too
    // so this stays correct if a later phase ever makes the field mutable.
    if ((routine.flavor === 'code' || b.flavor === 'code') && codeGateBlocks(c, d)) {
      return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    }
    const problem = validateUpdate(b, routine)
    if (problem) return err(c, 400, 'invalid_routine', problem)
    const patch: Parameters<typeof d.db.updateRoutine>[1] = {}
    if (b.prompt !== undefined) patch.prompt = b.prompt.trim()
    if (b.scheduleDisplay !== undefined) patch.scheduleDisplay = b.scheduleDisplay.trim()
    if (b.scheduleRule !== undefined) {
      patch.scheduleRule = b.scheduleRule
      if (routine.status === 'active') patch.nextFireAt = computeNextFireTime(b.scheduleRule, new Date()).toISOString()
    }
    if (b.modelKey !== undefined) patch.modelKey = b.modelKey.trim()
    if (b.workspacePath !== undefined) patch.workspacePath = b.workspacePath
    if (b.codingAgent !== undefined) patch.codingAgent = b.codingAgent
    if (b.permissionMode !== undefined) patch.permissionMode = b.permissionMode
    return c.json(d.db.updateRoutine(routine.id, patch))
  })

  app.put('/api/v1/routines/:id/pause', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    // X2: gated for symmetry, and because /pause is load-bearing for the "confirm is the only
    // door into 'active'" invariant below — leaving the pause half of the pause/resume pair open
    // to a keyless LAN caller would mean the state machine that guards arming is only half
    // protected. It also stops an unauthenticated caller silently disabling a code routine the
    // host is relying on. Same ordering as /run-now: 404 before 401, gate before the status check.
    if (routine.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    // Guarding on 'active' is what keeps /confirm the ONLY door into 'active': without it,
    // pending_confirmation -> pause -> resume walks a never-confirmed routine straight to
    // active, since /resume only checks for 'paused'.
    if (routine.status !== 'active') return err(c, 409, 'not_active', 'Routine is not active.')
    return c.json(d.db.updateRoutine(routine.id, { status: 'paused', nextFireAt: null }))
  })

  app.put('/api/v1/routines/:id/resume', (c) => {
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    // X2: the second door into 'active', and the more realistic one — a host who set up a code
    // routine and paused it leaves exactly the state this route re-arms. Same gate, same ordering.
    if (routine.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    if (routine.status !== 'paused') return err(c, 409, 'not_paused', 'Routine is not paused.')
    const nextFireAt = computeNextFireTime(routine.scheduleRule, new Date()).toISOString()
    return c.json(d.db.updateRoutine(routine.id, { status: 'active', nextFireAt }))
  })

  app.delete('/api/v1/routines/:id', (c) => {
    if (!d.db.deleteRoutine(c.req.param('id'))) return err(c, 404, 'not_found', 'Routine not found.')
    return c.json({ ok: true })
  })

  app.post('/api/v1/routines/:id/run-now', (c) => {
    if (!d.routineScheduler) return err(c, 503, 'scheduler_unavailable', 'The routine scheduler is not running.')
    // Fetch the routine ourselves (rather than letting RoutineScheduler.runNow's own lookup be
    // the only one) so the code-flavor gate (I2 fix) can be applied before anything fires: a
    // manual trigger on a flavor:'code' routine runs real bash/edit/write on demand, exactly the
    // capability create/update already gate behind codeAuth — leaving run-now/approve/deny
    // ungated would be strictly worse than the create/update case.
    const routine = d.db.getRoutine(c.req.param('id'))
    if (!routine) return err(c, 404, 'not_found', 'Routine not found.')
    if (routine.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    const result = d.routineScheduler.runNow(routine.id)
    if (!result.ok) {
      if (result.reason === 'not_found') return err(c, 404, 'not_found', 'Routine not found.')
      if (result.reason === 'not_confirmed') return err(c, 409, 'not_confirmed', 'Routine has not been confirmed yet.')
      return err(c, 409, 'already_running', 'This routine already has a run in progress.')
    }
    return c.json({ ok: true }, 202)
  })

  app.post('/api/v1/routines/:id/runs/:runId/approve', async (c) => {
    const run = d.db.getRoutineRun(c.req.param('runId'))
    if (!run || run.routineId !== c.req.param('id')) return err(c, 404, 'not_found', 'Run not found.')
    // routine_runs cascades on routine delete, so `run` existing guarantees its routine still
    // does too — this is a live lookup (not the run's own configSnapshot) so it reflects the
    // CURRENT flavor, matching create/update's gate.
    const routine = d.db.getRoutine(run.routineId)
    if (routine?.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    let result: ResumeResult
    try {
      result = await resumeRoutineRun(d, run, 'allow')
    } catch (e) {
      return internalError(c, run.id, e)
    }
    releaseParkedIfResolved(d, run, result)
    if (!result.ok) return err(c, 409, result.code, result.message)
    return c.json({ ok: true })
  })

  app.post('/api/v1/routines/:id/runs/:runId/deny', async (c) => {
    const run = d.db.getRoutineRun(c.req.param('runId'))
    if (!run || run.routineId !== c.req.param('id')) return err(c, 404, 'not_found', 'Run not found.')
    const routine = d.db.getRoutine(run.routineId)
    if (routine?.flavor === 'code' && codeGateBlocks(c, d)) return err(c, 401, 'unauthorized', CODE_GATE_MESSAGE)
    let result: ResumeResult
    try {
      result = await resumeRoutineRun(d, run, 'deny')
    } catch (e) {
      return internalError(c, run.id, e)
    }
    releaseParkedIfResolved(d, run, result)
    if (!result.ok) return err(c, 409, result.code, result.message)
    return c.json({ ok: true })
  })
}

type ResumeResult = Awaited<ReturnType<typeof resumeRoutineRun>>

/** I3 fix: resumeRoutineRun re-throws (after reverting its claim — see its own doc comment) on a
 *  genuine internal error (e.g. an unexpected failure from the underlying runner plumbing), which
 *  used to escape /approve and /deny as a raw, unshaped Hono 500 instead of this file's
 *  `{error:{code,message}}` envelope convention every other route follows. The parked-guard
 *  behavior on this path is already correct without any extra handling — the claim was reverted,
 *  so the run is genuinely still 'needs_approval' and must stay parked, and `releaseParkedIfResolved`
 *  is simply never called on this path (there's no `result` to evaluate). */
function internalError(c: Context, runId: string, e: unknown) {
  console.error(`[routine-routes] resumeRoutineRun threw for run ${runId}:`, e)
  return err(c, 500, 'internal_error', e instanceof Error ? e.message : String(e))
}

/** resumeRoutineRun's own failure codes that leave the SAME run legitimately still awaiting a
 *  decision, and must therefore NEVER release the scheduler's parked guard:
 *
 *  - 'not_stalled': the run wasn't 'needs_approval' when checked. This covers two cases the
 *    return code alone can't distinguish — the run already resolved via a DIFFERENT call (in
 *    which case THAT call already released, or will), or (the C1 regression a live-execution
 *    review confirmed) a CONCURRENT call for the SAME run just claimed it and is still actively
 *    resolving it. Either way, this call releasing is either redundant or actively wrong — never
 *    releasing here is always safe: the actual resolver's own call handles the real release.
 *  - 'gate_timeout' / 'model_busy' / 'model_unavailable': the claim is reverted (execute.ts's
 *    `revertClaim`) back to 'needs_approval' specifically so the user can just retry approving
 *    shortly — releasing here would let a concurrent scheduled tick fire a SECOND run for the
 *    same routine while this one is still sitting there un-decided. */
const NON_RELEASING_RESUME_FAILURE_CODES = new Set(['not_stalled', 'gate_timeout', 'model_busy', 'model_unavailable'])

/** Closes the double-fire hole scheduler.ts's own doc comment on `RoutineSchedulerDeps.
 *  runRoutine` describes: a routine that stalls awaiting approval is kept in the scheduler's
 *  `inFlight`/`parked` state (see scheduler.ts) so a tick can't fire it again while parked, but
 *  nothing else can ever clear that guard, since `resumeRoutineRun` (Task 8) is invoked directly
 *  by this file's /approve and /deny handlers, never through the scheduler's own tick()/runRoutine
 *  path. Called after EVERY resumeRoutineRun call that actually returned (approve or deny), but it
 *  only actually releases the scheduler's guard when `run.id` has genuinely stopped needing a
 *  decision:
 *
 *  - A code in `NON_RELEASING_RESUME_FAILURE_CODES` leaves the SAME run legitimately parked
 *    (see that set's own doc comment) — must NOT release.
 *  - Otherwise, a genuinely unrecoverable failure (e.g. 'corrupt_pending_call') DOES need to
 *    release, or the routine would be stuck unable to ever fire again — the concern the task
 *    brief's "even a denied/failed resume must release the parked slot" flags. (`execute.ts`'s
 *    `resumeRoutineRun` now also moves a `corrupt_pending_call` run to a real terminal 'errored'
 *    state instead of leaving it at 'needs_approval' forever, so this case no longer keeps
 *    re-triggering on every retry either.)
 *  - A successful resume (`result.ok`) that dispatched a real continuation can itself re-park
 *    the run on a second/chained tool-call approval (chat-runner.ts/code-runner.ts's resume
 *    paths, covered by their own tests) — re-read the run FRESH from the DB (never trust the
 *    caller's possibly-stale `run` argument) and skip releasing when it did.
 *
 *  Passes `run.id` (not just `run.routineId`) to `RoutineScheduler.releaseParked` — the guard is
 *  RUN-scoped (see scheduler.ts), specifically so a stale, duplicate, or wrong-run approve/deny
 *  can never release a DIFFERENT, currently-executing fire's guard (the C2 regression a
 *  live-execution review confirmed against the routine-scoped-only first cut).
 *
 *  A no-op when there is no scheduler configured (route-level tests that don't wire one, or a
 *  build where the scheduler never started). */
function releaseParkedIfResolved(d: Deps, run: RoutineRun, result: ResumeResult): void {
  if (!d.routineScheduler) return
  if (!result.ok && NON_RELEASING_RESUME_FAILURE_CODES.has(result.code)) return
  if (result.ok) {
    const fresh = d.db.getRoutineRun(run.id)
    if (fresh?.status === 'needs_approval') return
  }
  d.routineScheduler.releaseParked(run.routineId, run.id)
}
