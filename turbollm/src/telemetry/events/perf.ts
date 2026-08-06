/**
 * `bench_result` (spec 24, ADR-333) — unchanged from ADR-299 Decision 6.
 *
 * The one event whose validation previously needed its own bespoke
 * top-level function (`validatePayload`'s `bench_result` branch,
 * `validateHw`) because of its nested block shape. Expressed here purely as
 * `f.object`/`f.array` field specs — proof that the generic `checkFields`
 * (core/validate.ts) genuinely replaces that bespoke code rather than
 * merely wrapping it: no `bench_result`-specific validator function exists
 * anywhere in this redesign.
 *
 * Phase 4 (spec 23 §3.7) adds one field — `source: autotune|chat|gateway|
 * code` — so real-run t/s gets captured alongside autotune's synthetic
 * benchmark, distinguishable by that one flag.
 */

import { defineEvent, f } from '../core/define'
import { OUTCOMES } from '../core/enums'

export const benchResult = defineEvent({
  name: 'bench_result',
  since: 1,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'One benchmark measurement — model/quant/engine config and its measured t/s, TTFT, and VRAM.',
  payload: {
    model: f.object({
      name: f.ident(),
      quant: f.ident(),
      arch: f.ident(),
      sizeBytes: f.int(),
      moe: f.bool(),
    }),
    engine: f.object({
      version: f.ident(),
    }),
    params: f.object({
      ctx: f.int(),
      ngl: f.int(),
      nglFit: f.bool({ optional: true }),
      nCpuMoe: f.int(),
      nCpuMoeFit: f.bool({ optional: true }),
      parallel: f.int(),
      kvTypeK: f.ident(),
      flashAttn: f.ident(),
    }),
    result: f.object({
      tps: f.int(),
      ttftMs: f.int(),
      // `null` is real data here: BenchResult.vramMb is `number | null`, meaning
      // "we could not measure VRAM on this box" — distinct from "not reported".
      vramMb: f.int({ optional: true, nullable: true }),
      outcome: f.enum(OUTCOMES),
    }),
  },
  extraEnvelopeBlock: {
    key: 'hw',
    shape: {
      cpu: f.ident(),
      ramMb: f.int(),
      gpus: f.array(f.object({ name: f.ident(), vramMb: f.int() })),
    },
  },
})
