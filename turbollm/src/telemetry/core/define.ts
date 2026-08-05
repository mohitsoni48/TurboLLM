/**
 * Field builders for `defineEvent` payloads (spec 24, ADR-333).
 *
 * Thin, deliberately un-clever wrappers over the `FieldSpec` shapes in
 * `types.ts` — their only job is a terse call-site spelling
 * (`f.enum([...])` instead of `{ kind: 'enum', values: [...] }`) plus
 * preserving literal types through `const` type parameters, so
 * `PayloadOf<>` sees the real enum members rather than `string[]`.
 */

import type { FieldSpec } from './types'

export { defineEvent } from './types'

export const f = {
  enum<const V extends readonly [string, ...string[]]>(
    values: V,
    opts?: { optional?: boolean },
  ): { kind: 'enum'; values: V; optional?: boolean } {
    return { kind: 'enum', values, ...opts }
  },

  ident(opts?: { optional?: boolean; nullable?: boolean }): { kind: 'ident'; optional?: boolean; nullable?: boolean } {
    return { kind: 'ident', ...opts }
  },

  /** `app.os` shape ONLY — see `core/validate.ts`'s `isSafeOs`. Not a
   *  general identifier; do not reuse for anything else. */
  os(opts?: { optional?: boolean }): { kind: 'os'; optional?: boolean } {
    return { kind: 'os', ...opts }
  },

  int(opts?: { optional?: boolean; nullable?: boolean; min?: number; max?: number }): {
    kind: 'number'
    optional?: boolean
    nullable?: boolean
    min?: number
    max?: number
  } {
    return { kind: 'number', ...opts }
  },

  bool(opts?: { optional?: boolean }): { kind: 'boolean'; optional?: boolean } {
    return { kind: 'boolean', ...opts }
  },

  /** A nested block (today: `bench_result`'s `model`/`engine`/`params`/
   *  `result`). Recurses through the same field kinds, so a nested block
   *  can itself contain another nested block if a future event ever needs
   *  one — untested today because nothing needs it yet, not because it is
   *  unsupported. */
  object<const S extends Record<string, FieldSpec>>(shape: S, opts?: { optional?: boolean }): { kind: 'object'; shape: S; optional?: boolean } {
    return { kind: 'object', shape, ...opts }
  },

  /** An array of `items` (today: `bench_result.hw.gpus[]` only). */
  array<const I extends FieldSpec>(items: I, opts?: { optional?: boolean }): { kind: 'array'; items: I; optional?: boolean } {
    return { kind: 'array', items, ...opts }
  },
}
