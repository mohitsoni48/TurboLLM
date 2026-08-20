// turbollm/src/ext/limits.ts
//
// Per-tenant caps (spec 27 §8.4, §5.4). Bounded on purpose: on a single-GPU box an unbounded
// queue is a memory leak that presents to the user as a hang, so over-cap callers are refused
// with a Retry-After rather than parked.
interface Bucket { inFlight: number; stamps: number[] }

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
