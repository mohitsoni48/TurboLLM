/**
 * Model-load events (spec 24, ADR-333). `model_first_load` is unchanged from
 * ADR-299 Decision 6. `model_load` (spec 23 §3.3, founder-directed 2026-08-05:
 * "for model, which model is used, quant, kv quant, ctx basically whole
 * config") is new: it fires on EVERY load, not just the first, and carries
 * the resolved config that produced it — the config `model_first_load` and
 * `bench_result` both discard today.
 */

import { defineEvent, f } from '../core/define'
import { FAIL_REASONS, OUTCOMES } from '../core/enums'
import type { PayloadOf } from '../core/types'
import type { LoadProfile } from '../../models/profile'
import type { ModelEntry } from '../../models/scanner'
import type { Engine } from '../../config/config'
import type { VramFit } from '../../models/profile'

export const modelFirstLoad = defineEvent({
  name: 'model_first_load',
  since: 1,
  consent: 'anon',
  lifecycle: 'once-with-payload',
  description: "The outcome of this install's first-ever model load attempt (including a failed one).",
  payload: {
    outcome: f.enum(OUTCOMES),
    failReason: f.enum(FAIL_REASONS, { optional: true }),
  },
})

/** Who initiated a load. `gateway_switch` and `resume`/`manual` all funnel
 *  through `Manager.onLoadSettled` (cli.ts); `autotune` is reported directly
 *  by `bench.ts`, since an auto-tune sweep calls `Manager.start()` — a
 *  separate entry point from `.load()` that `onLoadSettled` never fires for
 *  (see cli.ts's own comment on this exact gap for `model_first_load`). */
export const MODEL_LOAD_TRIGGERS = ['manual', 'autotune', 'gateway_switch', 'resume'] as const

export const modelLoad = defineEvent({
  name: 'model_load',
  since: 2,
  consent: 'full',
  lifecycle: 'per-action',
  description: 'One model load attempt (success or failure), with the full resolved config that produced it.',
  payload: {
    outcome: f.enum(OUTCOMES),
    failReason: f.enum(FAIL_REASONS, { optional: true }),
    trigger: f.enum(MODEL_LOAD_TRIGGERS),

    // Absent together when no profile/model-entry was available to report from
    // (the transitional dev-model fallback path, cli.ts) — never fabricated
    // partially. See `buildModelLoadConfig` below.
    model: f.object(
      {
        name: f.ident(),
        quant: f.ident(),
        arch: f.ident(),
        sizeBytes: f.int(),
        moe: f.bool(),
        nativeCtx: f.int(),
      },
      { optional: true },
    ),
    engine: f.object(
      {
        // Free string in the config today (no closed EngineKind type exists yet —
        // see TODO.md's engine-catalog descriptor-table item), and can legitimately
        // be a user's own self-added git-repo engine — enumerating it would silently
        // under-count exactly those. `ident`, matching `bench_result.engine.version`'s
        // own precedent for the same open-ended-but-safe-to-cap situation.
        kind: f.ident(),
        isCustom: f.bool(),
      },
      { optional: true },
    ),
    params: f.object(
      {
        ctx: f.int(),
        ngl: f.int(),
        nglFit: f.bool(),
        nCpuMoe: f.int(),
        nCpuMoeFit: f.bool(),
        kvTypeK: f.ident(),
        kvTypeV: f.ident(),
        kvUnified: f.bool(),
        kvOffload: f.bool(),
        flashAttn: f.enum(['auto', 'on', 'off']),
        parallel: f.int(),
        threads: f.int(),
        threadsBatch: f.int(),
        batchSize: f.int({ optional: true }),
        uBatchSize: f.int({ optional: true }),
        cacheReuse: f.int(),
        speculative: f.enum(['off', 'mtp', 'nextn', 'draft']),
        contextOverflow: f.enum(['shift', 'keep']),
        nKeep: f.int(),
        ropeScalingType: f.enum(['none', 'linear', 'yarn']),
        useJinja: f.bool(),
        // Booleans only — never the grammar text or the extraArgs strings themselves,
        // both of which can contain arbitrary user content (a GBNF grammar, a raw
        // engine flag with an embedded value).
        hasGrammar: f.bool(),
        hasExtraArgs: f.bool(),
        multiGpu: f.bool(),
        gpuCount: f.int(),
      },
      { optional: true },
    ),
    fit: f.object(
      {
        // Estimated only (profile.ts's pure calculation) — a live-measured VRAM
        // number isn't available at this hook point without new plumbing; noted
        // as a deliberate, documented gap (TODO.md) rather than a fabricated value.
        estimatedVramMb: f.int({ optional: true, nullable: true }),
      },
      { optional: true },
    ),
  },
})

/** The three optional config blocks (`model`/`engine`/`params`), or `null` if
 *  the fit calculation and a real model entry + engine + profile weren't all
 *  available — matching `modelLoad`'s own "absent together, never fabricated
 *  partially" contract. Shared by cli.ts's `Manager.onLoadSettled` wiring and
 *  bench.ts's auto-tune sweep reporting, so the field mapping lives in one
 *  place rather than two copies that could quietly drift apart. */
export function buildModelLoadConfig(
  entry: ModelEntry,
  profile: LoadProfile,
  engine: Engine,
  vram: VramFit,
): Pick<PayloadOf<NonNullable<(typeof modelLoad)['payload']>>, 'model' | 'engine' | 'params' | 'fit'> {
  const gpuCount = profile.gpu.tensorSplit.length > 0 ? profile.gpu.tensorSplit.length : 1
  return {
    model: {
      name: entry.name,
      quant: entry.quant,
      arch: entry.arch,
      sizeBytes: entry.sizeBytes,
      moe: entry.moe,
      nativeCtx: entry.nativeCtx,
    },
    engine: {
      kind: engine.kind,
      isCustom: Boolean(engine.sourceRepo),
    },
    params: {
      ctx: profile.ctx,
      ngl: profile.ngl,
      nglFit: profile.nglFit ?? false,
      nCpuMoe: profile.nCpuMoe,
      nCpuMoeFit: profile.nCpuMoeFit ?? false,
      kvTypeK: profile.kvTypeK,
      kvTypeV: profile.kvTypeV,
      kvUnified: profile.kvUnified,
      kvOffload: profile.kvOffload,
      flashAttn: profile.flashAttn,
      parallel: profile.parallel,
      threads: profile.threads,
      threadsBatch: profile.threadsBatch,
      batchSize: profile.batchSize,
      uBatchSize: profile.uBatchSize,
      cacheReuse: profile.cacheReuse,
      speculative: profile.speculative,
      contextOverflow: profile.contextOverflow,
      nKeep: profile.nKeep,
      ropeScalingType: profile.ropeScalingType,
      useJinja: profile.useJinja,
      hasGrammar: profile.grammar !== '',
      hasExtraArgs: profile.extraArgs.length > 0,
      multiGpu: gpuCount > 1,
      gpuCount,
    },
    fit: {
      estimatedVramMb: vram.estMb,
    },
  }
}
