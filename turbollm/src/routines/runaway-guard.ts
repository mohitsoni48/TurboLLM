// Runaway/loop protection shared by both this phase's execution paths (spec 20 §6): a hard
// wall-clock timeout via AbortController, plus a re-export of Code's existing consecutive-
// identical-tool-call breaker (agent-loop-rules.ts) for the Chat-flavor runner, which — unlike
// the in-app-pi path — does not get that protection for free (see this task's own investigation
// note above).
export { ToolLoopTracker, LOOP_BREAK_AFTER, LOOP_ABORT_AFTER, toolCallSignature } from '../code/agent-loop-rules'

/** Hard wall-clock ceiling for one routine run/resume (both flavors this phase owns). 10
 *  minutes: generous for a handful of local-model tool round-trips (a routine has no human
 *  narrating urgency), while still bounding the worst case a genuinely stuck run can cost.
 *  Includes any time spent queued behind foreground GenerationGate traffic — a routine that
 *  spends its whole budget waiting its turn and never gets to run is exactly the "don't run
 *  forever" case this guards, not just "don't loop forever once running."
 *
 *  Phase 3's plan (`docs/superpowers/plans/2026-08-01-routine-phase3-cli-execution.md`)
 *  independently picked the SAME 600_000ms value for its own `CLI_ROUTINE_TIMEOUT_MS`
 *  (`cli-process.ts`), before this plan existed to reconcile against — see this plan's own
 *  Self-review notes for the follow-up to point that constant at this one instead of keeping
 *  two independent copies of the same number. */
export const ROUTINE_RUN_TIMEOUT_MS = 10 * 60_000

/** An AbortController that self-aborts after `timeoutMs`, with a `cancel()` to clear the timer
 *  once the run finishes normally — so a completed run's timer never fires later, and so the
 *  timer never keeps the process alive (`.unref()`'d, matching every other scheduler timer in
 *  this codebase). `reason` lets a caller tell a timeout apart from a user/system abort. */
export interface RunDeadline {
  signal: AbortSignal
  cancel: () => void
}

export function createRunDeadline(timeoutMs: number = ROUTINE_RUN_TIMEOUT_MS): RunDeadline {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('routine_run_timeout')), timeoutMs)
  timer.unref()
  return { signal: ac.signal, cancel: () => clearTimeout(timer) }
}
