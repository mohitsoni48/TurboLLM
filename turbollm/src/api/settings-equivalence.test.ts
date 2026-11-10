// GET and PATCH /api/v1/settings pinned against what the hand-written route did before the declarative SETTINGS table
// (src/config/settings-schema.ts, scalability item 5.3) replaced it. fixtures/settings-golden.json was recorded from
// that route: the GET payload byte for byte over several configs, and for every PATCH body below the status, the error,
// a hash of the response body, a hash of the config it left, and the side effects it ran — once from the host and once
// from a caller hostGate refuses. Settings exposed after the recording (NEW_KEYS) are left out of both sides.
//
// Re-record (only on purpose, never to make a failure pass): TURBOLLM_SETTINGS_GOLDEN=write npx tsx --test <this file>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { defaultConfig, type Config } from '../config/config'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'
import { registerSettingsRoutes } from './settings-routes'

process.env.TURBOLLM_TELEMETRY = 'off' // a telemetryLevel change would otherwise send the consent ping

const GOLDEN = join(import.meta.dirname, 'fixtures', 'settings-golden.json')
const WRITE = process.env.TURBOLLM_SETTINGS_GOLDEN === 'write'
/** Top-level payload keys added after the recording. */
const NEW_KEYS = ['downloadConcurrency', 'engineLoadStallSeconds']
/** `experimental` flags added after the recording, dropped from the payload and from the config hash alike. */
const NEW_EXPERIMENTAL = ['sandbox']

type Remote = 'none' | 'off' | 'on'

function mkDeps(cfg: Config, remote: Remote) {
  let live = cfg
  let dir: string | undefined
  const calls: string[] = []
  const remoteKind = remote === 'on' ? 'connected' : 'off'
  const d = {
    version: 'test',
    store: {
      snapshot: () => structuredClone(live),
      read: () => live,
      update: (fn: (c: Config) => void) => { const work = structuredClone(live); fn(work); live = work },
      dir: () => (dir ??= tmpDir('settings-equivalence-')),
    },
    tools: {
      updateConfig: () => { calls.push('tools.updateConfig') },
      buildToolDefinitions: async () => { calls.push('tools.buildToolDefinitions') },
    },
    rebind: () => {},
    remote: remote === 'none' ? undefined : {
      state: () => ({ kind: remoteKind }),
      ingressPort: () => (remote === 'on' ? 6997 : undefined),
      targetIngressPort: () => 6997,
      disable: async () => { calls.push('remote.disable') },
    },
  } as unknown as Deps
  const app = new Hono()
  registerSettingsRoutes(app, d)
  return { app, calls, config: () => live }
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

function withoutNewExperimental(experimental: unknown): unknown {
  if (!experimental || typeof experimental !== 'object') return experimental
  return Object.fromEntries(Object.entries(experimental).filter(([k]) => !NEW_EXPERIMENTAL.includes(k)))
}

function withoutNewKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(payload).filter(([k]) => !NEW_KEYS.includes(k)))
  return 'experimental' in kept ? { ...kept, experimental: withoutNewExperimental(kept.experimental) } : kept
}

function configAsRecorded(c: Config): unknown {
  return { ...c, daemon: { ...c.daemon, experimental: withoutNewExperimental(c.daemon.experimental) } }
}

