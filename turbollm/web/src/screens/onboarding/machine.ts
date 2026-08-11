/** The onboarding state machine (spec 25 §9.3, ADR-340).
 *
 *  State is a serialisable step ID, never an index or a pointer: step order is
 *  context-dependent, so an index means something different after a context
 *  change, and a pointer cannot survive the tab close or Pro's navigate-away
 *  Discover handoff that resume must tolerate. */

import { REGISTRY } from './steps/registry'
import type { StepContext, StepDescriptor } from './steps/define'

export interface MachineState {
  currentId: string | null
  ctx: StepContext
}

export type MachineEvent =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'goto'; id: string }
  | { type: 'ctx'; patch: Partial<StepContext> }

/** The applicable ordered sequence for this context. Pure; the whole reason
 *  every tier is testable without mocks or hardware. */
export function deriveSteps(ctx: StepContext): StepDescriptor[] {
  return REGISTRY.filter((s) => s.appliesTo(ctx))
}

/** Where to land on resume. A saved id that no longer exists (step removed in
 *  a later release) or no longer applies (context changed while away) must not
 *  strand the user — fall back to the first applicable step. */
export function resumeAt(savedId: string | null, ctx: StepContext): string {
  const steps = deriveSteps(ctx)
  if (savedId && steps.some((s) => s.id === savedId)) return savedId
  return steps[0].id
}

function shift(state: MachineState, delta: number): MachineState {
  const steps = deriveSteps(state.ctx)
  const i = steps.findIndex((s) => s.id === state.currentId)
  if (i === -1) return { ...state, currentId: steps[0].id }
  const next = Math.min(Math.max(i + delta, 0), steps.length - 1)
  return { ...state, currentId: steps[next].id }
}

export function reduce(state: MachineState, event: MachineEvent): MachineState {
  switch (event.type) {
    case 'next':
      return shift(state, 1)
    case 'back':
      return shift(state, -1)
    case 'skip':
      // Skip exits the wizard; the caller persists status='skipped'. In-flight
      // downloads and installs are deliberately untouched (spec 25 §3.1).
      return { ...state, currentId: null }
    case 'goto':
      return deriveSteps(state.ctx).some((s) => s.id === event.id)
        ? { ...state, currentId: event.id }
        : state
    case 'ctx': {
      const ctx = { ...state.ctx, ...event.patch }
      // A context change can remove the step the user is standing on
      // (e.g. the download finishes while they are on `personalize`).
      return { ctx, currentId: resumeAt(state.currentId, ctx) }
    }
  }
}
