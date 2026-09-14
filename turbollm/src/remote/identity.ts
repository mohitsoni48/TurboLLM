import type { Context } from 'hono'

/** The authenticated tailnet user behind a Tailscale **Serve** request, or null.
 *
 *  Serve injects `Tailscale-User-Login` / `Tailscale-User-Name` for authenticated tailnet
 *  users. **Funnel deliberately injects neither** — Tailscale's own security choice, since
 *  Funnel traffic is public and there is no identity to assert. So this returning null on a
 *  Funnel request is correct behaviour, not a gap to paper over: a Funnel caller falls
 *  through to the scoped bearer token (spec 30 §6.1, §6.3).
 *
 *  Unforgeable in this topology, and only in this topology: the caller reaches us over the
 *  loopback ingress socket, which only tailscaled can connect to. The header is trustworthy
 *  BECAUSE of where it arrived, which is why every caller must confirm the request is an
 *  ingress request before consulting this. */
export function tailscaleIdentity(c: Context): { login: string; name: string } | null {
  const login = (c.req.header('Tailscale-User-Login') ?? '').trim()
  if (!login) return null
  const name = (c.req.header('Tailscale-User-Name') ?? '').trim()
  return { login, name: name || login }
}
