// turbollm/src/ext/auth.test.ts
//
// The public surface always requires a key (spec 27 §10). The existing loopback bypass is
// path-agnostic, so this middleware must opt OUT explicitly — inheriting it would leave the
// public API unauthenticated to anything on the machine or the LAN.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { Hono } from 'hono'
import { extAuth, resolveTenantFromKey } from './auth.js'
import { registerExtChatRoutes } from './routes.chats.js'

// Stored keys hold only a SHA-256 hash of the raw value (never the raw value itself, see
// ../auth.ts's hashKey/generateApiKey/verifyKeyValue) — mirroring that here, the same way
// src/auth.test.ts's RAW_KEY/RAW_KEY_HASH does, is what makes these tests actually exercise
// the real matching path instead of a shape that coincidentally bypassed it.
function depsWith(keys: Array<{ key: string; tenant?: string; scopes?: string[]; grant?: unknown }>) {
  return {
    store: {
      snapshot: () => ({
        apiKeys: keys.map(({ key, ...rest }) => ({
          ...rest,
          hash: createHash('sha256').update(key).digest('hex'),
          prefix: key.slice(0, 8),
        })),
      }),
    },
  } as never
}

test('a key resolves to its tenant and scopes', () => {
  const d = depsWith([{ key: 'tllm-ext-acme-secret', tenant: 'acme', scopes: ['chats:read', 'chats:write'] }])
  const r = resolveTenantFromKey('tllm-ext-acme-secret', d)
  assert.equal(r?.tenant, 'acme')
  assert.deepEqual(r?.scopes, ['chats:read', 'chats:write'])
})

test('a legacy key with no tenant field resolves to the local tenant', () => {
  const d = depsWith([{ key: 'tllm-legacy' }])
  assert.equal(resolveTenantFromKey('tllm-legacy', d)?.tenant, 'local')
})

test('an unknown key resolves to null', () => {
  const d = depsWith([{ key: 'tllm-ext-acme-secret', tenant: 'acme' }])
  assert.equal(resolveTenantFromKey('nope', d), null)
})

test('a loopback request with NO key is still rejected', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-ext-acme-secret', tenant: 'acme' }])
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/ping', (c) => c.json({ ok: true }))

  const res = await app.request('/api/ext/v1/ping')
  assert.equal(res.status, 401)
  const body = await res.json() as { error: { type: string; code: string } }
  assert.equal(body.error.type, 'auth')
  assert.equal(body.error.code, 'unauthorized')
})

test('a valid key passes and puts the tenant on the context', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-ext-acme-secret', tenant: 'acme', scopes: ['chats:read'] }])
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/ping', (c) => c.json({ tenant: c.get('extTenant') }))

  const res = await app.request('/api/ext/v1/ping', { headers: { Authorization: 'Bearer tllm-ext-acme-secret' } })
  assert.equal(res.status, 200)
  assert.equal((await res.json() as { tenant: string }).tenant, 'acme')
})

// I2 (release-gate finding): every key issued by the product today — including a legacy key,
// a Cloud Launch tunnel key, or a plain `turbollm launch`-generated key — resolves to
// `tenant: 'local'` with every scope (resolveTenantFromKey's own fallback, and there is no
// supported way yet to mint a key with an explicit non-local tenant). Once an operator flips
// `api.ext.enabled`, that made every key they had ever issued a full read/write/delete
// credential for their own chat history via the external API. `local` is the desktop UI's own
// data — refused categorically here, not just left to the default-owner convention.
test('a key that resolves to the local tenant is refused on the external API, even though it is valid everywhere else', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-legacy-key' }])   // no `tenant` field -> resolves to 'local'
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/ping', (c) => c.json({ ok: true }))

  const res = await app.request('/api/ext/v1/ping', { headers: { Authorization: 'Bearer tllm-legacy-key' } })
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { type: string; code: string } }
  assert.equal(body.error.type, 'auth')
  assert.equal(body.error.code, 'tenant_not_supported')
})

// Round-2 release-gate finding H1a: the local-tenant refusal above made GET /capabilities and
// GET /openapi.json unreachable to EVERY key today — a clean regression, since there is
// currently no supported way to mint a non-local-tenant key at all, and these two routes carry
// no tenant data whatsoever (pure schema/limits discovery, and the only two routes with no
// requireScope call). A local-tenant key must still reach these specifically, while remaining
// refused everywhere else.
test('a local-tenant key still reaches GET /capabilities and GET /openapi.json — pure discovery routes, no tenant data', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-legacy-key' }])   // no `tenant` field -> resolves to 'local'
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/capabilities', (c) => c.json({ ok: true }))
  app.get('/api/ext/v1/openapi.json', (c) => c.json({ ok: true }))

  for (const path of ['/api/ext/v1/capabilities', '/api/ext/v1/openapi.json']) {
    const res = await app.request(path, { headers: { Authorization: 'Bearer tllm-legacy-key' } })
    assert.equal(res.status, 200, `${path} must stay reachable to a local-tenant key`)
  }
})

test('the local-tenant refusal still applies to every OTHER route, even one with a similar-looking path', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-legacy-key' }])
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/chats', (c) => c.json({ ok: true }))
  app.get('/api/ext/v1/capabilities/nested', (c) => c.json({ ok: true }))

  for (const path of ['/api/ext/v1/chats', '/api/ext/v1/capabilities/nested']) {
    const res = await app.request(path, { headers: { Authorization: 'Bearer tllm-legacy-key' } })
    assert.equal(res.status, 403, `${path} must still be refused — the exemption is two exact paths, not a prefix`)
  }
})

