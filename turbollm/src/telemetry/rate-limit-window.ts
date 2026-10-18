/**
 * Pure fixed-window rate-limit arithmetic (ADR-299 follow-up). Lives here,
 * not in `telemetry-worker/`, for the same reason `ingest.ts`/`schema.ts` do:
 * this repo's test runner only covers `turbollm/src/**`, and this exact class
 * of bug — a rate limiter that silently enforces nothing — has already
 * shipped twice this cycle (a KV counter, then Cloudflare's native Rate
 * Limiting binding, both verified live to never reject a real burst). The
 * Durable Object in `telemetry-worker/src/rate-limiter-do.ts` imports this
 * function rather than reimplementing it.
 */

export interface RateLimitWindow {
  count: number
  windowStart: number
}

// Both must clear MAX_BATCH (ingest.ts): uploader.ts sends a client's ENTIRE
// queue in one unbatched request, so a limit smaller than a single legitimate
// worst-case flush deadlocks that client forever (a rejected flush leaves
// events queued for retry, and every retry is the same size or larger).
// MACHINE_LIMIT is exactly 2x MAX_BATCH; IP_LIMIT keeps the original 1:5
// machine:IP ratio. Exported (not left as a duplicated literal in index.ts
// and the test) so the two can never drift apart again the way the
// request-scale limits (20/100) silently did after charging switched to
// event count (found in pre-release review).
export const MACHINE_LIMIT = 1000
export const IP_LIMIT = 5000

// IP_LIMIT bounds a minute, not a day: one IP (or IPv6 /64) holding it for a
// day writes 7.2M D1 rows, quarantined ones included, of up to MAX_EVENT_BYTES
// (4 KB) each, ~29 GB, which fills a D1 database (10 GB at most) within
// hours, after which storing real events fails silently. So every request also
// counts against a daily allowance, kept per install rather than only per IP:
// with 10,000 a day for the whole IP, one install flushing a full queue every
// 5 minutes used it up in under 2 hours and every other install behind that
// IP (an office, a campus, a carrier NAT) got 429 for the rest of the 24 h.
//
// MACHINE_DAILY_LIMIT is one install's day: 20 full queue drains (MAX_BATCH),
// the whole IP's former allowance, so an install alone on its address keeps
// what it had. Most events are daily rollups or one per model load; the
// largest real day is a heavy Full-level user's ui_action, one per click, a
// few thousand. IP_DAILY_LIMIT stays as the ceiling for everything from one
// IP: installs, rows with no validated machineId to charge (consent_choice,
// quarantined rows, all-invalid batches) and an attacker minting fresh ids.
// At 10x one install's day it takes ten installs at their cap, or dozens of
// heavy real ones, to reach it, while one address's worst case stays ~400 MB
// a day: 25 days to fill a D1 database instead of hours.
export const MACHINE_DAILY_LIMIT = 10_000
export const IP_DAILY_LIMIT = 100_000

const DAY_SECONDS = 86_400

/** One rate-limiter key a request is charged, with what it may hold in a
 *  window of `periodSeconds` and how much this request costs it. */
export interface RateLimitCharge {
  key: string
  limit: number
  periodSeconds: number
  amount: number
}

/**
 * Every rate-limiter key one request is charged, in the order the Worker
 * charges them; it stops at the first that refuses and then stores nothing.
 * Exported, like the limits above, so the regression test runs the Worker's
 * own keys and order rather than a copy of them.
 *
 * - `ip:<ip hash>`, per minute, accepted plus quarantined events, at least 1:
 *   it also bounds raw request frequency, whatever the payload.
 * - `machine:<id>` per minute and `machineday:<id>` per day, for each
 *   validated machineId, accepted events: one install's own share.
 * - `ipday:<ip hash>`, per day, the same charge as `ip`: the IP's ceiling,
 *   which bounds D1 writes per address.
 *
 * The ceiling comes last so that an install refused at its own limit, which
 * keeps its queue and retries every flush, never spends the allowance the
 * other installs behind its IP share. The reverse cost remains: while the
 * ceiling refuses, each install's retries still count against its own day.
 * Key names are kept across changes: a renamed key hands every caller a fresh
 * window at the deploy.
 */
export function rateLimitCharges(
  ip: string,
  machineIds: readonly string[],
  accepted: number,
  quarantined: number,
): RateLimitCharge[] {
  const charge = Math.max(1, accepted + quarantined)
  return [
    { key: `ip:${ip}`, limit: IP_LIMIT, periodSeconds: 60, amount: charge },
    ...machineIds.flatMap((id) => [
      { key: `machine:${id}`, limit: MACHINE_LIMIT, periodSeconds: 60, amount: accepted },
      { key: `machineday:${id}`, limit: MACHINE_DAILY_LIMIT, periodSeconds: DAY_SECONDS, amount: accepted },
    ]),
    { key: `ipday:${ip}`, limit: IP_DAILY_LIMIT, periodSeconds: DAY_SECONDS, amount: charge },
  ]
}

export interface RateLimitCheck {
  /** The window state to persist, or `null` if nothing should be written. */
  next: RateLimitWindow | null
  success: boolean
}

/**
 * One honest caveat, inherent to any fixed window (not specific to this
 * implementation — GitHub's and Stripe's public rate limiters use the same
 * shape): a caller can burst up to ~2x the limit across a window boundary
 * (e.g. `limit` requests at t=59s plus `limit` more at t=61s). Accepted here,
 * not a defect — closing it needs a sliding-window log, which costs more
 * storage per key for a threat model that only needs "a flood stays noisy,
 * not expensive."
 */
export function evaluateWindow(
  existing: RateLimitWindow | undefined,
  now: number,
  periodMs: number,
  amount: number,
  limit: number,
): RateLimitCheck {
  // A zero-event batch (e.g. one that validated to nothing) consumes no
  // capacity — always allow it, and don't bother writing.
  if (amount === 0) return { next: null, success: true }

  const inCurrentWindow = existing !== undefined && now - existing.windowStart < periodMs
  const currentCount = inCurrentWindow ? existing.count : 0

  if (currentCount >= limit) {
    // Already over limit for this window: reject without paying for another
    // storage write. A sustained flood against one key should not cost
    // anything beyond the first rejection.
    return { next: null, success: false }
  }

  const next: RateLimitWindow = inCurrentWindow
    ? { count: existing.count + amount, windowStart: existing.windowStart }
    : { count: amount, windowStart: now }

  return { next, success: next.count <= limit }
}

/**
 * What the IP tier is keyed on. An IPv6 host normally controls a whole /64
 * (2^64 source addresses), so keying on the full address hands an attacker a
 * fresh IP_LIMIT per address; key on the /64 instead. IPv4, an IPv6 address
 * with an embedded IPv4 tail (::ffff:1.2.3.4, whose /64 is shared by every
 * such address) and anything unparseable keep the whole string, as before.
 */
export function ipRateLimitSubject(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip
  const halves = ip.toLowerCase().split('::')
  if (halves.length > 2) return ip
  const split = (s: string): string[] => (s ? s.split(':') : [])
  const head = split(halves[0])
  const tail = halves.length === 2 ? split(halves[1]) : []
  const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (zeros < 0) return ip
  const groups = [...head, ...Array<string>(zeros).fill('0'), ...tail]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip
  // parseInt drops leading zeros, so every spelling of one /64 yields one key.
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`
}
