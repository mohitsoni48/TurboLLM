import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { linkAuth, requireCapability } from './link-auth'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'

function depsWith(keys: ApiKey[], daemon: { lanBind: boolean; requireApiKey: boolean }): Deps {
  const cfg = { apiKeys: keys, daemon }
  return {
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
  } as unknown as Deps
}

function keyFor(raw: string, caps?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'peer', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never } } : {}),
  }
}

function appWith(d: Deps) {
  const app = new Hono()
  app.use('/api/link/v1/*', linkAuth(d))
  app.get('/api/link/v1/ping', (c) => c.json({ ok: true }))
  app.get('/api/link/v1/load', requireCapability('models:load'), (c) => c.json({ ok: true }))
  return app
}

// ── The inversion itself. Each of these four would be ALLOWED by lanAuth and must be
// REFUSED by linkAuth. Spec §3.3: the façade exempts nothing and fails closed.

test('refuses a keyless request even from loopback', async () => {
  const app = appWith(depsWith([], { lanBind: false, requireApiKey: true }))
  const res = await app.request('/api/link/v1/ping', {}, { remoteAddress: '127.0.0.1' })
  assert.equal(res.status, 401)
})

test('refuses a keyless request when the daemon is loopback-only (lanAuth would pass it)', async () => {
  const app = appWith(depsWith([], { lanBind: false, requireApiKey: false }))
  const res = await app.request('/api/link/v1/ping')
  assert.equal(res.status, 401)
})

test('refuses a keyless request when the LAN is open and requireApiKey is OFF', async () => {
  // The exact hole that would make the whole IAM model decorative.
  const app = appWith(depsWith([], { lanBind: true, requireApiKey: false }))
  const res = await app.request('/api/link/v1/ping')
  assert.equal(res.status, 401)
})

test('refuses an unknown key', async () => {
  const app = appWith(depsWith([keyFor('tllm-good')], { lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/link/v1/ping', { headers: { 'X-TurboLLM-Auth': 'tllm-wrong' } })
  assert.equal(res.status, 401)
})

test('accepts a valid link token', async () => {
  const app = appWith(depsWith([keyFor('tllm-good', ['models:use'])], { lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/link/v1/ping', { headers: { 'X-TurboLLM-Auth': 'tllm-good' } })
  assert.equal(res.status, 200)
})

test('accepts a legacy full-access key (no grant)', async () => {
  const app = appWith(depsWith([keyFor('tllm-legacy')], { lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/link/v1/ping', { headers: { 'X-TurboLLM-Auth': 'tllm-legacy' } })
  assert.equal(res.status, 200)
})

// ── Capability gating

test('requireCapability rejects a token that lacks it, with 403 not 401', async () => {
  const app = appWith(depsWith([keyFor('tllm-use', ['models:use'])], { lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/link/v1/load', { headers: { 'X-TurboLLM-Auth': 'tllm-use' } })
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { code: string; capability: string } }
  // The peer greys buttons off the handshake, so a 403 here means the peer and host
  // disagree. Naming the capability makes that diagnosable instead of mysterious.
  assert.equal(body.error.code, 'forbidden')
  assert.equal(body.error.capability, 'models:load')
})

test('requireCapability admits a token that has it', async () => {
  const app = appWith(depsWith([keyFor('tllm-srv', ['models:use', 'models:load'])], { lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/link/v1/load', { headers: { 'X-TurboLLM-Auth': 'tllm-srv' } })
  assert.equal(res.status, 200)
})

test('a Bearer token is accepted, matching every other auth surface', async () => {
  const app = appWith(depsWith([keyFor('tllm-good', ['models:use'])], { lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/link/v1/ping', { headers: { Authorization: 'Bearer tllm-good' } })
  assert.equal(res.status, 200)
})