// ── configs the GET payload is pinned over ──
function richConfig(): Config {
  const c = defaultConfig()
  c.daemon.idleTtlMinutes = 45
  c.daemon.port = 7100
  c.daemon.theme = 'dark'
  c.daemon.machineName = 'rig'
  c.daemon.lanBind = true
  c.daemon.requireApiKey = false
  c.daemon.experimental = { memory: true, cloudDeploy: true, routines: true, turboLink: false, remoteAccess: true, sandbox: false }
  c.vramHeadroomMb = 0
  c.telemetry.level = 'anon'
  c.modelDefaults = { ...c.modelDefaults, ctx: 32768, ngl: 40, kvTypeK: 'q8_0', kvTypeV: 'q8_0' }
  c.comfyui = { enabled: true, gatePath: '/comfy/custom_nodes/gate', url: 'http://127.0.0.1:8188', reverseGate: true, cachePersist: false }
  c.gateway = { autoSwap: false, keepN: 3, maxBodyMb: 64 }
  c.requestLog = { enabled: false, captureBodies: true, maxEntries: 900 }
  c.retention = { enabled: false, apiUsageRawDays: 365, routineRunsKept: 50 }
  c.hf.token = 'hf_secret'
  c.gh = { token: 'gh_secret' }
  c.tools = {
    tavily: { apiKey: 'tv_legacy' },
    search: { provider: 'searxng', tavilyApiKey: 'tv_new', kagiApiKey: 'kg', searxngUrl: 'http://searx.local' },
    toolPolicies: { run_code: 'allow', web_search: 'deny' },
    autoAllowAll: true,
    chatApprovalWaitMinutes: 0,
  }
  c.mcp = {
    servers: [
      { id: 'a', name: 'stdio one', transport: 'stdio', command: 'npx', args: ['srv'], env: { TOKEN: 'secret', EMPTY: '' }, enabled: true },
      { id: 'b', name: 'sse one', transport: 'sse', url: 'http://mcp.local/sse', apiKey: 'bearer', enabled: false },
    ],
  }
  c.build.toolchainDirs = ['/opt/cuda/bin', 'C:\\tools']
  c.code = { agentsMdProjectCandidates: ['AGENTS.md'], agentsMdGlobalCandidates: ['CLAUDE.md', 'agents.md'], defaultAgent: 'pi' }
  c.cloudDeploy = { runpodTemplateId: 'tmpl-1' }
  c.remoteAccess = {
    ...c.remoteAccess,
    enabled: true,
    provider: 'cloudflare-named',
    ingressPort: 7200,
    cloudflare: { tunnelToken: 'cf_tok', hostname: 'box.example.com', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'aud', requireAccess: true },
    ngrok: { authtoken: 'ng', domain: 'x.ngrok.app' },
    tailscale: { port: 8443 },
    custom: { publicUrl: 'https://me.example' },
    tokenGrant: { capabilities: ['models:use', 'models:load'], models: ['qwen'] },
    lastUrl: 'https://box.example.com',
  }
  c.autoLoadOnStart = true
  c.showAllEngineModels = true
  c.downloadConcurrency = 5
  c.engineLoadStallSeconds = 0
  return c
}

/** Optional blocks absent, as an old or hand-written file can leave them before normalize fills them. */
function sparseConfig(): Config {
  const c = defaultConfig()
  c.telemetry.level = 'benchmarks'
  c.tools = { tavily: { apiKey: 'legacy-only' } }
  delete (c as Partial<Config>).gh
  delete (c.daemon as { machineName?: string }).machineName
  return c
}

function legacyLevelConfig(): Config {
  const c = defaultConfig()
  c.telemetry.level = 'unset'
  c.tools = { search: { provider: 'kagi', kagiApiKey: 'k' } }
  return c
}

const CONFIGS: Record<string, () => Config> = {
  default: defaultConfig,
  rich: richConfig,
  sparse: sparseConfig,
  legacyLevel: legacyLevelConfig,
}

// ── PATCH bodies ──
/** A body that sets one dotted path. */
function at(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.')
  const root: Record<string, unknown> = {}
  let node = root
  for (const k of keys.slice(0, -1)) node = (node[k] = {}) as Record<string, unknown>
  node[keys[keys.length - 1]] = value
  return root
}

