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
import { createRunDeadline, ROUTINE_RUN_TIMEOUT_MS } from './runaway-guard'
import { runChatRoutine, resumeChatRoutine, type ChatRunOutcome } from './chat-runner'
import { runCodeRoutine, resumeCodeRoutine, type CodeRunOutcome } from './code-runner'
import { parsePendingToolCall } from './approval'
import { runCliCodeRoutine, type CliRoutineDeps } from './cli-routine'
import { isClaudeCliAvailable } from './cli-preflight'
import { realSpawnCliProcess, runClaudeCliProcess } from './cli-process'
import { claudePermissionModeChoices } from '../terminal/agent-modes'
import { engineIsIdle } from '../engines/update-scheduler'
import type { GenerationGate } from '../agents/gate'
import { runCliInteractiveRoutine, type CliInteractiveDeps } from './cli-interactive-runner'
import { createAgentTerminal, getTerminalManager } from '../terminal/terminal-routes'

type RoutineOutcome = ChatRunOutcome | CodeRunOutcome

async function dispatchRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal): Promise<RoutineOutcome> {
  if (routine.flavor === 'chat') return runChatRoutine(d, routine, run, signal)
  if (routine.flavor === 'code' && routine.codingAgent === 'pi') return runCodeRoutine(d, routine, run, signal)
  // CLI-flavor Code Routines (codingAgent: 'claude_cli') are deliberately NOT handled here:
  // `runCliCodeRoutine` is a fully self-contained orchestrator (own model-conflict handling, own
  // terminal-state writes) and must not be nested inside this phase's withPinnedModel wrapper or
  // its blocking gate acquisition. It is wired as a top-level sibling branch in `executeRoutine`
  // below (see `runCliRoutineBranch`), so this function is never reached for that combination.
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

/** The gate snapshot used by the CLI branch when no GenerationGate is wired at all (`Deps.gate` is
 *  optional — absent under tests and in any embedder that doesn't build one). Reports "nothing in
 *  flight, unbounded capacity", i.e. the gate half of cli-routine.ts's AND-ed busy-check simply
 *  abstains; `getEngineIdle()` — the load-bearing half, which is what actually observes a live
 *  foreground chat turn — still guards the swap on its own. This mirrors how the rest of this file
 *  treats a missing gate (`if (d.gate)` below), and is never used when a real gate exists. */
const ABSENT_GATE = { stats: () => ({ inFlight: 0, queued: 0, capacity: Infinity }) } as unknown as GenerationGate

/** CLI-flavor Code Routines (`codingAgent: 'claude_cli'`, Phase 3). Builds `runCliCodeRoutine`'s
 *  dependency bundle from the daemon's real `Deps` and returns the terminal status the run
 *  actually reached.
 *
 *  Two things here are load-bearing and easy to get subtly wrong:
 *   - `getEngineIdle` MUST be `engineIsIdle(d.manager)` (the same call model-swap.ts makes for the
 *     Chat/pi path), NOT a `gate.stats()` read: only the Manager's `activeRequests` counter sees
 *     the main in-app chat stream (`chat-routes.ts`'s `manager.generationStart()`), which never
 *     touches the gate. Substituting the gate here would let a routine hot-swap the model out from
 *     under a live foreground chat — exactly what spec 20 §5 forbids. cli-routine.ts's own
 *     `getEngineIdle` doc comment states this requirement explicitly.
 *   - `existingRun` MUST be the `run` the scheduler already created and handed to
 *     `executeRoutine`; without it `runCliCodeRoutine` would create a SECOND row and every fire
 *     would show up twice in the run history.
 *
 *  `runCliCodeRoutine` resolves to `void` and writes its own terminal state (with skipReason /
 *  result / error fields only it knows), unlike the outcome-returning Chat/pi runners — so the
 *  status is read back from the row to satisfy `executeRoutine`'s own return contract.
 *
 *  Exported, with `_runCli` as a default-parameter seam (same shape as cli-process.ts's `_spawn`/
 *  `_killTree` and cli-preflight.ts's `run`), purely so this wiring can be asserted in a test
 *  without spawning a real `claude` subprocess: the very first thing the real orchestrator does is
 *  probe the installed CLI, so there is no other way to cover the branch deterministically.
 *  `_timeoutMs` is the same kind of seam for the wall-clock race below, so the timeout path can be
 *  proven in milliseconds instead of ten minutes. */
export async function runCliRoutineBranch(
  d: Deps,
  routine: Routine,
  run: RoutineRun,
  _runCli: (routine: Routine, deps: CliRoutineDeps) => Promise<void> = runCliCodeRoutine,
  _timeoutMs: number = ROUTINE_RUN_TIMEOUT_MS,
): Promise<RoutineRunStatus> {
  const cliDeps: CliRoutineDeps = {
    store: d.db,
    gate: d.gate ?? ABSENT_GATE,
    getLoadedModelKey: () => d.manager.status().model?.key ?? null,
    getEngineIdle: () => engineIsIdle(d.manager),
    loadExplicit: (modelKey) => d.modelRouter.loadExplicit(modelKey),
    now: () => new Date(),
    port: d.store.snapshot().daemon.port,
    isAvailable: () => isClaudeCliAvailable(),
    permissionModeChoices: () => claudePermissionModeChoices(),
    runProcess: (args, opts) => runClaudeCliProcess(args, opts, realSpawnCliProcess),
    existingRun: run,
  }
  // Wall-clock ceiling (I2). This branch deliberately skips `createRunDeadline()` (see
  // executeRoutine's comment: the self-deadlock fix), which also removed the ONLY wall-clock
  // backstop on this path — and runCliCodeRoutine bounds its own SUBPROCESS
  // (CLI_ROUTINE_TIMEOUT_MS, step 4) but not its pre-spawn probes. `deps.isAvailable()` — its very
  // first await — bottoms out in cli-launch.ts's `realRunCommand`, which resolves only on the
  // child's 'error'/'exit' events and has no timer at all: one wedged `claude --version` leaves
  // this promise unsettled forever, which strands the run row at 'running' with no endedAt AND
  // permanently pins the routine in scheduler.ts's `inFlight` set, so it silently never fires
  // again. Racing here (rather than only timing out `realRunCommand`) restores the wall-clock
  // ceiling spec 20 §6 requires for EVERY execution path, and covers any future unbounded await
  // inside the orchestrator, not just today's probe.
  let timer: ReturnType<typeof setTimeout> | undefined
  const TIMED_OUT = Symbol('cli_routine_timeout')
  let raced: unknown
  try {
    raced = await Promise.race([
      _runCli(routine, cliDeps),
      new Promise<symbol>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), _timeoutMs); timer.unref() }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (raced === TIMED_OUT) {
    // The orchestrator has no idea it was raced against and may still be running, so nothing else
    // will ever write this row's terminal state — do it here, or losing the race just trades an
    // unsettled promise for a permanently-'running' row. Read first: the orchestrator may have
    // finished in the same tick the timer fired, and its own more specific outcome wins.
    const timedOutStatus = d.db.getRoutineRun(run.id)?.status
    if (timedOutStatus && timedOutStatus !== 'running') return timedOutStatus
    d.db.updateRoutineRun(run.id, { status: 'errored', error: `claude CLI routine exceeded the ${_timeoutMs}ms wall-clock limit before reporting a result.`, endedAt: new Date().toISOString() })
    return 'errored'
  }
  // runCliCodeRoutine never throws (its own try/catch covers the whole body and always writes a
  // terminal row), so a missing/still-'running' row here would be a genuine bug in it rather than
  // an expected state — 'errored' is the honest fallback either way. M1: `?? 'errored'` alone only
  // caught the MISSING row; 'running' is a real RoutineRunStatus member and would otherwise be
  // returned verbatim, making scheduler.ts's writeTerminalStatus stamp `{status:'running', endedAt}`.
  const status = d.db.getRoutineRun(run.id)?.status
  return status && status !== 'running' ? status : 'errored'
}

/** Kickoff-only bound for the interactive (live-terminal) CLI branch — see
 *  cli-interactive-runner.ts's own header for the full design. Deliberately much shorter than
 *  `runCliRoutineBranch`'s `_timeoutMs`: unlike the one-shot path, `runCliInteractiveRoutine`
 *  itself never waits for the CLI to finish, only for the terminal to be spawned — completion is
 *  a separate, later event (the agent-exited callback or `sweepInteractiveCliRuns`). If THIS
 *  bound fires, kickoff itself is genuinely stuck (the same class of unbounded-await risk
 *  `runCliRoutineBranch`'s own comment documents for its pre-spawn probes), not a routine still
 *  legitimately awaiting a human. */
const CLI_INTERACTIVE_KICKOFF_TIMEOUT_MS = 60_000

/** Interactive (ask/plan) half of CLI-flavor Code Routine execution — see
 *  cli-interactive-runner.ts's module header for why this is a separate path from
 *  `runCliRoutineBranch`'s one-shot `-p` execution, which stays exactly as-is for `auto`.
 *  Builds `CliInteractiveDeps` from the daemon's real `Deps`, wiring `createTerminal` to
 *  terminal-routes.ts's `createAgentTerminal` (the exact function `POST
 *  /api/v1/code/sessions/:sessionId/terminal` itself calls) so a routine's live terminal is
 *  spawned the SAME way a human's would be, just eagerly and server-side. `_runInteractive` is a
 *  default-parameter seam, same convention as `runCliRoutineBranch`'s `_runCli`. */
export async function runCliInteractiveBranch(
  d: Deps,
  routine: Routine,
  run: RoutineRun,
  _runInteractive: (routine: Routine, run: RoutineRun, deps: CliInteractiveDeps) => Promise<RoutineRunStatus> = runCliInteractiveRoutine,
  _timeoutMs: number = CLI_INTERACTIVE_KICKOFF_TIMEOUT_MS,
): Promise<RoutineRunStatus> {
  const tm = getTerminalManager(d)
  const interactiveDeps: CliInteractiveDeps = {
    store: d.db,
    gate: d.gate ?? ABSENT_GATE,
    getLoadedModelKey: () => d.manager.status().model?.key ?? null,
    getEngineIdle: () => engineIsIdle(d.manager),
    loadExplicit: (modelKey) => d.modelRouter.loadExplicit(modelKey),
    now: () => new Date(),
    isAvailable: () => isClaudeCliAvailable(),
    createTerminal: (agentRun, opts) => createAgentTerminal(d, agentRun, opts),
    isTerminalActive: (codeSessionId) => tm.isActive(codeSessionId),
    isAgentExited: (codeSessionId) => tm.isAgentExited(codeSessionId),
    getExitCode: (codeSessionId) => tm.getExitCode(codeSessionId),
    killTerminal: (codeSessionId) => tm.kill(codeSessionId),
    releaseParked: d.routineScheduler ? (routineId, runId) => d.routineScheduler!.releaseParked(routineId, runId) : undefined,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const TIMED_OUT = Symbol('cli_interactive_kickoff_timeout')
  let raced: unknown
  try {
    raced = await Promise.race([
      _runInteractive(routine, run, interactiveDeps),
      new Promise<symbol>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), _timeoutMs); timer.unref() }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (raced === TIMED_OUT) {
    const timedOutStatus = d.db.getRoutineRun(run.id)?.status
    if (timedOutStatus && timedOutStatus !== 'running') return timedOutStatus
    d.db.updateRoutineRun(run.id, { status: 'errored', error: `Starting the interactive claude CLI session exceeded the ${_timeoutMs}ms kickoff limit.`, endedAt: new Date().toISOString() })
    return 'errored'
  }
  return raced as RoutineRunStatus
}

/** The real Chat/in-app-pi Routine executor (spec 20 §5) — the real `RoutineSchedulerDeps.runRoutine`
 *  (Phase 2), wired in cli.ts (Task 10). The scheduler has already created `run` (status
 *  'running') before calling this; this function only decides which terminal RoutineRunStatus
 *  the fire reached (writing its own more-specific fields — skipReason, result, error,
 *  pendingToolCall — along the way) and returns it, matching scheduler.ts's own doc comment on
 *  `RoutineSchedulerDeps.runRoutine` exactly. Acquires GenerationGate at 'bg' priority (spec 20
 *  §5: a routine never preempts foreground chat/Code), resolves the model-conflict decision, and
 *  dispatches to the flavor-specific runner.
 *
 *  `_runCliBranch` is a default-parameter seam (I1), same pattern as `runCliRoutineBranch`'s own
 *  `_runCli` and cli-process.ts's `_spawn`/`_killTree`. It exists so the DISPATCH CONDITION itself
 *  — not just the branch body — is testable: without it, a regression that inverted the condition
 *  or mistyped the `codingAgent` literal would route every scheduled CLI-flavor fire to
 *  dispatchRoutine's "not implemented yet" error and still ship a green suite. The production call
 *  site (cli.ts's `runRoutine: (routine, run) => executeRoutine(deps, routine, run)`) passes three
 *  arguments, so the default applies there. */
export async function executeRoutine(
  d: Deps,
  routine: Routine,
  run: RoutineRun,
  _runCliBranch: typeof runCliRoutineBranch = runCliRoutineBranch,
  _runCliInteractiveBranch: typeof runCliInteractiveBranch = runCliInteractiveBranch,
): Promise<RoutineRunStatus> {
  // CLI-flavor Code Routines: see dispatchRoutine's own comment — a deliberate top-level sibling
  // branch that returns immediately, never nested in the swap/gate flow below, because
  // runCliCodeRoutine owns its own model-conflict handling and must not sit inside a blocking
  // gate acquisition (cli-routine.ts's "the busy-check NEVER calls gate.acquire()" design note
  // explains the self-deadlock that would otherwise be possible against a single-slot engine).
  // "auto" keeps the cheap, fully-automated one-shot `-p` path; "ask"/"plan" can actually hit a
  // permission prompt, so those go through the live-terminal path instead (cli-interactive-runner.ts).
  if (routine.flavor === 'code' && routine.codingAgent === 'claude_cli') {
    if (routine.permissionMode === 'ask' || routine.permissionMode === 'plan') {
      return _runCliInteractiveBranch(d, routine, run)
    }
    return _runCliBranch(d, routine, run)
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
  if (!pending) {
    // Permanently unresolvable (verified real gap found by a live-execution review of Task 9's
    // scheduler-side double-fire fix): no FUTURE approve/deny call could ever parse this
    // pendingToolCall either, since it's the same corrupt column value every time. Leaving the
    // row at 'needs_approval' would make it durably re-triggerable — every retry hits this exact
    // branch forever — and would leave `routine-routes.ts`'s scheduler-guard release logic with
    // no way to ever tell this run is done. Move it to a real terminal state instead. This point
    // is reached before the claim below, so there's nothing to revert, and a concurrent duplicate
    // call landing here too just performs the identical, idempotent write.
    const message = "This run's pending tool call could not be read."
    d.db.updateRoutineRun(current.id, { status: 'errored', error: message, endedAt: new Date().toISOString() })
    return { ok: false, code: 'corrupt_pending_call', message }
  }
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
