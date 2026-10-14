// Route-level regressions for a gate in registerApi, on a real Hono app with a minimal Deps
// double (same discipline as keys-network.test.ts). app.request() carries no TCP connection, so
// auth.ts's isLoopback cannot resolve an address and fails closed: with lanBind on, every request
// here is a non-host caller.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { defaultConfig, type Config } from '../config/config'
import type { Deps } from '../deps'

function fakeApp(cfg: Config): Hono {
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    manager: { status: () => ({ state: 'stopped', model: null }) },
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
