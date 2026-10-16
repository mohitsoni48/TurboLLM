// Host-side actions (a stdio MCP server, a build) through the REAL createApp, for the callers
// lanAuth lets in with no key: a Tailscale Serve identity and a verified Cloudflare Access JWT.
// isLocalOrAuthenticated used to read `requireApiKey: true` as "lanAuth has verified a key", so
// either identity could add an MCP server (a command the daemon spawns) or start a build, while
// hostGate refused it a key and codeAuth refused it Code. Drives createApp because what matters
// is lanAuth and the route gates together.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createApp } from './server'
import { hashKey } from './auth'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import { tmpDir } from './test-support/tmp'

const INGRESS_PORT = 6997
const SERVE_HOST = 'box.tail1234.ts.net'
const RAW_KEY = 'tllm-hostactionshostactionshostactionsho1'

function mkDeps(mutate: (cfg: Config) => void = () => {}): { d: Deps; cfg: Config } {
  const cfg = defaultConfig()
  cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
  mutate(cfg)
  const dir = tmpDir('host-actions-')
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg), dir: () => dir },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null },
    registry: { list: () => ({ engines: [] }), active: () => undefined, customSources: () => [] },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => cfg.remoteAccess.provider,
      url: () => `https://${SERVE_HOST}`,
      state: () => ({ kind: 'connected' }),
    },
  } as unknown as Deps
  return { d, cfg }
}

/** A request on the remote-access ingress socket: a tunnel's local leg, loopback by construction. */
function tunneled(d: Deps, path: string, headers: Record<string, string>, body: unknown) {
  return createApp(d).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  }, { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

/** A request on the main listener from another machine on the LAN. */
function fromLan(d: Deps, path: string, headers: Record<string, string>, body: unknown) {
  return createApp(d).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: '192.168.1.20:6996', ...headers },
    body: JSON.stringify(body),
  }, { incoming: { socket: { localPort: 6996, remoteAddress: '192.168.1.50', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

const STDIO = { name: 'x', transport: 'stdio', command: 'sh', args: ['-c', 'id'], enabled: false }

test('a keyless Tailscale Serve identity cannot add an MCP server or start a build; with a key it can', async () => {
  const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
  assert.equal(cfg.daemon.requireApiKey, true, 'the shipped default the hole depended on')
  const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }

  const mcp = await tunneled(d, '/api/v1/mcp/servers', serve, STDIO)
  assert.equal(mcp.status, 403)
  assert.equal(cfg.mcp.servers.length, 0, 'nothing may be stored')
  assert.equal((await tunneled(d, '/api/v1/build/run', serve, {})).status, 403)
  // The identity still passes lanAuth: an ordinary route behind it is reached.
  assert.equal((await createApp(d).request('/api/v1/skills', { headers: serve }, {
    incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
  } as never)).status, 200)

  const keyed = { ...serve, 'X-TurboLLM-Auth': RAW_KEY }
  assert.equal((await tunneled(d, '/api/v1/mcp/servers', keyed, STDIO)).status, 201)
  assert.equal(cfg.mcp.servers.length, 1)
  // Past the gate: refused only for its missing repo URL, nothing started.
  assert.equal((await tunneled(d, '/api/v1/build/run', keyed, {})).status, 400)
})

// Same RS256 machinery as auth.lanauth-composed.test.ts: a correctly signed assertion whose JWKS a
// stubbed fetch serves, so lanAuth's Access block really verifies it.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWKS = JSON.stringify({ keys: [{ ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256' }] })
function accessJwt(teamDomain: string, aud: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
  const body = b64({ iss: teamDomain, aud: [aud], exp: now + 600, iat: now - 10, sub: randomUUID(), email: 'sam@example.com' })
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`
}

test('a verified Cloudflare Access JWT with no key cannot add an MCP server or start a build', async () => {
  const teamDomain = 'https://host-actions.cloudflareaccess.com'
  const real = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
  try {
    const { d, cfg } = mkDeps((c) => {
      c.remoteAccess.provider = 'cloudflare-named'
      c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
      c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
    })
    const access = { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }
    assert.equal((await tunneled(d, '/api/v1/mcp/servers', access, STDIO)).status, 403)
    assert.equal(cfg.mcp.servers.length, 0)
    assert.equal((await tunneled(d, '/api/v1/build/run', access, {})).status, 403)
    assert.equal((await tunneled(d, '/api/v1/mcp/servers', { ...access, Authorization: `Bearer ${RAW_KEY}` }, STDIO)).status, 201)
  } finally {
    globalThis.fetch = real
  }
})

test('a LAN caller with a valid key may add an MCP server even with requireApiKey off; without one it may not', async () => {
  const { d, cfg } = mkDeps((c) => {
    c.daemon.lanBind = true
    c.daemon.requireApiKey = false
  })
  assert.equal((await fromLan(d, '/api/v1/mcp/servers', {}, STDIO)).status, 403)
  assert.equal((await fromLan(d, '/api/v1/mcp/servers', { 'X-TurboLLM-Auth': RAW_KEY }, STDIO)).status, 201)
  assert.equal(cfg.mcp.servers.length, 1)
})
