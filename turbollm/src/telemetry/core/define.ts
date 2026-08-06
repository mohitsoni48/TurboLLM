/**
 * Field builders for `defineEvent` payloads (spec 24, ADR-333).
 *
 * Thin, deliberately un-clever wrappers over the `FieldSpec` shapes in
 * `types.ts` — their only job is a terse call-site spelling
 * (`f.enum([...])` instead of `{ kind: 'enum', values: [...] }`) plus
 * preserving literal types through `const` type parameters, so
 * `PayloadOf<>` sees the real enum members rather than `string[]`.
 *
 * `optional`/`nullable` are generic type parameters (`Opt`/`Nul`), NOT typed
 * as plain `boolean` on the return value — `PayloadOf<>` dispatches on
 * `Spec[K] extends { optional: true }`, which only matches when the field's
 * own type carries the LITERAL `true`, not the widened `boolean` a plain
 * `optional?: boolean` return annotation would produce. Getting this wrong
 * silently turns every "optional" field into a required one at the type
 * level with no error — found only once an event with a real optional field
 * (`model_load`) was pushed through the typed `emit()` path for the first
 * time; every Phase 1 event exercised either had no optional fields or no
 * payload at all, so it went undetected until this call site (see the
 * ADR-333 commit history for the `PayloadOf` fix this shipped alongside).
 */

import type { FieldSpec } from './types'

export { defineEvent } from './types'

export const f = {
  enum<const V extends readonly [string, ...string[]], const Opt extends boolean = false>(
    values: V,
    opts?: { optional?: Opt },
  ): { kind: 'enum'; values: V; optional: Opt } {
    return { kind: 'enum', values, optional: (opts?.optional ?? false) as Opt }
  },

  ident<const Opt extends boolean = false, const Nul extends boolean = false>(
    opts?: { optional?: Opt; nullable?: Nul },
  ): { kind: 'ident'; optional: Opt; nullable: Nul } {
    return { kind: 'ident', optional: (opts?.optional ?? false) as Opt, nullable: (opts?.nullable ?? false) as Nul }
  },

  /** `app.os` shape ONLY — see `core/validate.ts`'s `isSafeOs`. Not a
   *  general identifier; do not reuse for anything else. */
  os<const Opt extends boolean = false>(opts?: { optional?: Opt }): { kind: 'os'; optional: Opt } {
    return { kind: 'os', optional: (opts?.optional ?? false) as Opt }
  },

  int<const Opt extends boolean = false, const Nul extends boolean = false>(
    opts?: { optional?: Opt; nullable?: Nul; min?: number; max?: number },
  ): { kind: 'number'; optional: Opt; nullable: Nul; min?: number; max?: number } {
    return {
      kind: 'number',
      optional: (opts?.optional ?? false) as Opt,
      nullable: (opts?.nullable ?? false) as Nul,
      ...(opts?.min !== undefined ? { min: opts.min } : {}),
      ...(opts?.max !== undefined ? { max: opts.max } : {}),
    }
  },

  bool<const Opt extends boolean = false>(opts?: { optional?: Opt }): { kind: 'boolean'; optional: Opt } {
    return { kind: 'boolean', optional: (opts?.optional ?? false) as Opt }
  },

  /** A nested block (today: `bench_result`'s `model`/`engine`/`params`/
   *  `result`, `model_load`'s equivalents). Recurses through the same field
   *  kinds, so a nested block can itself contain another nested block if a
   *  future event ever needs one — untested today because nothing needs it
   *  yet, not because it is unsupported. */
  object<const S extends Record<string, FieldSpec>, const Opt extends boolean = false>(
    shape: S,
    opts?: { optional?: Opt },
  ): { kind: 'object'; shape: S; optional: Opt } {
    return { kind: 'object', shape, optional: (opts?.optional ?? false) as Opt }
  },

  /** An array of `items` (today: `bench_result.hw.gpus[]` only). */
  array<const I extends FieldSpec, const Opt extends boolean = false>(
    items: I,
    opts?: { optional?: Opt },
  ): { kind: 'array'; items: I; optional: Opt } {
    return { kind: 'array', items, optional: (opts?.optional ?? false) as Opt }
  },
}
