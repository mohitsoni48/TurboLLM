// TURBOLLM_APP_SECRET (TurboLLM-Android): on a phone every installed app shares
// 127.0.0.1, so the app hands its daemon a per-launch secret and a loopback request is trusted
// only when it carries it — as the `turbollm_app` cookie (the WebView) or the X-TurboLLM-App
// header (the app's native code). Without it, the request is judged like a LAN one. Unset
// (desktop, npm, Docker), nothing changes. Same harness as auth.lanauth-composed.test.ts: the
// real lanAuth on a Hono app, driven through app.request() with a simulated socket.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { codeAuth, hashKey, hostGate, isLocalOrAuthenticated, isLocalRequest, isLocalUpgrade, lanAuth } from './auth'
import { defaultConfig } from './config/config'
import type { Deps } from './deps'

const SECRET = 'a'.repeat(64)
const RAW_KEY = 'tllm-appsecretTestKeyABCDEFGHIJKLMNOPQRS'

function makeDeps(mutate: (cfg: ReturnType<typeof defaultConfig>) => void = () => {}): Deps {
  const cfg = defaultConfig()
  mutate(cfg)
  return {
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) },
  } as unknown as Deps
}

function buildApp(d: Deps): Hono {
  const app = new Hono()
  app.use('*', lanAuth(d))
  app.use('/api/v1/code/*', codeAuth(d))
  app.get('/api/v1/status', (c) => c.json({ ok: true }))
  app.get('/v1/models', (c) => c.json({ ok: true }))
  app.post('/api/v1/keys', (c) => (hostGate(c, d) ? c.json({ ok: true }) : c.json({ error: 'host-only' }, 403)))
  app.post('/api/v1/mcp/servers', (c) => (isLocalOrAuthenticated(c, d) ? c.json({ ok: true }) : c.json({ error: 'host-only' }, 403)))
  app.get('/api/v1/code/sessions', (c) => c.json({ ok: true }))
  // The SPA shell and its assets (registerSpaFallback serves every other GET).
  app.get('/*', (c) => c.text('<html>'))
  return app
}

function loopbackRequest(app: Hono, path: string, init: RequestInit = {}): Response | Promise<Response> {
  return app.request(path, init, {
    incoming: { socket: { localPort: 7000, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
  } as never)
}

function lanRequest(app: Hono, path: string, init: RequestInit = {}): Response | Promise<Response> {
  return app.request(path, init, {
    incoming: { socket: { localPort: 7000, remoteAddress: '192.168.1.50', remotePort: 55555, remoteFamily: 'IPv4' } },
  } as never)
}

function fakeContext(headers: Record<string, string | undefined>): Parameters<typeof isLocalRequest>[0] {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: { incoming: { socket: { localPort: 7000, remoteAddress: '127.0.0.1' } } },
  } as unknown as Parameters<typeof isLocalRequest>[0]
}

/** Runs `fn` with TURBOLLM_APP_SECRET set to `value` (or unset), restoring the original after. */
async function withSecret(value: string | undefined, fn: () => void | Promise<void>): Promise<void> {
  const saved = process.env.TURBOLLM_APP_SECRET
  if (value === undefined) delete process.env.TURBOLLM_APP_SECRET
  else process.env.TURBOLLM_APP_SECRET = value
  try {
    await fn()
  } finally {
    if (saved === undefined) delete process.env.TURBOLLM_APP_SECRET
    else process.env.TURBOLLM_APP_SECRET = saved
  }
}

const POST = { method: 'POST' }

test('app secret unset (desktop/npm/Docker): loopback trust is exactly as before', () =>
  withSecret(undefined, async () => {
    const d = makeDeps()
    const app = buildApp(d)
    assert.equal((await loopbackRequest(app, '/api/v1/status')).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/keys', POST)).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/mcp/servers', POST)).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/code/sessions')).status, 200)
    assert.equal(isLocalRequest(fakeContext({}), d), true)
    assert.equal(isLocalOrAuthenticated(fakeContext({}), d), true)
    assert.equal(isLocalUpgrade('127.0.0.1', 7000, {}, d), true)
    // An empty value is "unset" too: the app never sends one, and it must not lock anything.
    process.env.TURBOLLM_APP_SECRET = ''
    assert.equal((await loopbackRequest(app, '/api/v1/keys', POST)).status, 200)
    assert.equal(isLocalUpgrade('127.0.0.1', 7000, {}, d), true)
  }))

test('app secret set: a loopback request without it is refused like a LAN one', () =>
  withSecret(SECRET, async () => {
    const d = makeDeps() // the defaults: loopback-only bind, requireApiKey on
    const app = buildApp(d)
    assert.equal((await loopbackRequest(app, '/api/v1/status')).status, 401)
    assert.equal((await loopbackRequest(app, '/v1/models')).status, 401)
    assert.equal((await loopbackRequest(app, '/api/v1/keys', POST)).status, 401)
    assert.equal((await loopbackRequest(app, '/api/v1/mcp/servers', POST)).status, 401)
    assert.equal((await loopbackRequest(app, '/api/v1/code/sessions')).status, 401)
    assert.equal(isLocalRequest(fakeContext({}), d), false)
    assert.equal(isLocalUpgrade('127.0.0.1', 7000, {}, d), false, 'the terminal WebSocket too')
    // The SPA shell and /healthz stay open, as for any LAN caller: they are the APK's own public files.
    assert.equal((await loopbackRequest(app, '/')).status, 200)
    assert.equal((await loopbackRequest(app, '/assets/index.js')).status, 200)
  }))

