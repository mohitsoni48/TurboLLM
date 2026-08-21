// Interactive (live-terminal) execution for CLI-flavor Code Routines whose `permissionMode` is
// "ask" or "plan" (`codingAgent: 'claude_cli'`) — the sibling to cli-routine.ts's one-shot,
// non-interactive `-p` path, which stays exactly as-is for `permissionMode: 'auto'`.
//
// ── Why a second path at all ────────────────────────────────────────────────────────────────
// cli-routine.ts runs `claude -p --output-format stream-json`: a single non-interactive
// subprocess call, fed the whole prompt via stdin once, with no channel back into it. If that
// process ever needs to ASK for permission (exactly what "ask"/"plan" mean), there is nothing to
// answer it — it just sits until CLI_ROUTINE_TIMEOUT_MS kills it. The raw `--input-format
// stream-json` protocol that could in principle carry a permission answer back in is NOT
// officially documented by Anthropic at the wire-protocol level (confirmed against
// code.claude.com/docs before choosing this design) — hand-rolling it would mean guessing at an
// unstable, version-fragile format for a security-relevant approval gate.
//
// Instead, this reuses infrastructure that already solves the identical problem for a HUMAN: the
// terminal-agent PTY (terminal/pty-session.ts, terminal/terminal-manager.ts) that live Code
// sessions already use to run `claude` fully interactively. A routine fire creates a real Code
// session (an AgentRun + conversation, `codeAgent: 'claude'` — literally the same shape a human
// clicking "New Code Session" and picking Claude CLI would get) and spawns its terminal
// EAGERLY, server-side, right now — rather than lazily on a browser opening a tab, since nobody
// may ever open one. The routine's own `RoutineRun` links to it via `codeSessionId`
// (RoutineEditPage.tsx already embeds ANY run's `codeSessionId` as a live `CodeSessionScreen`,
// so a human who opens the routine sees and can answer the SAME real interactive prompt the CLI
// renders — no keystroke-mapping or TUI-scraping needed, they just type into the terminal).
//
// ── Two independent completion signals, because there is no single "the run is done" call ────
// A one-shot subprocess call's promise resolving IS completion. A PTY has no such moment: the
// shell stays alive after the CLI exits (pty-session.ts's `-NoExit`/`exec bash`, so a human
// reviewing later still sees the transcript), and nobody may be watching to see it exit at all.
// So completion is detected two ways, both funnelled through `finalizeInteractiveRun`:
//   1. FAST PATH — `turbollm launch claude`'s existing agent-exited callback (cli.ts, unchanged)
//      already fires when the CLI itself exits, and terminal-manager.ts's `isAgentExited`/
//      `getExitCode` already record that — zero new plumbing needed for the signal itself.
//   2. SAFETY NET — `sweepInteractiveCliRuns`, a periodic watchdog (wired in cli.ts alongside the
//      scheduler), catches every case the fast path can miss: the terminal got idle-killed
//      (TerminalManager.cleanupIdle — nobody ever opened it) before the CLI reported, the daemon
//      restarted (the PTY is unconditionally dead; nothing else will ever call agent-exited for
//      it again), or the CLI has been sitting at a prompt for too long even WITH a live terminal
//      (the hard wall-clock cap spec 20 §6 requires on every execution path).
//
// ── Parking, not "running" ───────────────────────────────────────────────────────────────────
// The run is left at 'needs_approval', not 'running', once its terminal is up. That status
// already has exactly the semantics this needs, built for the pi tool-approval stall (Task 9)
// but generic in scheduler.ts: no `endedAt` (the run hasn't ended), and the routine stays
// "parked" — protected from a second concurrent fire — until `releaseParked()` is called. This
// run's `pendingToolCall` is deliberately left UNSET, which is exactly what lets
// RoutineEditPage.tsx tell the two 'needs_approval' shapes apart: a pi stall always sets it
// (chat-runner.ts/code-runner.ts's stallRoutineRun) and renders the structured
// RoutineApprovalCard; this run has nothing structured to approve via a button — the human
// answers the CLI's own prompt directly in the embedded terminal instead.
import type { AgentRun, ConversationStore } from '../chat/db'
import type { GenerationGate } from '../agents/gate'
import type { Routine, RoutineRun, RoutineRunStatus } from './schema'
import { isTerminalCodingAgent, TERMINAL_CODE_AGENT } from './schema'
import type { RouteResult } from '../gateway/model-router'
import { decideModelAction } from './model-conflict'
import type { CreateAgentTerminalResult } from '../terminal/terminal-routes'

