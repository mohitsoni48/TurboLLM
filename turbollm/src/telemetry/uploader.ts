/**
 * The telemetry uploader (ADR-299) — the half of the flywheel that never
 * existed. `bench.ts` has queued events since the MVP; nothing ever drained
 * them, which is why `TELEMETRY_UI_ENABLED` has been `false` since ADR-041.
 *
 * Offline-first is a hard constraint (ADR-009): this must never block startup,
 * never throw, and never become a failure mode of the product. Callers are not
 * expected to await it.
 *
 * There is **no credential of any kind** in the request (ADR-299 Decision 2).
 * A "public" write key would be extractable from `npm pack` and, since the
 * aggregate IS the product, that makes it a dataset-poisoning primitive. Abuse
 * is handled at the edge instead: schema allow-list, rate limits, plausibility
 * filtering, defensive analysis.
 */

import { readQueue, remove } from './queue'

/** The ingest endpoint. Public and openly documented — there is nothing secret
 *  about the URL, and pretending otherwise would be security theatre. */
export const INGEST_URL = 'https://t.turbollm.dev/v1/events'

/** Sends a batch. Returns whether it was accepted. Injected so tests never
 *  touch the network. */
export type Transport = (events: unknown[]) => Promise<boolean>

/** Consent levels that permit transmission of queued events. `unset` (undecided)
 *  is deliberately NOT among them — an undecided user has not opted in. */
function mayTransmit(level: string): boolean {
  return level === 'anon' || level === 'full'
}

/**
 * Drain the queue.
 *
 * On a failed send the events stay queued, so an offline machine loses nothing.
 * When consent is not granted the queue is **purged rather than preserved**:
 * events queued while telemetry was on must not be transmitted after the user
 * turns it off, and must not sit on disk waiting for consent to flip back on.
 */
export async function flush(dataDir: string, level: string, transport: Transport = httpTransport): Promise<void> {
  try {
    const queued = readQueue(dataDir)

    if (!mayTransmit(level)) {
      for (const q of queued) remove(dataDir, q.file)
      return
    }
    if (queued.length === 0) return

    const accepted = await transport(queued.map((q) => q.event))
    if (accepted) for (const q of queued) remove(dataDir, q.file)
  } catch {
    // Best-effort by contract: a telemetry failure is never the user's problem.
  }
}

/** The real transport. Short timeout — a hanging ingest must not keep a handle
 *  open or delay shutdown. */
const httpTransport: Transport = async (events) => {
  const signal = AbortSignal.timeout(10_000)
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(events),
    signal,
  })
  return res.ok
}
