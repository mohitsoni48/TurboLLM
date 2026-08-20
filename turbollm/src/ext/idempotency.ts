// turbollm/src/ext/idempotency.ts
//
// Spec 27 §7.6. The commit point is RUN CREATION, before the engine is touched — committing
// at completion would let an ordinary network retry during a minutes-long generation start a
// second one, which is the exact failure this exists to prevent.
//
// Residual window, stated rather than hidden: the message persists to the integrator's store
// and the key persists here, with no shared transaction. A crash between them leaves a replay
// that appends a duplicate user message — visible, and never a lost message.
interface Entry { value: unknown; at: number }

const DEFAULT_TTL_MS = 24 * 60 * 60_000

export class IdempotencyStore {
  private entries = new Map<string, Entry>()
  private readonly ttlMs: number

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  }

  private key(tenant: string, key: string): string { return `${tenant} ${key}` }

  lookup(tenant: string, key: string): unknown | null {
    const e = this.entries.get(this.key(tenant, key))
    if (!e) return null
    if (Date.now() - e.at > this.ttlMs) { this.entries.delete(this.key(tenant, key)); return null }
    return e.value
  }

  remember<T>(tenant: string, key: string, value: T): T {
    this.entries.set(this.key(tenant, key), { value, at: Date.now() })
    return value
  }

  prune(now = Date.now()): void {
    for (const [k, e] of this.entries) if (now - e.at > this.ttlMs) this.entries.delete(k)
  }
}
