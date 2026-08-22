// turbollm/src/ext/idempotency.ts
//
// Spec 27 §7.6. The commit point is RUN CREATION, before the engine is touched — committing
// at completion would let an ordinary network retry during a minutes-long generation start a
// second one, which is the exact failure this exists to prevent.
//
// Residual window, stated rather than hidden: the message persists to the integrator's store
// and the key persists here, with no shared transaction. A crash between them leaves a replay
// that appends a duplicate user message — visible, and never a lost message.
//
// `op` (fix round 2): a single store instance is shared across every idempotent endpoint
// (mount.ts hands the same instance to both routes.chats.ts and routes.runs.ts), and an
// integrator's `Idempotency-Key` header is just a client-chosen string — nothing stops the
// SAME value being reused across two genuinely different operations (a client that treats
// "create a chat, then send the first message" as one logical idempotent action is a plausible
// pattern, not a misuse). Without an operation tag baked into the key, that reuse is a real
// cross-endpoint collision: a POST /chats replay and a POST .../messages/generate replay would
// read and write the exact same entry, so the generate call would deserialize a ChatDTO as if
// it were a run pointer and fail closed on a request that was never actually attempted before.
// Namespacing by `op` at the store level (not left to each call site to remember to prefix)
// makes that collision structurally impossible for this and any future caller.
//
// `owner` (final-gate fix round, N1): a tenant's API key is shared across an integrator's many
// end users (spec 27 §3.1) — exactly the model C1's owner-scoping fix applied everywhere on the
// run-resource routes. This store was the one place that discipline was skipped: keying by
// `tenant`+`op` alone meant any caller within the same tenant who reused (or guessed/collided
// on) another user's `Idempotency-Key` value replayed THAT user's cached result verbatim —
// live-reproduced as a full cross-owner leak of a chat (including private metadata) and of a
// generation's real run id and streamed content. `owner` is now a mandatory positional
// component of the key, same as `tenant`/`op` — there is no "caller didn't care about owner"
// escape hatch, matching every other scope check on this surface.
interface Entry { value: unknown; at: number }

const DEFAULT_TTL_MS = 24 * 60 * 60_000

export class IdempotencyStore {
  private entries = new Map<string, Entry>()
  private readonly ttlMs: number

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  }

  private key(tenant: string, owner: string, op: string, key: string): string { return `${tenant} ${owner} ${op} ${key}` }

  lookup(tenant: string, owner: string, op: string, key: string): unknown | null {
    const k = this.key(tenant, owner, op, key)
    const e = this.entries.get(k)
    if (!e) return null
    if (Date.now() - e.at > this.ttlMs) { this.entries.delete(k); return null }
    return e.value
  }

  remember<T>(tenant: string, owner: string, op: string, key: string, value: T): T {
    this.entries.set(this.key(tenant, owner, op, key), { value, at: Date.now() })
    return value
  }

  prune(now = Date.now()): void {
    for (const [k, e] of this.entries) if (now - e.at > this.ttlMs) this.entries.delete(k)
  }
}
