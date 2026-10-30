// `GET /api/v1/status` says which server features are on (`serving`). The Android app quits the daemon when it is
// closed with nothing running, and reads a model loaded or work running from this route and /api/v1/activity; a daemon
// serving LAN clients, a remote-access URL or Turbo Link peers with no model loaded read as nothing running. Driven
// through the real routes: the listener's address as cli.ts records it on a bind, a real RemoteAccessManager with the
// real Tailscale provider (its CLI scripted, as manager.test.ts does), and link tokens minted and revoked through the
// real admin routes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { registerLinkAdminRoutes } from './link-admin-routes'
import { provisionRemoteApiKey } from '../auth'
import { RemoteAccessManager } from '../remote/manager'
import { TailscaleServeProvider, type RunTailscale } from '../remote/providers/tailscale'
import type { PreflightState, RemoteProvider } from '../remote/types'
import type { Deps } from '../deps'

type Serving = { lan: boolean; remote: boolean; linkPeers: number }

// Double mirrors status-fail-reason.test.ts's: the status route reads more of Manager/registry than this field does.
function app(deps?: Record<string, unknown>) {
  const cfg: Record<string, unknown> = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test', experimental: { turboLink: true } },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
  }
  const a = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '/nonexistent' },
    manager: {
      currentOpts: () => null,
      restartOpts: () => null,
      status: () => ({ state: 'stopped', err: null, port: null, pid: null, model: null }),
      launchCommand: () => undefined,
      parallelSlots: () => undefined,
      sessionStats: () => null,
      liveGeneration: () => null,
    },
    registry: { active: () => ({ id: 'eng-1', name: 'llama.cpp', kind: 'llama.cpp', binPath: '/opt/turbollm/engines/llama-server' }) },
    modelRouter: { aliveSlots: () => [], poolModelCount: () => 0 },
    scanner: { get: () => undefined },
    bench: { status: () => ({ state: 'idle' }) },
    downloads: { activeCount: () => 0 },
    provision: { get: () => undefined },
    build: { get: () => undefined },
    ...deps,
  } as unknown as Deps
  registerApi(a, d)
  registerLinkAdminRoutes(a, d)
  const serving = async () => ((await (await a.request('/api/v1/status')).json()) as { serving?: Serving }).serving
  return { a, d, cfg, serving }
}

test('GET /api/v1/status says serving.lan while the listener is bound beyond loopback', async () => {
  const h = app()
  const bind = (host: string) => { (h.d as { bindHost?: string }).bindHost = host } // as cli.ts's listen callback does
  bind('127.0.0.1')
  assert.deepEqual(await h.serving(), { lan: false, remote: false, linkPeers: 0 }, 'a loopback daemon serves nothing')
  // LAN access on: the rebind it runs binds 0.0.0.0.
  bind('0.0.0.0')
  assert.equal((await h.serving())?.lan, true)
  // Every interface over IPv6, and one LAN address (`--addr 192.168.1.5:…`), are beyond loopback too.
  bind('::')
  assert.equal((await h.serving())?.lan, true)
  bind('192.168.1.5')
  assert.equal((await h.serving())?.lan, true)
  // LAN access off again: the rebind back to loopback.
  bind('127.0.0.1')
  assert.equal((await h.serving())?.lan, false)
  bind('::1')
  assert.equal((await h.serving())?.lan, false)
  // The address really bound decides, not the setting: `--addr 127.0.0.1:…` wins over LAN access at boot.
  ;(h.cfg.daemon as { lanBind: boolean }).lanBind = true
  bind('127.0.0.1')
  assert.equal((await h.serving())?.lan, false)
})

/** A tunnel that will not come up (cloudflared exiting before it prints a URL). */
class FailingTunnel implements RemoteProvider {
  readonly id = 'cloudflare-quick' as const
  readonly lifecycle = 'child-process' as const
  async preflight(): Promise<PreflightState> { return { kind: 'off' } }
  async start(): Promise<{ url: string }> { throw new Error('cloudflared exited') }
  async stop(): Promise<void> {}
  alive(): boolean { return false }
}

/** A tunnel that comes up and then drops (cloudflared exiting under a live URL), as manager.test.ts's
 *  WatchableProvider does: its exit sends the manager into restart()'s backoff, 'reconnecting'. */
class DroppingTunnel implements RemoteProvider {
  readonly id = 'cloudflare-quick' as const
  readonly lifecycle = 'child-process' as const
  private exited: ((code: number | null) => void) | undefined
  async preflight(): Promise<PreflightState> { return { kind: 'off' } }
  async start(): Promise<{ url: string }> { return { url: 'https://dropping.trycloudflare.com' } }
  async stop(): Promise<void> {}
  alive(): boolean { return true }
  onExit(cb: (code: number | null) => void): void { this.exited = cb }
  drop(): void { this.exited?.(1) }
}

