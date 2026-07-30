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

interface Env {
  DB: D1Database
  RL: KVNamespace
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
}

/** Events per hour, per machine and per IP-hash. Generous enough that a real
 *  install never notices; tight enough that a script is not free. */
const PER_MACHINE_HOURLY = 120
const PER_IP_HOURLY = 600

/** Hash the IP so the rate-limit key cannot be reversed into an address. The IP
 *  itself is never written anywhere — this is the only thing derived from it,
 *  and it lives in KV with a 1-hour TTL. */
async function ipKey(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Fixed-window counter in KV. Approximate by design: a window boundary is
 *  cheaper to accept than the coordination a precise limiter would need. */
async function bump(kv: KVNamespace, key: string, limit: number): Promise<boolean> {
  const current = Number((await kv.get(key)) ?? '0')
  if (current >= limit) return false
  await kv.put(key, String(current + 1), { expirationTtl: 3600 })
  return true
}

function makeDeps(env: Env): IngestDeps {
  return {
    now: () => Date.now(),

    rateLimit: async (req, events) => {
      const hour = Math.floor(Date.now() / 3_600_000)
      if (!(await bump(env.RL, `ip:${await ipKey(req)}:${hour}`, PER_IP_HOURLY))) return false

      // consent_choice carries no machineId by design, so it is rate-limited by
      // IP alone. That is a known, accepted weakness (ADR-299 Decision 5): the
      // opt-out count it produces is directional, not exact.
      const ids = new Set(events.map((e) => e.machineId).filter((v): v is string => typeof v === 'string'))
      for (const id of ids) {
        if (!(await bump(env.RL, `m:${id}:${hour}`, PER_MACHINE_HOURLY))) return false
      }
      return true
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
