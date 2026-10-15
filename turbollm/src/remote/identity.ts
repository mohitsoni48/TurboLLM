import type { Context } from 'hono'

/** The authenticated tailnet user behind a Tailscale **Serve** request, or null.
 *
 *  Serve injects `Tailscale-User-Login` / `Tailscale-User-Name` for authenticated tailnet
 *  users. **Funnel deliberately injects neither** — Tailscale's own security choice, since
 *  Funnel traffic is public and there is no identity to assert. So this returning null on a
 *  Funnel request is correct behaviour, not a gap to paper over: a Funnel caller falls
 *  through to the scoped bearer token (spec 30 §6.1, §6.3).
 *
 *  NOT unforgeable. Serve deletes any copy the tailnet client sent before setting its own, but
 *  the ingress socket is an ordinary 127.0.0.1 listener that any process on this machine can
 *  connect to and send any header, Host included. So a caller must confirm all of: the request
 *  arrived on the ingress socket, Serve is the provider running, and its Host is the MagicDNS
 *  name and port Serve serves (auth.ts's lanAuth). Together they stop a browser page (a
 *  DNS-rebinding one can reach the ingress port and set this header, but its Host carries the
 *  ingress port, not Serve's public one unless the two were configured equal, and its own name
 *  unless it also answers DNS for the served one: see namesServedHost). A local process is not
 *  stopped, so lanAuth honours the header only where such a process already has keyless
 *  loopback trust on the main listener, which is more than this header grants: on desktop, with
 *  that listener bound to the default, a loopback or a wildcard address. Bound to one specific
 *  LAN address, a local process is a LAN peer that needs a key, and on Android loopback needs
 *  the app's secret; there tailnet users need the remote token. */
export function tailscaleIdentity(c: Context): { login: string; name: string } | null {
  const login = (c.req.header('Tailscale-User-Login') ?? '').trim()
  if (!login) return null
  const name = (c.req.header('Tailscale-User-Name') ?? '').trim()
  return { login, name: name || login }
}
