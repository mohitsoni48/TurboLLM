// Host-side actions (a stdio MCP server, a build) through the REAL createApp, for the callers
// lanAuth lets in with no key: a Tailscale Serve identity and a verified Cloudflare Access JWT.
// isLocalOrAuthenticated used to read `requireApiKey: true` as "lanAuth has verified a key", so
// either identity could add an MCP server (a command the daemon spawns) or start a build, while
// hostGate refused it a key and codeAuth refused it Code. Drives createApp because what matters
// is lanAuth and the route gates together.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './server'
import { hashKey, provisionRemoteApiKey } from './auth'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import { availableBackends } from './engines/download'
import { BuildState } from './engines/build-state'
import { Scanner, type ModelEntry } from './models/scanner'
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
function tunneled(d: Deps, path: string, headers: Record<string, string>, body: unknown, method = 'POST') {
  return createApp(d).request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  }, { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

/** A request on the main listener from another machine on the LAN. */
function fromLan(d: Deps, path: string, headers: Record<string, string>, body: unknown, method = 'POST') {
  return createApp(d).request(path, {
    method,
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

// PUT /api/v1/engines/:id sets the repo a source-built engine came from (ADR-088). The update
// check then compares that repo's head with the build and offers Rebuild, whose one click (the
// owner's, on the host) clones and compiles it: a caller that may not start a build may not
// choose what the owner's next build compiles either. A rename stays open to them.
function withEngine(d: Deps): { engine: { id: string; name: string; sourceRepo?: string; sourceBranch?: string } } {
  const engine: { id: string; name: string; sourceRepo?: string; sourceBranch?: string } = { id: 'e1', name: 'llama' }
  Object.assign((d as unknown as { registry: Record<string, unknown> }).registry, {
    get: (id: string) => (id === engine.id ? { ...engine } : undefined),
    setSource: (_id: string, s: { sourceRepo?: string; sourceBranch?: string }) => {
      if (s.sourceRepo !== undefined) engine.sourceRepo = s.sourceRepo
      if (s.sourceBranch !== undefined) engine.sourceBranch = s.sourceBranch
      return { ...engine }
    },
    rename: (_id: string, name: string) => { engine.name = name; return { ...engine } },
  })
  return { engine }
}
const EVIL_SOURCE = { sourceRepo: 'https://github.com/evil/llama.cpp', sourceBranch: 'main' }

test("a keyless Serve identity, Access JWT or open-LAN peer cannot set an engine's source repo; a rename still works", async () => {
  // Tailscale Serve, no key.
  {
    const { d } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
    const { engine } = withEngine(d)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    const res = await tunneled(d, '/api/v1/engines/e1', serve, EVIL_SOURCE, 'PUT')
    assert.equal(res.status, 403)
    assert.equal(engine.sourceRepo, undefined, 'nothing may be stored')
    // Refused as a whole: a rename sent with it is not applied either.
    assert.equal((await tunneled(d, '/api/v1/engines/e1', serve, { name: 'x', ...EVIL_SOURCE }, 'PUT')).status, 403)
    assert.equal(engine.name, 'llama')
    assert.equal((await tunneled(d, '/api/v1/engines/e1', serve, { name: 'renamed' }, 'PUT')).status, 200)
    assert.equal(engine.name, 'renamed')
    // With a key it may.
    assert.equal((await tunneled(d, '/api/v1/engines/e1', { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, EVIL_SOURCE, 'PUT')).status, 200)
    assert.equal(engine.sourceRepo, EVIL_SOURCE.sourceRepo)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-engine.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
      })
      const { engine } = withEngine(d)
      const access = { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }
      assert.equal((await tunneled(d, '/api/v1/engines/e1', access, { sourceRepo: EVIL_SOURCE.sourceRepo }, 'PUT')).status, 403)
      assert.equal((await tunneled(d, '/api/v1/engines/e1', access, { sourceBranch: 'evil' }, 'PUT')).status, 403)
      assert.equal(engine.sourceRepo, undefined)
      assert.equal(engine.sourceBranch, undefined)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d } = mkDeps((c) => {
      c.daemon.lanBind = true
      c.daemon.requireApiKey = false
    })
    const { engine } = withEngine(d)
    assert.equal((await fromLan(d, '/api/v1/engines/e1', {}, EVIL_SOURCE, 'PUT')).status, 403)
    assert.equal(engine.sourceRepo, undefined)
    assert.equal((await fromLan(d, '/api/v1/engines/e1', { 'X-TurboLLM-Auth': RAW_KEY }, EVIL_SOURCE, 'PUT')).status, 200)
    assert.equal(engine.sourceRepo, EVIL_SOURCE.sourceRepo)
  }
  // The host itself, unchanged.
  {
    const { d } = mkDeps()
    const { engine } = withEngine(d)
    const res = await createApp(d).request('/api/v1/engines/e1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:6996' },
      body: JSON.stringify(EVIL_SOURCE),
    }, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
    assert.equal(res.status, 200)
    assert.equal(engine.sourceRepo, EVIL_SOURCE.sourceRepo)
  }
})

// DELETE /api/v1/mcp/servers/:id removes a server the owner set up (and stops its process): the same
// host-side change as adding or editing one, refused to the same callers.
test('a keyless Serve identity, Access JWT or open-LAN peer cannot delete an MCP server; with a key it can', async () => {
  const saved = { id: 'srv-1', name: 'Owner files', transport: 'stdio' as const, command: 'sh', args: ['-c', 'true'], enabled: false }
  // Tailscale Serve, no key.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve'; c.mcp.servers.push({ ...saved }) })
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    assert.equal((await tunneled(d, '/api/v1/mcp/servers/srv-1', serve, {}, 'DELETE')).status, 403)
    assert.equal(cfg.mcp.servers.length, 1, 'the server is kept')
    assert.equal((await tunneled(d, '/api/v1/mcp/servers/srv-1', { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE')).status, 200)
    assert.equal(cfg.mcp.servers.length, 0)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-mcp.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d, cfg } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
        c.mcp.servers.push({ ...saved })
      })
      const access = { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }
      assert.equal((await tunneled(d, '/api/v1/mcp/servers/srv-1', access, {}, 'DELETE')).status, 403)
      assert.equal(cfg.mcp.servers.length, 1)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d, cfg } = mkDeps((c) => {
      c.daemon.lanBind = true
      c.daemon.requireApiKey = false
      c.mcp.servers.push({ ...saved })
    })
    assert.equal((await fromLan(d, '/api/v1/mcp/servers/srv-1', {}, {}, 'DELETE')).status, 403)
    assert.equal(cfg.mcp.servers.length, 1)
    assert.equal((await fromLan(d, '/api/v1/mcp/servers/srv-1', { 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE')).status, 200)
    assert.equal(cfg.mcp.servers.length, 0)
  }
})

// POST /api/v1/modeldirs, POST /modeldirs/primary and DELETE /modeldirs choose where downloads are
// written: a download with a subdir keeps the name its URL ends in, so a caller who could add the
// home folder and make it primary could write ~/.ssh/authorized_keys. Refused to the same callers as
// an MCP server, with api_key_required (the web client's key prompt). A remote token was already
// refused (no capability maps /modeldirs).
type Send = (path: string, body: unknown, method?: string) => Response | Promise<Response>
async function assertModelDirsRefused(send: Send, cfg: Config): Promise<void> {
  const [a, b] = cfg.modelDirs
  const home = tmpDir('host-actions-home-')
  for (const [path, body, method] of [
    ['/api/v1/modeldirs', { dir: home }, 'POST'],
    ['/api/v1/modeldirs/primary', { dir: b }, 'POST'],
    ['/api/v1/modeldirs', { dir: a }, 'DELETE'],
  ] as const) {
    const res = await send(path, body, method)
    assert.equal(res.status, 403, `${method} ${path}`)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'api_key_required', `${method} ${path}`)
  }
  assert.deepEqual(cfg.modelDirs, [a, b], 'no folder added or removed')
  assert.equal(cfg.primaryModelDir, '', 'the primary folder is unchanged')
}
async function assertModelDirsAllowed(send: Send, cfg: Config): Promise<void> {
  const [a, b] = cfg.modelDirs
  const c = tmpDir('host-actions-more-models-')
  assert.equal((await send('/api/v1/modeldirs', { dir: c }, 'POST')).status, 201)
  assert.equal((await send('/api/v1/modeldirs/primary', { dir: b }, 'POST')).status, 200)
  assert.equal((await send('/api/v1/modeldirs', { dir: a }, 'DELETE')).status, 200)
  assert.deepEqual(cfg.modelDirs, [b, c])
  assert.equal(cfg.primaryModelDir, b)
}
function withModelDirs(c: Config): void {
  c.modelDirs = [tmpDir('host-actions-models-a-'), tmpDir('host-actions-models-b-')]
  c.primaryModelDir = ''
}
function withScanner(d: Deps): Deps {
  return Object.assign(d, { scanner: { rescan: async () => {} } })
}

test('a keyless Serve identity, Access JWT, open-LAN peer or remote token cannot add, choose or remove a model folder; with a key it can', async () => {
  // Tailscale Serve, no key.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve'; withModelDirs(c) })
    withScanner(d)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    await assertModelDirsRefused((p, b, m) => tunneled(d, p, serve, b, m), cfg)
    await assertModelDirsAllowed((p, b, m) => tunneled(d, p, { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, b, m), cfg)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-modeldirs.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d, cfg } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
        withModelDirs(c)
      })
      withScanner(d)
      const access = () => ({ Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') })
      await assertModelDirsRefused((p, b, m) => tunneled(d, p, access(), b, m), cfg)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d, cfg } = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false; withModelDirs(c) })
    withScanner(d)
    await assertModelDirsRefused((p, b, m) => fromLan(d, p, {}, b, m), cfg)
    await assertModelDirsAllowed((p, b, m) => fromLan(d, p, { 'X-TurboLLM-Auth': RAW_KEY }, b, m), cfg)
  }
  // A remote-access token, whatever it may otherwise do: refused before the route.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick'; withModelDirs(c) })
    withScanner(d)
    const token = { 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load', 'config:write', 'downloads:write'] }) }
    const [a, b] = cfg.modelDirs
    assert.equal((await tunneled(d, '/api/v1/modeldirs', token, { dir: tmpDir('host-actions-home-') })).status, 403)
    assert.equal((await tunneled(d, '/api/v1/modeldirs/primary', token, { dir: b })).status, 403)
    assert.equal((await tunneled(d, '/api/v1/modeldirs', token, { dir: a }, 'DELETE')).status, 403)
    assert.deepEqual(cfg.modelDirs, [a, b])
    assert.equal(cfg.primaryModelDir, '')
  }
  // The host itself, unchanged.
  {
    const { d, cfg } = mkDeps(withModelDirs)
    withScanner(d)
    await assertModelDirsAllowed((p, b, m) => createApp(d).request(p, {
      method: m,
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:6996' },
      body: JSON.stringify(b),
    }, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never), cfg)
  }
})

