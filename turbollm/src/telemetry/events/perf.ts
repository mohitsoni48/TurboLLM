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
import type { PayloadOf } from '../core/types'
import type { LoadProfile } from '../../models/profile'
import type { ModelEntry } from '../../models/scanner'
import type { SysInfo } from '../../sysinfo/sysinfo'

/** Where a `bench_result` measurement came from. `autotune` is the original,
 *  synthetic sweep (short, idle-machine, cold-cache); the other three are
 *  real production traffic under real context depth and concurrency —
 *  strictly better data, and it arrives continuously instead of once. This
 *  is the field that keeps the two populations separable so a synthetic
 *  best-case number is never averaged into a real-world one (spec 23 §3.7,
 *  founder-directed 2026-08-05). */
export const BENCH_SOURCES = ['autotune', 'chat', 'gateway', 'code'] as const

export const benchResult = defineEvent({
  name: 'bench_result',
  since: 2,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'One benchmark measurement — model/quant/engine config and its measured t/s, TTFT, and VRAM.',
  payload: {
    source: f.enum(BENCH_SOURCES),
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

/** The `model`/`engine`/`params`/`hw` blocks for a real-run `bench_result`
 *  (`source: chat|gateway|code`) — the same currently-loaded config a
 *  `model_load` for this model already reported, reshaped to `bench_result`'s
 *  narrower params set (no `kvTypeV`/`kvUnified`/threads/etc. — this event
 *  only ever asked for the subset that most affects t/s). Shared by every
 *  real-run call site so the field mapping lives in one place. */
export function buildBenchResultConfig(
  entry: ModelEntry,
  profile: LoadProfile,
  engineVersion: string,
  sys: SysInfo,
): Pick<PayloadOf<NonNullable<(typeof benchResult)['payload']>>, 'model' | 'engine' | 'params'> & {
  hw: { cpu: string; ramMb: number; gpus: { name: string; vramMb: number }[] }
} {
  return {
    model: { name: entry.name, quant: entry.quant, arch: entry.arch, sizeBytes: entry.sizeBytes, moe: entry.moe },
    engine: { version: engineVersion },
    params: {
      ctx: profile.ctx,
      ngl: profile.ngl,
      nglFit: profile.nglFit ?? false,
      nCpuMoe: profile.nCpuMoe,
      nCpuMoeFit: profile.nCpuMoeFit ?? false,
      parallel: profile.parallel,
      kvTypeK: profile.kvTypeK,
      flashAttn: profile.flashAttn,
    },
    hw: {
      cpu: sys.cpu,
      ramMb: sys.ramMB,
      gpus: sys.gpus.map((g) => ({ name: g.name, vramMb: g.vramMb })),
    },
  }
}