/** Generous relative to CLI_ROUTINE_TIMEOUT_MS/ROUTINE_RUN_TIMEOUT_MS's 10 minutes: those bound a
 *  FULLY AUTOMATED run nobody needs to attend. This bounds a run that may genuinely need a human
 *  to notice a scheduled fire happened and come look — but it must still end, or an unattended,
 *  never-opened terminal blocks its routine from ever firing again (parked = protected from a
 *  concurrent fire, forever, without this). */
export const CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS = 30 * 60_000

export interface CliInteractiveDeps {
  store: ConversationStore
  gate: GenerationGate
  getLoadedModelKey: () => string | null
  getEngineIdle: () => boolean
  loadExplicit: (modelKey: string) => Promise<RouteResult>
  now: () => Date
  isAvailable: () => Promise<boolean>
  /** Spawns the actual terminal for a freshly-created AgentRun — terminal-routes.ts's
   *  `createAgentTerminal`, partially applied with the real daemon `Deps` at the call site so
   *  this module never needs to import or hold the whole thing. */
  createTerminal: (agentRun: AgentRun, opts: { mode: string; firstMessage: string }) => Promise<CreateAgentTerminalResult>
  isTerminalActive: (codeSessionId: string) => boolean
  isAgentExited: (codeSessionId: string) => boolean
  getExitCode: (codeSessionId: string) => number | undefined
  killTerminal: (codeSessionId: string) => void
  /** RoutineScheduler.releaseParked — undefined under tests/embedders that don't wire a
   *  scheduler, mirroring `Deps.routineScheduler`'s own optionality. */
  releaseParked?: (routineId: string, runId: string) => void
}

/** codeSessionId -> the model that was loaded before this run swapped it out, so it can be
 *  restored once the run finalizes (spec 20 §5). In-memory only, same acceptable gap
 *  cli-routine.ts's own restore logic documents for a cold daemon: after a restart there is
 *  nothing left in memory to restore FROM, so `finalizeInteractiveRun` simply skips it — no worse
 *  than the one-shot path's own documented behavior. */
const pendingRestore = new Map<string, string>()

/** The harness name to use in a user-facing error. This runner now drives claude, opencode and pi,
 *  so a hardcoded "claude" sent the user to debug a CLI that was never involved. */
function agentLabel(routine: Routine): string {
  return isTerminalCodingAgent(routine.codingAgent) ? TERMINAL_CODE_AGENT[routine.codingAgent] : 'claude'
}

/** The real Chat/in-app-pi… no — the interactive CLI-flavor Routine executor (spec 20 §5/§6,
 *  ask/plan half of Phase 3's claude_cli support). Kicks the run off and returns quickly (spawn
 *  the terminal, don't wait for it to finish) — completion is a SEPARATE event handled by
 *  `finalizeInteractiveRun`, called from either the agent-exited fast path or the
 *  `sweepInteractiveCliRuns` safety net. See this module's header for the full design. */
