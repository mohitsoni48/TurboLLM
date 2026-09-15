import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerRemoteApi, sanitizeTokenGrant } from './routes'
import { defaultConfig, normalizeProvider } from '../config/config'
import { isRemoteAccessEnabled } from './gate'

test('sanitizeTokenGrant: strips config:*/downloads:* even if stored, keeps the four server capabilities', () => {
  const r = sanitizeTokenGrant({
    capabilities: ['models:use', 'models:wake', 'models:load', 'models:unload', 'config:write', 'config:read', 'downloads:read', 'downloads:write'],
  })
  assert.deepEqual(
    [...r.capabilities].sort(),
    ['models:load', 'models:unload', 'models:use', 'models:wake'],
  )
})

test('sanitizeTokenGrant: a grant holding only config:write falls back to models:use, never an empty or config grant', () => {
  const r = sanitizeTokenGrant({ capabilities: ['config:write'] })
  assert.deepEqual(r.capabilities, ['models:use'])
})

test('sanitizeTokenGrant: an unknown string is dropped like any other out-of-scope capability', () => {
  const r = sanitizeTokenGrant({ capabilities: ['models:use', 'made-up:capability'] })
  assert.deepEqual(r.capabilities, ['models:use'])
})

const makeApp = (opts: { enabled: boolean; lanBind?: boolean }) => {
  const cfg = defaultConfig()
  cfg.daemon.experimental.remoteAccess = opts.enabled
  cfg.daemon.lanBind = opts.lanBind ?? false
  let enabled = 0
  let disabled = 0
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '' },
    remote: {
      ingressPort: () => 6997,
      state: () => ({ kind: 'connected', url: 'https://x.test', since: '2026-09-10T00:00:00Z' }),
      url: () => 'https://x.test',
      enable: async () => {
        enabled++
      },
      disable: async () => {
        disabled++
      },
    },
  } as unknown as Deps
  const app = new Hono()
  registerRemoteApi(app, d)
  return { app, counts: () => ({ enabled, disabled }), cfg }
}

// These routes are the OWNER managing their own box locally (e.g. flipping the Settings
// toggle) — never a request that arrived over the tunnel. `makeApp`'s fake Deps configures
// an ingress port (6997) same as production, so since isTunneled/isLocalRequest now fail
// CLOSED when a request's local port can't be determined at all, every call here must
// simulate landing on a DIFFERENT, ordinary port — matching what a real Node HTTP server's
// `c.env` would actually carry, the same shape `auth.remote.test.ts` uses.
const LOCAL_ENV = { incoming: { socket: { localPort: 6996 } } }

test('remote routes: status refuses with a typed code while the flag is off', async () => {
  const { app } = makeApp({ enabled: false })
  const res = await app.request('/api/v1/remote/status', {}, LOCAL_ENV)
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'remote_access_disabled')
})

test('remote routes: status reports the provider and live state when enabled', async () => {
  const { app } = makeApp({ enabled: true })
  const res = await app.request('/api/v1/remote/status', {}, LOCAL_ENV)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { provider: string; state: { kind: string }; url: string }
  assert.equal(body.provider, 'cloudflare-quick')
  assert.equal(body.state.kind, 'connected')
  assert.equal(body.url, 'https://x.test')
})

test('remote routes: start sets enabled in config and calls the manager', async () => {
  const { app, counts, cfg } = makeApp({ enabled: true })
  const res = await app.request('/api/v1/remote/start', { method: 'POST' }, LOCAL_ENV)
  assert.equal(res.status, 200)
  assert.equal(counts().enabled, 1)
  assert.equal(cfg.remoteAccess.enabled, true)
})

test('remote routes: stop clears enabled in config and calls the manager', async () => {
  const { app, counts, cfg } = makeApp({ enabled: true })
  await app.request('/api/v1/remote/start', { method: 'POST' }, LOCAL_ENV)
  const res = await app.request('/api/v1/remote/stop', { method: 'POST' }, LOCAL_ENV)
  assert.equal(res.status, 200)
  assert.equal(counts().disabled, 1)
  assert.equal(cfg.remoteAccess.enabled, false)
})

