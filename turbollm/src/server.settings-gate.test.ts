// PATCH /api/v1/settings through the REAL createApp, for the three callers lanAuth admits with
// no key that hostGate refuses: a Tailscale Serve identity, a verified Cloudflare Access JWT and
// a peer on an open LAN. lanAuth was the only gate in front of the route, so any of them could
// turn requireApiKey off, turn lanBind on, or rewrite the remote-access block (tunnel tokens,
// Access team/aud, the remote token grant), while /api/v1/keys and /api/v1/remote/* refused them.
// The tool-call approve route's "Always Allow" writes the same toolPolicies, so it is tried too.
// So is the request log: its captured bodies hold the host's Code prompts, which codeAuth keeps
// from all three, and they could switch capture on here and read it back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createApp } from './server'
import { hashKey } from './auth'
import { RequestLog } from './observability/request-log'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'
import { tmpDir } from './test-support/tmp'

const INGRESS_PORT = 6997
const SERVE_HOST = 'box.tail1234.ts.net'
const RAW_KEY = 'tllm-settingsgatesettingsgatesettingsgat1'
const AGENT_SECRET = 'AWS_SECRET_ACCESS_KEY=settings-gate-secret'

function mkDeps(mutate: (cfg: Config) => void = () => {}): { d: Deps; cfg: Config } {
  const cfg = defaultConfig()
  cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
  mutate(cfg)
  const dir = tmpDir('settings-gate-')
  // One Code turn captured with its bodies, as the gateway logs it with capture on.
  const requestLog = new RequestLog()
  const id = requestLog.start({
    source: 'anthropic', harness: 'claude_code', codeSessionId: 's1', modelKey: 'qwen3-8b', remote: null, stream: true,
    params: {}, counts: { messages: 2, tools: 1, systemChars: 0 },
    requestBody: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: `cat .env\n${AGENT_SECRET}` }] }] }),
  })
  requestLog.finalize(id, { status: 200, responseBody: '{"content":"done"}' })
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg), dir: () => dir },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => cfg.remoteAccess.provider,
      url: () => `https://${SERVE_HOST}`,
      state: () => ({ kind: 'connected' }),
    },
    requestLog,
  } as unknown as Deps
  return { d, cfg }
}