export async function runCliInteractiveRoutine(
  routine: Routine,
  run: RoutineRun,
  deps: CliInteractiveDeps,
): Promise<RoutineRunStatus> {
  const finish = (patch: Parameters<ConversationStore['updateRoutineRun']>[1]) =>
    deps.store.updateRoutineRun(run.id, { ...patch, endedAt: deps.now().toISOString() })

  if (!(await deps.isAvailable())) {
    finish({ status: 'skipped', skipReason: 'cli_unavailable' })
    return 'skipped'
  }

  const pinnedModel = routine.modelKey
  const currentlyLoaded = deps.getLoadedModelKey()
  const { inFlight, capacity } = deps.gate.stats()
  const action = decideModelAction({
    pinnedModel,
    currentlyLoaded,
    engineIdle: deps.getEngineIdle() && inFlight < capacity,
  })
  if (action === 'skip-busy') {
    finish({ status: 'skipped', skipReason: 'model_busy' })
    return 'skipped'
  }

  let previousModel: string | null = null
  if (action === 'swap-then-run') {
    const swapResult = await deps.loadExplicit(pinnedModel)
    if ('status' in swapResult) {
      finish({ status: 'errored', error: `Could not load pinned model '${pinnedModel}': ${swapResult.message}` })
      return 'errored'
    }
    previousModel = currentlyLoaded
  }

  const mode = routine.permissionMode ?? 'ask'
  const conv = deps.store.createConversation({ kind: 'code', modelKey: routine.modelKey })
  deps.store.setConversationMode(conv.id, mode)
  const agentRun = deps.store.createAgentRun({
    convId: conv.id, title: routine.prompt.slice(0, 60), allowedTools: [],
    repoRoot: routine.workspacePath,
    // Mapped from the routine's own choice, never hardcoded: this same runner now drives every
    // terminal harness (claude/opencode/pi), and stamping 'claude' on an opencode routine would
    // make createAgentTerminal build a claude launch command for it. See schema.ts's
    // TERMINAL_CODE_AGENT for why the two vocabularies differ.
    codeAgent: isTerminalCodingAgent(routine.codingAgent) ? TERMINAL_CODE_AGENT[routine.codingAgent] : 'claude',
  })
  deps.store.updateRoutineRun(run.id, { codeSessionId: agentRun.id })
  deps.store.addMessage(conv.id, 'user', routine.prompt)

  // The launch command ALSO seeds this same prompt as the CLI's own opening argument
  // (buildTerminalLaunchCommand) — the addMessage call above is a durable record for the UI/run
  // history, not the delivery mechanism. `canSeedFirstMessage`'s limits (length, quotes, control
  // characters) still apply here exactly as they do for a human's first Code-session message: a
  // prompt that doesn't fit opens an idle CLI instead of a silently-failed one — worse than normal
  // seeding, but still strictly better than erroring the routine outright, and no one is
  // guaranteed to be watching to retype it the way a human would.
  const result = await deps.createTerminal(agentRun, { mode, firstMessage: routine.prompt })
  if (!result.ok) {
    if (previousModel) await restoreModel(deps, previousModel)
    finish({ status: 'errored', error: `Could not start the interactive ${agentLabel(routine)} CLI session: ${result.message}` })
    return 'errored'
  }

  if (previousModel) pendingRestore.set(agentRun.id, previousModel)
  // No endedAt: the run has not ended, it's parked. See this module's header comment.
  deps.store.updateRoutineRun(run.id, { status: 'needs_approval' })
  return 'needs_approval'
}

