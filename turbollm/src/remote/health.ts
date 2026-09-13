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

export async function probeUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const target = `${url.replace(/\/+$/, '')}/healthz`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(target, { signal: ac.signal })
    return res.ok
  } catch {
    return false // a probe never throws: an unreachable tunnel is a state, not an exception
  } finally {
    clearTimeout(timer)
  }
}
