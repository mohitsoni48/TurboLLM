/** End-to-end reachability check for remote access (spec 30 §2.4).
 *
 *  Deliberately goes out through the PUBLIC URL and back, not to the local ingress port.
 *  Process liveness alone misses the exact failure this feature exists to fix — cloudflared
 *  alive and happy while the edge has dropped the tunnel — and only a request that traverses
 *  the whole path can tell the difference.
 *
 *  Hits `/healthz`, which auth.ts's isExempt leaves unconditionally open, so the probe needs
 *  no credential and cannot break when a user rotates their key. */
export const HEALTH_INTERVAL_MS = 60_000

const PROBE_TIMEOUT_MS = 10_000

/** How many CONSECUTIVE failed probes it takes before the supervisor treats the connection as
 *  dead and restarts the provider (ADR-422 Phase 2 final review, Critical finding C1).
 *
 *  A single failed probe is NOT enough: a 10s-timeout abort on a shared network, one dropped
 *  packet, or one slow edge hop must not cost a user their public URL — for cloudflare-quick
 *  that means a brand-new `*.trycloudflare.com` address, re-rolled on every restart. Only a
 *  run of failures that survives multiple probe intervals (3 x 60s = 3 minutes of the tunnel
 *  not answering at all) is treated as a genuine dead tunnel. */
export const CONSECUTIVE_FAILURES_BEFORE_RESTART = 3

export async function probeUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const target = `${url.replace(/\/+$/, '')}/healthz`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(target, { signal: ac.signal })
    // A quick tunnel's edge returns 429 BY DESIGN once 200 requests are in flight (spec 30
    // §1.2) — Cloudflare's own documented "busy" response, not a dead-tunnel signal. It means
    // the edge is up and actively talking to us, which is the OPPOSITE of what this probe is
    // testing for, so it counts as a healthy probe rather than a failure (ADR-422 Phase 2
    // final review, Critical finding C1). Without this, ordinary heavy use (UI + SSE chat +
    // model list) on the ungated `--tunnel` path could trip the restart loop and re-roll the
    // public URL out from under an active session.
    //
    // Every other non-2xx still counts as a failure, including 503 and 530: neither has an
    // equivalent documented "busy but alive" meaning on this path. 530 in particular is
    // Cloudflare's own signal that the edge could NOT reach the tunnel at all (the
    // Argo/cloudflared-side 1033 family surfaces behind it), so treating it leniently would
    // silently reintroduce the exact failure C1 is about — the CONSECUTIVE_FAILURES_BEFORE_
    // RESTART gate (applied by the caller in manager.ts, not here) is what protects against a
    // single transient 503/502/timeout; probeUrl itself stays a plain per-probe signal.
    if (res.status === 429) return true
    return res.ok
  } catch {
    return false // a probe never throws: an unreachable tunnel is a state, not an exception
  } finally {
    clearTimeout(timer)
  }
}

export interface HealthCheckResult {
  /** Updated consecutive-failure streak to carry into the next probe. */
  consecutiveFailures: number
  /** True once the streak has reached CONSECUTIVE_FAILURES_BEFORE_RESTART. The caller should
   *  treat this exactly like an unexpected provider exit — tear it down and restart with
   *  backoff — and the returned `consecutiveFailures` is already reset to 0 for the next
   *  connection's own streak. */
  shouldRestart: boolean
}

/** Decide what a single health-probe result means for the supervisor's restart decision. A
 *  pure function, deliberately kept separate from `probeUrl` and from `RemoteAccessManager`,
 *  so the "how many failures in a row" policy is unit-testable without real timers or a
 *  running manager (ADR-422 Phase 2 final review, Critical finding C1). The caller
 *  (`manager.ts`) owns the mutable streak counter across ticks; this function only computes
 *  its next value from the previous one plus the latest probe result.
 *
 *  Any success resets the streak to zero immediately — an isolated earlier failure is never
 *  "banked" against a later, unrelated one. */
export function nextHealthCheck(ok: boolean, consecutiveFailures: number): HealthCheckResult {
  if (ok) return { consecutiveFailures: 0, shouldRestart: false }
  const next = consecutiveFailures + 1
  if (next >= CONSECUTIVE_FAILURES_BEFORE_RESTART) return { consecutiveFailures: 0, shouldRestart: true }
  return { consecutiveFailures: next, shouldRestart: false }
}
