//
// Pure decision function for spec 20 §5's model-conflict rule, shared by EVERY Routine
// execution flavor (chat, in-app-pi code, and — per that phase's own plan — the CLI-flavor
// code path in Phase 3). Mirrors update-scheduler.ts's existing decideAutoUpdate() shape:
// no I/O, no Manager/GenerationGate dependency of its own, just already-resolved inputs in,
// a decision out. Callers own how they compute `engineIdle` (see model-swap.ts in this file's
// own directory for this phase's choice, and this plan's own header note for how that differs
// from Phase 3's).

export type ModelAction = 'run' | 'swap-then-run' | 'skip-busy'

/** Decide what a due routine should do about the currently-loaded model before it fires.
 *  - Pinned model already loaded → 'run', no swap needed, regardless of idle/busy.
 *  - A different model is loaded (or none at all) and the engine is idle → 'swap-then-run'.
 *  - A different model is loaded (or none at all) and the engine is busy → 'skip-busy': never
 *    queue indefinitely, never preempt a live foreground generation (spec 20 §5). */
export function decideModelAction(params: {
  pinnedModel: string
  currentlyLoaded: string | null
  engineIdle: boolean
}): ModelAction {
  if (params.currentlyLoaded === params.pinnedModel) return 'run'
  return params.engineIdle ? 'swap-then-run' : 'skip-busy'
}
