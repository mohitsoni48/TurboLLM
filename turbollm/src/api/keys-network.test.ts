// Route-level tests for the API-key host gate added alongside the Developer pane fix: while the
// LAN is open and unauthenticated (lanBind on, requireApiKey off), lanAuth's own bypassesAuth
// deliberately lets ANY request through with zero credential (spec 06 §5's "opted into open LAN
// access") — which meant, before this fix, a non-host device on the LAN could list key names or
// mint itself a durable `tllm-...` API key with no credential at all, a real self-escalation (see
// routes.ts's keysHostGate comment). These tests exercise the actual HTTP routes on a real Hono
// app, mirroring code-routes.export.test.ts's "real app, minimal Deps double" discipline — a pure
// function test can't reach this, since the decision depends on a real request Context.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'

type FakeConfig = { daemon: { lanBind: boolean; requireApiKey: boolean; port: number }; apiKeys: Array<{ id: string; name: string; hash: string; prefix: string; createdAt: string; lastUsedAt: string | null }> }

/** Minimal Deps double: registerApi only touches these fields at ROUTE-HANDLER time (lazy
 *  closures), never at registration time (confirmed by reading routes.ts's top), so a store +
 *  manager double is sufficient for exercising /api/v1/keys, /api/v1/settings/network, and
 *  /api/v1/connect/:cli specifically. */
function fakeApp(cfg: FakeConfig): { app: Hono; cfg: FakeConfig } {
  const app = new Hono()
  const d = {
    version: 'test',
    store: {
      snapshot: () => cfg,
      update: (fn: (c: FakeConfig) => void) => fn(cfg),
    },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  registerApi(app, d)
  return { app, cfg }
}

function baseConfig(overrides: Partial<FakeConfig['daemon']> = {}): FakeConfig {
  return { daemon: { lanBind: false, requireApiKey: false, port: 6996, ...overrides }, apiKeys: [] }
}

// app.request() carries no real TCP connection, so getConnInfo (auth.ts's isLoopback) cannot
// resolve an address — isLoopback fails closed to null, and isLocalRequest treats an
// undetermined address as remote WHENEVER lanBind is true. That's exactly the "non-host viewer"
// case these tests need; the lanBind:false branch below is unconditionally local by a separate,
// address-independent shortcut in isLocalRequest, so it isn't relying on that same resolution.

test('GET /api/v1/keys: 200 when lanBind is off (loopback-only bind — always local)', async () => {
  const { app } = fakeApp(baseConfig({ lanBind: false, requireApiKey: false }))
  const res = await app.request('/api/v1/keys')
  assert.equal(res.status, 200)
})

test('GET /api/v1/keys: 200 for a non-host caller once requireApiKey is already on (self-service is fine post-auth)', async () => {
  const { app } = fakeApp(baseConfig({ lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/v1/keys')
  assert.equal(res.status, 200)
})

test('GET /api/v1/keys: 403 for a non-host caller while the LAN is open and unauthenticated', async () => {
  const { app } = fakeApp(baseConfig({ lanBind: true, requireApiKey: false }))
  const res = await app.request('/api/v1/keys')
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'forbidden')
})

test('POST /api/v1/keys: 403 for a non-host caller while the LAN is open and unauthenticated — cannot self-mint a key', async () => {
  const { app, cfg } = fakeApp(baseConfig({ lanBind: true, requireApiKey: false }))
  const res = await app.request('/api/v1/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'sneaky' }),
  })
  assert.equal(res.status, 403)
  assert.equal(cfg.apiKeys.length, 0, 'no key must have actually been created')
})

test('POST /api/v1/keys: 201 when lanBind is off (host use is unaffected by the new gate)', async () => {
  const { app } = fakeApp(baseConfig({ lanBind: false, requireApiKey: false }))
  const res = await app.request('/api/v1/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'my-key' }),
  })
  assert.equal(res.status, 201)
  const body = (await res.json()) as { key?: string }
  assert.match(body.key ?? '', /^tllm-/)
})

test('GET /api/v1/settings/network: isHost is true when lanBind is off, false for a non-host-looking caller while lanBind is on', async () => {
  const { app: localApp } = fakeApp(baseConfig({ lanBind: false }))
  const localRes = await localApp.request('/api/v1/settings/network')
  const localBody = (await localRes.json()) as { isHost: boolean; requireApiKey: boolean }
  assert.equal(localBody.isHost, true)

  const { app: lanApp } = fakeApp(baseConfig({ lanBind: true, requireApiKey: false }))
  const lanRes = await lanApp.request('/api/v1/settings/network')
  const lanBody = (await lanRes.json()) as { isHost: boolean; requireApiKey: boolean }
  assert.equal(lanBody.isHost, false)
  assert.equal(lanBody.requireApiKey, false)
})

test('GET /api/v1/settings/network: requireApiKey field reflects the live config', async () => {
  const { app } = fakeApp(baseConfig({ lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/v1/settings/network')
  const body = (await res.json()) as { requireApiKey: boolean }
  assert.equal(body.requireApiKey, true)
})

// ── GET /api/v1/connect/:cli — worse than the list/create case: this route MINTS a fresh live
// key on every call while lanBind is on, and (in the real UI) fires automatically the instant
// the Developer page loads, with no explicit click required at all.

test('GET /api/v1/connect/:cli: 403 for a non-host caller while the LAN is open and unauthenticated — no key minted', async () => {
  const { app, cfg } = fakeApp(baseConfig({ lanBind: true, requireApiKey: false }))
  const res = await app.request('/api/v1/connect/claude-code')
  assert.equal(res.status, 403)
  assert.equal(cfg.apiKeys.length, 0, 'no key must have actually been minted by the blocked request')
})

test('GET /api/v1/connect/:cli: 200 with a real live key when lanBind is off (loopback-only — always local)', async () => {
  const { app } = fakeApp(baseConfig({ lanBind: false }))
  const res = await app.request('/api/v1/connect/claude-code')
  assert.equal(res.status, 200)
})

test('GET /api/v1/connect/:cli: 200 for a non-host caller once requireApiKey is already on (self-service is fine post-auth)', async () => {
  const { app } = fakeApp(baseConfig({ lanBind: true, requireApiKey: true }))
  const res = await app.request('/api/v1/connect/claude-code')
  assert.equal(res.status, 200)
})
