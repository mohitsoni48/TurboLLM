/**
 * The ingest handler (ADR-299 Decision 1/2) — the logic behind the Cloudflare
 * Worker at `t.turbollm.dev`.
 *
 * It lives in the daemon's source tree, not the worker directory, so it imports
 * the SAME `schema.ts` the client emits against. That shared import is the
 * whole mechanism behind "client and edge cannot disagree about what is
 * allowed": if the allow-list is edited, both sides change together and these
 * tests run in the daemon's own suite.
 *
 * The Worker itself is a thin shell that supplies D1, KV and PostHog; all the
 * decisions are here, where they are testable without miniflare.
 *
 * There is no authentication, by design. The endpoint is public and documented
 * as such — a credential shipped in an open-source client is not a credential.
 * Defence is: schema allow-list, rate limits, plausibility filtering, and
 * defensive analysis downstream.
 */

import { validateEvent } from './schema'

/** Max events in one request. Matches `MAX_QUEUED_EVENTS` (queue.ts) exactly —
 *  a real client can never legitimately send more than its own queue holds, so
 *  any margin above that is pure headroom for an attacker, not a real client
 *  (found in pre-release review). Exported so the Worker's rate-limit tiers
 *  (telemetry-worker/src/index.ts) can be tested against the real worst-case
 *  batch size rather than a hardcoded literal that could silently drift. */
export const MAX_BATCH = 500

/** Plausibility ceiling for tokens/sec. Nothing on consumer hardware is close;
 *  anything above it is a fabricated row, not a lucky benchmark. */
const MAX_PLAUSIBLE_TPS = 100_000

export interface IngestDeps {
  now: () => number
  /** Returns whether this caller may proceed. Keyed on machineId + IP hash by
   *  the Worker; the IP is used transiently and never persisted. */
  rateLimit: (req: Request, events: Record<string, unknown>[]) => Promise<boolean>
  /** Durable raw mirror (D1) — the owned copy, and the one the benchmark-page
   *  generator reads. */
  store: (events: Record<string, unknown>[]) => Promise<void>
  /** Product-analytics fan-out (PostHog). */
  forward: (events: Record<string, unknown>[]) => Promise<void>
}

/** Reject rows that are well-formed but cannot be true. Cheap, and it keeps the
 *  public benchmark pages from quoting a fabricated number. */
function plausible(event: Record<string, unknown>): boolean {
  if (event.event !== 'bench_result') return true
  const payload = event.payload as { result?: { tps?: unknown } } | undefined
  const tps = payload?.result?.tps
  if (typeof tps !== 'number') return false
  return tps > 0 && tps < MAX_PLAUSIBLE_TPS
}

export async function handleIngest(req: Request, d: IngestDeps): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('bad json', { status: 400 })
  }
  if (!Array.isArray(body)) return new Response('expected an array of events', { status: 400 })
  if (body.length > MAX_BATCH) return new Response('batch too large', { status: 413 })

  // Validate first so the rate limiter sees the real machineId rather than
  // whatever an attacker claimed in an unvalidated field.
  const accepted: Record<string, unknown>[] = []
  for (const raw of body) {
    const result = validateEvent(raw)
    if (result.ok && plausible(result.event)) accepted.push(result.event)
  }

  if (!(await d.rateLimit(req, accepted))) {
    return new Response('slow down', { status: 429 })
  }

  if (accepted.length > 0) {
    // Storage failures must not become a client-visible error: the client would
    // retry, and a struggling backend would get hammered by its own users.
    try {
      await d.store(accepted)
    } catch {
      // swallowed deliberately
    }
    try {
      await d.forward(accepted)
    } catch {
      // swallowed deliberately
    }
  }

  // Always 202, whatever was dropped. Reporting which events failed validation
  // would hand a prober a free oracle for mapping the allow-list.
  return new Response(null, { status: 202 })
}
