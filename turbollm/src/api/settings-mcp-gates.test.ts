// Route-level regressions for two gates in registerApi, on a real Hono app with a minimal Deps
// double (same discipline as keys-network.test.ts). app.request() carries no TCP connection, so
// auth.ts's isLoopback cannot resolve an address and fails closed: with lanBind on, every request
// here is a non-host caller.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { defaultConfig, type Config } from '../config/config'
import type { Deps } from '../deps'
import type { RemoteState } from '../remote/types'

function fakeApp(cfg: Config, remote?: { kind: RemoteState['kind'] }): Hono {
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    ...(remote ? { remote: { ingressPort: () => undefined, state: () => remote } } : {}),
  } as unknown as Deps
  registerApi(app, d)
  return app
}

// ── POST/PUT /api/v1/mcp/servers spawn a caller-chosen command (a stdio server starts right
// away), so they carry the same isLocalOrAuthenticated gate as POST /engines and /build/*. ──

test('POST /api/v1/mcp/servers: 403 for a keyless non-host caller on an open LAN — nothing stored', async () => {
  const cfg = defaultConfig()
  cfg.daemon.lanBind = true
  cfg.daemon.requireApiKey = false
  const res = await fakeApp(cfg).request('/api/v1/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', command: 'calc.exe' }),
  })
  assert.equal(res.status, 403)
  assert.equal(cfg.mcp.servers.length, 0)
})

test('PUT /api/v1/mcp/servers/:id: 403 for a keyless non-host caller on an open LAN — command unchanged', async () => {
  const cfg = defaultConfig()
  cfg.daemon.lanBind = true
  cfg.daemon.requireApiKey = false
  cfg.mcp.servers.push({ id: 's1', name: 'mine', transport: 'stdio', enabled: true, command: 'npx', args: [], env: {} })
  const res = await fakeApp(cfg).request('/api/v1/mcp/servers/s1', {
    method: 'PUT',
    body: JSON.stringify({ command: 'calc.exe' }),
  })
  assert.equal(res.status, 403)
  assert.equal(cfg.mcp.servers[0].command, 'npx')
})

test('POST /api/v1/mcp/servers: still works for the host itself (loopback-only bind)', async () => {
  const cfg = defaultConfig()
  const res = await fakeApp(cfg).request('/api/v1/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', command: 'npx' }),
  })
  assert.equal(res.status, 201)
  assert.equal(cfg.mcp.servers.length, 1)
})

// ── The remote-access provider must not change under a running tunnel. Saved mid-session it
// is what the next crash/health restart starts (skipping the exposure confirmation), and the UI
// labels the still-running old tunnel with it. ──────────────────────────────────────────────────

test('PATCH /api/v1/settings: 409 for a provider change while remote access is running — config unchanged', async () => {
  for (const kind of ['starting', 'connected', 'reconnecting'] as const) {
    const cfg = defaultConfig()
    cfg.remoteAccess.provider = 'cloudflare-quick'
    const res = await fakeApp(cfg, { kind }).request('/api/v1/settings', {
      method: 'PATCH',
      body: JSON.stringify({ remoteAccess: { provider: 'tailscale-serve' } }),
    })
    assert.equal(res.status, 409, kind)
    assert.equal(cfg.remoteAccess.provider, 'cloudflare-quick', kind)
  }
})

test('PATCH /api/v1/settings: 409 for a provider change while remote access is enabled but not up (failed / needs-setup / unavailable)', async () => {
  // Still `enabled`, so the next boot auto-starts the saved provider — a switch here would publish
  // through a provider nobody confirmed.
  for (const kind of ['failed', 'needs-setup', 'unavailable'] as const) {
    const cfg = defaultConfig()
    cfg.remoteAccess.provider = 'tailscale-serve'
    cfg.remoteAccess.enabled = true
    const res = await fakeApp(cfg, { kind }).request('/api/v1/settings', {
      method: 'PATCH',
      body: JSON.stringify({ remoteAccess: { provider: 'cloudflare-quick' } }),
    })
    assert.equal(res.status, 409, kind)
    assert.equal(cfg.remoteAccess.provider, 'tailscale-serve', kind)
  }
})

test('PATCH /api/v1/settings: a provider change is accepted while remote access is off', async () => {
  for (const kind of ['off', 'failed', 'needs-setup'] as const) {
    const cfg = defaultConfig()
    cfg.remoteAccess.provider = 'cloudflare-quick'
    const res = await fakeApp(cfg, { kind }).request('/api/v1/settings', {
      method: 'PATCH',
      body: JSON.stringify({ remoteAccess: { provider: 'tailscale-serve' } }),
    })
    assert.notEqual(res.status, 409, kind)
    assert.equal(cfg.remoteAccess.provider, 'tailscale-serve', kind)
  }
})
