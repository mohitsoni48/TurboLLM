// An External Chat API tenant key (spec 27 §10: a key whose `tenant` is set and is not 'local',
// added to config.json by hand, and scoped by its `scopes`) is a credential for /api/ext/v1 and
// for nothing else. It carries no `grant`, and every internal check compared the hash and the
// grant alone, so a key scoped chats:read was a full owner key everywhere else: it minted
// permanent keys, added stdio MCP servers, read the settings, opened Code and its terminal, and
// got every Turbo Link capability. Drives the REAL createApp: what matters is lanAuth, the route
// gates and the façade's own gate together.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server'
import { hashKey, keyHashStillAccepted, verifyKeyValue } from './auth'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import { tmpDir } from './test-support/tmp'

const INGRESS_PORT = 6997
const TENANT_KEY = 'tllm-tenantkeytenantkeytenantkeytenant01'
const OWNER_KEY = 'tllm-ownerkeyownerkeyownerkeyownerkey0001'

function mkDeps(mutate: (cfg: Config) => void = () => {}): { d: Deps; cfg: Config } {
  const cfg = defaultConfig()
  cfg.daemon.lanBind = true
  cfg.daemon.experimental.turboLink = true
  cfg.api = { ext: { enabled: true } }
  cfg.apiKeys.push(
    { id: 't1', name: 'acme', hash: hashKey(TENANT_KEY), prefix: TENANT_KEY.slice(0, 12), createdAt: '', lastUsedAt: null, tenant: 'acme', scopes: ['chats:read'] },
    { id: 'k1', name: 'mine', hash: hashKey(OWNER_KEY), prefix: OWNER_KEY.slice(0, 12), createdAt: '', lastUsedAt: null },
  )
  mutate(cfg)
  const dir = tmpDir('tenant-key-')
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg), dir: () => dir },
    db: new Proxy({}, { get: () => () => [] }),
    chatStore: {
      capabilities: { search: false },
      listChats: async () => ({ data: [], hasMore: false, nextCursor: null }),
    },
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null },
    registry: { list: () => ({ engines: [] }), active: () => undefined, customSources: () => [] },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => 'cloudflare-quick',
      url: () => 'https://quick.trycloudflare.com',
      state: () => ({ kind: 'connected' }),
    },
  } as unknown as Deps
  return { d, cfg }
}

type Send = (path: string, key: string | null, method?: string, body?: unknown) => Response | Promise<Response>

/** A request on the main listener from another machine on the LAN. */
function fromLan(d: Deps): Send {
  return (path, key, method = 'GET', body) => createApp(d).request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Host: '192.168.1.20:6996', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { incoming: { socket: { localPort: 6996, remoteAddress: '192.168.1.50', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

/** A request on the remote-access ingress socket: a tunnel's local leg, loopback by construction. */
function tunneled(d: Deps): Send {
  return (path, key, method = 'GET', body) => createApp(d).request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Host: 'quick.trycloudflare.com', 'Sec-Fetch-Site': 'same-origin', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

const STDIO = { name: 'x', transport: 'stdio', command: 'sh', args: ['-c', 'id'], enabled: false }

/** The tenant key reaches the ext API (past its auth: the capabilities and its chats:read list)
 *  and is refused everywhere else, with nothing stored; an ordinary key is unchanged. */
async function assertExtOnly(send: Send, cfg: Config, link: boolean) {
  assert.equal((await send('/api/ext/v1/capabilities', TENANT_KEY)).status, 200)
  assert.equal((await send('/api/ext/v1/chats?owner=u1', TENANT_KEY)).status, 200)
  assert.equal((await send('/api/ext/v1/capabilities', null)).status, 401, 'the ext API still needs a key')

  const keys = cfg.apiKeys.length
  assert.equal((await send('/api/v1/keys', TENANT_KEY, 'POST', { name: 'minted' })).status, 401, 'POST /keys')
  assert.equal(cfg.apiKeys.length, keys, 'no key may be minted')
  assert.equal((await send('/api/v1/mcp/servers', TENANT_KEY, 'POST', STDIO)).status, 401, 'POST /mcp/servers')
  assert.equal(cfg.mcp.servers.length, 0, 'no MCP server may be added')
  assert.equal((await send('/api/v1/settings', TENANT_KEY)).status, 401, 'GET /settings')
  assert.equal((await send('/api/v1/code/sessions', TENANT_KEY)).status, 401, 'GET /code/sessions')
  assert.equal((await send('/v1/models', TENANT_KEY)).status, 401, 'GET /v1/models')
  if (link) assert.equal((await send('/api/link/v1/hello', TENANT_KEY, 'POST', {})).status, 401, 'POST /api/link/v1/hello')

  assert.equal((await send('/api/v1/settings', OWNER_KEY)).status, 200, 'an ordinary key is unchanged')
  assert.equal((await send('/api/v1/keys', OWNER_KEY, 'POST', { name: 'minted' })).status, 201)
}

test('an External Chat API tenant key works on /api/ext/v1 only, from the LAN', async () => {
  const { d, cfg } = mkDeps()
  assert.equal(cfg.daemon.requireApiKey, true, 'the shipped default')
  await assertExtOnly(fromLan(d), cfg, true)
})

test('an External Chat API tenant key works on /api/ext/v1 only, over remote access', async () => {
  const { d, cfg } = mkDeps((c) => { c.daemon.lanBind = false; c.daemon.experimental.turboLink = false })
  await assertExtOnly(tunneled(d), cfg, false)
})

test('on an open LAN a tenant key counts as no key for the host-side gates', async () => {
  const { d, cfg } = mkDeps((c) => { c.daemon.requireApiKey = false })
  const send = fromLan(d)
  // lanAuth admits every LAN caller here; the gates that need a real key must not take this one.
  assert.equal((await send('/api/v1/keys', TENANT_KEY, 'POST', { name: 'minted' })).status, 403, 'POST /keys (hostGate)')
  assert.equal((await send('/api/v1/mcp/servers', TENANT_KEY, 'POST', STDIO)).status, 403, 'POST /mcp/servers (isLocalOrAuthenticated)')
  assert.equal((await send('/api/v1/code/sessions', TENANT_KEY)).status, 401, 'GET /code/sessions (codeAuth)')
  assert.equal((await send('/api/link/v1/hello', TENANT_KEY, 'POST', {})).status, 401, 'POST /api/link/v1/hello (linkAuth)')
  assert.equal(cfg.mcp.servers.length, 0)
  assert.equal((await send('/api/ext/v1/capabilities', TENANT_KEY)).status, 200)
  assert.equal((await send('/api/v1/mcp/servers', OWNER_KEY, 'POST', STDIO)).status, 201)
})

test("a Code terminal opened on a tenant key would not be kept open: the key check refuses it", () => {
  const { d } = mkDeps()
  assert.equal(verifyKeyValue(TENANT_KEY, d), false)
  assert.equal(keyHashStillAccepted(hashKey(TENANT_KEY), d), false)
  assert.equal(verifyKeyValue(OWNER_KEY, d), true)
  assert.equal(keyHashStillAccepted(hashKey(OWNER_KEY), d), true)
  // A key whose tenant is spelled 'local' is the install's own, as the ext API reads it.
  const { d: local, cfg } = mkDeps()
  cfg.apiKeys[0].tenant = 'local'
  assert.equal(verifyKeyValue(TENANT_KEY, local), true)
})
