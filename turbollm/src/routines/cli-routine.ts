// Orchestrates ONE scheduled fire of a CLI-flavor Code Routine (`codingAgent: 'claude_cli'`) —
// spec 20 §5/§6/§7. Self-contained on purpose: unlike the Chat/in-app-pi flavors, which run
// inside `execute.ts`'s `withPinnedModel(...)` wrapper, this path owns its OWN model-conflict
// decision (see the gate design note below for why it cannot share that wrapper's blocking
// gate acquisition), so `execute.ts` wires it as a top-level sibling branch instead.
//
// ── Design note: the busy-check NEVER calls `gate.acquire()` ──────────────────────────────────
// `GenerationGate.acquire()` is a QUEUEING mutex (`gate.ts:65-118`): a caller that can't be
// admitted immediately waits in line until a slot frees. That is exactly wrong here. Spec 20 §5
// requires a routine to SKIP immediately when the engine is busy rather than queue indefinitely
// for an unknown wait — and worse, an `acquire('bg')` here would SELF-DEADLOCK a single-slot
// engine: the gateway's own `/v1/messages` handler already acquires this SAME gate at 'bg'
// priority for every individual turn the `claude` subprocess sends, so a routine holding the one
// slot while waiting for its subprocess to get that same slot can never make progress. THAT
// gateway-side acquisition is what actually satisfies "a CLI-flavor run participates in
// GenerationGate at background priority" end-to-end; this orchestrator adds nothing on top.
// So every input to the model-conflict decision is a plain, non-blocking snapshot. Deliberately
// racy — a foreground request can start between the read and the `loadExplicit()` below — in the
// same way `update-scheduler.ts`'s `decideAutoUpdate({ idle })` takes a plain boolean, not a lock.
//
// ── Design note: `engineIdle` is TWO signals AND-ed, and `getEngineIdle` is the load-bearing one ─
// `gate.stats()` alone is NOT a sufficient busy-check, and an earlier version of this comment
// wrongly claimed it agreed with `model-swap.ts`'s `engineIsIdle(manager)` for a single-slot
// engine. It does not, at any slot count: the main in-app chat streaming turn calls
// `manager.generationStart()` (`chat-routes.ts:800`) and never touches the gate at all (the only
// `gate.acquire` in that file is the low-priority auto-title at `:1419`). Reading the gate alone
// therefore reports a live foreground chat conversation as IDLE — and swapping the engine's model
// out from under it is precisely what spec 20 §5 ("never preempt a live foreground generation")
// exists to prevent. A second, independent hole: `cli.ts:327` builds the gate with
// `manager.parallelSlots() ?? Infinity`, and only llama.cpp's arg builder emits `--parallel`
// (`profile.ts:531`) — so on vLLM/mlx-lm/koboldcpp `capacity === Infinity` and `inFlight < capacity`
// is unconditionally true, making 'skip-busy' dead code.
//
// So `engineIdle` comes primarily from `getEngineIdle()`, which production wires to the SAME
// `engineIsIdle(manager)` (`update-scheduler.ts:31`) that `model-swap.ts:43` — the Chat/pi path —
// already uses; that one reads `manager.sessionStats().activeRequests`, i.e. the counter
// `chat-routes.ts:800` increments, so it DOES see the chat turn. The gate snapshot is kept AND-ed
// on top (`getEngineIdle() && inFlight < capacity`) because the two signals observe overlapping but
// non-identical work: the gate additionally sees queued/in-flight agent + gateway acquisitions
// (`memory.ts`, `code-session.ts`, `gateway.ts`, `execute.ts`) that may not yet have reached
// Manager's counter. AND-ing is conservative in the only direction that is safe here — every extra
// "busy" reading costs at most a deferred routine (it fires again next tick), while every missed
// one costs a killed foreground generation. This is the same bias `engineIsIdle`'s own doc states
// ("when in doubt, busy") and the same shape as `decideAutoUpdate({ policy, hasUpdate, idle })`,
// which likewise only proceeds when every input agrees.
//
// ── Design note: model restore, and the SPEC-GAP when nothing was loaded ──────────────────────
// Per spec 20 §5, after a `swap-then-run` the previously-loaded model is restored once the run
// completes (best-effort, always attempted — same shape as `model-swap.ts`'s own restore). If
// nothing was loaded before the swap (`currentlyLoaded: null`, e.g. a cold daemon), there is
// nothing to restore TO. SPEC-GAP per 00-conventions.md §8, resolved by simply not restoring —
// leaving the routine's pinned model loaded — rather than inventing an "unload" behavior spec 20
// never describes.
//
// ── Security: the prompt is never an argument ─────────────────────────────────────────────────
// A routine's prompt is arbitrary free text accepted over HTTP and replayed unattended. It is
// passed to `runClaudeCliProcess` via `opts.stdin` and NEVER as an argv element — see
// `cli-process.ts`'s module header (C1) for the real command-injection this closes. `args` here
// therefore carries only TurboLLM's own fixed flags, every one of which clears that module's
// shell-safety allow-list.
import type { ConversationStore } from '../chat/db'
import type { GenerationGate } from '../agents/gate'
import type { Routine, RoutineRun } from './schema'
import { decideModelAction } from './model-conflict'
import { CLI_ROUTINE_TIMEOUT_MS, type CliProcessResult } from './cli-process'
import { parseClaudeCliStreamJson } from './cli-output'
import { inheritedEnv } from '../cli-launch'
import { sessionAuth } from '../code/session-auth'
import { resolveClaudePermissionMode } from '../terminal/agent-modes'
import type { RouteResult } from '../gateway/model-router'

