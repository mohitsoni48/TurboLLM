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

/**
 * RETIRED in v1.10.3 — no shipping code path emits this any more (`cli.ts` and
 * `bench/bench.ts` both say so at their retirement points). "First load" is now
 * derived as the first `model_load` per machine.
 *
 * DELIBERATELY STILL REGISTERED, and it must stay that way (2026-08-21
 * data-integrity audit). Deleting a name from the registry does not stop old
 * clients sending it — it makes the WORKER start rejecting them, which is exactly
 * what happened to `onboarding_step`: binaries already on users' machines kept
 * emitting it forever and every one of those events was refused at the edge.
 * Every install still on v1.10.2 or earlier emits this event today, and keeping
 * the entry is what lets those events be accepted and stored normally.
 *
 * What it is NOT is a metric. Because only pre-1.10.3 clients can emit it, its
 * machine count froze on 2026-08-06 and reads as a cliff — it showed 99 machines
 * "ever loaded a model" when `model_load` showed 192, a 2x understatement that
 * looked exactly like a regression. Do not put it in a funnel; use `model_load`.
 * Remove the entry only once telemetry from pre-1.10.3 clients has genuinely
 * stopped arriving.
 */
export const modelFirstLoad = defineEvent({
  name: 'model_first_load',
  since: 1,
  consent: 'anon',
  lifecycle: 'once-with-payload',
  description: "RETIRED (v1.10.3, derive from the first model_load instead). The outcome of this install's first-ever model load attempt — still accepted so pre-1.10.3 clients are not rejected at the edge.",
  payload: {
    outcome: f.enum(OUTCOMES),
    failReason: f.enum(FAIL_REASONS, { optional: true }),
  },
})

/** One model download settled (spec 23 §4, ADR-333) — promoted out of
 *  `onboarding_step`'s `step: 'model_download'` into its own first-class
 *  event when `onboarding_step` was deleted (Phase 7). `cancelled` is a
 *  deliberate abandon (`downloads.ts`'s own `AbortError` handling), never
 *  conflated with a genuine failure — the same distinction onboarding_step
 *  already made. */
export const modelDownloaded = defineEvent({
  name: 'model_downloaded',
  since: 2,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'One model download settled (success, failure, or a deliberate cancel).',
  payload: {
    outcome: f.enum(OUTCOMES),
  },
})

/** Who initiated a load. `gateway_switch` and `resume`/`manual` all funnel
 *  through `Manager.onLoadSettled` (cli.ts); `autotune` is reported directly
 *  by `bench.ts`, since an auto-tune sweep calls `Manager.start()` — a
 *  separate entry point from `.load()` that `onLoadSettled` never fires for
 *  (see cli.ts's own comment on this exact gap for `model_first_load`). */
export const MODEL_LOAD_TRIGGERS = ['manual', 'autotune', 'gateway_switch', 'resume'] as const

/** Structured `LoadError.code` values this product's own code emits (grep
 *  `code: '...'` across src/). A closed set by construction — these strings are
 *  written by us, never by an engine binary, a model file or a user — which is
 *  what makes reporting one compatible with the no-free-form-strings rule.
 *  `unknown` covers a code we do not recognise, so a future code added
 *  elsewhere degrades to a named bucket rather than being dropped. */
export const LOAD_ERROR_CODES = [
  'readiness_timeout', 'engine_unsupported', 'engine_exited', 'engine_spawn_failed',
  'model_load_failed', 'load_failed', 'model_not_loaded', 'unknown',
] as const

export const modelLoad = defineEvent({
  name: 'model_load',
  since: 2,
  consent: 'full',
  lifecycle: 'per-action',
  description: 'One model load attempt (success or failure), with the full resolved config that produced it.',
  payload: {
    outcome: f.enum(OUTCOMES),
    failReason: f.enum(FAIL_REASONS, { optional: true }),
    // The STRUCTURED error code the daemon's own code produced, alongside the
    // text-sniffed `failReason` (2026-08-21 data-integrity audit).
    //
    // 57.6% of failed loads classify as `failReason: 'other'`, and that tail can
    // never be narrowed from telemetry, because the thing that would explain it —
    // the error text — is deliberately never transmitted. Adding more sign-lists
    // to `classifyLoadFailure` would be guessing at strings nobody can see. This
    // is the way out that does not break the privacy rule: `code` is emitted by
    // OUR code from a closed set, never by a driver, a model file or a user, so
    // it can be reported as an enum. `other` + `engine_exited` reads as "the
    // process died and we could not say why from the log" — still a gap, but a
    // named one, instead of an unsplittable half of every failure.
    errorCode: f.enum(LOAD_ERROR_CODES, { optional: true }),
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
        speculative: f.enum(['off', 'mtp', 'nextn', 'draft', 'dflash']),
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