// POST /api/v1/downloads with a `url` fetches any origin the caller names and, with a `subdir`, writes
// under the name the URL ends in, replacing a file there. Callers refused host-side actions get the
// Turbo Link façade's contract instead: an HF repo file (with a subdir and folder, as the
// whole-folder dialog sends them), never a URL, an HF one included. A remote token is held to it
// too, whatever its capabilities.
function withDownloads(d: Deps): { queued: unknown[] } {
  const queued: unknown[] = []
  Object.assign(d, { downloads: { enqueue: async (input: unknown) => { queued.push(input); return [] } } })
  return { queued }
}
const RAW_URL = { url: 'http://127.0.0.1:9/x/authorized_keys', subdir: '.ssh' }
const HF_URL = { url: 'https://huggingface.co/o/r/resolve/main/m.gguf' }
const REPO_FILE = { repo: 'o/r', rfilename: 'enc/config.json', subdir: 'r/enc', folder: { files: [{ path: 'r/enc/config.json', size: 10 }] } }
async function assertUrlRefused(send: (body: unknown) => Response | Promise<Response>, queued: unknown[]): Promise<void> {
  for (const b of [RAW_URL, HF_URL]) {
    const res = await send(b)
    assert.equal(res.status, 403, b.url)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'api_key_required', b.url)
  }
  assert.deepEqual(queued, [], 'nothing may be queued')
  assert.equal((await send(REPO_FILE)).status, 202, 'an HF repo file still downloads')
  assert.deepEqual(queued, [REPO_FILE])
}

