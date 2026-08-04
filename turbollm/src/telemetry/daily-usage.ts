/**
 * Daily-bucketed feature usage counter (`feature_used_daily`, ADR-299
 * Decision 6 / the telemetry-review follow-up that actually wired it up).
 *
 * A raw usage count is a behavioural fingerprint, so it is never sent as a
 * number — this module tracks the real per-day-per-feature count locally
 * (mirrors `ledger.ts`'s file-based, best-effort, never-throws shape) and
 * only a `COUNT_BUCKETS` bucket ever crosses into an emitted event.
 *
 * In-memory cache, not a disk round-trip per call (PR #105 review finding):
 * `recordFeatureUse` runs on the feature-discovery middleware, which fires on
 * EVERY matching API request — including the heaviest agentic-coding traffic
 * this product is designed to serve. A synchronous read+write per request
 * would double the disk I/O the pre-existing `firstUse`/`claimOnce` path
 * already pays on that same hot path. Instead, same-day increments only touch
 * an in-memory map; disk writes happen on a real rollover (at most once per
 * feature per day) or via `persistDailyUsage`, called from the daemon's
 * existing 5-minute telemetry flush interval (cli.ts) so a crash between
 * flushes loses at most one interval's worth of counting — the same bounded
 * risk ADR-009 already accepts for the queue flush.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface DailyCount {
  day: string
  count: number
}

type DailyUsage = Record<string, DailyCount>

/** Per-dataDir in-memory cache. Keyed by dataDir (not a singleton) so
 *  multiple daemons/tests pointed at different data directories in the same
 *  process never share state. */
const cache = new Map<string, DailyUsage>()

function usagePath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'daily-usage.json')
}

function readFromDisk(dataDir: string): DailyUsage {
  try {
    const parsed: unknown = JSON.parse(readFileSync(usagePath(dataDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as DailyUsage
  } catch {
    return {}
  }
}

function writeToDisk(dataDir: string, usage: DailyUsage): void {
  mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
  writeFileSync(usagePath(dataDir), JSON.stringify(usage))
}

/** The in-memory usage map for `dataDir`, hydrated from disk on first access
 *  (once per process per dataDir — later calls are pure memory). */
function loadCache(dataDir: string): DailyUsage {
  let usage = cache.get(dataDir)
  if (usage === undefined) {
    usage = readFromDisk(dataDir)
    cache.set(dataDir, usage)
  }
  return usage
}

/** Bucket a raw count into `COUNT_BUCKETS` (schema.ts) — the only shape of
 *  this number that may ever leave the machine. */
export function bucketCount(n: number): string {
  if (n <= 1) return '1'
  if (n <= 5) return '2-5'
  if (n <= 20) return '6-20'
  if (n <= 100) return '21-100'
  return '100+'
}

/**
 * Record one use of `feature` on `today`. Returns the PREVIOUS day's bucketed
 * tally when the calendar day just rolled over for this feature (the caller
 * emits it); returns `null` when there is nothing to roll over yet — either
 * the first use ever, or still the same day as the last one.
 *
 * Same-day increments are in-memory only (see module doc comment) — a
 * rollover is the only case that persists to disk immediately, since it's
 * inherently rare (at most once per feature per day).
 *
 * Never throws (ADR-009): any read/write failure is swallowed and treated as
 * "nothing to roll over", the same failure philosophy as `ledger.ts`.
 */
export function recordFeatureUse(
  dataDir: string,
  feature: string,
  today: string,
): { day: string; bucket: string } | null {
  try {
    const usage = loadCache(dataDir)
    const existing = usage[feature]

    if (existing === undefined) {
      usage[feature] = { day: today, count: 1 }
      return null
    }

    if (existing.day === today) {
      usage[feature] = { day: today, count: existing.count + 1 }
      return null
    }

    const rolled = { day: existing.day, bucket: bucketCount(existing.count) }
    usage[feature] = { day: today, count: 1 }
    writeToDisk(dataDir, usage)
    return rolled
  } catch {
    return null
  }
}

/**
 * Roll over every feature whose recorded day is earlier than `today`. Called
 * from the daemon's periodic telemetry flush (cli.ts) so a feature used only
 * on a user's LAST active day still gets its count reported, rather than
 * waiting forever for a next use of that same feature that may never come.
 */
export function flushStaleDailyUsage(
  dataDir: string,
  today: string,
): Array<{ feature: string; day: string; bucket: string }> {
  try {
    const usage = loadCache(dataDir)
    const rolled: Array<{ feature: string; day: string; bucket: string }> = []
    let changed = false
    for (const [feature, entry] of Object.entries(usage)) {
      if (entry.day === today) continue
      rolled.push({ feature, day: entry.day, bucket: bucketCount(entry.count) })
      delete usage[feature]
      changed = true
    }
    if (changed) writeToDisk(dataDir, usage)
    return rolled
  } catch {
    return []
  }
}

/**
 * Persist the current in-memory tally to disk as-is, without rolling
 * anything over — the periodic-flush half of the hot-path fix (PR #105
 * review): same-day counts otherwise only live in memory and would be lost
 * on a crash between rollovers. Called from the same 5-minute interval as
 * `flushStaleDailyUsage` (cli.ts), immediately after it, so a stale entry is
 * rolled over first and only the fresh remainder gets written here.
 */
export function persistDailyUsage(dataDir: string): void {
  try {
    const usage = cache.get(dataDir)
    if (usage === undefined) return // nothing recorded this process — nothing to persist
    writeToDisk(dataDir, usage)
  } catch {
    // Best-effort by contract (ADR-009).
  }
}
