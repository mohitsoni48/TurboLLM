/**
 * Daily-bucketed feature usage counter (`feature_used_daily`, ADR-299
 * Decision 6 / the telemetry-review follow-up that actually wired it up).
 *
 * A raw usage count is a behavioural fingerprint, so it is never sent as a
 * number — this module tracks the real per-day-per-feature count locally
 * (mirrors `ledger.ts`'s file-based, best-effort, never-throws shape) and
 * only a `COUNT_BUCKETS` bucket ever crosses into an emitted event.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface DailyCount {
  day: string
  count: number
}

type DailyUsage = Record<string, DailyCount>

function usagePath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'daily-usage.json')
}

function read(dataDir: string): DailyUsage {
  try {
    const parsed: unknown = JSON.parse(readFileSync(usagePath(dataDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as DailyUsage
  } catch {
    return {}
  }
}

function write(dataDir: string, usage: DailyUsage): void {
  mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
  writeFileSync(usagePath(dataDir), JSON.stringify(usage))
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
 * Never throws (ADR-009): any read/write failure is swallowed and treated as
 * "nothing to roll over", the same failure philosophy as `ledger.ts`.
 */
export function recordFeatureUse(
  dataDir: string,
  feature: string,
  today: string,
): { day: string; bucket: string } | null {
  try {
    const usage = read(dataDir)
    const existing = usage[feature]

    if (existing === undefined) {
      usage[feature] = { day: today, count: 1 }
      write(dataDir, usage)
      return null
    }

    if (existing.day === today) {
      usage[feature] = { day: today, count: existing.count + 1 }
      write(dataDir, usage)
      return null
    }

    const rolled = { day: existing.day, bucket: bucketCount(existing.count) }
    usage[feature] = { day: today, count: 1 }
    write(dataDir, usage)
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
    const usage = read(dataDir)
    const rolled: Array<{ feature: string; day: string; bucket: string }> = []
    let changed = false
    for (const [feature, entry] of Object.entries(usage)) {
      if (entry.day === today) continue
      rolled.push({ feature, day: entry.day, bucket: bucketCount(entry.count) })
      delete usage[feature]
      changed = true
    }
    if (changed) write(dataDir, usage)
    return rolled
  } catch {
    return []
  }
}
