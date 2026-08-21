import type { MiddlewareHandler } from 'hono'
import { resolveKey } from '../auth'
import type { Deps } from '../deps'
import { hasCapability } from './capabilities'
import type { LinkCapability } from './types'

/** Turbo Link's gate for /api/link/v1 — an INVERSION of lanAuth, and the reason the
 *  capability model is not decorative (spec §3.3, ADR-376).
 *
 *  lanAuth exempts loopback unconditionally and only enforces a key when lanBind is on.
 *  Correct for its own purpose, catastrophic here:
 *    - a host with LAN open and "Require API key" OFF would let a peer call in with NO
 *      token at all, bypassing the grant entirely; and
 *    - cloudflared's local leg connects from 127.0.0.1 (ADR-153), so the loopback
 *      exemption would hand a TUNNEL peer everything.
 *
 *  So this middleware exempts NOTHING — not loopback, not "auth disabled", not a
 *  full-access key — and is independent of the global network toggle. Same shape as
 *  codeAuth, which solved the same class of problem for Code's filesystem access.
 *
 *  Register it scoped to '/api/link/v1/*' AFTER lanAuth. */
export function linkAuth(d: Deps): MiddlewareHandler {
  return async (c, next) => {
    const key = resolveKey(c, d)
    if (!key) {
      return c.json(
        { error: { code: 'unauthorized', message: 'A valid Turbo Link token is required.' } },
        401,
      )
    }
    c.set('linkKey', key)
    return next()
  }
}

/** Gate one façade route on a single capability. Register AFTER linkAuth, which has
 *  already put the resolved key on the context.
 *
 *  Returns 403 (not 401) with the capability named: the peer greys its own controls off
 *  the handshake, so reaching this means peer and host disagree — naming the capability
 *  turns a mysterious failure into a diagnosable one. */
export function requireCapability(cap: LinkCapability): MiddlewareHandler {
  return async (c, next) => {
    const key = c.get('linkKey')
    if (!hasCapability(key, cap)) {
      return c.json(
        {
          error: {
            code: 'forbidden',
            capability: cap,
            message: `This link is not granted '${cap}'.`,
          },
        },
        403,
      )
    }
    return next()
  }
}
