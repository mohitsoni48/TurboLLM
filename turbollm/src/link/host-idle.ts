// The host's idle judgement for Turbo Link wake semantics (spec §5.5, ADR-376).
//
// `models:wake` is the capability that says "you may take my machine, but only when I am
// not using it". The judgement therefore CANNOT live on the peer: only the host knows
// whether its owner is mid-turn or just clicked something. This module is that judgement,
// kept pure (`canWake`) so it can be exhaustively tested, plus the thin adapter
// (`hostIdleState`) that reads the live daemon state into it.
import type { Deps } from '../deps'

/** How long after the owner's last local request a wake stays blocked. Long enough that
 *  "I'm reading the answer and about to ask a follow-up" is not treated as idle; short
 *  enough that a machine genuinely left alone becomes usable again without a fuss. */
export const DEFAULT_IDLE_GRACE_MS = 300_000

export interface HostIdleState {
  /** Is the engine producing tokens for ANYONE right now (local UI, terminal agent, or
   *  another link peer)? A swap mid-generation kills that generation outright. */
  generating: boolean
  /** Epoch-ms of the last request that came from the OWNER of this machine, or null when
   *  nothing local has been seen since the daemon started. */
  lastLocalActivityMs: number | null
  nowMs: number
  /** Override the grace window. Present for tests and for a future user-facing setting;
   *  production callers leave it unset and get DEFAULT_IDLE_GRACE_MS. */
  idleGraceMs?: number
}

/** May a peer holding `models:wake` (but NOT `models:load`) swap the loaded model?
 *
 *  Fails CLOSED on every ambiguity — a wrong `true` evicts the owner's model out from
 *  under them, a wrong `false` costs the peer one retry. That is why a future/clock-skewed
 *  timestamp counts as "just now" rather than as "infinitely long ago": negative elapsed
 *  time must never be read as an idle machine. */
export function canWake(state: HostIdleState): boolean {
  if (state.generating) return false
  const last = state.lastLocalActivityMs
  if (last === null || last === undefined) return true
  const grace = state.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS
  const elapsed = state.nowMs - last
  if (!Number.isFinite(elapsed)) return false
  return elapsed >= grace
}

// ── Local-activity ledger ───────────────────────────────────────────────────
//
// Process-global on purpose: there is exactly one daemon, one engine, and one owner per
// process, and threading a mutable timestamp through Deps would put a field on every test
// double for a value only this module reads.

let lastLocal = 0

/** Record that the OWNER of this machine just asked the engine for something. Called from
 *  the local request paths only (the in-app chat routes, and the gateway when the request
 *  did NOT arrive through the Turbo Link façade) — counting a peer's own traffic here
 *  would let one peer's request block the next one's wake for five minutes. */
export function noteLocalActivity(atMs: number = Date.now()): void {
  if (atMs > lastLocal) lastLocal = atMs
}

/** Epoch-ms of the last local request, or null if there has not been one. */
export function lastLocalActivityMs(): number | null {
  return lastLocal || null
}

/** Test-only: forget the ledger so one test's activity cannot leak into the next. */
export function resetLocalActivity(): void {
  lastLocal = 0
}

/** Read the live daemon state into the shape `canWake` judges. */
export function hostIdleState(d: Deps): HostIdleState {
  let generating = false
  try {
    generating = (d.manager.sessionStats().activeRequests ?? 0) > 0
  } catch {
    // A Deps double (or a manager torn down mid-shutdown) with no sessionStats must not
    // 500 the request. Unknown → not generating; the activity ledger still gates.
  }
  return { generating, lastLocalActivityMs: lastLocalActivityMs(), nowMs: Date.now() }
}