test('a keyless Serve identity, Access JWT, open-LAN peer or remote token cannot download from a URL; an HF repo file still queues, and with a key a URL does', async () => {
  // Tailscale Serve, no key.
  {
    const { d } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
    const { queued } = withDownloads(d)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    await assertUrlRefused((b) => tunneled(d, '/api/v1/downloads', serve, b), queued)
    assert.equal((await tunneled(d, '/api/v1/downloads', { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, RAW_URL)).status, 202)
    assert.deepEqual(queued.at(-1), RAW_URL)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-downloads.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
      })
      const { queued } = withDownloads(d)
      await assertUrlRefused((b) => tunneled(d, '/api/v1/downloads', { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }, b), queued)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d } = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
    const { queued } = withDownloads(d)
    await assertUrlRefused((b) => fromLan(d, '/api/v1/downloads', {}, b), queued)
    assert.equal((await fromLan(d, '/api/v1/downloads', { 'X-TurboLLM-Auth': RAW_KEY }, RAW_URL)).status, 202)
    assert.deepEqual(queued.at(-1), RAW_URL)
  }
  // A remote-access token holding downloads:write (none the product mints can).
  {
    const { d } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const { queued } = withDownloads(d)
    const token = { 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'downloads:write'] }) }
    await assertUrlRefused((b) => tunneled(d, '/api/v1/downloads', token, b), queued)
  }
  // The host itself, unchanged.
  {
    const { d } = mkDeps()
    const { queued } = withDownloads(d)
    const res = await createApp(d).request('/api/v1/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:6996' },
      body: JSON.stringify(RAW_URL),
    }, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
    assert.equal(res.status, 202)
    assert.deepEqual(queued, [RAW_URL])
  }
})

// DELETE /api/v1/models/:key removes model files from the host's disk for good (a whole MLX folder
// with everything in it): refused to the same callers, with api_key_required. A remote token was
// already refused (requiredCapability, I3).
async function withLibrary(d: Deps, cfg: Config): Promise<{ file: string; key: string }> {
  const dir = tmpDir('host-actions-library-')
  const file = join(dir, 'other.gguf')
  writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1)) // the scanner lists a .gguf of 1 MiB or more
  cfg.modelDirs = [dir]
  const scanner = new Scanner(d.store as never)
  Object.assign(d, { scanner, modelRouter: { loadedModelKeys: () => new Set<string>() } })
  await scanner.rescan()
  const entry = scanner.list().models.find((m) => m.path === file)
  assert.ok(entry, 'the scanner lists the model')
  return { file, key: entry.key }
}

