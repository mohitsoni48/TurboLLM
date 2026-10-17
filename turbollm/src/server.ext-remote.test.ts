// The External Chat API (spec 27) called by a backend on the daemon's own machine, on the LAN or
// through remote access, through the REAL createApp: what matters is lanAuth in front of the ext
// routes, which judges each request by the socket it arrived on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server'
import { hashKey } from './auth'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import { ConversationStore } from './chat/db'
import { ChatStoreRouter } from './chat/store/router'
import { EXT_ERROR_TYPES } from './ext/errors'
import { buildOpenApiDocument } from './ext/openapi'
import { tmpDir } from './test-support/tmp'

const INGRESS_PORT = 6997
const TENANT_KEY = 'tllm-tenantkeytenantkeytenantkeytenant01'

function mkDeps(mutate: (cfg: Config) => void = () => {}, provider = 'cloudflare-quick'): { d: Deps; cfg: Config; conv: ConversationStore } {
  const cfg = defaultConfig()
  cfg.daemon.lanBind = true
  cfg.api = { ext: { enabled: true } }
  cfg.apiKeys.push({
    id: 't1', name: 'acme', hash: hashKey(TENANT_KEY), prefix: TENANT_KEY.slice(0, 12), createdAt: '', lastUsedAt: null,
    tenant: 'acme', scopes: ['chats:read', 'chats:write', 'runs:write'],
  })
  mutate(cfg)
  const dir = tmpDir('ext-remote-')
  const conv = new ConversationStore(dir)
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg), dir: () => dir },
    db: conv,
    chatStore: new ChatStoreRouter(conv.chatStore, conv.chatStore),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null },
    registry: { list: () => ({ engines: [] }), active: () => undefined, customSources: () => [] },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => provider,
      url: () => 'https://chat.example.com',
      state: () => ({ kind: 'connected' }),
    },
  } as unknown as Deps
  return { d, cfg, conv }
}

/** A named tunnel whose Cloudflare Access login is the only way in through the tunnel. */
function accessRequired(cfg: Config) {
  cfg.remoteAccess.provider = 'cloudflare-named'
  cfg.remoteAccess.cloudflare.accessTeamDomain = 'team.cloudflareaccess.com'
  cfg.remoteAccess.cloudflare.accessAud = 'aud-1'
  cfg.remoteAccess.cloudflare.requireAccess = true
}

