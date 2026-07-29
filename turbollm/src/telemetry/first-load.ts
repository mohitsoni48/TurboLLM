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
 */

import { claimOnce } from './ledger'
import { classifyLoadFailure, type LoadError } from './classify'
import type { Emitter } from './emit'

/** Report the outcome of a model load. Only the first is recorded; later loads
 *  are ignored. Never throws. */
export function reportModelLoad(dataDir: string, emitter: Emitter, ok: boolean, err: LoadError | null): void {
  try {
    // Consent is checked BEFORE the claim is spent, so a load that happens
    // while telemetry is off does not silently consume the one chance to
    // record this (see Emitter.canSend).
    if (!emitter.canSend('model_first_load')) return
    if (!claimOnce(dataDir, 'once:model_first_load')) return

    emitter.emit(
      'model_first_load',
      ok ? { outcome: 'ok' } : { outcome: 'fail', failReason: classifyLoadFailure(err) },
    )
  } catch {
    // Best-effort by contract (ADR-009).
  }
}
