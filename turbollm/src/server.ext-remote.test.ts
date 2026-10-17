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

type Send = (path: string, key: string | null, method?: string, body?: unknown) => Response | Promise<Response>

/** A request on the main listener from a process on the daemon's own machine. */
function fromHost(app: ReturnType<typeof createApp>): Send {
  return (path, key, method = 'GET', body) => app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:6996', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

/** A request on the main listener from another machine on the LAN. */
function fromLan(app: ReturnType<typeof createApp>): Send {
  return (path, key, method = 'GET', body) => app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Host: '192.168.1.20:6996', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { incoming: { socket: { localPort: 6996, remoteAddress: '192.168.1.50', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

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
