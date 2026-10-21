// Who may pause a download (POST /api/v1/downloads/:id/pause): exactly the callers that may cancel
// or resume one, through the REAL createApp, since lanAuth and the route gates decide it together.
// A remote-access token needs downloads:write; a LAN peer without a key gets in only while
// "Require an API key" is off. And what POST /api/v1/downloads tells a token that may write
// downloads but not list them about a download already holding the file it asks for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server'
import { hashKey, provisionRemoteApiKey } from './auth'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import type { LinkCapability } from './link/types'

const INGRESS_PORT = 6997
const RAW_KEY = 'tllm-downloadpausedownloadpausedownloadp1'

/** Deps with a downloads stand-in that records each verb it was asked to carry out. */
function mkDeps(mutate: (cfg: Config) => void = () => {}): { d: Deps; done: string[] } {
  const cfg = defaultConfig()
  cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
  mutate(cfg)
  const done: string[] = []
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null },
    registry: { list: () => ({ engines: [] }), active: () => undefined, customSources: () => [] },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => cfg.remoteAccess.provider,
      url: () => 'https://quick-tunnel.trycloudflare.com',
      state: () => ({ kind: 'connected' }),
    },
    downloads: {
      pause: () => { done.push('pause'); return true },
      cancel: () => { done.push('cancel'); return true },
      resume: () => { done.push('resume'); return true },
      // Every file asked for is already held by HELD, paused.
      enqueue: async (_input: unknown, held: unknown[]) => { held.push(HELD); return [] },
      list: () => [HELD],
    },
  } as unknown as Deps
  return { d, done }
}

/** A paused download as the host holds it: its path on the host, where it came from, how far. */
const HELD = {
  id: 'dl-held', name: 'm.gguf', repo: 'owner/repo', url: 'https://huggingface.co/owner/repo/resolve/main/m.gguf',
  dest: '/home/owner/models/m.gguf', total: 100, received: 40, status: 'paused', error: null, bytesPerSec: 0,
  validator: '"v1"', createdAt: '2026-10-21T00:00:00.000Z',
}

type Socket = { localPort: number; remoteAddress: string }
const LOCAL: Socket = { localPort: 6996, remoteAddress: '127.0.0.1' }
const LAN: Socket = { localPort: 6996, remoteAddress: '192.168.1.50' }
const INGRESS: Socket = { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1' }

function post(d: Deps, path: string, socket: Socket, headers: Record<string, string>, body = '{}') {
  return createApp(d).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  }, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

function get(d: Deps, path: string, socket: Socket, headers: Record<string, string>) {
  return createApp(d).request(path, { headers }, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

/** Each verb's status for one caller, and which verbs reached the download manager. */
async function verbs(socket: Socket, headers: Record<string, string>, mutate?: (cfg: Config) => void, token?: LinkCapability[]) {
  const { d, done } = mkDeps(mutate)
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${provisionRemoteApiKey(d, { kind: 'remote', capabilities: token })}` } : {}
  const status: Record<string, number> = {}
  for (const v of ['pause', 'cancel', 'resume']) status[v] = (await post(d, `/api/v1/downloads/dl-1/${v}`, socket, { ...headers, ...auth })).status
  return { status, done }
}

const ALL = ['pause', 'cancel', 'resume']

test('the host itself may pause a download, as it may cancel or resume one', async () => {
  assert.deepEqual(await verbs(LOCAL, { Host: '127.0.0.1:6996' }), { status: { pause: 200, cancel: 200, resume: 200 }, done: ALL })
})

test('a LAN peer without a key may not, while "Require an API key" is on; with the key it may', async () => {
  const lan = { Host: '192.168.1.20:6996' }
  const on = (c: Config) => { c.daemon.lanBind = true }
  assert.deepEqual(await verbs(LAN, lan, on), { status: { pause: 401, cancel: 401, resume: 401 }, done: [] })
  assert.deepEqual(await verbs(LAN, { ...lan, 'X-TurboLLM-Auth': RAW_KEY }, on), { status: { pause: 200, cancel: 200, resume: 200 }, done: ALL })
  const open = (c: Config) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false }
  assert.deepEqual(await verbs(LAN, lan, open), { status: { pause: 200, cancel: 200, resume: 200 }, done: ALL })
})

test('a remote-access token needs downloads:write, as for cancel and resume', async () => {
  const tunnel = { Host: 'quick-tunnel.trycloudflare.com' }
  const quick = (c: Config) => { c.remoteAccess.provider = 'cloudflare-quick' }
  assert.deepEqual(
    await verbs(INGRESS, tunnel, quick, ['models:use', 'downloads:read']),
    { status: { pause: 403, cancel: 403, resume: 403 }, done: [] },
  )
  assert.deepEqual(
    await verbs(INGRESS, tunnel, quick, ['models:use', 'downloads:write']),
    { status: { pause: 200, cancel: 200, resume: 200 }, done: ALL },
  )
})

// A file a live row already holds gets no second row; the answer names that row in `existing`, so
// the web can follow it or resume it. It carried the whole row, to a remote token with
// downloads:write and not downloads:read as well, which GET /api/v1/downloads refuses: the host's
// path for the file, the URL it came from and its progress. Now its id, name and status, for
// every caller, which is all following or resuming it takes.
test('POST /downloads names a download already holding the file by id, name and status only, also to a token refused the list', async () => {
  const tunnel = { Host: 'quick-tunnel.trycloudflare.com' }
  const { d } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
  const token = { Authorization: `Bearer ${provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'downloads:write'] })}` }
  const ask = JSON.stringify({ repo: 'owner/repo', rfilename: 'm.gguf' })
  const answer = { downloads: [], existing: [{ id: 'dl-held', name: 'm.gguf', status: 'paused' }] }

  assert.equal((await get(d, '/api/v1/downloads', INGRESS, { ...tunnel, ...token })).status, 403)
  const remote = await post(d, '/api/v1/downloads', INGRESS, { ...tunnel, ...token }, ask)
  assert.equal(remote.status, 202)
  assert.deepEqual(await remote.json(), answer)

  const host = await post(d, '/api/v1/downloads', LOCAL, { Host: '127.0.0.1:6996' }, ask)
  assert.equal(host.status, 202)
  assert.deepEqual(await host.json(), answer, 'the host lists its downloads with GET; this answer is the same')
})
