/**
 * Daily-bucketed UI click counter (`ui_daily`, spec 23 §3.8).
 *
 * Not `DailyRollup<Counters>` (`rollup.ts`): that class's `Counters` is a flat
 * `Record<string, number>`, one struct per key. `ui_daily` needs a struct PER
 * SCREEN (`actions` count + the set of distinct actions seen that day), so
 * this mirrors `daily-usage.ts`'s per-feature shape instead — same in-memory
 * cache, same disk-write-only-on-rollover-or-periodic-flush trade-off, same
 * never-throws contract — but keyed on `screen` and tracking a distinct-action
 * SET rather than a single count. Raw (unbucketed) counts are intentional here,
 * not an oversight: the founder's own decision for the Phase 3 daily rollups
 * (`chat_daily`/`gateway_daily`/`code_daily`) already moved off `COUNT_BUCKETS`
 * to raw per-day aggregates, and `ui_daily` follows the same precedent.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface ScreenUsage {
  day: string
  actions: number
  distinctActions: string[]
}

type UiDailyUsage = Record<string, ScreenUsage>

const cache = new Map<string, UiDailyUsage>()

function usagePath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'ui-daily-usage.json')
}

function readFromDisk(dataDir: string): UiDailyUsage {
  try {
    const parsed: unknown = JSON.parse(readFileSync(usagePath(dataDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as UiDailyUsage
  } catch {
    return {}
  }
}

function writeToDisk(dataDir: string, usage: UiDailyUsage): void {
  mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
  writeFileSync(usagePath(dataDir), JSON.stringify(usage))
}

function loadCache(dataDir: string): UiDailyUsage {
  let usage = cache.get(dataDir)
  if (usage === undefined) {
    usage = readFromDisk(dataDir)
    cache.set(dataDir, usage)
  }
  return usage
}

/**
 * Record one `ui_action` for `screen` on `today`. Returns the PREVIOUS day's
 * totals when the calendar day just rolled over for this screen (the caller
 * emits `ui_daily`); returns `null` when there is nothing to roll over yet.
 * Never throws (ADR-009).
 */
export function recordUiAction(
  dataDir: string,
  screen: string,
  action: string,
  today: string,
): { day: string; actions: number; distinctActions: number } | null {
  try {
    const usage = loadCache(dataDir)
    const existing = usage[screen]

    if (existing === undefined) {
      usage[screen] = { day: today, actions: 1, distinctActions: [action] }
      return null
    }

    if (existing.day === today) {
      usage[screen] = {
        day: today,
        actions: existing.actions + 1,
        distinctActions: existing.distinctActions.includes(action)
          ? existing.distinctActions
          : [...existing.distinctActions, action],
      }
      return null
    }

    const rolled = { day: existing.day, actions: existing.actions, distinctActions: existing.distinctActions.length }
    usage[screen] = { day: today, actions: 1, distinctActions: [action] }
    writeToDisk(dataDir, usage)
    return rolled
  } catch {
    return null
  }
}

/**
 * Roll over every screen whose recorded day is earlier than `today`. Called
 * from the daemon's periodic telemetry flush (cli.ts), same reasoning as
 * `flushStaleDailyUsage`: a screen used only on a user's LAST active day still
 * gets reported instead of waiting forever for a click that may never come.
 */
export function flushStaleUiUsage(
  dataDir: string,
  today: string,
): Array<{ screen: string; day: string; actions: number; distinctActions: number }> {
  try {
    const usage = loadCache(dataDir)
    const rolled: Array<{ screen: string; day: string; actions: number; distinctActions: number }> = []
    let changed = false
    for (const [screen, entry] of Object.entries(usage)) {
      if (entry.day === today) continue
      rolled.push({ screen, day: entry.day, actions: entry.actions, distinctActions: entry.distinctActions.length })
      delete usage[screen]
      changed = true
    }
    if (changed) writeToDisk(dataDir, usage)
    return rolled
  } catch {
    return []
  }
}

/** Persist the current in-memory tally to disk as-is, without rolling
 *  anything over — the periodic-flush half of the hot-path fix, same as
 *  `persistDailyUsage`. */
export function persistUiDailyUsage(dataDir: string): void {
  try {
    const usage = cache.get(dataDir)
    if (usage === undefined) return
    writeToDisk(dataDir, usage)
  } catch {
    // Best-effort by contract (ADR-009).
  }
}