test('a keyless Serve identity, Access JWT, open-LAN peer or remote token cannot delete a model; with a key it can', async () => {
  const del = (key: string) => `/api/v1/models/${encodeURIComponent(key)}`
  const refused = async (res: Response | Promise<Response>, file: string) => {
    const r = await res
    assert.equal(r.status, 403)
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'api_key_required')
    assert.ok(existsSync(file), 'the model file is kept')
  }
  // Tailscale Serve, no key.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
    const { file, key } = await withLibrary(d, cfg)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    await refused(tunneled(d, del(key), serve, {}, 'DELETE'), file)
    assert.equal((await tunneled(d, del(key), { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE')).status, 200)
    assert.equal(existsSync(file), false)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-models.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d, cfg } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
      })
      const { file, key } = await withLibrary(d, cfg)
      await refused(tunneled(d, del(key), { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }, {}, 'DELETE'), file)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d, cfg } = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
    const { file, key } = await withLibrary(d, cfg)
    await refused(fromLan(d, del(key), {}, {}, 'DELETE'), file)
    assert.equal((await fromLan(d, del(key), { 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE')).status, 200)
    assert.equal(existsSync(file), false)
  }
  // A remote-access token, whatever it may otherwise do: refused before the route.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const { file, key } = await withLibrary(d, cfg)
    const token = { 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load', 'config:write', 'downloads:write'] }) }
    assert.equal((await tunneled(d, del(key), token, {}, 'DELETE')).status, 403)
    assert.ok(existsSync(file))
  }
  // The host itself, unchanged.
  {
    const { d, cfg } = mkDeps()
    const { file, key } = await withLibrary(d, cfg)
    const res = await createApp(d).request(del(key), { method: 'DELETE', headers: { Host: '127.0.0.1:6996' } }, {
      incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
    } as never)
    assert.equal(res.status, 200)
    assert.equal(existsSync(file), false)
  }
})

// DELETE /api/v1/engines/:id?purge=1 deletes an engine's install folder and DELETE
// /api/v1/engines/backends/:id every build of a backend: refused to the same callers as DELETE
// /engines/build (a Disabled build's smaller delete), with api_key_required. A plain Disable only
// unregisters, keeps the files and stays open. A remote token was already refused (no capability
// maps /engines).
function withEngines(d: Deps): { buildDir: string; otherDir: string; backendDir: string; backendId: string; removed: string[] } {
  const root = join(d.store.dir(), 'engines')
  const buildDir = join(root, 'build', 'mybuild')
  const otherDir = join(root, 'build', 'otherbuild')
  for (const dir of [buildDir, otherDir]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'llama-server'), 'bin')
  }
  const backendId = availableBackends()[0]!.id
  const backendDir = join(root, `llama.cpp-b1-${backendId}`)
  mkdirSync(backendDir, { recursive: true })
  writeFileSync(join(backendDir, 'llama-server'), 'bin')
  const engines = [
    { id: 'e1', name: 'My build', kind: 'llama-server', binPath: join(buildDir, 'llama-server') },
    { id: 'e2', name: 'Other build', kind: 'llama-server', binPath: join(otherDir, 'llama-server') },
    { id: 'be', name: 'llama.cpp', kind: 'llama-server', binPath: join(backendDir, 'llama-server') },
  ]
  const removed: string[] = []
  const live = () => engines.filter((e) => !removed.includes(e.id))
  Object.assign(d, {
    provision: { get: () => ({ active: false }) },
    build: new BuildState(),
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, stopAndWait: async () => {} },
    modelRouter: { poolEngineIds: () => new Set<string>(), stopPoolSlotsOnEngine: async () => {} },
    registry: {
      active: () => undefined,
      list: () => ({ engines: live() }),
      get: (id: string) => live().find((e) => e.id === id),
      remove: (id: string) => { removed.push(id) },
      recordCustomSource: () => {},
      forgetCustomSource: () => {},
      customSources: () => [],
    },
  })
  return { buildDir, otherDir, backendDir, backendId, removed }
}

