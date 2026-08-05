/**
 * Compile-time-checked emit (spec 24 G2, ADR-333).
 *
 * `Emitter.emit(event: EventName, payload?: Record<string, unknown>)`
 * (`emit.ts`) is, and stays, untyped on the payload — that is exactly the
 * mechanism behind ADR-327's `error`/`feature_used_daily` incident: `error`
 * and `feature_used_daily` were fully specified in the schema and shipped,
 * and NOTHING emitted them for a month, because a missing call site or a
 * wrong field name compiled fine and only ever failed silently at runtime
 * (or never even ran, so there was no runtime to fail).
 *
 * These wrappers close that gap at call sites without touching `Emitter`
 * itself — which already gets consent, the kill switch, and the ledger
 * exactly right, and has the test coverage to prove it. A typo'd field, a
 * missing required field, or an enum value that doesn't exist is now a
 * TypeScript error where the call is written, not a rejection nobody
 * notices until someone happens to query PostHog.
 */

import type { Emitter } from '../emit'
import type { EventDef, PayloadOf, FieldSpec } from '../core/types'
import type { EventName } from '../schema'

type PayloadArg<Payload extends Record<string, FieldSpec> | undefined> = Payload extends undefined
  ? []
  : [payload: PayloadOf<NonNullable<Payload>>]

/**
 * Emit a per-action event (no dedup) — `error`, `bench_result`, and most
 * events from Phase 2 on. `def` must be a real registered event (`Name
 * extends EventName`), so a stray ad-hoc object can never be passed here by
 * accident.
 */
export function emit<const Name extends EventName, const Payload extends Record<string, FieldSpec> | undefined>(
  emitter: Emitter,
  def: EventDef<Name, Payload>,
  ...args: PayloadArg<Payload>
): void {
  emitter.emit(def.name, args[0] as Record<string, unknown> | undefined)
}

/**
 * Emit a lifecycle:'once' event with no payload (`app_first_run`-shaped).
 * For 'once-with-payload' (a milestone whose once-ness must survive even a
 * FAILED first attempt — `model_first_load`'s now-retired shape, see
 * `events/model.ts`) see the event's own dedicated report function, which
 * claims the ledger key itself before calling {@link emit} — that decision is
 * specific enough per event (what counts as "the first attempt"?) that a
 * generic wrapper would either be wrong for some future event or need as
 * many options as just writing the three lines directly.
 */
export function emitOnce<const Name extends EventName>(emitter: Emitter, def: EventDef<Name, undefined>): void {
  emitter.once(def.name)
}
