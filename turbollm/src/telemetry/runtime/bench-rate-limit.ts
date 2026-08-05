/**
 * Rate limit for real-run `bench_result` telemetry (spec 23 §3.7, ADR-333).
 *
 * A heavy chat user could otherwise generate hundreds of `bench_result`
 * events a day. Bounded to at most one per `(model, config, source)` per
 * hour — the same model+quant+ctx+ngl+... combination measured twice inside
 * an hour is not new information. Simplified from spec 23's original "keep
 * the median of the hour's runs" to "keep the first run of the hour,
 * everything else in that window is dropped": a true median needs buffering
 * every candidate for the hour and only flushing the winner at the end,
 * which is a real accumulator (like `runtime/rollup.ts`'s, but keyed by a
 * dynamic, per-model `key` rather than one fixed event name) — a genuinely
 * separate piece of infrastructure, not a one-line change. Tracked as a
 * follow-up (TODO.md) rather than silently downgraded without a note.
 *
 * File-based, best-effort, never throws — same shape as `ledger.ts`/
 * `daily-usage.ts`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** How often the SAME (model, config, source) key may report. */
export const BENCH_RATE_LIMIT_MS = 60 * 60 * 1000

/** Floor below which a run is too short to be a meaningful t/s sample —
 *  t/s over a handful of tokens is mostly measurement noise, not signal. */
export const MIN_GEN_TOKENS_FOR_BENCH = 32

function statePath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'bench-rate-limit.json')
}

function read(dataDir: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(dataDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, number>
  } catch {
    return {}
  }
}

/** A stable key for one (model, config, source) combination. Deliberately a
 *  handful of the fields that most affect t/s — not every field in
 *  `buildModelLoadConfig`-style configs — since the point is deduplicating
 *  "the same measurement again", not creating a near-infinite key space that
 *  defeats the rate limit's own purpose. */
export function benchRateLimitKey(modelKey: string, quant: string, ctx: number, ngl: number, nCpuMoe: number, kvTypeK: string, source: string): string {
  return [modelKey, quant, ctx, ngl, nCpuMoe, kvTypeK, source].join('|')
}

/** Whether a `bench_result` for `key` may be sent right now. Claims the slot
 *  (updates the last-sent time) as a side effect when it returns true, same
 *  "claiming is part of checking" shape as `ledger.ts`'s `claimOnce`, so a
 *  caller never has to remember a separate follow-up write. On any read/write
 *  failure this returns `true` (allow) rather than `false` — unlike
 *  `claimOnce`'s "fail closed", over-sending an occasional duplicate
 *  measurement is a far smaller cost than silently going blind to real t/s
 *  data because of a transient disk error. */
export function shouldEmitBenchResult(dataDir: string, key: string, now: number = Date.now()): boolean {
  try {
    const state = read(dataDir)
    const last = state[key]
    if (last !== undefined && now - last < BENCH_RATE_LIMIT_MS) return false

    state[key] = now
    // Bound the file: entries older than the rate-limit window are pure
    // clutter (they can never block anything again) and would otherwise
    // grow this file forever across every distinct model/config/source a
    // machine has ever measured.
    for (const k of Object.keys(state)) {
      if (now - state[k] >= BENCH_RATE_LIMIT_MS) delete state[k]
    }
    mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
    writeFileSync(statePath(dataDir), JSON.stringify(state))
    return true
  } catch {
    return true
  }
}