test('a keyless Serve identity, Access JWT, open-LAN peer or remote token cannot purge an engine or delete a backend; Disable stays open, and with a key they can', async () => {
  const assertRefused = async (send: (path: string) => Response | Promise<Response>, h: ReturnType<typeof withEngines>) => {
    for (const path of ['/api/v1/engines/e1?purge=1', `/api/v1/engines/backends/${h.backendId}`]) {
      const res = await send(path)
      assert.equal(res.status, 403, path)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'api_key_required', path)
    }
    assert.deepEqual(h.removed, [], 'nothing unregistered')
    assert.ok(existsSync(h.buildDir) && existsSync(h.backendDir), 'the files are kept')
  }
  const assertAllowed = async (send: (path: string) => Response | Promise<Response>, h: ReturnType<typeof withEngines>) => {
    assert.equal((await send('/api/v1/engines/e1?purge=1')).status, 200)
    assert.equal(existsSync(h.buildDir), false)
    assert.equal((await send(`/api/v1/engines/backends/${h.backendId}`)).status, 200)
    assert.equal(existsSync(h.backendDir), false)
    assert.ok(h.removed.includes('e1') && h.removed.includes('be'))
  }
  // Tailscale Serve, no key.
  {
    const { d } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
    const h = withEngines(d)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    await assertRefused((p) => tunneled(d, p, serve, {}, 'DELETE'), h)
    // A plain Disable only unregisters, keeps the files and stays open.
    assert.equal((await tunneled(d, '/api/v1/engines/e2', serve, {}, 'DELETE')).status, 200)
    assert.deepEqual(h.removed, ['e2'])
    assert.ok(existsSync(h.otherDir))
    await assertAllowed((p) => tunneled(d, p, { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE'), h)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-purge.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
      })
      const h = withEngines(d)
      await assertRefused((p) => tunneled(d, p, { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }, {}, 'DELETE'), h)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d } = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
    const h = withEngines(d)
    await assertRefused((p) => fromLan(d, p, {}, {}, 'DELETE'), h)
    await assertAllowed((p) => fromLan(d, p, { 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE'), h)
  }
  // A remote-access token, whatever it may otherwise do: refused before the route.
  {
    const { d } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const h = withEngines(d)
    const token = { 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load', 'config:write', 'downloads:write'] }) }
    for (const path of ['/api/v1/engines/e1?purge=1', `/api/v1/engines/backends/${h.backendId}`])
      assert.equal((await tunneled(d, path, token, {}, 'DELETE')).status, 403, path)
    assert.deepEqual(h.removed, [])
  }
  // The host itself, unchanged.
  {
    const { d } = mkDeps()
    const h = withEngines(d)
    await assertAllowed((p) => createApp(d).request(p, { method: 'DELETE', headers: { Host: '127.0.0.1:6996' } }, {
      incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
    } as never), h)
  }
})

// DELETE /api/v1/engines/build deletes a Disabled build's folder (a Disabled source-built card's
// Delete, and the second step of a Disabled git-built custom engine's Remove). Its refusal was a
// plain 403 'forbidden', which opens no key prompt, so a keyless caller's Delete only toasted.
// api_key_required, as the purge and the backend delete above answer.
test('a keyless Serve identity, Access JWT or open-LAN peer cannot delete a Disabled build and gets the key prompt; with a key it can', async () => {
  /** withEngines' harness plus engines/build/myfork, a build no engine and no source claims. */
  const disabledBuild = (d: Deps) => {
    withEngines(d)
    const dir = join(d.store.dir(), 'engines', 'build', 'myfork')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'llama-server'), 'bin')
    return { dir, path: `/api/v1/engines/build?binPath=${encodeURIComponent(join(dir, 'llama-server'))}` }
  }
  const assertRefused = async (res: Response, dir: string) => {
    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'api_key_required')
    assert.ok(existsSync(join(dir, 'llama-server')), 'the folder is kept')
  }
  const assertDeleted = async (res: Response, dir: string) => {
    assert.equal(res.status, 200)
    assert.equal(existsSync(dir), false)
  }
  // Tailscale Serve, no key; with a key it may.
  {
    const { d } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
    const { dir, path } = disabledBuild(d)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    await assertRefused(await tunneled(d, path, serve, {}, 'DELETE'), dir)
    await assertDeleted(await tunneled(d, path, { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE'), dir)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-build.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
      })
      const { dir, path } = disabledBuild(d)
      await assertRefused(await tunneled(d, path, { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }, {}, 'DELETE'), dir)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d } = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
    const { dir, path } = disabledBuild(d)
    await assertRefused(await fromLan(d, path, {}, {}, 'DELETE'), dir)
    await assertDeleted(await fromLan(d, path, { 'X-TurboLLM-Auth': RAW_KEY }, {}, 'DELETE'), dir)
  }
  // The host itself, unchanged.
  {
    const { d } = mkDeps()
    const { dir, path } = disabledBuild(d)
    await assertDeleted(await createApp(d).request(path, { method: 'DELETE', headers: { Host: '127.0.0.1:6996' } }, {
      incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
    } as never), dir)
  }
})

// POST /api/v1/comfyui/install writes the gate node into a custom_nodes folder the caller names and
// records it as gatePath; POST /comfyui/uninstall deletes gatePath recursively. Refused to the same
// callers, with api_key_required, so none of them can replace another folder's __init__.py, repoint
// gatePath, or delete the owner's working gate. A remote token was already refused (no capability
// maps /comfyui).
function withComfy(cfg: Config): { ownerGate: string; other: string } {
  const owner = tmpDir('host-actions-comfy-owner-')
  const ownerGate = join(owner, 'custom_nodes', 'turbollm_gate')
  mkdirSync(ownerGate, { recursive: true })
  writeFileSync(join(ownerGate, '__init__.py'), 'owner gate')
  cfg.comfyui.gatePath = ownerGate
  const other = join(tmpDir('host-actions-comfy-other-'), 'custom_nodes')
  mkdirSync(join(other, 'turbollm_gate'), { recursive: true })
  writeFileSync(join(other, 'turbollm_gate', '__init__.py'), 'foreign node')
  return { ownerGate, other }
}