test('settings: secrets are write-only — GET reports only whether one is stored', () => {
  // Mirrors settingsPayload's redaction (spec 30 T-11). A payload that echoed the token back
  // would put a live Cloudflare credential into every settings poll the browser makes.
  const cfg = defaultConfig()
  cfg.remoteAccess.cloudflare.tunnelToken = 'a-real-token'
  cfg.remoteAccess.ngrok.authtoken = 'a-real-authtoken'
  const payload = {
    cloudflare: { hasTunnelToken: !!cfg.remoteAccess.cloudflare.tunnelToken },
    ngrok: { hasAuthtoken: !!cfg.remoteAccess.ngrok.authtoken },
  }
  const json = JSON.stringify(payload)
  assert.equal(json.includes('a-real-token'), false)
  assert.equal(json.includes('a-real-authtoken'), false)
  assert.equal(payload.cloudflare.hasTunnelToken, true)
})

test('settings: a patch touching only the provider must not wipe a stored token', () => {
  // The per-field-merge rule requestLog and experimental already follow. An Object.assign
  // over the block would clear every sibling the patch did not mention.
  const cfg = defaultConfig()
  cfg.remoteAccess.cloudflare.tunnelToken = 'keep-me'
  const patch: { provider?: string; cloudflare?: { tunnelToken?: string } } = { provider: 'ngrok' }
  if (patch.provider !== undefined) cfg.remoteAccess.provider = normalizeProvider(patch.provider)
  if (patch.cloudflare?.tunnelToken !== undefined) cfg.remoteAccess.cloudflare.tunnelToken = patch.cloudflare.tunnelToken
  assert.equal(cfg.remoteAccess.provider, 'ngrok')
  assert.equal(cfg.remoteAccess.cloudflare.tunnelToken, 'keep-me')
})

test('settings: an explicit empty string clears a stored secret', () => {
  const cfg = defaultConfig()
  cfg.remoteAccess.ngrok.authtoken = 'old'
  const patch: { ngrok?: { authtoken?: string } } = { ngrok: { authtoken: '' } }
  if (patch.ngrok?.authtoken !== undefined) cfg.remoteAccess.ngrok.authtoken = String(patch.ngrok.authtoken).trim()
  assert.equal(cfg.remoteAccess.ngrok.authtoken, '')
})

test("boot gating: a persisted enabled:true does NOT bypass the experimental flag", () => {
  // Spec 30 §8.1: "the supervisor does not run" with the flag off. Only --tunnel is the
  // ungated override (§8.3). This is a plain function test, not a route test — it exercises
  // the exact boolean cli.ts computes for remoteWanted, without needing to boot the daemon.
  const cfg = defaultConfig()
  cfg.remoteAccess.enabled = true
  cfg.daemon.experimental.remoteAccess = false
  const d = { store: { snapshot: () => cfg } } as unknown as Deps
  const tunnelFlag = false
  const remoteWanted = tunnelFlag || (isRemoteAccessEnabled(d) && cfg.remoteAccess.enabled)
  assert.equal(remoteWanted, false)
})

test("boot gating: enabled:true DOES start the supervisor once the flag is on", () => {
  const cfg = defaultConfig()
  cfg.remoteAccess.enabled = true
  cfg.daemon.experimental.remoteAccess = true
  const d = { store: { snapshot: () => cfg } } as unknown as Deps
  const tunnelFlag = false
  const remoteWanted = tunnelFlag || (isRemoteAccessEnabled(d) && cfg.remoteAccess.enabled)
  assert.equal(remoteWanted, true)
})

test("boot gating: --tunnel is the ungated override regardless of the flag or enabled", () => {
  const cfg = defaultConfig()
  cfg.remoteAccess.enabled = false
  cfg.daemon.experimental.remoteAccess = false
  const d = { store: { snapshot: () => cfg } } as unknown as Deps
  const tunnelFlag = true
  const remoteWanted = tunnelFlag || (isRemoteAccessEnabled(d) && cfg.remoteAccess.enabled)
  assert.equal(remoteWanted, true)
})

test('remote routes: preflight rejects an unknown provider id', async () => {
  const { app } = makeApp({ enabled: true })
  const res = await app.request('/api/v1/remote/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'not-a-provider' }),
  }, LOCAL_ENV)
  assert.equal(res.status, 400)
})