test('GET /api/v1/status says serving.remote while remote access is up or coming up, Tailscale Serve included', async (t) => {
  let loggedIn = true
  let openStatus: () => void = () => {}
  let statusGate: Promise<void> = Promise.resolve()
  const run: RunTailscale = async (args) => {
    if (args[0] === 'status') {
      await statusGate
      return { code: 0, stdout: JSON.stringify({ BackendState: loggedIn ? 'Running' : 'NeedsLogin', Self: { DNSName: 'phone.tail1234.ts.net.' } }), stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' } // `serve --bg …` and `serve … off`
  }
  let makeProvider: () => RemoteProvider = () => new TailscaleServeProvider({ port: 443 }, run)
  const ingressApp = new Hono()
  const remote = new RemoteAccessManager({ app: ingressApp, ingressPort: 0, makeProvider: () => makeProvider(), probe: async () => true })
  const h = app({ remote })
  try {
    assert.equal((await h.serving())?.remote, false, 'remote access off')
    // Tailscale Serve coming up: its preflight's `tailscale status` held.
    statusGate = new Promise<void>((r) => { openStatus = r })
    const up = remote.enable()
    assert.equal(remote.state().kind, 'starting')
    assert.equal((await h.serving())?.remote, true, 'starting')
    statusGate = Promise.resolve()
    openStatus()
    await up
    assert.equal(remote.state().kind, 'connected')
    assert.equal((await h.serving())?.remote, true, 'Tailscale Serve on')
    await remote.disable()
    assert.equal((await h.serving())?.remote, false, 'Stop: the serve reset, the ingress down')
    // Tailscale logged out: the preflight says so and nothing is bound.
    loggedIn = false
    await remote.enable()
    assert.equal(remote.state().kind, 'needs-setup')
    assert.equal((await h.serving())?.remote, false, 'needs-setup')
    // A tunnel that failed to start: its ingress is closed again.
    makeProvider = () => new FailingTunnel()
    await remote.enable()
    assert.equal(remote.state().kind, 'failed')
    assert.equal((await h.serving())?.remote, false, 'failed')
    // A tunnel that dropped: reconnecting, its URL on its way back, so the daemon still serves it. The backoff before
    // the reconnect is a mocked timer, never fired: a live one would outlive the test.
    const dropping = new DroppingTunnel()
    makeProvider = () => dropping
    await remote.enable()
    assert.equal(remote.state().kind, 'connected')
    assert.equal((await h.serving())?.remote, true, 'a tunnel up')
    t.mock.timers.enable({ apis: ['setTimeout'] })
    dropping.drop()
    assert.equal(remote.state().kind, 'reconnecting')
    assert.equal((await h.serving())?.remote, true, 'reconnecting')
    await remote.disable()
    assert.equal((await h.serving())?.remote, false, 'Stop while reconnecting')
  } finally {
    await remote.disable()
  }
  // No remote access wired at all.
  assert.equal((await app().serving())?.remote, false)
})

test('GET /api/v1/status counts the Turbo Link peers this daemon hosts in serving.linkPeers', async () => {
  const h = app()
  const mint = async (name: string) => {
    const res = await h.a.request('/api/v1/links/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, capabilities: ['models:use'] }) })
    assert.equal(res.status, 200)
    return ((await res.json()) as { keyId: string }).keyId
  }
  assert.equal((await h.serving())?.linkPeers, 0, 'no link minted')
  const laptop = await mint('laptop')
  assert.equal((await h.serving())?.linkPeers, 1)
  await mint('desktop')
  assert.equal((await h.serving())?.linkPeers, 2)
  // A mint stores no grant kind, which reads as 'link' (auth.ts grantKind); a grant that names 'link' counts the same.
  ;(h.cfg.apiKeys as unknown[]).push({ id: 'old', name: 'link:old', hash: 'h-old', prefix: 'tllm-old', createdAt: '', lastUsedAt: null, grant: { kind: 'link', capabilities: ['models:use'] } })
  assert.equal((await h.serving())?.linkPeers, 3)
  // Neither a remote-access token nor an ordinary key is a peer.
  provisionRemoteApiKey(h.d, { capabilities: ['models:use'] })
  ;(h.cfg.apiKeys as unknown[]).push({ id: 'plain', name: 'cli', hash: 'h-plain', prefix: 'tllm-plain', createdAt: '', lastUsedAt: null })
  assert.equal((await h.serving())?.linkPeers, 3)
  // Turbo Link switched off: the façade serves no peer, whatever tokens are kept for when it is back on.
  const experimental = (h.cfg.daemon as { experimental: { turboLink: boolean } }).experimental
  experimental.turboLink = false
  assert.equal((await h.serving())?.linkPeers, 0)
  experimental.turboLink = true
  assert.equal((await h.serving())?.linkPeers, 3)
  // Revoking an inbound link (the host panel's Revoke: DELETE /api/v1/keys/:id).
  assert.equal((await h.a.request(`/api/v1/keys/${laptop}`, { method: 'DELETE' })).status, 200)
  assert.equal((await h.serving())?.linkPeers, 2)
})
