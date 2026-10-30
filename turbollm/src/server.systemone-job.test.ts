// Who may start, read and cancel the text classification playground's run (/api/v1/jev/playground/run): exactly the
// callers that may post /v1/systemone, through the REAL createApp, since lanAuth and the capability map decide it
// together. GET reads the last answer, whoever asked it, so it is held to the same bar as asking: a caller that may not
// ask gets no answer either. Each request here is one the route refuses or answers before any model is touched (an
// invalid body, a read, a cancel with nothing running), so a status other than 401/403 means the caller was let in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server'
import { hashKey, provisionRemoteApiKey } from './auth'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'

const INGRESS_PORT = 6997
const RAW_KEY = 'tllm-systemonejobsystemonejobsystemonejob1'
const RUN = '/api/v1/jev/playground/run'

function mkDeps(mutate: (cfg: Config) => void = () => {}): Deps {
  const cfg = defaultConfig()
  cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
  mutate(cfg)
  return {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    scanner: { get: () => undefined, list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null },
    registry: { list: () => ({ engines: [] }), active: () => undefined, customSources: () => [] },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => cfg.remoteAccess.provider,
      url: () => 'https://quick-tunnel.trycloudflare.com',
      state: () => ({ kind: 'connected' }),
    },
  } as unknown as Deps
}

type Socket = { localPort: number; remoteAddress: string }
const LOCAL: Socket = { localPort: 6996, remoteAddress: '127.0.0.1' }
const LAN: Socket = { localPort: 6996, remoteAddress: '192.168.1.50' }
const INGRESS: Socket = { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1' }

async function status(d: Deps, method: string, path: string, socket: Socket, headers: Record<string, string>): Promise<number> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...headers } }
  if (method === 'POST') init.body = '{}' // refused 422 by both routes' body check, before any model is resolved
  const res = await createApp(d).request(path, init, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
  return res.status
}

/** /v1/systemone's status for one caller, and the job route's for asking, reading and cancelling. */
async function all(d: Deps, socket: Socket, headers: Record<string, string>) {
  return {
    systemone: await status(d, 'POST', '/v1/systemone', socket, headers),
    start: await status(d, 'POST', RUN, socket, headers),
    read: await status(d, 'GET', RUN, socket, headers),
    cancel: await status(d, 'DELETE', RUN, socket, headers),
  }
}

const LET_IN = { systemone: 422, start: 422, read: 200, cancel: 200 }

test('the host itself may run, read and cancel, as it may post /v1/systemone', async () => {
  assert.deepEqual(await all(mkDeps(), LOCAL, { Host: '127.0.0.1:6996' }), LET_IN)
})

test('a LAN peer without a key may not, while "Require an API key" is on; with the key it may', async () => {
  const lan = { Host: '192.168.1.20:6996' }
  const d = mkDeps((c) => { c.daemon.lanBind = true })
  assert.deepEqual(await all(d, LAN, lan), { systemone: 401, start: 401, read: 401, cancel: 401 })
  assert.deepEqual(await all(d, LAN, { ...lan, 'X-TurboLLM-Auth': RAW_KEY }), LET_IN)
})

test('on an open LAN ("Require an API key" off) a keyless peer may, as it may post /v1/systemone', async () => {
  const d = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
  assert.deepEqual(await all(d, LAN, { Host: '192.168.1.20:6996' }), LET_IN)
})

test('a remote-access token needs models:use, as for /v1/systemone; one without it reads nothing', async () => {
  const tunnel = { Host: 'quick-tunnel.trycloudflare.com' }
  {
    const d = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['downloads:read'] })
    assert.deepEqual(await all(d, INGRESS, { ...tunnel, Authorization: `Bearer ${token}` }), { systemone: 403, start: 403, read: 403, cancel: 403 })
  }
  {
    const d = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
    assert.deepEqual(await all(d, INGRESS, { ...tunnel, Authorization: `Bearer ${token}` }), LET_IN)
  }
})
