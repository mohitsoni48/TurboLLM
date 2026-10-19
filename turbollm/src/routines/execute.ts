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
import { withPinnedModel, type ModelSwapOutcome, type PinnedRoute, type SwapGate } from './model-swap'
import { createRunDeadline, ROUTINE_RUN_TIMEOUT_MS } from './runaway-guard'
import { runChatRoutine, resumeChatRoutine, type ChatRunOutcome } from './chat-runner'
import { runCodeRoutine, resumeCodeRoutine, type CodeRunOutcome } from './code-runner'
import { parsePendingToolCall } from './approval'
import { runCliCodeRoutine, type CliRoutineDeps } from './cli-routine'
import { isCliAvailable, isClaudeCliAvailable } from './cli-preflight'
import { cliBin } from '../cli-launch'
import { isTerminalCodingAgent, TERMINAL_CODE_AGENT } from './schema'

import { realSpawnCliProcess, runClaudeCliProcess } from './cli-process'
import { claudePermissionModeChoices } from '../terminal/agent-modes'
import { engineIsIdle } from '../engines/update-scheduler'
import type { GenerationGate } from '../agents/gate'
import { runCliInteractiveRoutine, closeInteractiveRun, terminalLookupsBySession, agentLabel, CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS, type CliInteractiveDeps } from './cli-interactive-runner'
import { createAgentTerminal, getTerminalManager } from '../terminal/terminal-routes'

/** The binary a terminal-harness routine needs installed. Falls back to `claude` for a routine with
 *  no terminal harness set, which is the only value that could reach here before this existed. */
function terminalHarnessBin(routine: Routine): string {
  if (!isTerminalCodingAgent(routine.codingAgent)) return 'claude'
  return cliBin(TERMINAL_CODE_AGENT[routine.codingAgent]) ?? 'claude'
}

type RoutineOutcome = ChatRunOutcome | CodeRunOutcome

/** `route`: where withPinnedModel's swap loaded the routine's model (see runChatRoutine). A pi Code routine's session
 *  does not take it: its turns go through resolveChatUpstream, which reads the primary. */
async function dispatchRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal, route?: PinnedRoute): Promise<RoutineOutcome> {
  if (routine.flavor === 'chat') return runChatRoutine(d, routine, run, signal, route)
  if (routine.flavor === 'code' && routine.codingAgent === 'pi') return runCodeRoutine(d, routine, run, signal)
  // CLI-flavor Code Routines (codingAgent: 'claude_cli') are deliberately NOT handled here:
  // `runCliCodeRoutine` is a fully self-contained orchestrator (own model-conflict handling, own
  // terminal-state writes) and must not be nested inside this phase's withPinnedModel wrapper or
  // its blocking gate acquisition. It is wired as a top-level sibling branch in `executeRoutine`
  // below (see `runCliRoutineBranch`), so this function is never reached for that combination.
  return { status: 'errored', error: `Routine execution for flavor "${routine.flavor}"/codingAgent "${routine.codingAgent ?? 'none'}" is not implemented yet.` }
}

async function dispatchResume(d: Deps, routine: Routine, run: RoutineRun, pending: NonNullable<ReturnType<typeof parsePendingToolCall>>, decision: 'allow' | 'deny', signal: AbortSignal, route?: PinnedRoute): Promise<RoutineOutcome> {
  if (routine.flavor === 'chat') return resumeChatRoutine(d, routine, run, pending, decision, signal, route)
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
  if (swap.outcome === 'skip-comfyui-busy') {
    d.db.updateRoutineRun(runId, { status: 'skipped', skipReason: 'comfyui_busy', endedAt })
    return 'skipped'
  }
  d.db.updateRoutineRun(runId, { status: 'errored', error: swap.message, endedAt })
  return 'errored'
}

/** How withPinnedModel treats the gate this run took (see executeRoutine): a chat routine keeps it
 *  for the whole run (undefined); a pi Code routine lets go of it before its session runs and takes
 *  it again for the restore, without the run's deadline: a run that hit it must still restore. */
function pinnedGate(d: Deps, routine: Routine, release: () => void): SwapGate | undefined {
  if (!d.gate || routine.flavor === 'chat') return undefined
  const gate = d.gate
  return { release, reacquire: () => gate.acquire('bg') }
}