test('a keyless Serve identity, Access JWT, open-LAN peer or remote token cannot install or remove the ComfyUI gate node; with a key it can', async () => {
  const assertRefused = async (send: (path: string, body: unknown) => Response | Promise<Response>, cfg: Config, h: ReturnType<typeof withComfy>) => {
    for (const [path, body] of [['/api/v1/comfyui/install', { path: h.other }], ['/api/v1/comfyui/uninstall', {}]] as const) {
      const res = await send(path, body)
      assert.equal(res.status, 403, path)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'api_key_required', path)
    }
    assert.equal(cfg.comfyui.gatePath, h.ownerGate, 'gatePath is unchanged')
    assert.equal(readFileSync(join(h.ownerGate, '__init__.py'), 'utf8'), 'owner gate', "the owner's gate is kept")
    assert.equal(readFileSync(join(h.other, 'turbollm_gate', '__init__.py'), 'utf8'), 'foreign node', 'nothing is written')
  }
  const assertAllowed = async (send: (path: string, body: unknown) => Response | Promise<Response>, cfg: Config, h: ReturnType<typeof withComfy>) => {
    assert.equal((await send('/api/v1/comfyui/install', { path: h.other })).status, 200)
    assert.equal(cfg.comfyui.gatePath, join(h.other, 'turbollm_gate'))
    assert.match(readFileSync(join(h.other, 'turbollm_gate', '__init__.py'), 'utf8'), /^TURBOLLM_URL = /m)
    assert.equal((await send('/api/v1/comfyui/uninstall', {})).status, 200)
    assert.equal(cfg.comfyui.gatePath, '')
    assert.equal(existsSync(join(h.other, 'turbollm_gate')), false)
  }
  // Tailscale Serve, no key.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
    const h = withComfy(cfg)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    await assertRefused((p, b) => tunneled(d, p, serve, b), cfg, h)
    await assertAllowed((p, b) => tunneled(d, p, { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, b), cfg, h)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-comfy.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d, cfg } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
      })
      const h = withComfy(cfg)
      await assertRefused((p, b) => tunneled(d, p, { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }, b), cfg, h)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d, cfg } = mkDeps((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
    const h = withComfy(cfg)
    await assertRefused((p, b) => fromLan(d, p, {}, b), cfg, h)
    await assertAllowed((p, b) => fromLan(d, p, { 'X-TurboLLM-Auth': RAW_KEY }, b), cfg, h)
  }
  // A remote-access token, whatever it may otherwise do: refused before the route.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
    const h = withComfy(cfg)
    const token = { 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load', 'config:write', 'downloads:write'] }) }
    assert.equal((await tunneled(d, '/api/v1/comfyui/install', token, { path: h.other })).status, 403)
    assert.equal((await tunneled(d, '/api/v1/comfyui/uninstall', token, {})).status, 403)
    assert.equal(cfg.comfyui.gatePath, h.ownerGate)
    assert.ok(existsSync(h.ownerGate))
  }
  // The host itself, unchanged.
  {
    const { d, cfg } = mkDeps()
    const h = withComfy(cfg)
    await assertAllowed((p, b) => createApp(d).request(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:6996' },
      body: JSON.stringify(b),
    }, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never), cfg, h)
  }
})

// Engine launch fields: a model profile's extra command-line flags, chat template file, draft model
// and MTP head file, and /engine/start's legacy model path and flags, all go onto the engine's
// command line as sent (profileToArgs appends extraArgs verbatim), and vLLM's trust-remote-code
// switch runs a repo's Python. Choosing them is a host-side action like a build: a caller refused
// /build/run may not put a flag or a file of its own there.
// It may still load, save a profile or a preset, or tune with the values the model already has
// (the web UI sends its whole draft every time), and pick a library model as the draft model.
function modelEntry(key: string, path: string): ModelEntry {
  return {
    key, name: key, path, dir: '/models', format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'Q4_K_M',
    nativeCtx: 8192, blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0, vision: false,
    audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
    incomplete: false,
  } as unknown as ModelEntry
}
const MODEL = modelEntry('m1', '/models/m1.gguf')
const DRAFT = modelEntry('d1', '/models/d1.gguf')
const OWNER_FLAGS = ['--owner-flag']

interface LaunchHarness { loads: { modelPath: string; extraArgs: string[] }[]; benches: { key: string; base: unknown }[] }

/** A llama-server engine, the library (MODEL and DRAFT), and the owner's saved profile for MODEL
 *  with OWNER_FLAGS plus an unpinned preset of someone else's flags; load and bench record calls. */
function withLaunch(d: Deps, cfg: Config): LaunchHarness {
  const h: LaunchHarness = { loads: [], benches: [] }
  const engine = { id: 'e1', kind: 'llama-server', name: 'llama', binPath: '/opt/llama-server', capabilities: { flags: [], kvTypes: [] } }
  cfg.modelProfiles = { m1: { e1: { profile: { ctx: 4096, extraArgs: OWNER_FLAGS }, updatedAt: '2026-10-01T00:00:00.000Z' } } }
  cfg.modelPresets = { m1: [{ id: 'p1', name: 'Other', engineId: '', profile: { ctx: 4096, extraArgs: ['--other'] }, updatedAt: '2026-10-01T00:00:00.000Z', origin: 'manual' }] }
  Object.assign(d as unknown as Record<string, unknown>, {
    scanner: { get: (k: string) => [MODEL, DRAFT].find((m) => m.key === k), list: () => ({ models: [MODEL, DRAFT], scanning: false, lastScanAt: '' }) },
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, load: (o: { modelPath: string; extraArgs: string[] }) => { h.loads.push(o); return Promise.resolve() } },
    modelRouter: { withSwapLock: (fn: () => unknown) => Promise.resolve(fn()), markPrimaryLoaded: () => {}, loadExplicit: () => Promise.resolve() },
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve(), start: (key: string, base: unknown) => { h.benches.push({ key, base }) } },
  })
  Object.assign((d as unknown as { registry: Record<string, unknown> }).registry, { active: () => engine, get: (id: string) => (id === 'e1' ? engine : undefined) })
  return h
}

/** Every way to put a flag or a file of the caller's own on the command line is refused with
 *  api_key_required (the web UI's key prompt) and changes nothing. `engine` is false for a remote
 *  token, which lanAuth already refuses /engine/start and /bench (no capability maps there). */
