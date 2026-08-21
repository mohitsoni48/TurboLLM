/**
 * Generic daily-aggregate accumulator (spec 24 §6, ADR-333) — the
 * `lifecycle: 'daily-rollup'` mechanism for events that report a STRUCT of
 * counters once a day (`chat_daily`, `gateway_daily`, `code_daily`,
 * `ui_daily`, spec 23 §3.4-3.8), as opposed to `daily-usage.ts`'s existing
 * per-FEATURE-dimension single count (`feature_used_daily`, kept as its own
 * module deliberately — see its own file's note on why this isn't forced
 * into the same mechanism).
 *
 * Same failure this is built to avoid as `daily-usage.ts` (found in PR #105
 * review, ADR-327): a synchronous disk read+write per call would double the
 * I/O on whatever hot path calls `bump()`, since some of these (gateway
 * request counts, chat messages) fire on the product's busiest routes.
 * Same fix — same-day increments are in-memory only; a write happens only
 * on a real day-rollover or via the periodic `persist()` call from the
 * existing 5-minute telemetry flush interval (cli.ts).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface RollupState<Counters extends Record<string, number>> {
  day: string
  counters: Counters
}

function statePath(dataDir: string, key: string): string {
  return join(dataDir, 'telemetry', `rollup-${key}.json`)
}

function readFromDisk<Counters extends Record<string, number>>(dataDir: string, key: string): RollupState<Counters> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(dataDir, key), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const p = parsed as Partial<RollupState<Counters>>
    if (typeof p.day !== 'string' || typeof p.counters !== 'object' || p.counters === null) return null
    return { day: p.day, counters: p.counters as Counters }
  } catch {
    return null
  }
}

/**
 * Whole days between two `YYYY-MM-DD` strings, clamped to the range every
 * rollup event's `daysAgo` field accepts (2026-08-21 data-integrity audit).
 *
 * Every daily-rollup event is stamped with its EMIT time, not the date its
 * counters describe, and the two only coincide when the daemon happened to be
 * running across that midnight. Charting rollups on `timestamp` therefore
 * attributed 17.7% of rows to the wrong day. `daysAgo` is what makes the real
 * day recoverable downstream (`toDate(ts) - daysAgo`), so it is computed here
 * once rather than open-coded at each of the five emit sites.
 *
 * Returns 0 for anything unparseable or in the future — a wrong-but-bounded
 * value that still validates beats dropping the event, which is the trade-off
 * every other function in this module already makes.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  const days = Math.round((b - a) / 86_400_000)
  return Math.min(366, Math.max(0, days))
}

function writeToDisk<Counters extends Record<string, number>>(dataDir: string, key: string, state: RollupState<Counters>): void {
  mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
  writeFileSync(statePath(dataDir, key), JSON.stringify(state))
}

/**
 * One event's running daily totals. `Counters` is the struct of numeric
 * fields the event reports (e.g. `{conversations: 0, messages: 0, ...}` for
 * `chat_daily`) — declared once per rollup event, matching the event's own
 * `defineEvent` payload shape field-for-field so nothing can drift between
 * what is counted and what is sent.
 *
 * Per-`dataDir`-per-`key` instances are expected to be long-lived (created
 * once at daemon startup, held for the process lifetime) rather than
 * constructed per call — `bump()` is meant to be cheap enough for a hot path.
 */
export class DailyRollup<Counters extends Record<string, number>> {
  private state: RollupState<Counters> | undefined

  constructor(
    private readonly dataDir: string,
    private readonly key: string,
    private readonly zero: Counters,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  /** Hydrate from disk on first access (once per process per instance —
   *  later calls are pure memory), same shape as `daily-usage.ts`'s
   *  `loadCache`. Never throws: a corrupt or missing state file just starts
   *  a fresh day at zero, which is the same "losing a data point beats
   *  crashing" trade-off every other file in this module makes. */
  private load(): RollupState<Counters> {
    if (this.state === undefined) {
      this.state = readFromDisk<Counters>(this.dataDir, this.key) ?? { day: this.today(), counters: { ...this.zero } }
    }
    return this.state
  }

  /** Increment one counter for TODAY by `by` (default 1). In-memory only —
   *  see the module doc comment. Never throws. */
  bump(counter: keyof Counters, by = 1): void {
    try {
      const s = this.load()
      s.counters[counter] = (s.counters[counter] + by) as Counters[typeof counter]
    } catch {
      // Best-effort by contract (ADR-009).
    }
  }

  /**
   * If the calendar day has moved past what's tracked, return the PREVIOUS
   * day's totals for the caller to emit and reset to a fresh zero struct for
   * the new day. Returns `null` when there is nothing to roll over yet.
   * Mirrors `daily-usage.ts`'s `recordFeatureUse`/rollover split: the caller
   * (the daemon's periodic flush, same as `flushDailyUsage`) decides when to
   * check, this decides whether there is anything to report.
   */
  takeRolledOver(): { day: string; counters: Counters } | null {
    try {
      const s = this.load()
      const todayStr = this.today()
      if (s.day === todayStr) return null
      const rolled = { day: s.day, counters: s.counters }
      this.state = { day: todayStr, counters: { ...this.zero } }
      writeToDisk(this.dataDir, this.key, this.state)
      return rolled
    } catch {
      return null
    }
  }

  /** Persist the current in-memory totals as-is, without rolling anything
   *  over — the periodic-flush half of the hot-path fix, exactly like
   *  `daily-usage.ts`'s `persistDailyUsage`: same-day counts otherwise only
   *  live in memory and would be lost on a crash between rollovers. */
  persist(): void {
    try {
      if (this.state === undefined) return
      writeToDisk(this.dataDir, this.key, this.state)
    } catch {
      // Best-effort by contract (ADR-009).
    }
  }
}
