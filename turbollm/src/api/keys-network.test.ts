// Route-level tests for the API-key host gate added alongside the Developer pane fix: while the
// LAN is open and unauthenticated (lanBind on, requireApiKey off), lanAuth's own bypassesAuth
// deliberately lets ANY request through with zero credential (spec 06 §5's "opted into open LAN
// access") — which meant, before this fix, a non-host device on the LAN could list key names or
// mint itself a durable `tllm-...` API key with no credential at all, a real self-escalation (see
// routes.ts's keysHostGate comment). These tests exercise the actual HTTP routes on a real Hono
// app, mirroring code-routes.export.test.ts's "real app, minimal Deps double" discipline — a pure
// function test can't reach this, since the decision depends on a real request Context.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { hashKey, lanAuth } from '../auth'
import type { Deps } from '../deps'
import { isTerminalBackendAvailable, registerTerminalWs } from '../terminal/terminal-routes'
import { TerminalManager } from '../terminal/terminal-manager'
import { tmpDir } from '../test-support/tmp'

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
  // C1 (Phase 5 final review): hostGate no longer treats `requireApiKey === true` alone as
  // proof of authentication — it requires THIS request to have actually resolved to a real
  // stored key, exactly what `lanAuth` running in front of this route in the real server
  // would have already verified. Present one here to model that.
  const RAW = 'tllm-selfservicekeyselfservicekeyselfse1'
  const cfg = baseConfig({ lanBind: true, requireApiKey: true })
  cfg.apiKeys.push({ id: 'k1', name: 'self', hash: hashKey(RAW), prefix: RAW.slice(0, 12), createdAt: '', lastUsedAt: null })
  const { app } = fakeApp(cfg)
  const res = await app.request('/api/v1/keys', { headers: { 'X-TurboLLM-Auth': RAW } })
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
  // C1 (Phase 5 final review): see the matching /api/v1/keys test above — hostGate now needs
  // THIS request to have actually resolved to a real stored key.
  const RAW = 'tllm-connectselfservicekeyconnectselfse1'
  const cfg = baseConfig({ lanBind: true, requireApiKey: true })
  cfg.apiKeys.push({ id: 'k1', name: 'self', hash: hashKey(RAW), prefix: RAW.slice(0, 12), createdAt: '', lastUsedAt: null })
  const { app } = fakeApp(cfg)
  const res = await app.request('/api/v1/connect/claude-code', { headers: { 'X-TurboLLM-Auth': RAW } })
  assert.equal(res.status, 200)
})

test('GET /api/v1/connect/:cli: the snippets carry the port really bound, not daemon.port', async () => {
  // `--port`/`--addr` (the Android app's 7000, `turbollm --port 8080`) win over the configured port.
  const cfg = baseConfig({ lanBind: false, port: 6996 })
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: FakeConfig) => void) => fn(cfg) },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    bindPort: 7000,
  } as unknown as Deps
  registerApi(app, d)
  const body = await (await app.request('/api/v1/connect/claude-code')).text()
  assert.match(body, /http:\/\/127\.0\.0\.1:7000/)
  assert.doesNotMatch(body, /:6996/)
})