type Socket = { localPort: number; remoteAddress: string }
const INGRESS: Socket = { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1' }
const LAN: Socket = { localPort: 6996, remoteAddress: '192.168.1.50' }
const LOOPBACK: Socket = { localPort: 6996, remoteAddress: '127.0.0.1' }

function send(d: Deps, socket: Socket, headers: Record<string, string>, method: string, path: string, body: unknown) {
  return createApp(d).request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  }, { incoming: { socket: { ...socket, remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

function patch(d: Deps, socket: Socket, headers: Record<string, string>, body: unknown) {
  return send(d, socket, headers, 'PATCH', '/api/v1/settings', body)
}

/** A tool-call approval. No call is pending in these tests, so one that gets past the gate ends
 *  in 404; "Always Allow" writes its global policy before that lookup. */
function approve(d: Deps, socket: Socket, headers: Record<string, string>, decision: string) {
  return send(d, socket, headers, 'POST', '/api/v1/conversations/conv1/tool-calls/call1/approve', { toolName: 'run_code', decision })
}

/** A save that changes nothing host-only: the stored values echoed back. The Settings screen's
 *  Save sends lanBind, requireApiKey and port this way with every general setting; the credential,
 *  search and build fields go further than it does, so the outcome check must also see an
 *  unchanged one as no change. The write-only credentials echo as '' when none is stored, and
 *  `search` creates its block. */
function echo(cfg: Config) {
  return {
    theme: 'dark',
    port: cfg.daemon.port,
    lanBind: cfg.daemon.lanBind,
    requireApiKey: cfg.daemon.requireApiKey,
    telemetryLevel: cfg.telemetry.level,
    hfToken: '',
    ghToken: '',
    tavilyApiKey: '',
    search: {},
    build: { toolchainDirs: cfg.build.toolchainDirs },
    requestLog: { enabled: cfg.requestLog.enabled, captureBodies: cfg.requestLog.captureBodies },
  }
}

/** The captured Code turn's bodies: what GET /api/v1/requests/:id answers this caller. */
async function readBodies(d: Deps, socket: Socket, headers: Record<string, string>) {
  const [{ id }] = d.requestLog!.list()
  const res = await send(d, socket, headers, 'GET', `/api/v1/requests/${id}`, undefined)
  return { status: res.status, text: await res.text() }
}

/** Each flips or replaces the stored value. Either way round for the two toggles: turning the
 *  key requirement back ON locks every other device out, as host-only as turning it off. */
const HOST_ONLY: [string, (cfg: Config) => unknown][] = [
  ['requireApiKey', (cfg) => ({ requireApiKey: !cfg.daemon.requireApiKey })],
  ['lanBind', (cfg) => ({ lanBind: !cfg.daemon.lanBind })],
  ['port', (cfg) => ({ port: cfg.daemon.port + 1 })],
  ['remoteAccess', () => ({ remoteAccess: { cloudflare: { accessTeamDomain: 'https://evil.cloudflareaccess.com', accessAud: 'evil-aud' } } })],
  ['remoteAccess', () => ({ remoteAccess: { ngrok: { authtoken: 'attacker-token' } } })],
  ['remoteAccess', () => ({ remoteAccess: { tokenGrant: { capabilities: ['models:use', 'models:load'] } } })],
  ['experimental.remoteAccess', () => ({ experimental: { remoteAccess: true } })],
  // GET /api/v1/build/prereqs (no gate) runs git/cmake from here: a UNC share passes the
  // absolute-path check, so on Windows this is the caller's git.exe run by the daemon.
  ['build.toolchainDirs', () => ({ build: { toolchainDirs: ['\\\\attacker\\share'] } })],
  ['build.toolchainDirs', () => ({ build: { toolchainDirs: ['/tmp/attacker-bin'] } })],
  ['autoAllowAll', () => ({ autoAllowAll: true })],
  ['toolPolicies', () => ({ toolPolicies: { run_code: 'allow' } })],
  ['hfToken', () => ({ hfToken: 'hf_attacker' })],
  ['ghToken', () => ({ ghToken: 'ghp_attacker' })],
  ['search.tavilyApiKey', () => ({ search: { tavilyApiKey: 'tvly-attacker' } })],
  ['search.tavilyApiKey', () => ({ tavilyApiKey: 'tvly-attacker' })], // the legacy top-level alias
  ['search.kagiApiKey', () => ({ search: { kagiApiKey: 'kagi-attacker' } })],
  ['search.searxngUrl', () => ({ search: { provider: 'searxng', searxngUrl: 'https://evil.example' } })],
  // Capture on records the host's Code prompts for the caller to read; the log off blinds the owner.
  ['requestLog.captureBodies', (cfg) => ({ requestLog: { captureBodies: !cfg.requestLog.captureBodies } })],
  ['requestLog.enabled', (cfg) => ({ requestLog: { enabled: !cfg.requestLog.enabled } })],
]

/** Every host-only change is refused (and nothing changes); a cosmetic one and an echo are not. */
async function assertGated(d: Deps, cfg: Config, socket: Socket, headers: Record<string, string>) {
  for (const [field, body] of HOST_ONLY) {
    const saved = JSON.stringify(cfg)
    const res = await patch(d, socket, headers, body(cfg))
    assert.equal(res.status, 403, field)
    const { error } = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(error.code, 'forbidden')
    assert.match(error.message, new RegExp(`^Changing ${field.replace('.', '\\.')} requires a valid API key`), field)
    assert.equal(JSON.stringify(cfg), saved, `${field}: nothing may be stored`)
  }
  // "Always Allow" writes toolPolicies too; "Allow for this chat" is the chat action, still open.
  const saved = JSON.stringify(cfg)
  const always = await approve(d, socket, headers, 'always_allow')
  assert.equal(always.status, 403, 'always_allow')
  assert.match(((await always.json()) as { error: { message: string } }).error.message, /requires a valid API key/)
  assert.equal(JSON.stringify(cfg), saved, 'always_allow: nothing may be stored')
  assert.equal((await approve(d, socket, headers, 'allow_chat')).status, 404)
  // Bodies already captured are host-only to read; the metadata list stays open.
  const one = await readBodies(d, socket, headers)
  assert.equal(one.status, 403, 'GET /requests/:id')
  assert.doesNotMatch(one.text, /settings-gate-secret/)
  const withBodies = await send(d, socket, headers, 'GET', '/api/v1/requests?bodies=1', undefined)
  assert.equal(withBodies.status, 403, 'GET /requests?bodies=1')
  assert.doesNotMatch(await withBodies.text(), /settings-gate-secret/)
  const list = await send(d, socket, headers, 'GET', '/api/v1/requests', undefined)
  assert.equal(list.status, 200)
  const { entries } = (await list.json()) as { entries: { harness: string; bodies: unknown }[] }
  assert.deepEqual(entries.map((e) => [e.harness, e.bodies]), [['claude_code', null]])
  const res = await patch(d, socket, headers, echo(cfg))
  assert.equal(res.status, 200, 'an unchanged echo of the host-only fields is no change')
  assert.equal(cfg.daemon.theme, 'dark')
  assert.equal((await patch(d, socket, headers, { machineName: 'box' })).status, 200)
  assert.equal(cfg.daemon.machineName, 'box')
}

test('a keyless Tailscale Serve identity cannot change requireApiKey, lanBind or remote access; cosmetic fields still save', async () => {
  const { d, cfg } = mkDeps((c) => { c.remoteAccess.provider = 'tailscale-serve' })
  const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' }
  await assertGated(d, cfg, INGRESS, serve)
  // The same identity presenting a real key may.
  assert.equal((await patch(d, INGRESS, { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, { requireApiKey: false })).status, 200)
  assert.equal(cfg.daemon.requireApiKey, false)
  assert.equal((await approve(d, INGRESS, { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, 'always_allow')).status, 404)
  assert.equal(cfg.tools.toolPolicies?.run_code, 'allow')
  assert.equal((await patch(d, INGRESS, { ...serve, 'X-TurboLLM-Auth': RAW_KEY }, { requestLog: { captureBodies: true } })).status, 200)
  assert.equal(cfg.requestLog.captureBodies, true)
  const keyed = await readBodies(d, INGRESS, { ...serve, 'X-TurboLLM-Auth': RAW_KEY })
  assert.equal(keyed.status, 200)
  assert.match(keyed.text, /settings-gate-secret/)
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

test('a verified Cloudflare Access JWT with no key cannot change host-only settings', async () => {
  const teamDomain = 'https://settings-gate.cloudflareaccess.com'
  const real = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(input) === `${teamDomain}/cdn-cgi/access/certs` ? new Response(JWKS, { status: 200 }) : real(input, init)) as typeof fetch
  try {
    const { d, cfg } = mkDeps((c) => {
      c.remoteAccess.provider = 'cloudflare-named'
      c.remoteAccess.cloudflare.accessTeamDomain = teamDomain
      c.remoteAccess.cloudflare.accessAud = 'aud-settings-gate'
    })
    await assertGated(d, cfg, INGRESS, { Host: 'llm.example.com', 'Cf-Access-Jwt-Assertion': accessJwt(teamDomain, 'aud-settings-gate') })
    assert.equal(cfg.remoteAccess.cloudflare.accessTeamDomain, teamDomain)
  } finally {
    globalThis.fetch = real
  }
})

test('a keyless peer on an open LAN cannot change host-only settings; with a key, or from this machine, it can', async () => {
  const { d, cfg } = mkDeps((c) => {
    c.daemon.lanBind = true
    c.daemon.requireApiKey = false
  })
  const lanHost = { Host: '192.168.1.20:6996' }
  await assertGated(d, cfg, LAN, lanHost)
  assert.equal((await patch(d, LAN, { ...lanHost, Authorization: `Bearer ${RAW_KEY}` }, { remoteAccess: { ngrok: { domain: 'mine.ngrok.app' } } })).status, 200)
  assert.equal(cfg.remoteAccess.ngrok.domain, 'mine.ngrok.app')
  assert.equal((await patch(d, LOOPBACK, { Host: '127.0.0.1:6996' }, { requireApiKey: true })).status, 200)
  assert.equal(cfg.daemon.requireApiKey, true)
  assert.equal((await approve(d, LOOPBACK, { Host: '127.0.0.1:6996' }, 'always_allow')).status, 404)
  assert.equal(cfg.tools.toolPolicies?.run_code, 'allow')
  assert.equal((await patch(d, LOOPBACK, { Host: '127.0.0.1:6996' }, { requestLog: { captureBodies: true } })).status, 200)
  assert.equal(cfg.requestLog.captureBodies, true)
  const keyed = await readBodies(d, LAN, { ...lanHost, Authorization: `Bearer ${RAW_KEY}` })
  assert.equal(keyed.status, 200)
  assert.match(keyed.text, /settings-gate-secret/)
  const host = await send(d, LOOPBACK, { Host: '127.0.0.1:6996' }, 'GET', '/api/v1/requests?bodies=1', undefined)
  assert.equal(host.status, 200)
  assert.match(await host.text(), /settings-gate-secret/)
})