/** The gate snapshot used by the CLI branch when no GenerationGate is wired at all (`Deps.gate` is
 *  optional — absent under tests and in any embedder that doesn't build one). Reports "nothing in
 *  flight, unbounded capacity", i.e. the gate half of cli-routine.ts's AND-ed busy-check simply
 *  abstains; `getEngineIdle()` — the load-bearing half, which is what actually observes a live
 *  foreground chat turn — still guards the swap on its own. This mirrors how the rest of this file
 *  treats a missing gate (`if (d.gate)` below), and is never used when a real gate exists. */
const ABSENT_GATE = { stats: () => ({ inFlight: 0, queued: 0, capacity: Infinity }) } as unknown as GenerationGate

/** Whether an auto-tune run holds the engine: every routine path treats it as busy (see withPinnedModel). A narrow
 *  Deps double with no BenchRunner has no tune running. */
function autotuneRunning(d: Deps): boolean {
  return d.bench?.isRunning() ?? false
}

/** The engine is free for a routine's swap: no in-app generation (engineIsIdle) and no auto-tune run. */
function engineFreeForRoutine(d: Deps): boolean {
  return engineIsIdle(d.manager) && !autotuneRunning(d)
}

/** CLI-flavor Code Routines (`codingAgent: 'claude_cli'`, Phase 3). Builds `runCliCodeRoutine`'s
 *  dependency bundle from the daemon's real `Deps` and returns the terminal status the run
 *  actually reached.
 *
 *  Two things here are load-bearing and easy to get subtly wrong:
 *   - `getEngineIdle` MUST read `engineIsIdle(d.manager)` (the same call model-swap.ts makes for
 *     the Chat/pi path), NOT a `gate.stats()` read: only the Manager's `activeRequests` counter
 *     sees the main in-app chat stream (`chat-routes.ts`'s `manager.generationStart()`), which never
 *     touches the gate. Substituting the gate here would let a routine hot-swap the model out from
 *     under a live foreground chat — exactly what spec 20 §5 forbids. cli-routine.ts's own
 *     `getEngineIdle` doc comment states this requirement explicitly. It is
 *     `engineFreeForRoutine(d)`: that call AND-ed with no auto-tune run, as on the Chat/pi path.
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
  const abandon = new AbortController()
  const cliDeps: CliRoutineDeps = {
    store: d.db,
    gate: d.gate ?? ABSENT_GATE,
    getLoadedModelKey: () => d.manager.status().model?.key ?? null,
    getEngineIdle: () => engineFreeForRoutine(d),
    loadExplicit: (modelKey, overrides, opts) => d.modelRouter.loadExplicit(modelKey, overrides, opts),
    reloadAfterRender: (modelKey, routineModelKey) => d.modelRouter.reloadAfterRender(modelKey, routineModelKey),
    now: () => new Date(),
    port: d.bindPort ?? d.store.snapshot().daemon.port, // the port really bound (`--port` wins over config)
    host: d.bindHost, // and the address: `--addr [::1]:6996` answers on no 127.0.0.1
    isAvailable: () => isClaudeCliAvailable(),
    permissionModeChoices: () => claudePermissionModeChoices(),
    runProcess: (args, opts) => runClaudeCliProcess(args, opts, realSpawnCliProcess),
    existingRun: run,
    runSignal: abandon.signal,
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
      // Deliberately NOT `.unref()`'d: this timer is the ONLY thing standing between a genuinely
      // wedged orchestrator call and a run row stranded at 'running' forever (see this function's
      // own comment above). Unref'ing it would let a shutdown-in-progress event loop decide "no
      // ref'd work left" and exit before the timer ever fires, in which case NEITHER promise in
      // this race would ever settle — the exact failure this timeout exists to prevent, and
      // reproduced live by a bare/isolated invocation (no other ref'd handles keeping the loop
      // alive) never firing the timer at all. Bounded by `_timeoutMs` either way, so this can only
      // ever delay a shutdown by that much, never block it.
      new Promise<symbol>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), _timeoutMs) }),
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
    // A model swap can outlast this bound, and the scheduler releases the routine once this
    // returns — stop the run from spawning the CLI later (or kill the one it already spawned) and
    // from overwriting this row.
    abandon.abort()
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
 *  legitimately awaiting a human. The model swap does not count against it (see
 *  runCliInteractiveBranch). */
