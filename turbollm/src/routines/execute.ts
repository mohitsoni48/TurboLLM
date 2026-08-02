// turbollm/src/routines/execute.ts
//
// The real Chat/in-app-pi Routine execution orchestrator (replaces Phase 1's "not implemented
// yet" stub) plus the approve/deny resume entry point routine-routes.ts's new endpoints
// (Task 9) call into.
//
// `executeRoutine`'s signature is `(d, routine, run) => Promise<RoutineRunStatus>`, matching
// scheduler.ts's ACTUAL, already-shipped, already-tested `RoutineSchedulerDeps.runRoutine`
// contract exactly (confirmed by reading scheduler.ts directly, not assumed): the scheduler
// creates `run` itself in tick() BEFORE calling runRoutine(routine, run), and it is fine for the
// scheduler's own generic `.then()` handler to redundantly write the SAME terminal
// `{status, endedAt}` this file already wrote more specifically (with `skipReason`/`result`/
// `error` fields the scheduler's handler doesn't know about) — updateRoutineRun's dynamic patch
// only touches the fields present in a given call, so a second `{status, endedAt}` write never
// clobbers an earlier, more specific one. This file therefore both writes the row's terminal
// state itself (for the specific fields only it knows, e.g. skipReason) AND returns the
// RoutineRunStatus it wrote, satisfying the caller's contract either way.
import type { Deps } from '../deps'
import type { Routine, RoutineRun, RoutineRunStatus } from './schema'
import { withPinnedModel, type ModelSwapOutcome } from './model-swap'
import { createRunDeadline } from './runaway-guard'
import { runChatRoutine, resumeChatRoutine, type ChatRunOutcome } from './chat-runner'
import { runCodeRoutine, resumeCodeRoutine, type CodeRunOutcome } from './code-runner'
import { parsePendingToolCall } from './approval'

type RoutineOutcome = ChatRunOutcome | CodeRunOutcome

async function dispatchRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal): Promise<RoutineOutcome> {
  if (routine.flavor === 'chat') return runChatRoutine(d, routine, run, signal)
  if (routine.flavor === 'code' && routine.codingAgent === 'pi') return runCodeRoutine(d, routine, run, signal)
  // CLI-flavor Code Routines (codingAgent: 'claude_cli') land here once Phase 3
  // (docs/superpowers/plans/2026-08-01-routine-phase3-cli-execution.md) is implemented — that
  // plan's own Task 8 note says its `runCliCodeRoutine` is a fully self-contained orchestrator
  // (own model-conflict handling) and should NOT be nested inside this phase's withPinnedModel
  // wrapper; wire it as its own top-level branch in executeRoutine below instead of inside this
  // function.
  return { status: 'errored', error: `Routine execution for flavor "${routine.flavor}"/codingAgent "${routine.codingAgent ?? 'none'}" is not implemented yet.` }
}

async function dispatchResume(d: Deps, routine: Routine, run: RoutineRun, pending: NonNullable<ReturnType<typeof parsePendingToolCall>>, decision: 'allow' | 'deny', signal: AbortSignal): Promise<RoutineOutcome> {
  if (routine.flavor === 'chat') return resumeChatRoutine(d, routine, run, pending, decision, signal)
  return resumeCodeRoutine(d, routine, run, pending, decision, signal)
}

/** Writes the run's terminal state for a dispatch outcome and returns the RoutineRunStatus it
 *  wrote (or, for 'needs_approval', the status the runner itself already persisted via
 *  stallRoutineRun — nothing to write here). */
function finalizeOutcome(d: Deps, runId: string, outcome: RoutineOutcome): RoutineRunStatus {
  if (outcome.status === 'needs_approval') return 'needs_approval' // already persisted by the runner itself (stallRoutineRun)
  const endedAt = new Date().toISOString()
  if (outcome.status === 'ok') {
    d.db.updateRoutineRun(runId, { status: 'ok', result: outcome.result, endedAt })
    return 'ok'
  }
  d.db.updateRoutineRun(runId, { status: 'errored', error: outcome.error, endedAt })
  return 'errored'
}

/** Writes the run's terminal state for a non-'ran' model-swap outcome and returns the
 *  RoutineRunStatus it wrote. For 'ran', `finalizeOutcome` already wrote (or the runner itself
 *  already stalled) inside the wrapped fn() — `ranStatus` is that already-computed value,
 *  returned as-is. */
function finalizeSwapOutcome(d: Deps, runId: string, swap: ModelSwapOutcome, ranStatus: RoutineRunStatus): RoutineRunStatus {
  if (swap.outcome === 'ran') return ranStatus
  const endedAt = new Date().toISOString()
  if (swap.outcome === 'skip-busy') {
    d.db.updateRoutineRun(runId, { status: 'skipped', skipReason: 'model_busy', endedAt })
    return 'skipped'
  }
  d.db.updateRoutineRun(runId, { status: 'errored', error: swap.message, endedAt })
  return 'errored'
}

/** The real Chat/in-app-pi Routine executor (spec 20 §5) — the real `RoutineSchedulerDeps.runRoutine`
 *  (Phase 2), wired in cli.ts (Task 10). The scheduler has already created `run` (status
 *  'running') before calling this; this function only decides which terminal RoutineRunStatus
 *  the fire reached (writing its own more-specific fields — skipReason, result, error,
 *  pendingToolCall — along the way) and returns it, matching scheduler.ts's own doc comment on
 *  `RoutineSchedulerDeps.runRoutine` exactly. Acquires GenerationGate at 'bg' priority (spec 20
 *  §5: a routine never preempts foreground chat/Code), resolves the model-conflict decision, and
 *  dispatches to the flavor-specific runner. */
