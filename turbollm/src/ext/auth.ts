// turbollm/src/ext/auth.ts
//
// Auth for /api/ext/v1 (spec 27 §10).
//
// This middleware deliberately does NOT call bypassesAuth() from ../auth.js. That helper is
// path-agnostic — a loopback or open-LAN caller bypasses it for ANY path — which is correct
// for the internal API and the gateway, and completely wrong here: a public API that is
// unauthenticated on the LAN is not a public API, it is an incident.
import type { MiddlewareHandler } from 'hono'
import type { Context } from 'hono'
import type { Deps } from '../deps.js'
import type { Scope } from '../chat/store/types.js'
import { hashKey, isFacadeOnlyKey } from '../auth.js'
import { extError } from './errors.js'

// Hono resolves `c.get`/`c.set` key types against this global map whenever the app instance
// itself isn't parameterized with `Variables` (e.g. plain `new Hono()`, as callers of this
// middleware do). Declaration-merging it here is the standard Hono pattern for typing context
// variables set by shared middleware — it has no runtime effect.
declare module 'hono' {
  interface ContextVariableMap {
    extTenant: string
    extScopes: string[]
  }
}

const ALL_SCOPES = ['chats:read', 'chats:write', 'runs:write']

export interface ResolvedKey { tenant: string; scopes: string[] }

/** Match a presented key against the configured keys. Stored keys hold only a SHA-256 hash
 *  (never the raw value, see ../auth.ts), so the presented key is hashed with the SAME
 *  derivation (`hashKey`) before comparison — comparing the raw value against the hash, as an
 *  earlier version of this function did, would reject every real key unconditionally. Legacy
 *  keys (no `tenant`) are `local` with all scopes, so nothing that works today stops working.
 *
 *  A Turbo Link FAÇADE-ONLY key (one carrying a `grant`) is refused here as though it did not
 *  match at all — the SAME rule, via the SAME predicate (`isFacadeOnlyKey`, see ../auth.ts's
 *  doc comment on it and on verifyKeyValue), that `verifyKeyValue` applies to every internal
 *  surface. This path exists because the external API resolves a key to a TENANT, not to a
 *  yes/no, so it cannot simply call verifyKeyValue; it must still honour the refusal.
 *
 *  Pre-merge review of PR #185, finding I1: before this, the invariant "a granted token works
 *  ONLY on /api/link/v1" held here purely because `lanAuth` happens to be registered ahead of
 *  `mountExtApi` in server.ts. Exempting /api/ext/v1/* from lanAuth — the obvious one-line
 *  change for a genuinely PUBLIC API — would silently have turned every façade-only token into
 *  a full ext-API credential, with nothing failing to signal it. The property now comes from
 *  the credential check, not from middleware ordering. */
export function resolveTenantFromKey(presented: string, d: Deps): ResolvedKey | null {
  if (!presented) return null
  const hash = hashKey(presented)
  const keys = d.store.snapshot().apiKeys ?? []
  for (const record of keys) {
    if (!record.hash || record.hash !== hash) continue
    if (isFacadeOnlyKey(record)) return null
    return { tenant: record.tenant ?? 'local', scopes: record.scopes ?? ALL_SCOPES }
  }
  return null
}

function presented(c: Context): string {
  const auth = c.req.header('Authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return c.req.header('X-Api-Key')?.trim() ?? ''
}

/** Every key issued today (legacy keys, `turbollm launch` keys, Cloud Launch tunnel keys) falls
 *  back to `tenant: 'local'` with all scopes (`resolveTenantFromKey`'s own fallback) — and
 *  there is no supported way yet to mint a key with an explicit non-local tenant. `local` is
 *  the desktop UI's OWN chat data; without this, flipping `api.ext.enabled` on would turn
 *  every key an operator has ever issued — including a tunnel key handed to an untrusted
 *  device — into a full read/write/delete credential for their own chats via the external API. */
const LOCAL_TENANT = 'local'

/** Round-2 release-gate finding H1a: the local-tenant refusal below made these two routes
 *  unreachable to EVERY key today (since there is currently no supported way to mint a
 *  non-local-tenant key at all) — a clean regression, since they carry no tenant data
 *  whatsoever. `GET /capabilities` and `GET /openapi.json` are the two live routes with no
 *  `requireScope` call at all (openapi.ts's own manifest entries document why: pure schema/
 *  limits discovery), and bootstrapping this API means being able to read the schema and
 *  limits BEFORE a properly-tenanted key exists. Exempted from the local-tenant refusal
 *  specifically — NOT from authentication itself, a valid key is still required — since a
 *  local-tenant key is still a real, valid credential; it is only refused elsewhere because
 *  those OTHER routes would hand it another tenant's (or the local install's own) data. */
const TENANT_AGNOSTIC_PATHS = new Set(['/api/ext/v1/capabilities', '/api/ext/v1/openapi.json'])

export function extAuth(d: Deps): MiddlewareHandler {
  return async (c, next) => {
    const key = presented(c)
    const resolved = key ? resolveTenantFromKey(key, d) : null
    if (!resolved) {
      return extError(c, 'auth', 'unauthorized', 'A valid API key is required for the external API.')
    }
    if (resolved.tenant === LOCAL_TENANT && !TENANT_AGNOSTIC_PATHS.has(c.req.path)) {
      return extError(
        c, 'auth', 'tenant_not_supported',
        "This key resolves to the local tenant, which is not accessible via /api/ext/v1. Mint a key with an explicit, non-'local' tenant to use the external API.",
        { status: 403 },
      )
    }
    c.set('extTenant', resolved.tenant)
    c.set('extScopes', resolved.scopes)
    await next()
  }
}

export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const scopes = (c.get('extScopes') as string[] | undefined) ?? []
    if (!scopes.includes(scope)) {
      return extError(c, 'auth', 'insufficient_scope', `This key lacks the '${scope}' scope.`, { status: 403 })
    }
    await next()
  }
}

/** Build the store Scope for a request. `tenant` comes from the key and nowhere else;
 *  `owner` is caller-supplied and trusted only within that tenant (spec 27 §10). */
export function scopeFor(c: Context, owner?: string): Scope {
  return { tenant: c.get('extTenant') as string, owner: owner?.trim() || 'default' }
}