const CLI_INTERACTIVE_KICKOFF_TIMEOUT_MS = 60_000

/** The idle TTL of an interactive routine's terminal: the run's own bound plus TerminalManager's
 *  default 5 minutes. The run's bound is measured from the run's start, which precedes the
 *  terminal's creation, so the sweep always reaches a parked run first. */
const ROUTINE_TERMINAL_IDLE_TTL_MS = CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS + 5 * 60_000

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
  const kickoff = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeOut = () => {}
  let kickoffSettled = false
  const armTimer = () => { clearTimeout(timer); timer = setTimeout(() => timeOut(), _timeoutMs) }
  const interactiveDeps: CliInteractiveDeps = {
    store: d.db,
    gate: d.gate ?? ABSENT_GATE,
    getLoadedModelKey: () => d.manager.status().model?.key ?? null,
    getEngineIdle: () => engineFreeForRoutine(d),
    // The kickoff bound is paused while a model loads, then re-armed in full for the steps after
    // it. A healthy load can take far longer than the bound (manager.ts allows each load
    // READINESS_TIMEOUT_MS, 600 s, and has seen a 65 GB model take over 120 s); counting it made
    // every fire of a routine pinned to such a model load it, throw it away, reload the previous
    // one and never start the CLI. The load is bounded by the manager itself.
    loadExplicit: async (modelKey, overrides, opts) => {
      clearTimeout(timer)
      try {
        return await d.modelRouter.loadExplicit(modelKey, overrides, opts)
      } finally {
        if (!kickoffSettled) armTimer()
      }
    },
    reloadAfterRender: (modelKey, routineModelKey) => d.modelRouter.reloadAfterRender(modelKey, routineModelKey),
    now: () => new Date(),
    // Probe the binary THIS routine actually needs — the interactive path now serves every terminal
    // harness, so a hardcoded `claude --version` would report "not installed" for a machine that has
    // opencode but no claude (and vice versa).
    isAvailable: () => isCliAvailable(terminalHarnessBin(routine)),
    // Nobody may ever open this terminal, so TerminalManager's 5-minute idle reaper would kill it
    // (and its CLI) long before the run's own CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS, which the sweep
    // enforces. Its idle TTL outlasts that bound, so the sweep decides; once the run has ended, the
    // shell left behind still ages out.
    createTerminal: (agentRun, opts) => createAgentTerminal(d, agentRun, { ...opts, signal: kickoff.signal, idleTtlMs: ROUTINE_TERMINAL_IDLE_TTL_MS }),
    // TerminalManager is keyed by its own terminal id, not the Code session id — the shared
    // helper maps every lookup first (the same wiring as cli.ts's sweep), or the abandoned-kickoff
    // kill in runCliInteractiveRoutine would be a silent no-op.
    ...terminalLookupsBySession(() => tm),
    releaseParked: d.routineScheduler ? (routineId, runId) => d.routineScheduler!.releaseParked(routineId, runId) : undefined,
    kickoffSignal: kickoff.signal,
  }
  const TIMED_OUT = Symbol('cli_interactive_kickoff_timeout')
  // Deliberately NOT `.unref()`'d — see runCliRoutineBranch's identical timer above for why:
  // unref'ing the one thing that can rescue a genuinely wedged kickoff risks it never firing
  // at all if nothing else is keeping the event loop alive at that moment, which is exactly
  // the failure this timeout exists to prevent. Bounded by `_timeoutMs` (paused during a
  // model load, see loadExplicit above). Armed before the kickoff starts, so a load can pause it.
  const timedOut = new Promise<symbol>((resolve) => { timeOut = () => resolve(TIMED_OUT) })
  let raced: unknown
  try {
    armTimer()
    raced = await Promise.race([_runInteractive(routine, run, interactiveDeps), timedOut])
  } finally {
    kickoffSettled = true
    clearTimeout(timer)
  }
  if (raced === TIMED_OUT) {
    const timedOutStatus = d.db.getRoutineRun(run.id)?.status
    if (timedOutStatus && timedOutStatus !== 'running') return timedOutStatus
    // Kickoff is still in flight — stop it from launching the CLI later, after this row is
    // 'errored' and the scheduler has released the routine.
    kickoff.abort()
    d.db.updateRoutineRun(run.id, { status: 'errored', error: `Starting the interactive ${agentLabel(routine)} CLI session exceeded the ${_timeoutMs}ms kickoff limit.`, endedAt: new Date().toISOString() })
    return 'errored'
  }
  return raced as RoutineRunStatus
}