// On a LAN-bound daemon this GET replaces the stored `cli-<name>` key, so it changes state
// like a write, and a GET needs no CORS preflight: an <img> on any site the host's user visits
// reached it with loopback trust, revoking the CLI's key (or piling up `cli-<anything>` keys).
test('GET /api/v1/connect/:cli: a cross-site request is refused before it can replace a CLI key', async () => {
  const cfg = baseConfig({ lanBind: true, requireApiKey: true })
  cfg.apiKeys.push({ id: 'k0', name: 'cli-claude-code', hash: 'h0', prefix: 'tllm-old', createdAt: '', lastUsedAt: null })
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: FakeConfig) => void) => fn(cfg) },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  const app = new Hono()
  app.use('*', lanAuth(d)) // server.ts's order: lanAuth in front of every route
  registerApi(app, d)
  // The box's own browser, on its loopback (what an <img> on another site reaches).
  const env = { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 5555, remoteFamily: 'IPv4' } } }
  const get = (path: string, headers: Record<string, string>) => app.request(path, { headers: { Host: '127.0.0.1:6996', ...headers } }, env as never)

  for (const site of ['cross-site', 'same-site']) {
    const res = await get('/api/v1/connect/claude-code', { 'Sec-Fetch-Site': site, 'Sec-Fetch-Dest': 'image' })
    assert.equal(res.status, 403, site)
  }
  assert.equal((await get('/api/v1/connect/flood-1', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  // The same requests carrying the UI's header (below): the cross-site check refuses them on its
  // own. Without the header the later header check refuses them as well, so only these pin it.
  for (const site of ['cross-site', 'same-site']) {
    const res = await get('/api/v1/connect/claude-code', { 'Sec-Fetch-Site': site, 'X-TurboLLM-UI': '1' })
    assert.equal(res.status, 403, `${site} with the UI header`)
  }
  // No Fetch Metadata, but a foreign Origin: the Origin half of the same check.
  assert.equal((await get('/api/v1/connect/claude-code', { Origin: 'https://evil.example', 'X-TurboLLM-UI': '1' })).status, 403)
  // An <img> GET carries no Origin, and a browser sends no Fetch Metadata to some URLs that
  // still land on loopback with loopback trust: an old browser to 127.0.0.1, WebKit to
  // `localhost.` (its potentially-trustworthy check takes no trailing dot), any browser to a
  // container host name that the hosts file maps to 127.0.0.1. Nothing marks such a request as
  // cross-site, so the route also needs a header only the UI sends (a page needs a preflight).
  const noMetadata = ['127.0.0.1:6996', 'localhost:6996', 'localhost.:6996', 'foo.localhost.:6996', 'host.docker.internal:6996']
  for (const host of [...noMetadata, '0.0.0.0:6996', '[::ffff:7f00:1]:6996']) {
    assert.equal((await get('/api/v1/connect/claude-code', { Host: host })).status, 403, host)
  }
  // Hosts with no loopback trust at all: refused even with the UI's header.
  for (const host of ['0.0.0.0:6996', '[::ffff:7f00:1]:6996', '[::ffff:127.0.0.1]:6996']) {
    assert.equal((await get('/api/v1/connect/claude-code', { Host: host, 'X-TurboLLM-UI': '1' })).status, 401, host)
  }
  assert.deepEqual(cfg.apiKeys.map((k) => k.id), ['k0'], 'the CLI key is untouched and nothing was added')

  // The web UI's own "Generate setup with a new key" click (web api.ts getConnect) is
  // same-origin, sends the header, and still works.
  const ok = await get('/api/v1/connect/claude-code', { 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json', 'X-TurboLLM-UI': '1' })
  assert.equal(ok.status, 200)
  assert.equal(cfg.apiKeys.length, 1)
  assert.notEqual(cfg.apiKeys[0].id, 'k0', 'an explicit, same-origin request still replaces the key, as the UI warns')
})

// The Connect page fetches on its own whenever its last network read said loopback-only. That read
// goes stale when LAN is switched on from another window while the page stays open, and each card
// click then minted a new cli-<name> key and revoked the one a CLI was using. Such a fetch says
// `?mint=0`, and a LAN-bound daemon refuses it instead of minting.
test('GET /api/v1/connect/:cli?mint=0: a LAN-bound daemon answers 409 lan_bound and keeps the CLI key', async () => {
  const RAW = 'tllm-nomintnomintnomintnomintnomintnomin1'
  const cfg = baseConfig({ lanBind: true, requireApiKey: true })
  cfg.apiKeys.push({ id: 'k1', name: 'self', hash: hashKey(RAW), prefix: RAW.slice(0, 12), createdAt: '', lastUsedAt: null })
  cfg.apiKeys.push({ id: 'k0', name: 'cli-claude-code', hash: 'h0', prefix: 'tllm-old', createdAt: '', lastUsedAt: null })
  const { app } = fakeApp(cfg)
  const res = await app.request('/api/v1/connect/claude-code?mint=0', { headers: { 'X-TurboLLM-Auth': RAW } })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'lan_bound')
  assert.deepEqual(cfg.apiKeys.map((k) => k.id), ['k1', 'k0'], 'nothing minted, nothing revoked')
  // The explicit Generate (no mint=0) still replaces it.
  assert.equal((await app.request('/api/v1/connect/claude-code', { headers: { 'X-TurboLLM-Auth': RAW } })).status, 200)
  assert.ok(!cfg.apiKeys.some((k) => k.id === 'k0'))
  // Loopback-only: no key is involved, so the snippet comes back as before.
  const loop = fakeApp(baseConfig({ lanBind: false }))
  assert.equal((await loop.app.request('/api/v1/connect/claude-code?mint=0')).status, 200)
})

// A Code terminal's WebSocket is let in on its `key` once, at the handshake, and then stays open:
// revoking that key left the shell attached. Both routes that remove a key close such terminals.

/** The real API routes and a real terminal WebSocket listener on the same Deps, with a live
 *  terminal (no PTY: the handshake only asks the manager these). `openWithKey` connects as
 *  another site's page would, so the key is what lets it in even on loopback. */
async function keysAndTerminal(t: TestContext, cfg: FakeConfig) {
  t.mock.method(TerminalManager.prototype, 'isActive', () => true)
  t.mock.method(TerminalManager.prototype, 'registerWsListener', () => {})
  t.mock.method(TerminalManager.prototype, 'unregisterWsListener', () => {})
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: FakeConfig) => void) => fn(cfg), dir: () => tmpDir('keys-network-terminal-') },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  registerApi(app, d)
  const server = http.createServer((_req, res) => res.end())
  registerTerminalWs(server, d)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const WebSocket = createRequire(import.meta.url)('ws')
  const clients: Array<{ terminate(): void }> = []
  const openWithKey = async (key: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/code/terminal/ws?terminalId=t1&key=${key}`, { headers: { Origin: 'https://other.example' } })
    clients.push(ws)
    let closed = false
    ws.on('close', () => { closed = true })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    return { closed: () => closed }
  }
  const settle = async (probe: () => boolean) => {
    for (let i = 0; i < 100 && !probe(); i++) await new Promise((r) => setTimeout(r, 10))
  }
  return { app, openWithKey, settle, cleanup: () => { for (const c of clients) c.terminate(); server.close() } }
}

test('DELETE /api/v1/keys/:id closes a Code terminal opened with that key; one opened with another key stays', { skip: !isTerminalBackendAvailable() && 'node-pty not installed' }, async (t) => {
  const RAW_A = 'tllm-revokedterminalArevokedterminalArev1'
  const RAW_B = 'tllm-revokedterminalBrevokedterminalBrev1'
  const cfg = baseConfig({ lanBind: false })
  cfg.apiKeys.push({ id: 'kA', name: 'laptop', hash: hashKey(RAW_A), prefix: RAW_A.slice(0, 12), createdAt: '', lastUsedAt: null })
  cfg.apiKeys.push({ id: 'kB', name: 'tablet', hash: hashKey(RAW_B), prefix: RAW_B.slice(0, 12), createdAt: '', lastUsedAt: null })
  const h = await keysAndTerminal(t, cfg)
  try {
    const a = await h.openWithKey(RAW_A)
    const b = await h.openWithKey(RAW_B)
    assert.equal((await h.app.request('/api/v1/keys/kA', { method: 'DELETE' })).status, 200)
    await h.settle(a.closed)
    assert.equal(a.closed(), true, "the revoked key's terminal is closed")
    assert.equal(b.closed(), false)
  } finally {
    h.cleanup()
  }
})

test("GET /api/v1/connect/:cli's re-mint closes a Code terminal opened with the CLI key it replaces", { skip: !isTerminalBackendAvailable() && 'node-pty not installed' }, async (t) => {
  const RAW_SELF = 'tllm-remintselfremintselfremintselfremin1'
  const RAW_CLI = 'tllm-remintclikeyremintclikeyremintclike1'
  const cfg = baseConfig({ lanBind: true, requireApiKey: true })
  cfg.apiKeys.push({ id: 'k1', name: 'self', hash: hashKey(RAW_SELF), prefix: RAW_SELF.slice(0, 12), createdAt: '', lastUsedAt: null })
  cfg.apiKeys.push({ id: 'k0', name: 'cli-claude-code', hash: hashKey(RAW_CLI), prefix: RAW_CLI.slice(0, 12), createdAt: '', lastUsedAt: null })
  const h = await keysAndTerminal(t, cfg)
  try {
    const cli = await h.openWithKey(RAW_CLI)
    const self = await h.openWithKey(RAW_SELF)
    assert.equal((await h.app.request('/api/v1/connect/claude-code', { headers: { 'X-TurboLLM-Auth': RAW_SELF } })).status, 200)
    assert.ok(!cfg.apiKeys.some((k) => k.id === 'k0'), 'the CLI key was replaced')
    await h.settle(cli.closed)
    assert.equal(cli.closed(), true, "the replaced key's terminal is closed")
    assert.equal(self.closed(), false)
  } finally {
    h.cleanup()
  }
})
