/**
 * The once-only ledger (ADR-299).
 *
 * Records that a one-time telemetry event has already happened, so it survives
 * a daemon restart. Shared by the journey emitter (`app_first_run`,
 * `feature_first_use`, `daily_active`) and the consent ping, which must agree
 * on what "once" means.
 *
 * Never throws.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** How many `daily:` keys to retain — one per day would otherwise grow forever. */
const DAILY_KEEP = 30

function ledgerPath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'ledger.json')
}

function read(dataDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(dataDir), 'utf8'))
    return Array.isArray(parsed) ? (parsed.filter((k) => typeof k === 'string') as string[]) : []
  } catch {
    return []
  }
}

/**
 * Claim a one-time key. Returns whether THIS call claimed it — i.e. whether the
 * caller should go ahead and emit.
 *
 * On any read/write failure this returns `false` (do not emit). Emitting anyway
 * would risk an unbounded duplicate stream from a machine with a failing disk;
 * declining loses a single data point. Losing data is the better failure.
 */
export function claimOnce(dataDir: string, key: string): boolean {
  try {
    const keys = read(dataDir)
    if (keys.includes(key)) return false

    keys.push(key)
    const dailies = keys.filter((k) => k.startsWith('daily:')).slice(-DAILY_KEEP)
    const rest = keys.filter((k) => !k.startsWith('daily:'))

    mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
    writeFileSync(ledgerPath(dataDir), JSON.stringify([...rest, ...dailies]))
    return true
  } catch {
    return false
  }
}
