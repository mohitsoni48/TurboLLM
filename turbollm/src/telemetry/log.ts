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
 *
 * Partitioned into two bounded files (spec 23 §6a, mandatory pre-ship
 * condition): `ui_action`/`ui_daily` can fire many times in a single session
 * (every click), and a single flat `MAX_LOGGED`-sized ring would let a few
 * minutes of clicking evict every rare, more sensitive entry (`error`,
 * `model_load`, `consent_choice`-adjacent events) — silently gutting the one
 * promise ("inspect what actually left this machine") that makes every other
 * privacy claim checkable. Each bucket gets its own cap; `readSentLog` merges
 * and re-sorts them for display so callers see one "newest first" list either
 * way.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** How many transmissions to retain per bucket. Enough to inspect a long
 *  session; small enough to stay a trivial file. */
export const MAX_LOGGED = 200
export const MAX_LOGGED_UI = 200

/** High-volume, per-click events get their own bucket so they can never evict
 *  a rare event from the general one. */
const UI_EVENTS = new Set(['ui_action', 'ui_daily'])

export interface SentEntry {
  sentAt: string
  event: Record<string, unknown>
}

function generalLogPath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'sent.json')
}

function uiLogPath(dataDir: string): string {
  return join(dataDir, 'telemetry', 'sent-ui.json')
}

function readBucket(path: string): SentEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as SentEntry[]) : []
  } catch {
    return []
  }
}

function writeBucket(dataDir: string, path: string, entries: SentEntry[]): void {
  mkdirSync(join(dataDir, 'telemetry'), { recursive: true })
  writeFileSync(path, JSON.stringify(entries))
}

/** Read the full log (both buckets merged), newest first. Never throws. */
export function readSentLog(dataDir: string): SentEntry[] {
  const merged = [...readBucket(generalLogPath(dataDir)), ...readBucket(uiLogPath(dataDir))]
  return merged.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0))
}

/** Append a transmitted batch as individual entries, routing `ui_action`/
 *  `ui_daily` into their own bounded bucket. Never throws. */
export function recordSent(dataDir: string, events: unknown[]): void {
  try {
    const sentAt = new Date().toISOString()
    const general: unknown[] = []
    const ui: unknown[] = []
    for (const event of events) {
      const name = (event as { event?: unknown } | null)?.event
      ;(typeof name === 'string' && UI_EVENTS.has(name) ? ui : general).push(event)
    }

    if (general.length > 0) {
      const fresh = general.map((event) => ({ sentAt, event: event as Record<string, unknown> })).reverse()
      writeBucket(dataDir, generalLogPath(dataDir), [...fresh, ...readBucket(generalLogPath(dataDir))].slice(0, MAX_LOGGED))
    }
    if (ui.length > 0) {
      const fresh = ui.map((event) => ({ sentAt, event: event as Record<string, unknown> })).reverse()
      writeBucket(dataDir, uiLogPath(dataDir), [...fresh, ...readBucket(uiLogPath(dataDir))].slice(0, MAX_LOGGED_UI))
    }
  } catch {
    // Best-effort: failing to log must not fail the send.
  }
}