async function assertLaunchRefused(send: Send, cfg: Config, h: LaunchHarness, engine = true) {
  const saved = JSON.stringify({ p: cfg.modelProfiles, s: cfg.modelPresets, pin: cfg.lastPresetId })
  const refused = async (what: string, res: Response, field: string) => {
    assert.equal(res.status, 403, what)
    const { error } = (await res.json()) as { error: { code: string; field: string; message: string } }
    assert.equal(error.code, 'api_key_required', what)
    assert.equal(error.field, field, what)
    assert.match(error.message, /requires a valid API key\.$/, what)
  }
  if (engine) {
    await refused('legacy modelPath', await send('/api/v1/engine/start', { modelPath: '/any/where/file.gguf', extraArgs: ['--zz'] }), 'modelPath')
    await refused('legacy extraArgs', await send('/api/v1/engine/start', { extraArgs: ['--zz'] }), 'extraArgs')
    await refused('start overrides', await send('/api/v1/engine/start', { modelKey: 'm1', profileOverrides: { ctx: 4096, extraArgs: ['--zz'] } }), 'extraArgs')
    await refused('start template', await send('/api/v1/engine/start', { modelKey: 'm1', profileOverrides: { chatTemplateFile: '/home/owner/.ssh/id_ed25519' } }), 'chatTemplateFile')
    // vLLM's --trust-remote-code runs the Python a model's repo ships: a flag by another name.
    await refused('start remote code', await send('/api/v1/engine/start', { modelKey: 'm1', profileOverrides: { vllm: { trustRemoteCode: true } } }), 'vllm.trustRemoteCode')
    await refused('bench base', await send('/api/v1/bench', { modelKey: 'm1', base: { ctx: 4096, extraArgs: ['--zz'] } }), 'extraArgs')
    assert.deepEqual(h.loads, [], 'nothing may load')
    assert.deepEqual(h.benches, [], 'no tune may start')
  }
  await refused('profile flags', await send('/api/v1/models/m1/profile', { ctx: 4096, extraArgs: ['--zz'] }, 'PUT'), 'extraArgs')
  await refused('profile draft file', await send('/api/v1/models/m1/profile', { ctx: 4096, extraArgs: OWNER_FLAGS, draftModelPath: '/tmp/x.gguf' }, 'PUT'), 'draftModelPath')
  await refused('profile MTP file', await send('/api/v1/models/m1/profile', { ctx: 4096, mtpHeadPath: '/tmp/x.gguf' }, 'PUT'), 'mtpHeadPath')
  await refused('profile remote code', await send('/api/v1/models/m1/profile', { ctx: 4096, extraArgs: OWNER_FLAGS, vllm: { trustRemoteCode: true } }, 'PUT'), 'vllm.trustRemoteCode')
  await refused('preset create', await send('/api/v1/models/m1/presets', { name: 'x', profile: { ctx: 4096, chatTemplateFile: '/etc/passwd' } }), 'chatTemplateFile')
  await refused('preset update', await send('/api/v1/models/m1/presets/p1', { profile: { ctx: 4096, extraArgs: ['--zz'] } }, 'PUT'), 'extraArgs')
  await refused('preset remote code', await send('/api/v1/models/m1/presets/p1', { profile: { ctx: 4096, extraArgs: ['--other'], vllm: { trustRemoteCode: true } } }, 'PUT'), 'vllm.trustRemoteCode')
  // A stored preset whose flags differ from what the model loads with now: pinning it changes them.
  await refused('preset apply', await send('/api/v1/models/m1/presets/p1/apply', {}), 'extraArgs')
  assert.equal(JSON.stringify({ p: cfg.modelProfiles, s: cfg.modelPresets, pin: cfg.lastPresetId }), saved, 'nothing may be stored')
}

/** The same caller keeps every use of the model's own values: an unchanged echo of the saved
 *  flags, no flags, and a library model as the draft. */
async function assertLaunchEchoOpen(send: Send, cfg: Config, h: LaunchHarness, engine = true) {
  if (engine) {
    assert.equal((await send('/api/v1/engine/start', { modelKey: 'm1' })).status, 202)
    assert.equal((await send('/api/v1/engine/start', { modelKey: 'm1', profileOverrides: { ctx: 8192, extraArgs: OWNER_FLAGS, chatTemplateFile: '' } })).status, 202)
    assert.equal(h.loads.length, 2)
    assert.equal(h.loads[1].modelPath, MODEL.path)
    assert.ok(h.loads[1].extraArgs.includes('--owner-flag'))
    assert.equal((await send('/api/v1/bench', { modelKey: 'm1', base: { ctx: 4096, extraArgs: OWNER_FLAGS } })).status, 202)
    assert.equal(h.benches.length, 1)
  }
  const profile = { ctx: 8192, extraArgs: ['--owner-flag'], draftModelPath: DRAFT.path, speculative: 'draft', vllm: { dtype: 'bfloat16', trustRemoteCode: false } }
  assert.equal((await send('/api/v1/models/m1/profile', profile, 'PUT')).status, 200)
  assert.equal((cfg.modelProfiles.m1.e1.profile as { draftModelPath: string }).draftModelPath, DRAFT.path)
  assert.equal((await send('/api/v1/models/m1/profile', { ctx: 4096, extraArgs: [] }, 'PUT')).status, 200)
  assert.equal((await send('/api/v1/models/m1/presets', { name: 'mine', profile: { ctx: 4096 } })).status, 201)
  assert.equal((await send('/api/v1/models/m1/presets/p1', { name: 'renamed' }, 'PUT')).status, 200)
}

