/**
 * TurboLLM telemetry ingest Worker (ADR-299).
 *
 * A thin shell. Every decision — validation, plausibility, what a 202 means —
 * lives in `handleIngest` in the daemon's source tree, so the Worker and the
 * client import the SAME schema and cannot drift. Do not reimplement any of
 * that here.
 *
 * Secrets (PostHog) are Worker secrets. Nothing secret ships in the npm client:
 * the endpoint is public and documented as public.
 *
 * Deploy:  wrangler secret put POSTHOG_KEY   (then)   wrangler deploy
 */

import { handleIngest, type IngestDeps } from '../../turbollm/src/telemetry/ingest'
import { MACHINE_LIMIT, IP_LIMIT } from '../../turbollm/src/telemetry/rate-limit-window'
import { RateLimiterDO } from './rate-limiter-do'

export { RateLimiterDO }

/** Structural Durable Object types. No `@cloudflare/workers-types` dependency
 *  exists in this bare, package.json-less Worker (wrangler bundles it with
 *  esbuild and does not typecheck), so these are plain structural types
 *  rather than imported ones — accurate to the documented API either way. */
interface DurableObjectId {
  readonly __brand: unique symbol
}
interface DurableObjectStub {
  fetch(url: string): Promise<Response>
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

interface Env {
  DB: D1Database
  RATE_LIMITER: DurableObjectNamespace
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
}

// MACHINE_LIMIT / IP_LIMIT live in rate-limit-window.ts, not here — imported
// rather than duplicated so they can't silently drift apart from the
// regression test that pins them to MAX_BATCH the way the old request-scale
// limits (20/100) drifted from reality once charging switched to event count
// (found in pre-release review).
const PERIOD_SECONDS = 60

// A real client's queue caps at MAX_QUEUED_EVENTS=500 (queue.ts) and always
// flushes one machine's own events, so a batch never legitimately carries
// more than one machineId. More than a couple in one request is an attacker
// packing many throwaway ids into a single batch to dodge the per-machine
// tier entirely — each fresh id would otherwise start its own counter at
// zero (found in pre-release review).
const MAX_DISTINCT_MACHINE_IDS = 2

async function checkLimit(ns: DurableObjectNamespace, key: string, limit: number, amount: number): Promise<boolean> {
  const stub = ns.get(ns.idFromName(key))
  const res = await stub.fetch(`https://rate-limiter/?limit=${limit}&period=${PERIOD_SECONDS}&amount=${amount}`)
  const { success } = (await res.json()) as { success: boolean }
  return success
}

/** Hash the IP so the rate-limit key cannot be reversed into an address. The IP
 *  itself is never written anywhere — this is the only thing derived from it. */
async function ipKey(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function makeDeps(env: Env): IngestDeps {
  return {
    now: () => Date.now(),

    rateLimit: async (req, events) => {
      try {
        // Charge the full event count, not 1 per HTTP call — otherwise a
        // large batch (up to MAX_BATCH) buys unlimited event volume for the
        // price of a single request (found in pre-release review). The IP
        // tier floors this at 1: an all-invalid batch validates to zero
        // accepted events, and per rate-limit-window.ts that is a free pass
        // (correct for the machine tier, which has no id to even charge) —
        // but the IP tier's other job is bounding raw REQUEST frequency
        // regardless of payload validity, so it must never charge 0.
        const ipOk = await checkLimit(env.RATE_LIMITER, `ip:${await ipKey(req)}`, IP_LIMIT, Math.max(1, events.length))
        if (!ipOk) return false

        // consent_choice carries no machineId by design, so it is rate-limited
        // by IP alone. That is a known, accepted weakness (ADR-299 Decision 5):
        // the opt-out count it produces is directional, not exact.
        const ids = new Set(events.map((e) => e.machineId).filter((v): v is string => typeof v === 'string'))
        if (ids.size > MAX_DISTINCT_MACHINE_IDS) return false

        for (const id of ids) {
          const machineOk = await checkLimit(env.RATE_LIMITER, `machine:${id}`, MACHINE_LIMIT, events.length)
          if (!machineOk) return false
        }
        return true
      } catch (err) {
        // A broken rate limiter must fail CLOSED deliberately, not become an
        // uncaught Worker exception (found in pre-release review: this
        // previously propagated all the way to an unhandled 500).
        console.error(`rate limit check threw, failing closed: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    store: async (events) => {
      const stmt = env.DB.prepare('INSERT INTO events (received_at, event, machine_id, payload) VALUES (?, ?, ?, ?)')
      await env.DB.batch(
        events.map((e) =>
          stmt.bind(
            new Date().toISOString(),
            String(e.event),
            typeof e.machineId === 'string' ? e.machineId : null,
            JSON.stringify(e),
          ),
        ),
      )
      // Same reasoning as the PostHog log below: handleIngest swallows storage
      // failures so a client is never told to retry into a struggling backend,
      // which means a silently failing D1 is indistinguishable from a healthy one.
      console.log(`d1: stored ${events.length}`)
    },

    forward: async (events) => {
      if (!env.POSTHOG_KEY) {
        console.log('posthog: skipped (no POSTHOG_KEY configured)')
        return
      }
      const host = env.POSTHOG_HOST ?? 'https://us.i.posthog.com'
      const res = await fetch(`${host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: env.POSTHOG_KEY,
          batch: events.map((e) => ({
            event: String(e.event),
            // No machineId → no distinct_id we could invent. 'anonymous' keeps
            // the consent ping countable without fabricating an identity.
            distinct_id: typeof e.machineId === 'string' ? e.machineId : 'anonymous',
            properties: e,
          })),
        }),
      })

      // Log the OUTCOME, always. handleIngest swallows whatever this throws so a
      // vendor outage can never fail a client request — which is correct, but it
      // also means a permanently broken fan-out looks exactly like a working one
      // from outside. Without this line the only symptom is an empty PostHog and
      // no way to tell why. Visible via `wrangler tail`; the key is never logged.
      console.log(`posthog: ${res.status} host=${host} events=${events.length}`)
      if (!res.ok) console.error(`posthog rejected the batch: ${res.status} ${await res.text()}`)
    },
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname !== '/v1/events') return new Response('not found', { status: 404 })
    return handleIngest(req, makeDeps(env))
  },
}