const BOOL = [true, false, 'false', null, 0]
const STR = ['  value  ', '', 5, null]
const BOOLEAN_FIELDS = [
  'autoGenerateTitles', 'autoMemoryEnabled', 'openBrowserOnStart', 'autoLoadOnStart', 'showAllEngineModels', 'lanBind',
  'requireApiKey', 'autoAllowAll', 'comfyui.enabled', 'comfyui.reverseGate', 'gateway.autoSwap', 'requestLog.enabled',
  'requestLog.captureBodies', 'retention.enabled', 'experimental.memory', 'experimental.cloudDeploy', 'experimental.routines',
  'experimental.turboLink', 'experimental.remoteAccess', 'remoteAccess.cloudflare.requireAccess',
]
const STRING_FIELDS = [
  'machineName', 'hfToken', 'ghToken', 'tavilyApiKey', 'cloudDeploy.runpodTemplateId', 'search.tavilyApiKey', 'search.kagiApiKey',
  'search.searxngUrl', 'remoteAccess.cloudflare.tunnelToken', 'remoteAccess.cloudflare.hostname',
  'remoteAccess.cloudflare.accessTeamDomain', 'remoteAccess.cloudflare.accessAud', 'remoteAccess.ngrok.authtoken',
  'remoteAccess.ngrok.domain', 'remoteAccess.custom.publicUrl',
]
const VALUES: Record<string, unknown[]> = {
  idleTtlMinutes: [0, 30, 1.5, -1, '5', null],
  port: [1023, 1024, 6996, 6997, 7000, 65535, 65536, 8080.5, '7000', null],
  theme: ['system', 'light', 'dark', 'neon', 5, null],
  machineName: ['  box  ', 'a'.repeat(80), '', 5, null],
  vramHeadroomMb: [0, 299, 300, 1500.6, 2048, 2049, -1, '1024', null],
  telemetryLevel: ['off', 'anon', 'full', 'benchmarks', 5, null],
  modelDefaults: [5, 'abc', null, [], {}],
  'modelDefaults.ctx': [255, 256, 4096.7, -1, 'x', null],
  'modelDefaults.ngl': [-1, 0, 99, 99.7, 100, '9'],
  'modelDefaults.imageMaxTokens': [0, -1, 10.5, null],
  'modelDefaults.maxTokens': [0, -1, 2048, true],
  'modelDefaults.kvTypeK': ['', 'f16', 'q8_0', 'BAD', 'x'.repeat(17), 5, null],
  'modelDefaults.kvTypeV': ['', 'turbo3', 'q-4', 5],
  comfyui: [5, null, 'x'],
  'comfyui.url': ['', ' http://127.0.0.1:8188 ', 'HTTPS://host', 'ftp://x', 8188, null],
  gateway: [5, null],
  'gateway.keepN': [0, 1, 4, 5, 2.5, '2', null],
  'retention.apiUsageRawDays': [30, 31, 3650, 3651, 90.5, '90', null],
  'retention.routineRunsKept': [9, 10, 100000, 100001, 20.5],
  'build.toolchainDirs': [[], ['/opt/cuda'], ['C:\\cuda', '  ', ' /x '], ['rel/path'], '/x', [5], null, ['\\\\unc\\share']],
  'code.agentsMdProjectCandidates': [['AGENTS.md'], [], [' a.md ', ''], ['/abs'], ['C:\\abs'], Array(9).fill('x.md'), 'x', [null], null],
  'code.agentsMdGlobalCandidates': [['CLAUDE.md'], ['/abs'], 5],
  'code.defaultAgent': ['turbollm', 'pi', 'claude', 'opencode', 'vim', 5, null],
  code: [5],
  toolPolicies: [{ a: 'allow', b: 'ask', c: 'deny' }, { a: 'maybe' }, [], null, 'x', {}],
  chatApprovalWaitMinutes: [0, 30, 1440, 1441, -1, 1.5, '30', null],
  experimental: [5, null],
  search: [5, null, {}, 'x'],
  'search.provider': ['kagi', 'searxng', 'tavily', 'bing', 5, null],
  remoteAccess: [5, null],
  'remoteAccess.provider': ['ngrok', 'cloudflare-named', 'cloudflare-quick', 'bogus', 5],
  'remoteAccess.ingressPort': [7000, 6996, 7100, 0, 'x', null],
  'remoteAccess.tailscale.port': [443, 8443, 10000, 9999, '443', null],
  'remoteAccess.tokenGrant.capabilities': [['models:use', 5, 'models:load'], [], 'x', null],
  'remoteAccess.tokenGrant.models': [['a'], 5],
  'remoteAccess.enabled': [true],
  'remoteAccess.lastUrl': ['https://x'],
  unknownField: [1],
}
for (const f of BOOLEAN_FIELDS) VALUES[f] ??= BOOL
for (const f of STRING_FIELDS) VALUES[f] ??= STR

/** Bodies that touch several fields at once, or that need a particular starting config or remote state. */
const COMBINED: Array<{ name: string; body: unknown; config?: () => Config; remote?: Remote }> = [
  { name: 'not an object: null', body: null },
  { name: 'not an object: array', body: [{ autoLoadOnStart: true }] },
  { name: 'not an object: string', body: 'x' },
  { name: 'empty object', body: {} },
  { name: 'port and lanBind (rebind)', body: { port: 7000, lanBind: true } },
  { name: 'lanBind only (rebind, bound port kept)', body: { lanBind: true } },
  { name: 'port onto the ingress while remote is on', body: { port: 6997 }, remote: 'on' },
  { name: 'port onto the ingress while remote is off', body: { port: 6997 }, remote: 'off' },
  { name: 'port onto the ingress while remote is enabled but off', body: { port: 6997 }, remote: 'off', config: () => { const c = defaultConfig(); c.remoteAccess.enabled = true; return c } },
  { name: 'provider change while connected', body: { remoteAccess: { provider: 'ngrok' } }, remote: 'on' },
  { name: 'provider unchanged while connected', body: { remoteAccess: { provider: 'cloudflare-quick' } }, remote: 'on' },
  { name: 'provider change while off and enabled', body: { remoteAccess: { provider: 'ngrok' } }, remote: 'off', config: () => { const c = defaultConfig(); c.remoteAccess.enabled = true; return c } },
  { name: 'provider change while off', body: { remoteAccess: { provider: 'ngrok' } }, remote: 'off' },
  { name: 'requireApiKey back on', body: { requireApiKey: true }, config: () => { const c = defaultConfig(); c.daemon.requireApiKey = false; return c } },
  { name: 'experimental remote access off while enabled', body: { experimental: { remoteAccess: false } }, remote: 'off', config: () => { const c = defaultConfig(); c.daemon.experimental.remoteAccess = true; c.remoteAccess.enabled = true; return c } },
  { name: 'ingress port resolved against a new daemon port', body: { port: 7300, remoteAccess: { ingressPort: 7300 } } },
  { name: 'tavily alias and search key together', body: { tavilyApiKey: ' a ', search: { tavilyApiKey: 'b', provider: 'kagi' } } },
  { name: 'tavily alias cleared', body: { tavilyApiKey: '' }, config: richConfig },
  { name: 'echo of the rich config', body: { theme: 'dark', port: 7100, lanBind: true, requireApiKey: false, telemetryLevel: 'anon', hfToken: '', ghToken: '', search: {}, build: { toolchainDirs: ['/opt/cuda/bin', 'C:\\tools'] }, requestLog: { enabled: false, captureBodies: true } }, config: richConfig },
  { name: 'type error after a value error', body: { theme: 'neon', autoAllowAll: 'yes' } },
  { name: 'value error then 409', body: { theme: 'neon', remoteAccess: { provider: 'ngrok' } }, remote: 'on' },
  { name: '409 then host-only', body: { lanBind: true, remoteAccess: { provider: 'ngrok' } }, remote: 'on' },
  { name: 'everything valid at once', body: {
    idleTtlMinutes: 10, theme: 'light', machineName: 'm', autoGenerateTitles: false, vramHeadroomMb: 512, telemetryLevel: 'full',
    modelDefaults: { ctx: 8192, ngl: 20, imageMaxTokens: 100, maxTokens: 50, kvTypeK: 'f16', kvTypeV: '' },
    comfyui: { enabled: true, url: 'http://c', reverseGate: true }, gateway: { autoSwap: false, keepN: 2 },
    retention: { apiUsageRawDays: 60 }, code: { defaultAgent: 'claude' }, chatApprovalWaitMinutes: 5,
    cloudDeploy: { runpodTemplateId: 't' }, experimental: { routines: true },
  } },
]