/** The real Chat/in-app-pi Routine executor (spec 20 §5) — the real `RoutineSchedulerDeps.runRoutine`
 *  (Phase 2), wired in cli.ts (Task 10). The scheduler has already created `run` (status
 *  'running') before calling this; this function only decides which terminal RoutineRunStatus
 *  the fire reached (writing its own more-specific fields — skipReason, result, error,
 *  pendingToolCall — along the way) and returns it, matching scheduler.ts's own doc comment on
 *  `RoutineSchedulerDeps.runRoutine` exactly. Acquires GenerationGate at 'bg' priority (spec 20 §5:
 *  a routine never preempts foreground chat/Code), held for the whole run by a chat routine and only
 *  around the model swap and the restore by a pi Code routine, whose session gates each request
 *  itself (see pinnedGate); resolves the model-conflict decision, and dispatches to the
 *  flavor-specific runner.
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
  if (routine.flavor === 'code' && isTerminalCodingAgent(routine.codingAgent)) {
    if (routine.permissionMode === 'ask' || routine.permissionMode === 'plan') {
      return _runCliInteractiveBranch(d, routine, run)
    }
    // The one-shot `-p --output-format stream-json` path is claude-ONLY, and deliberately so: it
    // depends on parsing that CLI's specific stream-json event schema (cli-output.ts), which was
    // read off a real transcript rather than guessed. `pi -p --mode json` and `opencode run
    // --format json` both exist (probed) but their event schemas have NOT been captured yet, and a
    // parser written from an assumed schema would silently report every run as empty.
    //
    // So a non-claude terminal harness in `auto` runs through the LIVE-TERMINAL path instead. That
    // is a real, working unattended run — auto mode is exactly the mode that needs no human — and
    // completion is still detected by the agent-exited callback. The only thing given up is
    // structured capture of the run's output text, which is strictly better than a parser that
    // fabricates it. Switching a harness to the cheaper one-shot path is then just a matter of
    // capturing its real JSON transcript and adding a parser.
    if (routine.codingAgent === 'claude_cli') return _runCliBranch(d, routine, run)
    return _runCliInteractiveBranch(d, routine, run)
  }

  const deadline = createRunDeadline()
  try {
    let release: (() => void) | undefined
    try {
      // A chat routine holds the gate for its whole run. An in-app pi Code session acquires this
      // same gate itself before EVERY provider request (code-session.ts's before_provider_request
      // hook), so holding it across the run would self-deadlock against a single-slot engine (the
      // same hazard cli-routine.ts documents): a pi routine holds it only for the swap decision and
      // load, and again for the restore (pinnedGate). Without it, a swap would not wait for a chat
      // routine, compaction, title or memory call, which hold the gate without raising the
      // activeRequests engineIsIdle() reads, and would stop the engine under them.
      if (d.gate) release = await d.gate.acquire('bg', { signal: deadline.signal })
    } catch {
      d.db.updateRoutineRun(run.id, { status: 'skipped', skipReason: 'gate_timeout', endedAt: new Date().toISOString() })
      return 'skipped'
    }
    try {
      let ranStatus: RoutineRunStatus = 'errored'
      const swap = await withPinnedModel({ manager: d.manager, modelRouter: d.modelRouter, isAutotuneRunning: () => autotuneRunning(d) }, routine.modelKey, async (route) => {
        const outcome = await dispatchRoutine(d, routine, run, deadline.signal, route)
        ranStatus = finalizeOutcome(d, run.id, outcome)
      }, pinnedGate(d, routine, () => { release?.(); release = undefined }))
      return finalizeSwapOutcome(d, run.id, swap, ranStatus)
    } finally {
      release?.()
    }
  } finally {
    deadline.cancel()
  }
}

/** A run's configSnapshot, or undefined when it does not parse. */
function parseSnapshot(configSnapshot: string): Routine | undefined {
  try {
    return JSON.parse(configSnapshot) as Routine
  } catch {
    return undefined
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
 *  If the claim is made but dispatch never actually runs (an Approve's gate timeout, busy model or
 *  failed model load, or dispatch throwing outright), the claim is reverted so the run can still be
 *  retried later. A Deny takes neither the gate nor the routine's model (see below). */
export async function resumeRoutineRun(d: Deps, run: RoutineRun, decision: 'allow' | 'deny'): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const current = d.db.getRoutineRun(run.id)
  if (!current || current.status !== 'needs_approval') return { ok: false, code: 'not_stalled', message: 'This run is not awaiting approval.' }
  const pending = parsePendingToolCall(current.pendingToolCall)
  if (!pending) {
    // A terminal (CLI) routine's run parks at 'needs_approval' with no pendingToolCall while its
    // CLI runs in its own terminal, which is also where it asks, in ask mode
    // (cli-interactive-runner.ts). Approve and Deny have nothing to decide there; reaching one ends
    // the run, and it must end the way the run's other ends do: writing 'errored' alone left the
    // CLI running and the user's model swapped out.
    const snapshot = parseSnapshot(current.configSnapshot)
    if (snapshot?.flavor === 'code' && isTerminalCodingAgent(snapshot.codingAgent)) {
      const message = `Closed by ${decision === 'allow' ? 'Approve' : 'Deny'}: this run's ${agentLabel(snapshot)} CLI runs in its own terminal, so it had no tool call to decide.`
      closeInteractiveRun({
        store: d.db,
        loadExplicit: (modelKey, overrides, opts) => d.modelRouter.loadExplicit(modelKey, overrides, opts),
        reloadAfterRender: (modelKey, routineModelKey) => d.modelRouter.reloadAfterRender(modelKey, routineModelKey),
        now: () => new Date(),
        releaseParked: d.routineScheduler ? (routineId, runId) => d.routineScheduler!.releaseParked(routineId, runId) : undefined,
        killTerminal: terminalLookupsBySession(() => getTerminalManager(d)).killTerminal,
      }, current, message)
      return { ok: false, code: 'no_pending_call', message }
    }
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

  // A Deny runs nothing on the engine: both runners end the run on it without a request
  // (chat-runner.ts and code-runner.ts's deny branches). It used to take the gate and load the
  // routine's model first, like an Approve: while the user was chatting it waited out the gate and
  // answered gate_timeout, it swapped the user's model out and back for nothing, and once the
  // routine's model was gone every Deny answered model_unavailable, so the run stayed stalled.
  if (decision === 'deny') {
    try {
      finalizeOutcome(d, current.id, await dispatchResume(d, routine, current, pending, 'deny', new AbortController().signal))
    } catch (e) {
      revertClaim() // see the catch below
      throw e
    }
    return { ok: true }
  }

  const deadline = createRunDeadline()
  try {
    let release: (() => void) | undefined
    try {
      // See executeRoutine: a pi Code resume gates each provider request itself, so it holds the
      // gate only for the swap and the restore (pinnedGate).
      if (d.gate) release = await d.gate.acquire('bg', { signal: deadline.signal })
    } catch {
      revertClaim()
      return { ok: false, code: 'gate_timeout', message: 'Timed out waiting for the model server.' }
    }
    try {
      const swap = await withPinnedModel({ manager: d.manager, modelRouter: d.modelRouter, isAutotuneRunning: () => autotuneRunning(d) }, routine.modelKey, async (route) => {
        const outcome = await dispatchResume(d, routine, current, pending, decision, deadline.signal, route)
        finalizeOutcome(d, current.id, outcome)
      }, pinnedGate(d, routine, () => { release?.(); release = undefined }))
      if (swap.outcome === 'skip-busy') { revertClaim(); return { ok: false, code: 'model_busy', message: 'The model server is busy — try approving again shortly.' } }
      if (swap.outcome === 'skip-load-failed') { revertClaim(); return { ok: false, code: 'model_unavailable', message: swap.message } }
      // fn never ran here either, so nothing wrote a terminal state — without the revert the run
      // would sit at 'running' forever and every retry would get 'not_stalled'.
      if (swap.outcome === 'skip-comfyui-busy') { revertClaim(); return { ok: false, code: 'model_busy', message: 'ComfyUI is rendering — try approving again shortly.' } }
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