async function restoreModel(deps: Pick<CliInteractiveDeps, 'loadExplicit'>, previousModel: string): Promise<void> {
  try {
    const restoreResult = await deps.loadExplicit(previousModel)
    if ('status' in restoreResult) {
      console.warn(`[routines] failed to restore the previously-loaded model '${previousModel}' after an interactive CLI routine run: ${restoreResult.message}`)
    }
  } catch (e) {
    console.warn(`[routines] failed to restore the previously-loaded model after an interactive CLI routine run: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Closes out a parked interactive run — called from BOTH completion signals (see this module's
 *  header). Idempotency guard: re-reads the run fresh and bails if it has already moved off
 *  'needs_approval', since the fast path and the sweep can race (an agent-exited POST landing in
 *  the same tick the watchdog independently notices the same exit). */
function finalizeInteractiveRun(
  deps: Pick<CliInteractiveDeps, 'store' | 'loadExplicit' | 'now' | 'releaseParked'>,
  run: RoutineRun,
  outcome: { status: 'ok' | 'errored'; result?: string; error?: string },
): void {
  const current = deps.store.getRoutineRun(run.id)
  if (!current || current.status !== 'needs_approval') return
  deps.store.updateRoutineRun(run.id, { ...outcome, endedAt: deps.now().toISOString() })
  deps.releaseParked?.(run.routineId, run.id)
  const codeSessionId = current.codeSessionId
  if (codeSessionId) {
    const previousModel = pendingRestore.get(codeSessionId)
    if (previousModel) {
      pendingRestore.delete(codeSessionId)
      void restoreModel(deps, previousModel)
    }
  }
}

/** Everything `sweepInteractiveCliRuns` actually touches — a `Pick` of `CliInteractiveDeps`
 *  rather than the whole interface, so a caller (cli.ts) doesn't have to fabricate unused
 *  kickoff-only fields (`gate`, `getLoadedModelKey`, `getEngineIdle`, `isAvailable`,
 *  `createTerminal`) just to run the watchdog. */
export type CliInteractiveSweepDeps = Pick<
  CliInteractiveDeps,
  'store' | 'now' | 'loadExplicit' | 'isTerminalActive' | 'isAgentExited' | 'getExitCode' | 'killTerminal' | 'releaseParked'
>

/** Periodic safety net (see this module's header) — call on an interval from cli.ts, alongside
 *  the scheduler, AND once synchronously right after `RoutineScheduler.start()` so a run
 *  orphaned by a daemon restart (its PTY is unconditionally dead; nothing else will ever report
 *  it) is caught on the very next boot rather than sitting parked until the first interval tick.
 *
 *  Deliberately walks EVERY parked row (`listParkedRoutineRuns`, shared with the pi tool-approval
 *  stall) rather than a dedicated query: 'needs_approval' rows are rare, this runs at most once a
 *  tick, and filtering here keeps the pi stall's own storage untouched by this feature. */
export function sweepInteractiveCliRuns(deps: CliInteractiveSweepDeps): void {
  for (const run of deps.store.listParkedRoutineRuns()) {
    let routine: Routine
    try {
      routine = JSON.parse(run.configSnapshot) as Routine
    } catch {
      continue // not this module's problem to fix a corrupt snapshot — resumeRoutineRun's own callers own that
    }
    // EVERY terminal harness, not just claude_cli. This sweep is the ONLY code that finalizes an
    // interactive CLI routine run — `finalizeInteractiveRun` is module-private and every call site
    // sits below this line. While this said `!== 'claude_cli'`, an opencode_cli/pi_cli run (which
    // execute.ts routes here in every permission mode) fired once, parked at `needs_approval` with
    // no `endedAt`, and stayed PARKED — which this module treats as "protected from a second
    // concurrent fire", so the routine never fired again. Even the wall-clock timeout below could
    // not rescue it, because that check is also past this `continue`.
    //
    // An in-app 'pi' routine still skips: it has no CLI, no PTY and no codeSessionId, and its
    // tool-approval stall is genuinely not this sweep's problem.
    if (!isTerminalCodingAgent(routine.codingAgent)) continue
    if (!run.codeSessionId) continue // should be unreachable for this codingAgent; defensive only

    if (deps.isAgentExited(run.codeSessionId)) {
      const exitCode = deps.getExitCode(run.codeSessionId)
      finalizeInteractiveRun(deps, run,
        exitCode === 0
          ? { status: 'ok', result: 'Completed — see the embedded session for the full transcript.' }
          : { status: 'errored', error: `${agentLabel(routine)} CLI exited with code ${exitCode ?? 'unknown'}.` })
      continue
    }
    if (!deps.isTerminalActive(run.codeSessionId)) {
      // Terminal is gone with no agent-exited report — idle-killed before finishing, or a daemon
      // restart (the PTY cannot have survived that either way).
      finalizeInteractiveRun(deps, run, { status: 'errored', error: 'The interactive session ended unexpectedly before completing (its terminal is no longer running).' })
      continue
    }
    const ageMs = deps.now().getTime() - new Date(run.startedAt).getTime()
    if (ageMs > CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS) {
      deps.killTerminal(run.codeSessionId)
      finalizeInteractiveRun(deps, run, { status: 'errored', error: `No approval decision was made within ${CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS}ms — the session was closed.` })
    }
    // Otherwise: still genuinely in progress / awaiting a human. Leave it parked.
  }
}
