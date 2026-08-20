// turbollm/src/ext/limits.ts
//
// Per-tenant caps (spec 27 §8.4, §5.4). Bounded on purpose: on a single-GPU box an unbounded
// queue is a memory leak that presents to the user as a hang, so over-cap callers are refused
// with a Retry-After rather than parked.
//
// Wired into the live request path by mount.ts (constructs the single shared instance from
// `Config.api.ext.maxInFlightPerTenant`/`requestsPerMinutePerTenant`) and consumed by
// routes.chats.ts (tryRequest, as a blanket per-request budget across the whole surface) and
// routes.runs.ts (tryAcquire/release, the generation-concurrency cap specifically).
interface Bucket { inFlight: number; stamps: number[] }

/** Used when `Config.api.ext.maxInFlightPerTenant` is absent — generous for a single caller
 *  integration testing against one chat, still bounded so no tenant can monopolize the one
 *  local GPU this daemon drives. */
export const DEFAULT_MAX_IN_FLIGHT_PER_TENANT = 4
/** Used when `Config.api.ext.requestsPerMinutePerTenant` is absent — 2/s sustained, generous
 *  enough for a polling integration but still a real ceiling on the adapter/database traffic
 *  one tenant can generate. */
export const DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT = 120

export class TenantLimiter {
  private buckets = new Map<string, Bucket>()

  constructor(private readonly opts: { maxInFlight: number; ratePerMinute: number }) {}

  private bucket(tenant: string): Bucket {
    let b = this.buckets.get(tenant)
    if (!b) { b = { inFlight: 0, stamps: [] }; this.buckets.set(tenant, b) }
    return b
  }

  /** Reserve a generation slot. False ⇒ answer 429 rate_limited. */
  tryAcquire(tenant: string): boolean {
    const b = this.bucket(tenant)
    if (b.inFlight >= this.opts.maxInFlight) return false
    b.inFlight++
    return true
  }

  release(tenant: string): void {
    const b = this.bucket(tenant)
    b.inFlight = Math.max(0, b.inFlight - 1)
  }

  /** Sliding-window request rate, covering the read endpoints too — otherwise a client
   *  polling listChats in a loop hammers the integrator's own database through our adapter. */
  tryRequest(tenant: string, now = Date.now()): boolean {
    const b = this.bucket(tenant)
    const cutoff = now - 60_000
    b.stamps = b.stamps.filter((t) => t > cutoff)
    if (b.stamps.length >= this.opts.ratePerMinute) return false
    b.stamps.push(now)
    return true
  }
}