export interface CliRoutineDeps {
  store: ConversationStore
  gate: GenerationGate
  /** The primary manager's currently-loaded model key, or null if none — i.e.
   *  `manager.status().model?.key ?? null`. Kept as a thin function rather than the whole Manager
   *  so tests don't have to fake Manager's full surface. */
  getLoadedModelKey: () => string | null
  /** Is the engine free to have its model swapped out right now? Wire this to
   *  `engineIsIdle(manager)` (`engines/update-scheduler.ts`) — the SAME call `model-swap.ts:43`
   *  makes for the Chat/pi path — and nothing else: it reads
   *  `manager.sessionStats().activeRequests`, which is the only signal that observes the main
   *  in-app chat stream (`chat-routes.ts:800`'s `manager.generationStart()`). Do NOT substitute a
   *  `gate.stats()` read here; see this module's `engineIdle` design note for why that alone would
   *  hot-swap the model out from under a live foreground chat turn. Kept as a thin function rather
   *  than the whole Manager so tests don't have to fake Manager's full surface. */
  getEngineIdle: () => boolean
  /** `ModelRouter.loadExplicit`, or an equivalent. Returns `{ target }` on success and
   *  `{ status: 503, message }` on failure — it does not throw for a missing model. */
  loadExplicit: (modelKey: string) => Promise<RouteResult>
  now: () => Date
  /** The daemon's OWN configured port (`d.store.snapshot().daemon.port`), for ANTHROPIC_BASE_URL —
   *  the same source `terminal-routes.ts:298` uses and for the same reason: never the incoming
   *  request's Host, since this spawns a LOCAL subprocess that must reach the real daemon. */
  port: number
  isAvailable: () => Promise<boolean>
  permissionModeChoices: () => Promise<string[]>
  /** `runClaudeCliProcess`, partially applied with its spawn/kill seams. The prompt goes in
   *  `opts.stdin`; it must never be threaded into `args` (see this module's security note). */
  runProcess: (
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
  ) => Promise<CliProcessResult>
  /** An already-created run row to write into, instead of creating one here.
   *
   *  The scheduler (`scheduler.ts`'s `tick()`) creates the `RoutineRun` itself BEFORE calling
   *  `runRoutine(routine, run)`, and `execute.ts` receives that row — so the Task 8 wire-in has a
   *  run in hand already. Without this, every scheduled CLI fire would write TWO rows (the
   *  scheduler's and this function's) and the run history would show each fire twice. Optional so
   *  a standalone caller (and the smoke test) can still just hand over a routine. */
  existingRun?: RoutineRun
}

/** TurboLLM's own fixed, non-interactive invocation. `-p`/`--print` is a BARE boolean flag — it
 *  takes no value; the prompt is a separate input the CLI reads from stdin ("Input must be
 *  provided either through stdin or as a prompt argument when using --print", confirmed against
 *  the real binary while closing cli-process.ts's C1). `--verbose` is required alongside
 *  `--output-format stream-json` in print mode. */
function buildCliArgs(permissionMode: string | null): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (permissionMode) args.push('--permission-mode', permissionMode)
  return args
}

