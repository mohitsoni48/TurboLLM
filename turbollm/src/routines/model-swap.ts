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
import type { ModelRouter } from '../gateway/model-router'
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

/**
 * Resolve the model-conflict decision for `pinnedModel` and run `fn` under it:
 *  - 'run': the pinned model is already loaded — call `fn()` directly, no swap.
 *  - 'swap-then-run': load the pinned model (capturing whatever was loaded before), call
 *    `fn()`, then restore the prior model (a no-op if nothing was loaded before).
 *  - 'skip-busy': a different model is loaded and the engine is actively generating — `fn` is
 *    never called; the caller logs "skipped — model busy" (spec 20 §6).
 * Restoration is best-effort and always attempted (even if `fn` throws), so a routine run can
 * never strand the engine on a model the user didn't pick.
 */
export async function withPinnedModel(deps: ModelSwapDeps, pinnedModel: string, fn: () => Promise<void>): Promise<ModelSwapOutcome> {
  const currentlyLoaded = deps.manager.status().model?.key ?? null
  const action = decideModelAction({ pinnedModel, currentlyLoaded, engineIdle: engineIsIdle(deps.manager) })

  if (action === 'skip-busy') return { outcome: 'skip-busy' }
  if (action === 'run') {
    await fn()
    return { outcome: 'ran' }
  }

  // 'swap-then-run'
  const swapResult = await deps.modelRouter.loadExplicit(pinnedModel)
  if ('status' in swapResult) {
    // ComfyUI busy is a temporary yield, not a load failure.
    if (swapResult.message.includes('ComfyUI is rendering'))
      return { outcome: 'skip-comfyui-busy' }
    return { outcome: 'skip-load-failed', message: swapResult.message }
  }

  try {
    await fn()
  } finally {
    if (currentlyLoaded) {
      try {
        await deps.modelRouter.loadExplicit(currentlyLoaded)
      } catch (e) {
        console.warn(`[routines] failed to restore the previously-loaded model after a routine run: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return { outcome: 'ran' }
}
