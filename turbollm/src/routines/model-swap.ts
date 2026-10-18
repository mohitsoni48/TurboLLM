// turbollm/src/routines/model-swap.ts
//
// Model-conflict resolution + swap/restore orchestration for a due Routine (spec 20 §5). Wraps
// the pure decideModelAction() with the actual I/O: read the currently loaded model, swap to
// the routine's pinned one via ModelRouter.loadExplicit() if the engine is idle, run the
// routine, then restore whatever was loaded before via the SAME loadExplicit() call (Phase 3's
// plan established this "restore == loadExplicit(previousKey) again" pattern — reused here
// verbatim rather than hand-building StartOpts a second way).
//
// engineIdle is computed via engineIsIdle() (update-scheduler.ts) — this phase's own brief's
// explicit instruction, and a plain non-blocking read of Manager's own activeRequests counter
// (never Manager.acquire()-style blocking). Phase 3's plan computes the same input via
// GenerationGate.stats() instead; both are non-blocking, but they are not the same signal for a
// multi-slot engine (capacity > 1) — see this plan's own Self-review notes for the reconciliation
// this leaves open.
import type { Manager } from '../engines/manager'
import type { ModelRouter, RouteResult } from '../gateway/model-router'
import { engineIsIdle } from '../engines/update-scheduler'
import { decideModelAction } from './model-conflict'

export type ModelSwapOutcome =
  | { outcome: 'ran' }
  | { outcome: 'skip-busy' }
  | { outcome: 'skip-comfyui-busy' }
  | { outcome: 'skip-load-failed'; message: string }

export interface ModelSwapDeps {
  manager: Manager
  modelRouter: ModelRouter
}

/** For a caller that took the GenerationGate for the swap decision but must not hold it while `fn`
 *  runs (a pi Code routine: its session takes the gate before every provider request). */
export interface SwapGate {
  /** Lets go of the gate right before `fn` runs. */
  release: () => void
  /** Takes it again for the restore, so the restore waits for whoever is generating by then. A
   *  rejection (the gate's queue timeout) skips any restore that would load: someone still holds
   *  the gate. */
  reacquire: () => Promise<() => void>
}

/**
 * Resolve the model-conflict decision for `pinnedModel` and run `fn` under it:
 *  - 'run': the pinned model is already loaded — call `fn()` directly, no swap.
 *  - 'swap-then-run': load the pinned model (capturing whatever was loaded before), call
 *    `fn()`, then restore the prior model (a no-op if nothing was loaded before).
 *  - 'skip-busy': a different model is loaded and the engine is actively generating — `fn` is
 *    never called; the caller logs "skipped — model busy" (spec 20 §6).
 * Restoration is best-effort and attempted after `fn` (even if it throws), and after a pinned model
 * that fails to load or a swap a ComfyUI render refused: either may already have stopped the user's
 * model. A restore a render refuses is left to that render's release (ModelRouter.reloadAfterRender).
 * With `gate`, the caller holds the GenerationGate on entry: it is released right before `fn` and
 * taken again around the restore (see {@link SwapGate}); a restore that cannot take it back does
 * not load, so it never stops the engine under the generation that still holds it.
 */
