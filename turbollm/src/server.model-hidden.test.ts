// Who may hide a model (PUT /api/v1/models/:key/hidden): exactly the callers that may change its load profile (PUT
// /api/v1/models/:key/profile), through the REAL createApp, since lanAuth and the route gates decide it together. A
// remote-access token needs models:load for both; a LAN peer without a key gets in only while "Require an API key" is
// off, as it does for the profile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server'
import { hashKey, provisionRemoteApiKey } from './auth'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import type { ModelEntry } from './models/scanner'

const INGRESS_PORT = 6997
const RAW_KEY = 'tllm-modelhiddenmodelhiddenmodelhiddenmo1'
const MODEL = { key: 'm1', name: 'm1', path: '/models/m1.gguf', dir: '/models', format: 'gguf' } as unknown as ModelEntry

function mkDeps(mutate: (cfg: Config) => void = () => {}): { d: Deps; cfg: Config } {
  const cfg = defaultConfig()
  cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
  mutate(cfg)
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    scanner: { get: (k: string) => (k === MODEL.key ? MODEL : undefined), list: () => ({ models: [MODEL], scanning: false, lastScanAt: '' }) },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null },
    registry: { list: () => ({ engines: [] }), active: () => undefined, customSources: () => [] },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => cfg.remoteAccess.provider,
      url: () => 'https://quick-tunnel.trycloudflare.com',
      state: () => ({ kind: 'connected' }),
    },
  } as unknown as Deps
  return { d, cfg }
}

type Socket = { localPort: number; remoteAddress: string }
const LOCAL: Socket = { localPort: 6996, remoteAddress: '127.0.0.1' }
const LAN: Socket = { localPort: 6996, remoteAddress: '192.168.1.50' }
const INGRESS: Socket = { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1' }

function put(d: Deps, path: string, body: unknown, socket: Socket, headers: Record<string, string>) {
  return createApp(d).request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

/** The profile PUT's status and the hidden PUT's for one caller, and whether the model ended up hidden. */
async function both(d: Deps, cfg: Config, socket: Socket, headers: Record<string, string>) {
  const profile = (await put(d, '/api/v1/models/m1/profile', { ctx: 4096 }, socket, headers)).status
  const hidden = (await put(d, '/api/v1/models/m1/hidden', { hidden: true }, socket, headers)).status
  return { profile, hidden, stored: cfg.hiddenModels.includes('m1') }
}

test('the host itself may hide a model, as it may change its profile', async () => {
  const { d, cfg } = mkDeps()
  assert.deepEqual(await both(d, cfg, LOCAL, { Host: '127.0.0.1:6996' }), { profile: 200, hidden: 200, stored: true })
})

test('a LAN peer without a key may not, while "Require an API key" is on; with the key it may', async () => {
  const lan = { Host: '192.168.1.20:6996' }
  {
    const { d, cfg } = mkDeps((c) => { c.daemon.lanBind = true })
    assert.deepEqual(await both(d, cfg, LAN, lan), { profile: 401, hidden: 401, stored: false })
  }
  {
    const { d, cfg } = mkDeps((c) => { c.daemon.lanBind = true })
    assert.deepEqual(await both(d, cfg, LAN, { ...lan, 'X-TurboLLM-Auth': RAW_KEY }), { profile: 200, hidden: 200, stored: true })
  }
})

test('on an open LAN ("Require an API key" off) a keyless peer may, as it may change the profile', async () => {
  const { d, cfg } = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
  assert.deepEqual(await both(d, cfg, LAN, { Host: '192.168.1.20:6996' }), { profile: 200, hidden: 200, stored: true })
})

test('a remote-access token needs models:load, as for the profile', async () => {
  const tunnel = { Host: 'quick-tunnel.trycloudflare.com' }
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'config:write'] })
    assert.deepEqual(await both(d, cfg, INGRESS, { ...tunnel, Authorization: `Bearer ${token}` }), { profile: 403, hidden: 403, stored: false })
  }
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load'] })
    assert.deepEqual(await both(d, cfg, INGRESS, { ...tunnel, Authorization: `Bearer ${token}` }), { profile: 200, hidden: 200, stored: true })
  }
})
