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

// ── An SSE server's Bearer key is write-only, so the edit form opens with a blank key field and
// sends no apiKey when it is left blank. That kept the key across a URL change, and the old
// service's token went to whatever host the URL now named. ───────────────────────────────────────

test('PUT /api/v1/mcp/servers/:id: a URL moved to another origin with no new key drops the stored key', async () => {
  const cfg = defaultConfig()
  cfg.mcp.servers.push({ id: 's1', name: 'svc', transport: 'sse', enabled: true, url: 'https://mcp.one.example/sse', apiKey: 'tok-one' })
  const app = fakeApp(cfg)
  const put = (patch: object) =>
    app.request('/api/v1/mcp/servers/s1', { method: 'PUT', body: JSON.stringify(patch) })

  // A new path (or the same URL re-sent by the form) on the same origin keeps the key.
  assert.equal((await put({ url: 'https://MCP.one.example:443/v2/sse' })).status, 200)
  assert.equal(cfg.mcp.servers[0].apiKey, 'tok-one')
  assert.equal((await put({ name: 'svc', url: 'https://MCP.one.example:443/v2/sse' })).status, 200)
  assert.equal(cfg.mcp.servers[0].apiKey, 'tok-one')

  // Another host, scheme or port, with no new key: the old token must not follow it there.
  for (const url of ['https://mcp.two.example/sse', 'http://mcp.one.example/v2/sse', 'https://mcp.one.example:8443/sse']) {
    cfg.mcp.servers[0].url = 'https://mcp.one.example/sse'
    cfg.mcp.servers[0].apiKey = 'tok-one'
    assert.equal((await put({ url })).status, 200, url)
    assert.equal(cfg.mcp.servers[0].url, url)
    assert.equal(cfg.mcp.servers[0].apiKey, undefined, url)
  }

  // A key sent with the move is the new service's key and is stored.
  cfg.mcp.servers[0].apiKey = 'tok-one'
  assert.equal((await put({ url: 'https://mcp.three.example/sse', apiKey: 'tok-three' })).status, 200)
  assert.equal(cfg.mcp.servers[0].apiKey, 'tok-three')
})

test('GET /api/v1/settings: each MCP server says whether a key is stored, never the key', async () => {
  const cfg = defaultConfig()
  cfg.mcp.servers.push(
    { id: 's1', name: 'keyed', transport: 'sse', enabled: true, url: 'https://mcp.one.example/sse', apiKey: 'tok-one' },
    { id: 's2', name: 'open', transport: 'sse', enabled: true, url: 'https://mcp.two.example/sse' },
  )
  const res = await fakeApp(cfg).request('/api/v1/settings')
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.equal(text.includes('tok-one'), false)
  const { mcp } = JSON.parse(text) as { mcp: { servers: { id: string; apiKeySet?: boolean }[] } }
  assert.deepEqual(mcp.servers.map((s) => [s.id, s.apiKeySet]), [['s1', true], ['s2', false]])
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

// `off` with `enabled` still set (a Start that raced a Stop from another client, or the moment at
// boot before the auto-start): the UI shows remote access off and lets a provider be picked, and
// the 409 left no way out but Start then Stop.
test('PATCH /api/v1/settings: in `off` with enabled still set, a provider change is taken and clears enabled', async () => {
  const cfg = defaultConfig()
  cfg.remoteAccess.provider = 'cloudflare-quick'
  cfg.remoteAccess.enabled = true
  const app = fakeApp(cfg, { kind: 'off' })
  const patch = (provider: string) =>
    app.request('/api/v1/settings', { method: 'PATCH', body: JSON.stringify({ remoteAccess: { provider } }) })
  assert.notEqual((await patch('cloudflare-quick')).status, 409)
  assert.equal(cfg.remoteAccess.enabled, true, 're-saving the same provider changes nothing')
  assert.notEqual((await patch('ngrok')).status, 409)
  assert.equal(cfg.remoteAccess.provider, 'ngrok')
  assert.equal(cfg.remoteAccess.enabled, false, 'nothing may start the new provider unconfirmed')
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
