/**
 * `model_first_load` (ADR-299 Decision 6).
 *
 * The single most valuable journey event: an install that never gets a model
 * loaded is an install that never reached the product at all, and this is the
 * only signal that distinguishes "did not try" from "tried and it broke".
 *
 * A first load that FAILS still counts as the first load. If failures did not
 * claim the once-key, the user whose very first attempt OOMs — the precise
 * drop-off we are hunting — would look identical to a user who never tried.
 *
 * Classification is deliberately the CALLER's job, not this function's:
 * `Manager.load()` has a raw `LoadError` to run through `classifyLoadFailure`,
 * but `bench.ts`'s auto-tune sweep has no single error object at all — its
 * failure signal is the aggregate outcome of several internal search probes,
 * classified differently (see `classifyBenchFailure`). Forcing both through
 * one classifier shape would have meant reshaping bench's data to fit a
 * function that was never designed for it.
 */

import { claimOnce } from './ledger'
import type { Emitter } from './emit'

/** Report the outcome of a model load. Only the first is recorded — including
 *  a cancelled one, since the user whose FIRST attempt they abandon is still a
 *  real first-attempt data point. Never throws. */
export function reportModelLoad(
  dataDir: string,
  emitter: Emitter,
  outcome: 'ok' | 'fail' | 'cancelled',
  failReason?: string,
): void {
  try {
    // Consent is checked BEFORE the claim is spent, so a load that happens
    // while telemetry is off does not silently consume the one chance to
    // record this (see Emitter.canSend).
    if (!emitter.canSend('model_first_load')) return
    if (!claimOnce(dataDir, 'once:model_first_load')) return

    emitter.emit(
      'model_first_load',
      outcome === 'fail' ? { outcome, failReason } : { outcome },
    )
  } catch {
    // Best-effort by contract (ADR-009).
  }
}
