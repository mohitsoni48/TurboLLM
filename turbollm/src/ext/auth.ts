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
import { hashKey } from '../auth.js'
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
 *  keys (no `tenant`) are `local` with all scopes, so nothing that works today stops working. */
export function resolveTenantFromKey(presented: string, d: Deps): ResolvedKey | null {
  if (!presented) return null
  const hash = hashKey(presented)
  const keys = d.store.snapshot().apiKeys ?? []
  for (const record of keys) {
    if (!record.hash || record.hash !== hash) continue
    return { tenant: record.tenant ?? 'local', scopes: record.scopes ?? ALL_SCOPES }
  }
  return null
}

function presented(c: Context): string {
  const auth = c.req.header('Authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return c.req.header('X-Api-Key')?.trim() ?? ''
}

export function extAuth(d: Deps): MiddlewareHandler {
  return async (c, next) => {
    const key = presented(c)
    const resolved = key ? resolveTenantFromKey(key, d) : null
    if (!resolved) {
      return extError(c, 'auth', 'unauthorized', 'A valid API key is required for the external API.')
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