export async function runCliCodeRoutine(routine: Routine, deps: CliRoutineDeps): Promise<void> {
  const run =
    deps.existingRun ??
    deps.store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const finish = (patch: Parameters<ConversationStore['updateRoutineRun']>[1]) => {
    deps.store.updateRoutineRun(run.id, { ...patch, endedAt: deps.now().toISOString() })
  }

  // Declared OUTSIDE the try so the finally can see it on every exit path — including ones that
  // throw before the swap ever happens, where it must still read `null` so no restore is attempted.
  let previousModel: string | null = null

  // The exception boundary opens HERE, immediately after the run row exists, and covers the WHOLE
  // body — availability probe, conflict decision, swap, spawn, parse. Anything narrower strands the
  // row at 'running' with no `endedAt` when an earlier step throws: `deps.isAvailable()` is an
  // injected seam, and `ModelRouter.loadExplicit` is only documented not to throw FOR A MISSING
  // MODEL — its `scanner.list()`/`store.snapshot()`/`getSysInfo()`/`store.update()` calls are all
  // unguarded (`model-router.ts:102-106`, `:217-239`). A stranded 'running' row is the one outcome
  // spec 20 §6 rules out, and it must not depend on the caller happening to have its own `.catch()`.
  try {
    // 1. Availability precondition (spec 20 §6) — checked BEFORE touching the model or the gate at
    // all: there is no point deciding a swap for a CLI that cannot run anyway.
    if (!(await deps.isAvailable())) {
      finish({ status: 'skipped', skipReason: 'cli_unavailable' })
      return
    }

    // 2. Model-conflict decision (spec 20 §5) — non-blocking snapshot reads, never an acquire().
    // See this module's design notes for why that distinction is load-bearing, and why BOTH the
    // Manager-level idle read and the gate snapshot have to agree before a swap is allowed.
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
      return
    }

    if (action === 'swap-then-run') {
      const swapResult = await deps.loadExplicit(pinnedModel)
      if ('status' in swapResult) {
        // The swap never happened, so there is nothing loaded-by-us to restore — same call the
        // Chat/pi path makes for its own 'skip-load-failed' outcome (model-swap.ts:53).
        finish({ status: 'errored', error: `Could not load pinned model '${pinnedModel}': ${swapResult.message}` })
        return
      }
      // Only recorded AFTER a successful swap: a failed load must not schedule a restore.
      previousModel = currentlyLoaded
    }

    // 3. Build the non-interactive invocation. A session-scoped token (session-auth.ts) gives this
    // run's gateway traffic the same clean per-session attribution a live terminal session gets.
    const token = sessionAuth.mint(run.id)
    const choices = await deps.permissionModeChoices()
    const permissionMode = routine.permissionMode ? resolveClaudePermissionMode(routine.permissionMode, choices) : null
    const env: NodeJS.ProcessEnv = {
      ...inheritedEnv(),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${deps.port}`,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_TIMEOUT: '300000',
      ANTHROPIC_MAX_RETRIES: '0',
      ANTHROPIC_MODEL: pinnedModel,
    }

    // 4. Spawn + wait. cli-process.ts owns the hard wall-clock timeout and never rejects.
    const result = await deps.runProcess(buildCliArgs(permissionMode), {
      cwd: routine.workspacePath ?? process.cwd(),
      env,
      stdin: routine.prompt,
      timeoutMs: CLI_ROUTINE_TIMEOUT_MS,
    })

    if (result.timedOut) {
      finish({ status: 'errored', error: `claude CLI timed out after ${CLI_ROUTINE_TIMEOUT_MS}ms and was terminated.` })
      return
    }
    if (result.exitCode !== 0) {
      finish({ status: 'errored', error: result.stderr.trim() || `claude CLI exited with code ${result.exitCode}.` })
      return
    }

    // 5. Parse the CLI's own output — a clean exit code is NOT the same thing as task success
    // (spec 20 §7).
    const parsed = parseClaudeCliStreamJson(result.stdout)
    finish(parsed.success ? { status: 'ok', result: parsed.resultText } : { status: 'errored', error: parsed.resultText })
  } catch (e) {
    // Every step above lands here: `isAvailable()`, `getLoadedModelKey()`, `gate.stats()`,
    // `getEngineIdle()`, `loadExplicit()`, `mint()`, `permissionModeChoices()` and `runProcess()`
    // are all injected seams or genuinely-throwing code paths (`runClaudeCliProcess` itself
    // contracts never to reject, but the seam it is injected through carries no such promise).
    // Without this the run row would be left pinned at 'running' forever, which is the one outcome
    // spec 20 §6 rules out.
    finish({ status: 'errored', error: `claude CLI routine failed: ${e instanceof Error ? e.message : String(e)}` })
  } finally {
    // 6. Revoke the session-scoped token regardless of outcome — mirrors terminal-routes.ts's
    // kill-endpoint revoke, so a routine's auth never outlives its one-shot subprocess. Safe even
    // if nothing was ever minted.
    sessionAuth.revoke(run.id)
    // 7. Restore the previously-loaded model (spec 20 §5). Best-effort and swallowed on failure,
    // exactly as model-swap.ts:58-64 does: a restore that throws here would replace the run's real
    // outcome with an unrelated error and leave the caller with no result at all.
    if (previousModel) {
      try {
        const restoreResult = await deps.loadExplicit(previousModel)
        // A restore that RETURNS `{ status: 503 }` is the COMMON failure — a model that has since
        // gone missing is exactly the case `loadExplicit` signals by returning rather than throwing
        // (`model-router.ts:104`). Discarding it would leave the engine sitting on the routine's
        // pinned model with nothing anywhere in the log. Same warn as the throw path, deliberately.
        if ('status' in restoreResult) {
          console.warn(`[routines] failed to restore the previously-loaded model '${previousModel}' after a CLI routine run: ${restoreResult.message}`)
        }
      } catch (e) {
        console.warn(`[routines] failed to restore the previously-loaded model after a CLI routine run: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}