test("a keyless Serve identity, Access JWT or open-LAN peer cannot put its own flags or files on the engine's command line", async () => {
  // Tailscale Serve, no key; with a key it may.
  {
    const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
    const h = withLaunch(d, cfg)
    const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
    await assertLaunchRefused((p, b, m) => tunneled(d, p, serve, b, m), cfg, h)
    await assertLaunchEchoOpen((p, b, m) => tunneled(d, p, serve, b, m), cfg, h)
    const keyed = { ...serve, 'X-TurboLLM-Auth': RAW_KEY }
    assert.equal((await tunneled(d, '/api/v1/engine/start', keyed, { modelKey: 'm1', profileOverrides: { extraArgs: ['--zz'] } })).status, 202)
    assert.deepEqual(h.loads.at(-1)?.extraArgs.slice(-1), ['--zz'])
    const keyedProfile = { ctx: 4096, extraArgs: ['--zz'], vllm: { trustRemoteCode: true } }
    assert.equal((await tunneled(d, '/api/v1/models/m1/profile', keyed, keyedProfile, 'PUT')).status, 200)
    // What the owner stored is now the model's own: the keyless dialog's echo of it passes.
    assert.equal((await tunneled(d, '/api/v1/models/m1/profile', serve, { ...keyedProfile, ctx: 8192 }, 'PUT')).status, 200)
    assert.equal((await tunneled(d, '/api/v1/engine/start', serve, { modelKey: 'm1', profileOverrides: keyedProfile })).status, 202)
  }
  // A verified Cloudflare Access JWT, no key.
  {
    const teamDomain = 'https://host-actions-launch.cloudflareaccess.com'
    const real = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
    try {
      const { d, cfg } = mkDeps((c) => {
        c.remoteAccess.provider = 'cloudflare-named'
        c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
        c.remoteAccess.cloudflare.accessAud = 'aud-host-actions'
      })
      const h = withLaunch(d, cfg)
      const access = { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-host-actions') }
      await assertLaunchRefused((p, b, m) => tunneled(d, p, access, b, m), cfg, h)
    } finally {
      globalThis.fetch = real
    }
  }
  // An open LAN (requireApiKey off), no key; with a key it may.
  {
    const { d, cfg } = mkDeps((c) => {
      c.daemon.lanBind = true
      c.daemon.requireApiKey = false
    })
    const h = withLaunch(d, cfg)
    await assertLaunchRefused((p, b, m) => fromLan(d, p, {}, b, m), cfg, h)
    await assertLaunchEchoOpen((p, b, m) => fromLan(d, p, {}, b, m), cfg, h)
    const keyed = { 'X-TurboLLM-Auth': RAW_KEY }
    assert.equal((await fromLan(d, '/api/v1/engine/start', keyed, { modelPath: '/any/where/file.gguf', extraArgs: ['--zz'] })).status, 202)
    assert.equal(h.loads.at(-1)?.modelPath, '/any/where/file.gguf')
    assert.equal((await fromLan(d, '/api/v1/models/m1/presets/p1/apply', keyed, {})).status, 200)
    assert.equal(cfg.lastPresetId.m1, 'p1')
  }
  // The host itself, unchanged.
  {
    const { d, cfg } = mkDeps()
    const h = withLaunch(d, cfg)
    const local = (p: string, b: unknown, m = 'POST') => createApp(d).request(p, {
      method: m,
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:6996' },
      body: JSON.stringify(b),
    }, { incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
    assert.equal((await local('/api/v1/engine/start', { modelKey: 'm1', profileOverrides: { extraArgs: ['--zz'] } })).status, 202)
    assert.equal((await local('/api/v1/bench', { modelKey: 'm1', base: { chatTemplateFile: '/home/owner/t.jinja' } })).status, 202)
    assert.equal((await local('/api/v1/models/m1/profile', { ctx: 4096, mtpHeadPath: '/home/owner/mtp.gguf' }, 'PUT')).status, 200)
    assert.equal((await local('/api/v1/models/m1/presets', { name: 'x', profile: { ctx: 4096, extraArgs: ['--zz'] } })).status, 201)
    assert.equal(h.loads.length, 1)
  }
})

test("a remote-access token with models:load cannot set a model's engine flags through its profile or presets", async () => {
  const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'cloudflare-quick' })
  const h = withLaunch(d, cfg)
  const raw = 'tllm-remotetokenremotetokenremotetokenre1'
  cfg.apiKeys.push({ id: 'r1', name: 'remote', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null, grant: { kind: 'remote', capabilities: ['models:use', 'models:load'] } })
  const token = { Host: 'quick-tunnel.trycloudflare.com', Authorization: `Bearer ${raw}` }
  await assertLaunchRefused((p, b, m) => tunneled(d, p, token, b, m), cfg, h, false)
  await assertLaunchEchoOpen((p, b, m) => tunneled(d, p, token, b, m), cfg, h, false)
})