export async function executeRoutine(d: Deps, routine: Routine, run: RoutineRun): Promise<RoutineRunStatus> {
  // CLI-flavor Code Routines: see dispatchRoutine's own comment — this is a deliberate top-level
  // sibling branch, not nested in the swap/gate flow below (Phase 3's runCliCodeRoutine will own
  // its own model-conflict handling once it lands).
  if (routine.flavor === 'code' && routine.codingAgent === 'claude_cli') {
    d.db.updateRoutineRun(run.id, { status: 'errored', error: 'CLI-flavor Code Routine execution is not implemented yet (Phase 3).', endedAt: new Date().toISOString() })
    return 'errored'
  }

  const deadline = createRunDeadline()
  try {
    let release: (() => void) | undefined
    try {
      if (d.gate) release = await d.gate.acquire('bg', { signal: deadline.signal })
    } catch {
      d.db.updateRoutineRun(run.id, { status: 'skipped', skipReason: 'gate_timeout', endedAt: new Date().toISOString() })
      return 'skipped'
    }
    try {
      let ranStatus: RoutineRunStatus = 'errored'
      const swap = await withPinnedModel({ manager: d.manager, modelRouter: d.modelRouter }, routine.modelKey, async () => {
        const outcome = await dispatchRoutine(d, routine, run, deadline.signal)
        ranStatus = finalizeOutcome(d, run.id, outcome)
      })
      return finalizeSwapOutcome(d, run.id, swap, ranStatus)
    } finally {
      release?.()
    }
  } finally {
    deadline.cancel()
  }
}

/** Resume a stalled run after an approve/deny decision (routine-routes.ts's new .../approve and
 *  .../deny endpoints, Task 9). Never called by scheduler.ts's tick()/runNow() — a standalone
 *  entry point Task 9's REST routes call directly with a `run` they already fetched via
 *  `d.db.getRoutineRun(...)`, hence its different (non-RoutineSchedulerDeps) shape. Re-derives
 *  the routine from the run's OWN configSnapshot — never the live Routine row — per spec 20 §6's
 *  "resumes with its original snapshot, not a later edit" rule.
 *
 *  Idempotency (verified real gap flagged by Task 7's own review, progress.md's "Task 7: minor
 *  (deferred)" entry: "resumeCodeRoutine's 'allow' path is not idempotent... flagged for Task
 *  8/9's caller-side wiring to guard against"): neither chat-runner.ts nor code-runner.ts move a
 *  run's status away from 'needs_approval' before their own execution completes, so a naive
 *  "check status, then dispatch" here would let a double-clicked Approve button, a retried
 *  request, or a race in the caller start TWO independent continuation turns for the same
 *  approved action. Guarded here by re-reading the run FRESH from the DB (never trusting the
 *  caller's possibly-stale `run` argument) and, in the same synchronous stretch — no `await` in
 *  between, and node:sqlite's DatabaseSync is fully synchronous with Node single-threaded, so
 *  nothing else can interleave — flipping its status away from 'needs_approval' to CLAIM it
 *  before any async work starts. A second concurrent call for the same run id then sees a
 *  non-'needs_approval' status and fails cleanly with 'not_stalled' instead of double-dispatching.
 *  If the claim is made but dispatch never actually runs (gate timeout, model busy, model load
 *  failed, or dispatch throwing outright), the claim is reverted so the run can still be retried
 *  later. */
export async function resumeRoutineRun(d: Deps, run: RoutineRun, decision: 'allow' | 'deny'): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const current = d.db.getRoutineRun(run.id)
  if (!current || current.status !== 'needs_approval') return { ok: false, code: 'not_stalled', message: 'This run is not awaiting approval.' }
  const pending = parsePendingToolCall(current.pendingToolCall)
  if (!pending) return { ok: false, code: 'corrupt_pending_call', message: "This run's pending tool call could not be read." }
  const routine = JSON.parse(current.configSnapshot) as Routine

  // Claim the run (see this function's doc comment) before any await — this is what makes a
  // concurrent second call fail cleanly instead of double-executing the approved action.
  d.db.updateRoutineRun(current.id, { status: 'running' })
  const revertClaim = () => d.db.updateRoutineRun(current.id, { status: 'needs_approval' })

  const deadline = createRunDeadline()
  try {
    let release: (() => void) | undefined
    try {
      if (d.gate) release = await d.gate.acquire('bg', { signal: deadline.signal })
    } catch {
      revertClaim()
      return { ok: false, code: 'gate_timeout', message: 'Timed out waiting for the model server.' }
    }
    try {
      const swap = await withPinnedModel({ manager: d.manager, modelRouter: d.modelRouter }, routine.modelKey, async () => {
        const outcome = await dispatchResume(d, routine, current, pending, decision, deadline.signal)
        finalizeOutcome(d, current.id, outcome)
      })
      if (swap.outcome === 'skip-busy') { revertClaim(); return { ok: false, code: 'model_busy', message: 'The model server is busy — try approving again shortly.' } }
      if (swap.outcome === 'skip-load-failed') { revertClaim(); return { ok: false, code: 'model_unavailable', message: swap.message } }
      return { ok: true }
    } catch (e) {
      // dispatchResume/withPinnedModel threw instead of resolving to an outcome (e.g. a
      // genuinely unexpected error from the underlying subscribe()/fetch plumbing) — the claim
      // above must still be undone, or this run is permanently stuck at 'running' with no way to
      // ever retry it, which is strictly worse than the pre-claim behavior this fix replaces.
      revertClaim()
      throw e
    } finally {
      release?.()
    }
  } finally {
    deadline.cancel()
  }
}
