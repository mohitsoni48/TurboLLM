// turbollm/src/ext/auth.test.ts
//
// The public surface always requires a key (spec 27 §10). The existing loopback bypass is
// path-agnostic, so this middleware must opt OUT explicitly — inheriting it would leave the
// public API unauthenticated to anything on the machine or the LAN.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { extAuth, resolveTenantFromKey } from './auth.js'

function depsWith(keys: Array<{ key: string; tenant?: string; scopes?: string[] }>) {
  return {
    store: { snapshot: () => ({ apiKeys: keys.map((k) => ({ ...k, hash: k.key, prefix: k.key.slice(0, 8) })) }) },
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
