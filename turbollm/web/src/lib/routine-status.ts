import type { Routine, RoutineRun } from './routine-types'

/** Spec 20 §2.1's user-facing statuses. A DERIVED view, not a persisted field: `Routine.status`
 *  (schema.ts) only ever holds pending_confirmation/active/paused — 'needs_approval' and 'error'
 *  come from the routine's most recent RoutineRun. */
export type RoutineDisplayStatus = 'pending_confirmation' | 'active' | 'paused' | 'needs_approval' | 'error'

/** `latestRun` is index 0 of listRoutineRuns (newest-first; see routine-api.ts). A non-active
 *  routine's own status always wins — a paused routine whose last run errored reads "Paused",
 *  because nothing is scheduled to happen and "Error" would imply otherwise. */
export function deriveRoutineDisplayStatus(routine: Routine, latestRun: RoutineRun | null): RoutineDisplayStatus {
  if (routine.status !== 'active') return routine.status
  if (latestRun?.status === 'needs_approval') return 'needs_approval'
  if (latestRun?.status === 'errored') return 'error'
  return 'active'
}