const NON_HOST = { host: 'attacker.example' }

interface PatchRecord { status: number; error?: unknown; body: string; config: string; calls: string[] }

async function runPatch(body: unknown, config: () => Config, remote: Remote, host: boolean): Promise<PatchRecord> {
  const { app, calls, config: after } = mkDeps(config(), remote)
  const res = await app.request('/api/v1/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(host ? {} : NON_HOST) },
    body: JSON.stringify(body),
  })
  const json = await res.json() as Record<string, unknown>
  return {
    status: res.status,
    ...(res.status === 200 ? {} : { error: json.error }),
    body: hash(withoutNewKeys(json)),
    config: hash(configAsRecorded(after())),
    calls,
  }
}

async function record(): Promise<{ get: Record<string, string>; patch: Record<string, PatchRecord> }> {
  const get: Record<string, string> = {}
  for (const [name, config] of Object.entries(CONFIGS)) {
    const { app } = mkDeps(config(), 'none')
    const json = await (await app.request('/api/v1/settings')).json() as Record<string, unknown>
    get[name] = JSON.stringify(withoutNewKeys(json))
  }
  const patch: Record<string, PatchRecord> = {}
  const cases = [
    ...Object.entries(VALUES).flatMap(([path, values]) =>
      values.map((v) => ({ name: `${path} = ${JSON.stringify(v)}`, body: at(path, v), config: defaultConfig, remote: 'none' as Remote }))),
    ...COMBINED.map((c) => ({ name: c.name, body: c.body, config: c.config ?? defaultConfig, remote: c.remote ?? 'none' })),
  ]
  for (const c of cases) {
    for (const host of [true, false]) {
      patch[`${host ? 'host' : 'non-host'} | ${c.name}`] = await runPatch(c.body, c.config, c.remote, host)
    }
  }
  return { get, patch }
}

/** The one recorded answer the table changes on purpose. When a caller hostGate refuses changes several host-only
 *  settings in one save, the refusal names the first in table (payload) order; the hand-written list put lanBind
 *  before port. Either is a correct refusal of the same save, with nothing written. */
const INTENDED_CHANGES: Record<string, unknown> = {
  'non-host | port and lanBind (rebind)': {
    code: 'api_key_required', message: 'Changing the port requires a valid API key.', field: 'port',
  },
}

test('GET and PATCH /api/v1/settings answer exactly as the hand-written route did', async () => {
  const now = await record()
  if (WRITE) {
    writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n')
    return
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof now
  for (const name of Object.keys(golden.get)) assert.equal(now.get[name], golden.get[name], `GET over the ${name} config`)
  assert.deepEqual(Object.keys(now.patch), Object.keys(golden.patch))
  const differing = Object.keys(golden.patch).filter((name) => JSON.stringify(now.patch[name]) !== JSON.stringify(golden.patch[name]))
  assert.deepEqual(differing, Object.keys(INTENDED_CHANGES))
  for (const [name, error] of Object.entries(INTENDED_CHANGES)) assert.deepEqual(now.patch[name].error, error, name)
})