export async function withPinnedModel(deps: ModelSwapDeps, pinnedModel: string, fn: () => Promise<void>, gate?: SwapGate): Promise<ModelSwapOutcome> {
  const currentlyLoaded = deps.manager.status().model?.key ?? null
  const action = decideModelAction({ pinnedModel, currentlyLoaded, engineIdle: engineIsIdle(deps.manager) })

  if (action === 'skip-busy') return { outcome: 'skip-busy' }
  if (action === 'run') {
    gate?.release()
    await fn()
    return { outcome: 'ran' }
  }

  // 'swap-then-run'
  const swapResult = await deps.modelRouter.loadExplicit(pinnedModel)
  if ('status' in swapResult) {
    // ComfyUI busy is a temporary yield, not a load failure. It still restores: a render whose acquire landed during
    // the swap met the user's model already stopped (Manager.load stops the slot before its pre-start hook), or the
    // routine's model starting, which it kills and keeps for its release() to reload. Its release then loaded the
    // routine's model, for a routine that never ran, and the user's stayed unloaded. The restore is refused while the
    // render runs and handed to its release (see restore()). A render that held the GPU before the swap unloaded the
    // user's model itself and reloads it; the restore leaves that alone.
    if (swapResult.message.includes('ComfyUI is rendering')) {
      if (currentlyLoaded) await restore(deps, currentlyLoaded, pinnedModel, swapResult)
      return { outcome: 'skip-comfyui-busy' }
    }
    // A load that ran and failed has already stopped the user's model when it took that model's slot (keep-N 1, or a
    // full pool): Manager.load stops the slot before it starts the new model. Without this every run of a routine
    // whose model cannot start left the engine empty. A failure that stopped nothing (an incompatible model, one
    // that is gone) finds the user's model still running, and the restore is a no-op (doLoad's fast path). The
    // caller still holds the gate here: fn never ran, so it was never let go.
    if (currentlyLoaded) await restore(deps, currentlyLoaded, pinnedModel, swapResult)
    return { outcome: 'skip-load-failed', message: swapResult.message }
  }

  try {
    gate?.release()
    await fn()
  } finally {
    if (currentlyLoaded) {
      // The restore stops the engine as the swap did, so it waits for the gate as the swap did. A
      // re-acquire that fails is the gate's 3-minute queue timeout: someone still holds the slot,
      // a chat routine, a compaction or title call, or a holder that leaked its release. Restoring
      // anyway stopped the engine under that generation, so the restore loads nothing then: the
      // routine's model stays loaded, and the next load (a request's auto-swap, a manual load)
      // replaces it. With keep-N 2 or more the swap took a free pool slot, or in a full pool
      // evicted the model used least recently. When that was another model, the user's is still
      // running and its restore stops nothing: it only undoes the swap's record of the model last
      // loaded, and still does (`runningOnly`), or the next daemon start resumed the routine's
      // model. A swap that evicted the user's model is left as with keep-N 1, warning included.
      let unlock: (() => void) | undefined
      let gateHeld = false
      if (gate) {
        try {
          unlock = await gate.reacquire()
        } catch (e) {
          gateHeld = true
          const kept = await restore(deps, currentlyLoaded, pinnedModel, swapResult, { runningOnly: true })
          if (!kept || 'status' in kept) {
            console.warn(`[routines] not restoring '${currentlyLoaded}' after a routine run: the generation gate is still held (${e instanceof Error ? e.message : String(e)}), and the restore would stop the engine under it. '${pinnedModel}' stays loaded.`)
          }
        }
      }
      if (!gateHeld) {
        try {
          await restore(deps, currentlyLoaded, pinnedModel, swapResult)
        } finally {
          unlock?.()
        }
      }
    }
  }
  return { outcome: 'ran' }
}

/** Reload the model that was loaded before the routine's swap: the same loadExplicit() the swap made. Best effort.
 *  Handed the swap's result (`swap`), a restore that finds that model still running (keep-N 2 or more: the swap took a
 *  pool slot) puts back the model last loaded that the swap's record replaced (ModelRouter.undoSwapRecord).
 *  `runningOnly` (LoadExplicitOpts): only that, never a load. The result, or undefined when the load threw. */
async function restore(deps: ModelSwapDeps, modelKey: string, pinnedModel: string, swap: RouteResult, opts: { runningOnly?: boolean } = {}): Promise<RouteResult | undefined> {
  try {
    const result = await deps.modelRouter.loadExplicit(modelKey, undefined, { restoreAfter: swap, ...opts })
    // A ComfyUI render that began while the routine ran (or during its swap) keeps the routine's model, or the
    // routine's paused load, for its release() to load, and the restore is refused until that render ends. Dropped,
    // the render's end brought the routine's model back and left the user's unloaded: the render's release reloads
    // the user's model instead. A restore the render's pre-start hook refused is already a paused load of the user's
    // model, which release() resumes, and reloadAfterRender leaves it be.
    if ('status' in result && result.message.includes('ComfyUI is rendering')) {
      deps.modelRouter.reloadAfterRender(modelKey, pinnedModel)
    }
    return result
  } catch (e) {
    console.warn(`[routines] failed to restore the previously-loaded model after a routine run: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}
