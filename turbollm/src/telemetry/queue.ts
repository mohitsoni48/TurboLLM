/**
 * The local telemetry queue (ADR-299).
 *
 * Events are written here and drained later by the uploader. Extracted from
 * `bench.ts`, which has queued `bench_result` events since the MVP but left the
 * queue **unbounded** — a machine that never successfully uploads would grow it
 * forever. ADR-299 requires a bounded queue that drops on overflow.
 *
 * Two invariants, both load-bearing:
 *
 * 1. **Nothing invalid is ever queued.** Every event is validated against the
 *    shared schema on the way in, not merely on the way out. A malformed event
 *    that reached disk would be a privacy problem sitting in the user's data
 *    directory, whether or not it was ever transmitted.
 * 2. **Nothing here ever throws.** Telemetry is best-effort and offline-first
 *    (ADR-009): it may not become a failure mode of the product. Callers get a
 *    boolean; they are not expected to handle errors, because there is nothing
 *    useful they could do.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateEvent } from './schema'

/** Hard cap on queued events. At roughly 400 bytes each this is well under a
 *  megabyte — small enough to never matter, large enough to survive a long
 *  offline stretch without losing a session's worth of journey data. */
export const MAX_QUEUED_EVENTS = 500

/** One queued event, with the file name needed to delete it once drained. */
export interface QueuedEvent {
  file: string
  event: Record<string, unknown>
}

function queueDir(dataDir: string): string {
  return join(dataDir, 'telemetry', 'queue')
}

/**
 * Validate and append one event. Returns whether it was queued.
 *
 * Consent is NOT checked here — the caller owns that decision, because the one
 * event that may be sent by a machine with consent off (`consent_choice`, the
 * Off ping) would otherwise be impossible to express.
 */
export function enqueue(dataDir: string, event: unknown): boolean {
  try {
    const result = validateEvent(event)
    if (!result.ok) return false

    const dir = queueDir(dataDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(result.event))
    trim(dir)
    return true
  } catch {
    return false
  }
}

/** Read everything currently queued, oldest first. Corrupt files are skipped
 *  and removed rather than allowed to wedge the queue forever. */
export function readQueue(dataDir: string): QueuedEvent[] {
  const dir = queueDir(dataDir)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }

  const out: QueuedEvent[] = []
  for (const file of files) {
    try {
      const event = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
      if (validateEvent(event).ok) out.push({ file, event })
      else remove(dataDir, file)
    } catch {
      remove(dataDir, file)
    }
  }
  return out
}

/** Delete one drained (or unreadable) event. Never throws. */
export function remove(dataDir: string, file: string): void {
  try {
    rmSync(join(queueDir(dataDir), file), { force: true })
  } catch {
    // best-effort
  }
}

/** Enforce {@link MAX_QUEUED_EVENTS} by dropping the OLDEST events. Names are
 *  `<epoch-ms>-<uuid>.json`, so lexical order is chronological order. Dropping
 *  the oldest keeps the queue biased toward recent behaviour, which is what the
 *  journey data is actually for. */
function trim(dir: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_QUEUED_EVENTS))) {
      rmSync(join(dir, stale), { force: true })
    }
  } catch {
    // best-effort
  }
}
