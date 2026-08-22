import type { MiddlewareHandler } from 'hono'
import { resolveKey } from '../auth'
import type { Deps } from '../deps'
import { hasCapability } from './capabilities'
import { isTurboLinkEnabled, turboLinkDisabled, TURBO_LINK_DISABLED_HOST_MESSAGE } from './gate'
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
    // The experimental gate, BEFORE the credential is even resolved (ADR-376,
    // link/gate.ts). A host with Turbo Link switched off must not accept an inbound link
    // at all, so this refuses ahead of `resolveKey`: a disabled host discloses no machine
    // identity, no grant and no model list, and a valid token gets no further than an
    // invalid one. It also means the flag is a genuine kill switch for a host that ALREADY
    // handed out tokens — those keys stay in config and start working again the moment the
    // flag goes back on, but until then every route above answers this.
    //
    // 403 with a named code, never 404: `/api/link/v1` is a versioned contract, and a 404
    // reads to a peer as "that host is too old", sending its user after an upgrade that
    // does not exist.
    if (!isTurboLinkEnabled(d)) return turboLinkDisabled(c, TURBO_LINK_DISABLED_HOST_MESSAGE)
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
