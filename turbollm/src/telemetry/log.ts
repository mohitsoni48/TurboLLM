/**
 * The local submission log (ADR-299; specced in `architecture/08` since
 * 2026-06-13 and never built until now).
 *
 * Records what was **actually transmitted** — not what we intended to send, not
 * a representative sample. Every other privacy claim in this product is a
 * sentence in a document; this is the one that lets a user check those
 * sentences against reality on their own machine.
 *
 * Because of that, entries are stored **verbatim**. Summarising or redacting
 * them here would defeat the whole point: a log that shows a cleaned-up version
 * of the payload proves nothing about the payload.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** How many transmissions to retain. Enough to inspect a long session; small
 *  enough to stay a trivial file. */
export const MAX_LOGGED = 200

export interface SentEntry {
  sentAt: string
  event: Record<string, unknown>
}

function logPath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'sent.json')
}

/** Read the log, newest first. Never throws. */
export function readSentLog(dataDir: string): SentEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(logPath(dataDir), 'utf8'))
    return Array.isArray(parsed) ? (parsed as SentEntry[]) : []
  } catch {
    return []
  }
}

/** Append a transmitted batch as individual entries. Never throws. */
export function recordSent(dataDir: string, events: unknown[]): void {
  try {
    const sentAt = new Date().toISOString()
    const fresh = events.map((event) => ({ sentAt, event: event as Record<string, unknown> })).reverse()
    const next = [...fresh, ...readSentLog(dataDir)].slice(0, MAX_LOGGED)

    mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
    writeFileSync(logPath(dataDir), JSON.stringify(next))
  } catch {
    // Best-effort: failing to log must not fail the send.
  }
}
