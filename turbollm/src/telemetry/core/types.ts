/**
 * The field-spec type system (spec 24, ADR-333) — the thing that turns
 * "adding an event" from editing three parallel hand-maintained structures
 * (an enum array, a payload-spec map, a TypeScript type someone remembers to
 * update) into declaring one object once.
 *
 * A strict generalization of the FieldSpec shape `schema.ts` already used —
 * every kind here (`enum`/`ident`/`os`/`number`/`boolean`) validates exactly
 * as it always did. The one addition is `object`, which replaces the
 * bespoke `BENCH_PAYLOAD`-shaped nested-block handling with a spec that can
 * recurse into itself, so a future structured event does not need its own
 * hand-written nested validator.
 *
 * Deliberately no `string` kind. A free-form string cannot be expressed in
 * this type system at all — the privacy contract ("every field is an enum,
 * a capped identifier, a number, or a boolean — never free text") is
 * therefore enforced by the type system, not by a rule a reviewer has to
 * remember to check.
 */

export type FieldSpec =
  | { kind: 'enum'; values: readonly string[]; optional?: boolean }
  | { kind: 'ident'; optional?: boolean; nullable?: boolean }
  | { kind: 'os'; optional?: boolean }
  | { kind: 'number'; optional?: boolean; nullable?: boolean; min?: number; max?: number }
  | { kind: 'boolean'; optional?: boolean }
  | { kind: 'object'; shape: Record<string, FieldSpec>; optional?: boolean }
  | { kind: 'array'; items: FieldSpec; optional?: boolean }

type ValueOf<F extends FieldSpec> = F extends { kind: 'enum'; values: readonly (infer V extends string)[] }
  ? V
  : F extends { kind: 'ident' }
    ? string
    : F extends { kind: 'os' }
      ? string
      : F extends { kind: 'number' }
        ? number
        : F extends { kind: 'boolean' }
          ? boolean
          : F extends { kind: 'object'; shape: infer S extends Record<string, FieldSpec> }
            ? PayloadOf<S>
            : F extends { kind: 'array'; items: infer I extends FieldSpec }
              ? ValueOf<I>[]
              : never

type WithNull<F extends FieldSpec, V> = F extends { nullable: true } ? V | null : V

type RequiredKeys<Spec extends Record<string, FieldSpec>> = {
  [K in keyof Spec]: Spec[K] extends { optional: true } ? never : K
}[keyof Spec]

type OptionalKeys<Spec extends Record<string, FieldSpec>> = {
  [K in keyof Spec]: Spec[K] extends { optional: true } ? K : never
}[keyof Spec]

/** The TypeScript payload type a `Record<string, FieldSpec>` describes —
 *  what makes `emit()` a compile error on a wrong or missing field (G2,
 *  ADR-333), instead of a runtime rejection nobody notices for a month
 *  (ADR-299 → ADR-327's `error`/`feature_used_daily` incident). */
export type PayloadOf<Spec extends Record<string, FieldSpec>> = {
  [K in RequiredKeys<Spec>]: WithNull<Spec[K], ValueOf<Spec[K]>>
} & {
  [K in OptionalKeys<Spec>]?: WithNull<Spec[K], ValueOf<Spec[K]>>
}

/** When a `validateEvent`-style rejection should be treated as: 'once ever'
 *  (app_first_run-shaped, no payload beyond the envelope); 'once ever, may
 *  carry a payload' (model_first_load-shaped: the first attempt is recorded
 *  even if it failed); 'once per distinct key' (feature_first_use-shaped:
 *  once per feature, not once per event); 'once per calendar day'
 *  (daily_active-shaped); 'accumulate and flush once a day'
 *  (feature_used_daily today, chat_daily/gateway_daily/etc. from Phase 3,
 *  see `runtime/rollup.ts`); or 'no dedup, every call sends' (error,
 *  bench_result, and most events from Phase 2 on). This is metadata for
 *  humans reading the registry and for the runtime helpers in
 *  `runtime/typed-emit.ts` to dispatch on — it does not change what
 *  `validateEvent` accepts, which is a function only of `payload`. */
export type Lifecycle = 'once' | 'once-with-payload' | 'once-by-key' | 'once-daily' | 'daily-rollup' | 'per-action'

/** Which consent level must be granted for this event to ever leave the
 *  machine. `'always'` exists for exactly one event (`consent_choice`): its
 *  gating is bespoke (`telemetry/consent.ts`), not the standard
 *  `Emitter.canSend` check, because it is the one thing an opted-OUT
 *  machine still sends. */
export type ConsentLevel = 'anon' | 'full' | 'always'

export interface EventDef<
  Name extends string = string,
  Payload extends Record<string, FieldSpec> | undefined = Record<string, FieldSpec> | undefined,
> {
  name: Name
  /** Schema generation this event (or this shape of it) was introduced in.
   *  Documentation, not enforcement — a human-readable "since when has a
   *  Worker needed to know about this" marker, distinct from
   *  `TELEMETRY_SCHEMA_VERSION` (schema.ts), which only bumps for a breaking
   *  wire-format change. */
  since: number
  consent: ConsentLevel
  lifecycle: Lifecycle
  description: string
  /** `undefined` means this event carries no payload at all (matches
   *  today's `app_first_run`/`daily_active`) — sending one is a hard reject,
   *  same as always. */
  payload?: Payload
  /**
   * A second top-level envelope block besides `payload`. Exactly one event
   * uses this today (`bench_result`'s `hw` block) and it is expected to
   * stay that way — this is not a general escape hatch for skipping the
   * `payload` shape; adding a second consumer should be as deliberate a
   * decision as `hw` itself was (ADR-299).
   */
  extraEnvelopeBlock?: { key: string; shape: Record<string, FieldSpec> }
}

/** Identity function with a precise generic signature — its only job is
 *  letting TypeScript infer and preserve the exact literal `Name` and
 *  `Payload` shape of whatever is passed in, so `PayloadOf<>` and `emit()`
 *  see the real field specs rather than the widened `EventDef` interface. */
export function defineEvent<const Name extends string, const Payload extends Record<string, FieldSpec> | undefined = undefined>(
  def: EventDef<Name, Payload>,
): EventDef<Name, Payload> {
  return def
}