test('a non-local tenant is unaffected by the local-tenant refusal', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-ext-acme-secret', tenant: 'acme' }])
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/ping', (c) => c.json({ tenant: c.get('extTenant') }))

  const res = await app.request('/api/ext/v1/ping', { headers: { Authorization: 'Bearer tllm-ext-acme-secret' } })
  assert.equal(res.status, 200)
  assert.equal((await res.json() as { tenant: string }).tenant, 'acme')
})

test('a tenant named in a header or body is ignored — only the key decides', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-ext-acme-secret', tenant: 'acme' }])
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/ping', (c) => c.json({ tenant: c.get('extTenant') }))

  const res = await app.request('/api/ext/v1/ping', {
    headers: { Authorization: 'Bearer tllm-ext-acme-secret', 'X-Tenant': 'globex' },
  })
  assert.equal((await res.json() as { tenant: string }).tenant, 'acme', 'a request cannot name its own tenant')
})

// ── Turbo Link façade-only tokens (PR #185 pre-merge review, finding I1) ──────────────────
//
// A key carrying a `grant` is a FAÇADE-ONLY credential: usable on /api/link/v1 and refused by
// every other credential path (../auth.ts's isFacadeOnlyKey / verifyKeyValue). This file's
// resolveTenantFromKey is a SECOND credential path — it compares hashes itself and never routes
// through verifyKeyValue, because it answers "which tenant?" rather than "valid yes/no". Before
// the fix the refusal held here only because lanAuth happens to sit in front of mountExtApi in
// server.ts; exempting /api/ext/v1/* from lanAuth (the obvious change for a genuinely public
// API) would have silently promoted every façade-only token to a full ext-API credential.
//
// The route-level assertions below are deliberately against the REAL registered ext routes
// (registerExtChatRoutes, which is what mounts extAuth in production), not a stub handler: the
// finding exists precisely because the helper and the route were reasoned about separately.

const GRANT = { capabilities: ['models:list'], models: null }

test('a granted (façade-only) token does not resolve to a tenant at all', () => {
  const d = depsWith([{ key: 'tllm-link-peer-token', tenant: 'acme', scopes: ['chats:read'], grant: GRANT }])
  assert.equal(
    resolveTenantFromKey('tllm-link-peer-token', d),
    null,
    'a Turbo Link grant makes the key façade-only — it must look like no match here',
  )
})

test('an ungranted key with the same shape still resolves its tenant and scopes normally', () => {
  const d = depsWith([{ key: 'tllm-ordinary-token', tenant: 'acme', scopes: ['chats:read'] }])
  const r = resolveTenantFromKey('tllm-ordinary-token', d)
  assert.equal(r?.tenant, 'acme')
  assert.deepEqual(r?.scopes, ['chats:read'])
})

test('a granted token is 401 unauthorized on the ext middleware, indistinguishable from an unknown key', async () => {
  const app = new Hono()
  const d = depsWith([{ key: 'tllm-link-peer-token', tenant: 'acme', grant: GRANT }])
  app.use('/api/ext/v1/*', extAuth(d))
  app.get('/api/ext/v1/ping', (c) => c.json({ ok: true }))

  const res = await app.request('/api/ext/v1/ping', { headers: { Authorization: 'Bearer tllm-link-peer-token' } })
  assert.equal(res.status, 401, 'a façade-only token must not authenticate to the external API')
  const body = await res.json() as { error: { type: string; code: string } }
  assert.equal(body.error.type, 'auth')
  assert.equal(body.error.code, 'unauthorized', 'must be the generic unauthorized shape — never confirm the key exists')
})

// The two routes the finding named as today's realised harm: no `requireScope`, exempt from the
// local-tenant refusal, and therefore the only ones a façade-only token could actually have
// reached. Driven through the real route registration, since that is where the property is
// observable.
function realExtApp(keys: Array<{ key: string; tenant?: string; scopes?: string[]; grant?: unknown }>) {
  const app = new Hono()
  const base = depsWith(keys) as unknown as { store: unknown }
  const d = {
    ...base,
    chatStore: {
      capabilities: { chats: true },
      listChats: async () => ({ data: [], hasMore: false, nextCursor: null }),
    },
  } as never
  registerExtChatRoutes(app, d)
  return app
}

test('a granted token is refused by the real GET /capabilities route, not merely by lanAuth sitting in front of it', async () => {
  const app = realExtApp([{ key: 'tllm-link-peer-token', grant: GRANT }])
  const res = await app.request('/api/ext/v1/capabilities', { headers: { Authorization: 'Bearer tllm-link-peer-token' } })
  assert.equal(res.status, 401, 'the tenant-agnostic discovery route must refuse a façade-only token too')
})

test('an ungranted key reaches the real ext routes exactly as before', async () => {
  const app = realExtApp([{ key: 'tllm-ordinary-token', tenant: 'acme', scopes: ['chats:read'] }])

  const caps = await app.request('/api/ext/v1/capabilities', { headers: { Authorization: 'Bearer tllm-ordinary-token' } })
  assert.equal(caps.status, 200)

  const chats = await app.request('/api/ext/v1/chats', { headers: { Authorization: 'Bearer tllm-ordinary-token' } })
  assert.equal(chats.status, 200, 'ordinary tenant resolution must be completely unchanged')
})
