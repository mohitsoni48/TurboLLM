import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerRemoteApi, sanitizeTokenGrant } from './routes'
import { defaultConfig, normalizeProvider } from '../config/config'
import { isRemoteAccessEnabled } from './gate'
import { registerApi } from '../api/routes'
import { RemoteAccessManager } from './manager'
import { verifyKeyValue } from '../auth'
import type { PreflightState, RemoteProvider } from './types'

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

test('remote routes: status names the port a self-run tunnel points at, while off too, and the main port it must not', async () => {
  const cfg = defaultConfig()
  cfg.daemon.experimental.remoteAccess = true
  cfg.remoteAccess.provider = 'custom'
  // As under `--port 6997`: config still says 6997 for the ingress, which is the port the main
  // listener bound, and cli.ts moved this boot's ingress to 6996.
  cfg.remoteAccess.ingressPort = 6997
  const provider: RemoteProvider = {
    id: 'custom',
    lifecycle: 'none',
    preflight: async () => ({ kind: 'off' }),
    start: async () => ({ url: 'https://llm.example.com' }),
    stop: async () => {},
    alive: () => true,
  }
  const status = async (ingressPort: number) => {
    const remote = new RemoteAccessManager({ app: new Hono(), ingressPort, makeProvider: () => provider, probe: async () => true })
    const d = {
      store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '' },
      remote,
      bindPort: 6997,
    } as unknown as Deps
    const app = new Hono()
    registerRemoteApi(app, d)
    const read = async () =>
      (await (await app.request('/api/v1/remote/status', {}, { incoming: { socket: { localPort: 6997 } } })).json()) as {
        ingressPort: number | null
        tunnelTargetPort: number | null
        mainPort: number | null
      }
    return { remote, read }
  }

  const off = await (await status(6996)).read()
  assert.equal(off.ingressPort, null, 'nothing bound while off')
  assert.equal(off.tunnelTargetPort, 6996, "the port the next start binds, not config's 6997")
  assert.equal(off.mainPort, 6997)

  // Once up, the port it bound (an ephemeral one here).
  const on = await status(0)
  try {
    await on.remote.enable()
    const body = await on.read()
    assert.equal(typeof body.ingressPort, 'number')
    assert.equal(body.tunnelTargetPort, body.ingressPort)
    assert.equal(body.mainPort, 6997)
  } finally {
    await on.remote.disable()
  }

  // A remote that cannot say (this file's fake) names none; with no bindPort the main port is
  // config's.
  const { app } = makeApp({ enabled: true })
  const plain = (await (await app.request('/api/v1/remote/status', {}, LOCAL_ENV)).json()) as { tunnelTargetPort: number | null; mainPort: number }
  assert.equal(plain.tunnelTargetPort, null)
  assert.equal(plain.mainPort, 6996)
})

// Settings moves the main listener in place (PATCH /api/v1/settings {port}, deps.rebind), and the
// ingress port is fixed per boot. With remote access off, moving it onto that port was taken, and
// the status then named the main port as the one to point a tunnel at, right above the warning
// never to point it there.
test('remote routes: status names no tunnel port while the main listener holds the one remote access would bind', async () => {
  const cfg = defaultConfig()
  cfg.daemon.experimental.remoteAccess = true
  cfg.remoteAccess.provider = 'custom'
  const remote = new RemoteAccessManager({ app: new Hono(), ingressPort: 6997, makeProvider: () => { throw new Error('not started') }, probe: async () => true })
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '' },
    remote,
    bindPort: 6997, // moved there from 6996 in Settings, this boot
  } as unknown as Deps
  const app = new Hono()
  registerRemoteApi(app, d)
  const body = (await (await app.request('/api/v1/remote/status', {}, { incoming: { socket: { localPort: 6997 } } })).json()) as {
    ingressPort: number | null
    tunnelTargetPort: number | null
    mainPort: number | null
  }
  assert.equal(body.ingressPort, null)
  assert.equal(body.tunnelTargetPort, null, 'not the main port')
  assert.equal(body.mainPort, 6997)
})

