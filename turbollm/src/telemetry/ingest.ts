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

import { structuralSanityCheck, validateEvent } from './schema'

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

/** Bound on one event's serialized size before it may be quarantined
 *  (ADR-331/333). A real event — even `bench_result` with its `hw.gpus[]`
 *  block — measures under 700 bytes; this leaves ~6x headroom for schema
 *  growth while still bounding worst-case quarantine storage cost regardless
 *  of what a future schema adds. An event over this cap is hard-rejected, the
 *  same as a structurally invalid one, never quarantined. */
const MAX_EVENT_BYTES = 4096

/** A real release, as published to npm. Anything else (`canary`,
 *  `posthog-verify`, `e2e-check`) is our own synthetic traffic. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Project an event's NESTED blocks onto flat top-level property names for
 * PostHog (2026-08-21 data-integrity audit).
 *
 * The whole envelope is forwarded as `properties`, which means `app` and
 * `payload` arrive as JSON objects. PostHog does not register object-valued
 * properties in its taxonomy, so for every app event the property picker
 * offered exactly four things — `machineId`, `event`, `ts`, `schema` — and
 * nothing else. Version, screen, action, outcome, failure reason, every
 * counter: all present in the stored JSON, none of them selectable. Anyone
 * building a chart by clicking could see WHERE a number moved and had no way
 * to ask WHY, and every breakdown had to be hand-written HogQL. That single
 * gap is most of why the data was described as unreadable.
 *
 * Flattening at the edge rather than in the client keeps the wire format, the
 * privacy allow-list and the D1 mirror exactly as they were — the nested
 * originals are still forwarded alongside, so nothing that already queries
 * `properties.app.version` breaks. This only ADDS the flat aliases PostHog can
 * actually index, which is also why it is safe to ship ahead of any client.
 *
 * One level deep, on purpose: every payload in the registry is flat except
 * `bench_result`'s nested blocks, whose leaves are the benchmark page's
 * business and are already reachable in SQL. Values are limited to scalars, so
 * this can never widen what a property may contain beyond what `validateEvent`
 * already allowed through — it re-shapes accepted data, it never admits more.
 *
 * Lives here rather than in the Worker for the same reason validation does:
 * the Worker is a shell, and anything with a decision in it needs to be
 * testable without miniflare.
 */
export function flattenForAnalytics(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const block of ['app', 'payload'] as const) {
    const v = e[block]
    if (typeof v !== 'object' || v === null || Array.isArray(v)) continue
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || ['string', 'number', 'boolean'].includes(typeof val)) {
        out[`${block}_${k}`] = val
      }
    }
  }
  // One clause any insight can filter on, instead of maintaining a version
  // deny-list by hand. The deploy canary and the launch-day seed batch were
  // 1,844 of 2,379 app_first_run events — a 5x inflation of the headline
  // install number that nobody could see, because their only tell was a
  // non-release version string buried inside a nested object.
  const version = (e.app as { version?: unknown } | undefined)?.version
  out.is_synthetic = typeof version === 'string' ? !SEMVER.test(version) : false
  return out
}

export interface QuarantinedEvent {
  /** The raw, unvalidated event exactly as received. */
  raw: Record<string, unknown>
  /** Why `validateEvent` rejected it — for triage after a redeploy, not
   *  shown to any client. */
  reason: string
}

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
  /** An event that failed `validateEvent` but passed `structuralSanityCheck`
   *  and the size cap — plausibly real data from a schema this Worker's
   *  deployed snapshot hasn't caught up to yet (ADR-331), not something to
   *  destroy. A separate D1 table, never forwarded to PostHog, replayable
   *  after the Worker is redeployed. This is the fix for the exact failure
   *  mode that lost every `first_chat` event for two days: the same
   *  rejection that used to vanish is now recoverable. */
  quarantine: (rows: QuarantinedEvent[]) => Promise<void>
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
  const quarantined: QuarantinedEvent[] = []
  for (const raw of body) {
    // Oversized regardless of shape — hard reject, never quarantined. Bounds
    // worst-case quarantine storage no matter what a future schema adds.
    if (JSON.stringify(raw).length > MAX_EVENT_BYTES) continue

    // Fails a check that must hold forever (not an object, an unsafe event
    // name shape, or the consent_choice privacy invariant) — malformed or
    // hostile, not schema drift. Hard reject.
    if (!structuralSanityCheck(raw).ok) continue

    const result = validateEvent(raw)
    if (result.ok) {
      if (plausible(result.event)) accepted.push(result.event)
      // Implausible (e.g. a fabricated tps): well-formed but not schema
      // drift, so dropped outright rather than quarantined.
      continue
    }

    // Passed every check above but still failed validateEvent — most likely
    // an event name, field, or enum value this Worker's deployed schema
    // snapshot doesn't know about yet (ADR-331). Quarantine, don't destroy.
    quarantined.push({ raw: raw as Record<string, unknown>, reason: result.reason })
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

  if (quarantined.length > 0) {
    try {
      await d.quarantine(quarantined)
    } catch {
      // swallowed deliberately, same reasoning as store() above
    }
  }

  // Always 202, whatever was dropped or quarantined. Reporting which events
  // failed validation would hand a prober a free oracle for mapping the
  // allow-list — the client stays blind either way; only the Worker's own
  // logs and the quarantine table itself carry that information now.
  return new Response(null, { status: 202 })
}