type Send = (path: string, key: string | null, method?: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>

function sender(app: ReturnType<typeof createApp>, host: string, localPort: number, remoteAddress: string): Send {
  return (path, key, method = 'GET', body, headers = {}) => app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Host: host, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { incoming: { socket: { localPort, remoteAddress, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

/** A request on the main listener from a process on the daemon's own machine. */
const fromHost = (app: ReturnType<typeof createApp>) => sender(app, '127.0.0.1:6996', 6996, '127.0.0.1')
/** A request on the main listener from another machine on the LAN. */
const fromLan = (app: ReturnType<typeof createApp>) => sender(app, '192.168.1.20:6996', 6996, '192.168.1.50')
/** A request on the remote-access ingress socket: a tunnel's local leg, loopback by construction. */
const tunneled = (app: ReturnType<typeof createApp>) => sender(app, 'chat.example.com', INGRESS_PORT, '127.0.0.1')

test('POST /chats/:id/messages that generates answers a same-machine or LAN backend as /messages/generate does while an Access-required tunnel is up', async () => {
  const seen: Record<string, string> = {}
  for (const [provider, mutate] of [['cloudflare-named', accessRequired], ['cloudflare-quick', () => {}]] as const) {
    const { d, conv } = mkDeps(mutate, provider)
    const app = createApp(d)
    try {
      for (const [who, send] of [['same machine', fromHost(app)], ['LAN', fromLan(app)]] as const) {
        // No such chat: each route reaches its handler and the chat store, and answers 404.
        const generate = await send('/api/ext/v1/chats/c1/messages/generate', TENANT_KEY, 'POST', { content: 'hi', owner: 'u1' })
        const append = await send('/api/ext/v1/chats/c1/messages', TENANT_KEY, 'POST', { content: 'hi', owner: 'u1', generate: false })
        // The default forwards to /messages/generate inside the daemon. That forward is judged by
        // the caller's own socket, not as a request with none (which reads as tunneled while
        // remote access is up, and then needs an Access login no backend here has).
        const forwarded = await send('/api/ext/v1/chats/c1/messages', TENANT_KEY, 'POST', { content: 'hi', owner: 'u1' })
        const answer = async (r: Response) => `${r.status} ${((await r.json()) as { error?: { type?: string } }).error?.type}`
        seen[`${provider}, ${who}`] = `generate ${await answer(generate)}, append ${await answer(append)}, default ${await answer(forwarded)}`
      }
    } finally {
      conv.close()
    }
  }
  const same = 'generate 404 not_found, append 404 not_found, default 404 not_found'
  assert.deepEqual(seen, {
    'cloudflare-named, same machine': same,
    'cloudflare-named, LAN': same,
    'cloudflare-quick, same machine': same,
    'cloudflare-quick, LAN': same,
  })
})

test('the forward from POST /chats/:id/messages names the chat it was sent for, not another route', async () => {
  const { d, conv } = mkDeps()
  const app = createApp(d)
  const send = fromHost(app)
  try {
    // ':id' arrives decoded, so '..%2Fchats%3F' is '../chats?' and, put back into the forward's
    // URL as it is, made the forward POST /api/ext/v1/chats and create a chat.
    const res = await send('/api/ext/v1/chats/..%2Fchats%3F/messages', TENANT_KEY, 'POST', { content: 'hi', owner: 'u1', title: 'made by the forward' })
    assert.equal(res.status, 404)
    const list = await send('/api/ext/v1/chats?owner=u1', TENANT_KEY)
    assert.equal(list.status, 200)
    assert.deepEqual(((await list.json()) as { data: unknown[] }).data, [], 'no chat may be created')
    const audit = await send('/api/ext/v1/audit?owner=u1', TENANT_KEY)
    const rows = ((await audit.json()) as { data: { action: string; target_id: string | null }[] }).data
    // The request and its forward, each naming the chat id it was sent for.
    assert.deepEqual(rows.map((r) => `${r.action} ${r.target_id}`).sort(), ['message.create ../chats?', 'run.start ../chats?'])
  } finally {
    conv.close()
  }
})

/** What an integrator reads off a refusal: the fields the OpenAPI document's Error schema
 *  requires that the body lacks, then the ones it switches on. */
async function envelope(res: Response | Promise<Response>): Promise<string> {
  const r = await res
  const doc = buildOpenApiDocument('test')
  const required = (doc.components.schemas.Error as { properties: { error: { required: string[] } } }).properties.error.required
  const err = ((await r.json()) as { error: Record<string, unknown> }).error
  const missing = required.filter((f) => !(f in err))
  const type = EXT_ERROR_TYPES.includes(err.type as never) ? err.type : `not a type: ${String(err.type)}`
  const id = typeof err.request_id === 'string' && err.request_id.startsWith('req_') ? 'request_id' : 'no request_id'
  return `${r.status} missing [${missing.join(' ')}] ${type} ${err.code} ${id} retryable ${err.retryable}`
}

test('lanAuth refuses an /api/ext/v1 request from the LAN or a tunnel with the documented error envelope', async () => {
  const REVOKED = 'tllm-revokedrevokedrevokedrevokedrevoked1'
  const evil = { Origin: 'https://evil.example' }
  const seen: Record<string, string> = {}
  const { d, conv } = mkDeps()
  try {
    const app = createApp(d)
    const lan = fromLan(app)
    const tunnel = tunneled(app)
    // The same refusal from the ext API's own gate (extAuth), which a same-machine caller reaches.
    seen['same machine, no key'] = await envelope(fromHost(app)('/api/ext/v1/capabilities', null))
    seen['LAN, no key'] = await envelope(lan('/api/ext/v1/capabilities', null))
    seen['LAN, revoked key'] = await envelope(lan('/api/ext/v1/chats?owner=u1', REVOKED))
    seen['LAN, cross-site'] = await envelope(lan('/api/ext/v1/chats', TENANT_KEY, 'POST', { owner: 'u1' }, evil))
    seen['tunnel, no key'] = await envelope(tunnel('/api/ext/v1/capabilities', null))
    seen['tunnel, revoked key'] = await envelope(tunnel('/api/ext/v1/chats?owner=u1', REVOKED))
    // A caller's own X-Request-Id names the refusal and comes back in the header, from every side.
    for (const [who, send] of [['same machine', fromHost(app)], ['LAN', lan], ['tunnel', tunnel]] as const) {
      const r = await send('/api/ext/v1/capabilities', null, 'GET', undefined, { 'X-Request-Id': 'trace-1' })
      seen[`${who}, own request id`] = `${r.status} ${r.headers.get('X-Request-Id')} ${((await r.json()) as { error: { request_id?: string } }).error.request_id}`
    }
    assert.deepEqual(await conv.chatStore.listChats({ tenant: 'acme', owner: 'u1' }, {}).then((p) => p.data), [], 'the cross-site POST created nothing')
  } finally {
    conv.close()
  }
  const named = mkDeps(accessRequired, 'cloudflare-named')
  try {
    seen['Access required, no login'] = await envelope(tunneled(createApp(named.d))('/api/ext/v1/capabilities', TENANT_KEY))
  } finally {
    named.conv.close()
  }
  const key = '401 missing [] auth unauthorized request_id retryable false'
  assert.deepEqual(seen, {
    'same machine, no key': key,
    'LAN, no key': key,
    'LAN, revoked key': key,
    'LAN, cross-site': '403 missing [] auth forbidden request_id retryable false',
    'tunnel, no key': key,
    'tunnel, revoked key': key,
    'same machine, own request id': '401 trace-1 trace-1',
    'LAN, own request id': '401 trace-1 trace-1',
    'tunnel, own request id': '401 trace-1 trace-1',
    'Access required, no login': key,
  })
})

test('lanAuth keeps its own error shape outside /api/ext/v1', async () => {
  const { d, conv } = mkDeps()
  const named = mkDeps(accessRequired, 'cloudflare-named')
  try {
    const lan = fromLan(createApp(d))
    const body = async (res: Response | Promise<Response>) => [(await res).status, await (await res).json()]
    assert.deepEqual(await body(lan('/api/v1/settings', null)),
      [401, { error: { code: 'unauthorized', message: 'A valid API key is required for non-local access.' } }])
    assert.deepEqual(await body(lan('/api/v1/keys', TENANT_KEY, 'POST', { name: 'x' }, { Origin: 'https://evil.example' })),
      [403, { error: { code: 'forbidden', message: "Cross-site request refused. Behind a reverse proxy, have it pass the browser's Host header through." } }])
    assert.deepEqual(await body(tunneled(createApp(named.d))('/api/v1/settings', null)),
      [401, { error: { code: 'unauthorized', message: 'Cloudflare Access sign-in is required.' } }])
  } finally {
    conv.close()
    named.conv.close()
  }
})