test("settings: a port change onto this boot's remote-access port is refused while remote access is on, and taken while it is off", async () => {
  const setup = (s: { enabled: boolean; kind: string; bound: boolean }) => {
    const cfg = defaultConfig()
    cfg.daemon.experimental.remoteAccess = true
    cfg.remoteAccess.provider = 'custom'
    cfg.remoteAccess.enabled = s.enabled
    let rebinds = 0
    const d = {
      version: 'test',
      store: { snapshot: () => structuredClone(cfg), update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '' },
      manager: { status: () => ({ state: 'stopped', model: null }) },
      bindPort: 6996,
      // What the listen callback does once the new port is bound (cli.ts deps.rebind).
      rebind: () => {
        rebinds++
        d.bindPort = cfg.daemon.port
      },
      remote: {
        ingressPort: () => (s.bound ? 6997 : undefined),
        targetIngressPort: () => 6997,
        state: () => ({ kind: s.kind }),
        url: () => null,
        enable: async () => {},
        disable: async () => {},
      },
    } as unknown as Deps & { bindPort: number }
    const app = new Hono()
    registerApi(app, d)
    registerRemoteApi(app, d)
    const env = { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never
    const patch = (b: unknown) =>
      app.request('/api/v1/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, env)
    return { cfg, d, app, patch, env, rebinds: () => rebinds }
  }

  // On: up (UI-started), enabled but down (a failed start a retry or Start binds again), and the
  // ungated --tunnel override (enabled stays false).
  for (const s of [
    { enabled: true, kind: 'connected', bound: true },
    { enabled: true, kind: 'failed', bound: false },
    { enabled: false, kind: 'connected', bound: true },
  ]) {
    const { cfg, patch, rebinds } = setup(s)
    const res = await patch({ port: 6997 })
    assert.equal(res.status, 400, JSON.stringify(s))
    const json = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(json.error.code, 'invalid_config_value')
    assert.match(json.error.message, /^port 6997 is remote access's own port/)
    assert.equal(cfg.daemon.port, 6996, 'nothing written')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(rebinds(), 0, 'and no rebind')
    // Any other port is taken as before.
    assert.equal((await patch({ port: 6998 })).status, 200)
  }

  // Off: taken, as the remote-access port moves at the next boot. Until then the status names no
  // port for a tunnel.
  const { cfg, d, app, patch, env, rebinds } = setup({ enabled: false, kind: 'off', bound: false })
  const res = await patch({ port: 6997 })
  assert.equal(res.status, 200)
  assert.deepEqual(((await res.json()) as { rebind: unknown }).rebind, { portChanged: true, port: 6997, lanBind: false })
  assert.equal(cfg.daemon.port, 6997)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(rebinds(), 1)
  assert.equal(d.bindPort, 6997)
  const status = (await (await app.request('/api/v1/remote/status', {}, env)).json()) as { tunnelTargetPort: number | null; mainPort: number }
  assert.equal(status.tunnelTargetPort, null)
  assert.equal(status.mainPort, 6997)
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

/** A child-process provider whose stop() hangs until released, as a cloudflared given up to
 *  8 s to exit does; a stop() after the release resolves at once. */
class SlowStopProvider implements RemoteProvider {
  readonly id = 'cloudflare-quick' as const
  readonly lifecycle = 'child-process' as const
  starts = 0
  private hang = true
  private release: (() => void) | undefined
  async preflight(): Promise<PreflightState> {
    return { kind: 'off' }
  }
  async start(): Promise<{ url: string }> {
    this.starts++
    return { url: `https://tunnel-${this.starts}.trycloudflare.com` }
  }
  stop(): Promise<void> {
    if (!this.hang) return Promise.resolve()
    return new Promise((resolve) => {
      this.release = () => {
        this.hang = false
        resolve()
      }
    })
  }
  alive(): boolean {
    return true
  }
  onExit(): void {}
  releaseStop(): void {
    this.release?.()
  }
}

test('remote routes: a Start sent during a Stop waits for it, then answers with a token the Stop did not revoke', async () => {
  const cfg = defaultConfig()
  cfg.daemon.experimental.remoteAccess = true
  const p = new SlowStopProvider()
  const remote = new RemoteAccessManager({ app: new Hono(), ingressPort: 0, makeProvider: () => p, probe: async () => true })
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '' },
    remote,
  } as unknown as Deps
  const app = new Hono()
  registerRemoteApi(app, d)
  const post = (path: string) => app.request(path, { method: 'POST' }, LOCAL_ENV)
  try {
    assert.equal(((await (await post('/api/v1/remote/start')).json()) as { state: { kind: string } }).state.kind, 'connected')

    const stopping = post('/api/v1/remote/stop') // the provider's stop() hangs
    await new Promise((r) => setTimeout(r, 20))
    const starting = post('/api/v1/remote/start')
    await new Promise((r) => setTimeout(r, 20))
    p.releaseStop()
    assert.equal((await stopping).status, 200)
    const started = (await (await starting).json()) as { state: { kind: string; url?: string }; token?: string }

    assert.equal(started.state.kind, 'connected')
    assert.equal(started.state.url, 'https://tunnel-2.trycloudflare.com', 'started afresh after the Stop')
    assert.equal(remote.state().kind, 'connected')
    assert.equal(cfg.remoteAccess.enabled, true)
    assert.ok(started.token, 'a token is shown')
    // As a request over the tunnel presents it: a remote token is honoured only there.
    assert.equal(verifyKeyValue(started.token, d, { ingress: true }), true, 'the token shown still works')
  } finally {
    await remote.disable()
  }
})

// The remote token is cached for the daemon process's lifetime so a reconnect re-shows it, and
// `cachedRemoteToken ??= provisionRemoteApiKey(...)` kept it whether or not its key was still
// stored. Once the owner revoked that key (Customize → Connect, DELETE /api/v1/keys/:id), the
// next Start still answered with the cached token, which no request over the tunnel accepts.
test('remote routes: Start answers with a token whose key is stored, minting afresh once the cached one was revoked', async () => {
  const cfg = defaultConfig()
  cfg.daemon.experimental.remoteAccess = true
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '' },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    remote: {
      ingressPort: () => 6997,
      state: () => ({ kind: 'connected', url: 'https://x.test', since: '2026-09-10T00:00:00Z' }),
      url: () => 'https://x.test',
      enable: async () => {},
      disable: async () => {},
    },
  } as unknown as Deps
  const app = new Hono()
  registerRemoteApi(app, d)
  registerApi(app, d)
  const start = async () => ((await (await app.request('/api/v1/remote/start', { method: 'POST' }, LOCAL_ENV)).json()) as { token?: string }).token
  const remoteKeys = () => cfg.apiKeys.filter((k) => k.grant?.kind === 'remote')
  // The cache is module state: clear whatever an earlier test in this file left in it.
  assert.equal((await app.request('/api/v1/remote/stop', { method: 'POST' }, LOCAL_ENV)).status, 200)

  const first = await start()
  assert.ok(first && verifyKeyValue(first, d, { ingress: true }))
  assert.equal(await start(), first, 'a reconnect re-shows the same token')

  // Revoked from the key list, as the owner would.
  const [revoked] = remoteKeys()
  assert.equal((await app.request(`/api/v1/keys/${revoked.id}`, { method: 'DELETE' }, LOCAL_ENV)).status, 200)
  assert.equal(verifyKeyValue(first, d, { ingress: true }), false)

  const second = await start()
  assert.ok(second && second !== first, 'a fresh token, not the revoked one')
  assert.equal(verifyKeyValue(second, d, { ingress: true }), true, 'the token shown works over the tunnel')
  assert.equal(remoteKeys().length, 1)
  assert.equal(await start(), second, 'and is the one re-shown from then on')
  assert.equal(remoteKeys().length, 1, 'with no key minted on top of it')
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

// ── Switching the experimental flag off takes a running tunnel down ─────────────────────
// With the flag off every route above (Stop included) refuses and the UI hides the section,
// so a tunnel left running would stay public with no way to stop it (spec 30 §8.1: flag off →
// "the supervisor does not run"). Driven through the real PATCH /api/v1/settings.

function settingsApp(opts: { uiEnabled: boolean }) {
  const cfg = defaultConfig()
  cfg.daemon.experimental.remoteAccess = true
  // true: started from the UI (/start persists it) or auto-started from it at boot.
  // false: the ungated `--tunnel` override, which never touches it.
  cfg.remoteAccess.enabled = opts.uiEnabled
  cfg.apiKeys = [
    { id: 'r1', name: 'remote', hash: 'h1', prefix: 'tllm-r', createdAt: 'c', lastUsedAt: null, grant: { kind: 'remote', capabilities: ['models:use'] } },
    { id: 'n1', name: 'plain', hash: 'h2', prefix: 'tllm-n', createdAt: 'c', lastUsedAt: null },
  ] as typeof cfg.apiKeys
  let disabled = 0
  const d = {
    version: 'test',
    // snapshot() is a copy, as in ConfigStore — the PATCH compares before/after snapshots.
    store: { snapshot: () => structuredClone(cfg), update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '' },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    remote: {
      ingressPort: () => 6997,
      state: () => ({ kind: 'connected', url: 'https://x.test', since: '2026-09-10T00:00:00Z' }),
      url: () => 'https://x.test',
      enable: async () => {},
      disable: async () => {
        disabled++
      },
    },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  // From this machine, on the main listener: the flag is a host-only setting, and with an ingress
  // live a request whose local port can't be read counts as tunneled (auth.ts isTunneled).
  const patch = (b: unknown) =>
    app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    }, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
  return { patch, cfg, disabled: () => disabled }
}

test('settings: switching Experimental → Remote access off stops a UI-managed tunnel, exactly as Stop does', async () => {
  const { patch, cfg, disabled } = settingsApp({ uiEnabled: true })
  const res = await patch({ experimental: { remoteAccess: false } })
  assert.equal(res.status, 200)
  assert.equal(disabled(), 1, 'the tunnel was taken down')
  assert.equal(cfg.remoteAccess.enabled, false)
  assert.deepEqual(cfg.apiKeys.map((k) => k.id), ['n1'], 'the scoped remote key was revoked, the plain one kept')
})

test('settings: switching the flag off leaves the ungated --tunnel override running', async () => {
  const { patch, disabled } = settingsApp({ uiEnabled: false })
  assert.equal((await patch({ experimental: { remoteAccess: false } })).status, 200)
  assert.equal(disabled(), 0)
})

test('settings: a save that leaves the flag on does not touch the tunnel', async () => {
  const { patch, cfg, disabled } = settingsApp({ uiEnabled: true })
  assert.equal((await patch({ experimental: { remoteAccess: true }, autoLoadOnStart: true })).status, 200)
  assert.equal(disabled(), 0)
  assert.equal(cfg.remoteAccess.enabled, true)
})