test('app secret set: the X-TurboLLM-App header (the app\'s native code) restores loopback trust', () =>
  withSecret(SECRET, async () => {
    const d = makeDeps()
    const app = buildApp(d)
    const headers = { 'X-TurboLLM-App': SECRET }
    assert.equal((await loopbackRequest(app, '/api/v1/status', { headers })).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/keys', { method: 'POST', headers })).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/mcp/servers', { method: 'POST', headers })).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/code/sessions', { headers })).status, 200)
    assert.equal(isLocalRequest(fakeContext({ 'x-turbollm-app': SECRET }), d), true)
    assert.equal(isLocalOrAuthenticated(fakeContext({ 'x-turbollm-app': SECRET }), d), true)
    assert.equal(isLocalUpgrade('127.0.0.1', 7000, { 'x-turbollm-app': SECRET }, d), true)
  }))

test('app secret set: the turbollm_app cookie (the WebView) restores loopback trust, WebSocket included', () =>
  withSecret(SECRET, async () => {
    const d = makeDeps()
    const app = buildApp(d)
    const cookie = `theme=dark; turbollm_app=${SECRET}; other=1`
    const headers = { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' }
    assert.equal((await loopbackRequest(app, '/api/v1/status', { headers })).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/keys', { method: 'POST', headers })).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/code/sessions', { headers })).status, 200)
    assert.equal((await loopbackRequest(app, '/', { headers })).status, 200)
    assert.equal(isLocalRequest(fakeContext({ cookie }), d), true)
    assert.equal(isLocalUpgrade('127.0.0.1', 7000, { cookie }, d), true)
    // A stale cookie from an earlier launch next to the current one still counts.
    assert.equal(isLocalUpgrade('127.0.0.1', 7000, { cookie: `turbollm_app=${'b'.repeat(64)}; turbollm_app=${SECRET}` }, d), true)
  }))

test('app secret set: a wrong, empty, truncated or misnamed secret is refused', () =>
  withSecret(SECRET, async () => {
    const d = makeDeps()
    const app = buildApp(d)
    const wrong: Record<string, string>[] = [
      { 'X-TurboLLM-App': 'b'.repeat(64) },
      { 'X-TurboLLM-App': SECRET.slice(0, 63) },
      { 'X-TurboLLM-App': `${SECRET}0` },
      { Cookie: 'turbollm_app=' },
      { Cookie: `turbollm_app=${'b'.repeat(64)}` },
      { Cookie: `turbollm_apps=${SECRET}` },
      { Cookie: `x_turbollm_app=${SECRET}` },
      { 'X-TurboLLM-Auth': SECRET }, // the API-key header is not the app header
    ]
    for (const headers of wrong) {
      assert.equal((await loopbackRequest(app, '/api/v1/status', { headers })).status, 401, JSON.stringify(headers))
      assert.equal((await loopbackRequest(app, '/api/v1/keys', { method: 'POST', headers })).status, 401, JSON.stringify(headers))
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
      assert.equal(isLocalRequest(fakeContext(lower), d), false, JSON.stringify(headers))
      assert.equal(isLocalUpgrade('127.0.0.1', 7000, lower, d), false, JSON.stringify(headers))
    }
  }))

test('app secret set: another app with a real API key gets in like a LAN client, never as local', () =>
  withSecret(SECRET, async () => {
    const d = makeDeps((cfg) => {
      cfg.apiKeys.push({ id: 'k', name: 'k', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
    })
    const app = buildApp(d)
    const headers = { 'X-TurboLLM-Auth': RAW_KEY }
    assert.equal((await loopbackRequest(app, '/api/v1/status', { headers })).status, 200)
    assert.equal(isLocalRequest(fakeContext({ 'x-turbollm-auth': RAW_KEY }), d), false)
  }))

test('app secret set: requireApiKey off with nothing LAN-exposed still demands a key from another app', () =>
  withSecret(SECRET, async () => {
    // requireApiKey is only offered next to the LAN toggle; switched off and the LAN later closed
    // again, it must not leave the whole API open to every app on the phone.
    const d = makeDeps((cfg) => { cfg.daemon.requireApiKey = false })
    const app = buildApp(d)
    assert.equal((await loopbackRequest(app, '/api/v1/status')).status, 401)
    assert.equal((await loopbackRequest(app, '/api/v1/mcp/servers', POST)).status, 401)
    assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { 'X-TurboLLM-App': SECRET } })).status, 200)
  }))

test('app secret set: an open LAN (lanBind on, requireApiKey off) treats another app like any LAN device', () =>
  withSecret(SECRET, async () => {
    const d = makeDeps((cfg) => { cfg.daemon.lanBind = true; cfg.daemon.requireApiKey = false })
    const app = buildApp(d)
    // The user opened the API to the network with no key; a LAN device and another app alike get it...
    assert.equal((await lanRequest(app, '/api/v1/status')).status, 200)
    assert.equal((await loopbackRequest(app, '/api/v1/status')).status, 200)
    // ...but neither is the host: no local-admin action and no key minting.
    assert.equal((await lanRequest(app, '/api/v1/keys', POST)).status, 403)
    assert.equal((await loopbackRequest(app, '/api/v1/keys', POST)).status, 403)
    assert.equal((await loopbackRequest(app, '/api/v1/mcp/servers', POST)).status, 403)
    assert.equal((await loopbackRequest(app, '/api/v1/keys', { method: 'POST', headers: { 'X-TurboLLM-App': SECRET } })).status, 200)
  }))
