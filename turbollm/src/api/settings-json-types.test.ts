// PATCH /api/v1/settings read a few fields with a string or array method (comfyui.url's trim, the
// search keys' trim, remoteAccess.tokenGrant's filter) and every field off the body itself, with
// no check of the JSON type first. A number, an object or null there threw a TypeError out of the
// route, which went out as Hono's bare text/plain "Internal Server Error" 500 instead of the
// route's own 400 invalid_config_value.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { defaultConfig } from '../config/config'
import type { Deps } from '../deps'

function mkApp() {
  const cfg = defaultConfig()
  const app = new Hono()
  const d = {
    version: 'test',
    // Applies to a copy and commits it only when the function returns, as ConfigStore.update does.
    store: {
      snapshot: () => cfg,
      update: (fn: (c: typeof cfg) => void) => { const work = structuredClone(cfg); fn(work); Object.assign(cfg, work) },
      dir: () => '.',
    },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  registerApi(app, d)
  const patch = (raw: string) => app.request('/api/v1/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: raw,
  })
  return { cfg, patch }
}

test('PATCH /api/v1/settings answers a wrong JSON type with 400 invalid_config_value, not a bare 500', async () => {
  const cases: Array<[string, unknown]> = [
    ['comfyui.url', { comfyui: { url: 8188 } }],
    ['search.tavilyApiKey', { search: { tavilyApiKey: 123 } }],
    ['search.kagiApiKey', { search: { kagiApiKey: { key: 'k' } } }],
    ['search.searxngUrl', { search: { searxngUrl: null } }],
    ['remoteAccess.tokenGrant.capabilities', { remoteAccess: { tokenGrant: { capabilities: 'models:use' } } }],
    ['remoteAccess.tokenGrant.models', { remoteAccess: { tokenGrant: { models: 5 } } }],
    ['a null body', null],
    ['an array body', [{ autoLoadOnStart: true }]],
    ['a string body', 'autoLoadOnStart'],
  ]
  for (const [label, body] of cases) {
    const { cfg, patch } = mkApp()
    const before = structuredClone(cfg)
    // An unrelated valid field rides along: a refused patch writes none of it.
    const raw = body !== null && typeof body === 'object' && !Array.isArray(body)
      ? JSON.stringify({ autoLoadOnStart: !cfg.autoLoadOnStart, ...body })
      : JSON.stringify(body)
    const res = await patch(raw)
    assert.equal(res.status, 400, `${label}: ${res.status}`)
    assert.match(res.headers.get('Content-Type') ?? '', /application\/json/, label)
    const json = await res.json() as { error: { code: string; message: string } }
    assert.equal(json.error.code, 'invalid_config_value', label)
    if (label.includes('.')) assert.ok(json.error.message.includes(label), `${label}: ${json.error.message}`)
    assert.deepEqual(cfg, before, `${label}: nothing is written`)
  }
})

test('PATCH /api/v1/settings still takes those fields with the right JSON type', async () => {
  const { cfg, patch } = mkApp()
  const res = await patch(JSON.stringify({
    comfyui: { url: ' http://127.0.0.1:8188 ' },
    search: { tavilyApiKey: ' tv ', kagiApiKey: '', searxngUrl: 'http://searx.local' },
    remoteAccess: { tokenGrant: { capabilities: ['models:use', 7], models: ['m1'] } },
  }))
  assert.equal(res.status, 200)
  assert.equal(cfg.comfyui.url, 'http://127.0.0.1:8188')
  assert.equal(cfg.tools.search?.tavilyApiKey, 'tv')
  assert.equal(cfg.tools.search?.kagiApiKey, undefined)
  assert.equal(cfg.tools.search?.searxngUrl, 'http://searx.local')
  // Only the shape is checked here: entries that are not strings are dropped, as before.
  assert.deepEqual(cfg.remoteAccess.tokenGrant.capabilities, ['models:use'])
  assert.deepEqual(cfg.remoteAccess.tokenGrant.models, ['m1'])
})

// Every other field was read with `!!`, String() or Number(), which took any JSON type and stored
// what that made of it, with a 200: "false" turned lanBind (a rebind onto the LAN) or autoAllowAll
// on, null turned requireApiKey off and stored a token as the text "null", null made
// vramHeadroomMb 0 (VRAM spill) and modelDefaults.ngl 0 (no GPU offload).
test('PATCH /api/v1/settings answers a boolean, string or number field of another JSON type, null included, with 400 rather than coercing it', async () => {
  const nest = (path: string, v: unknown): Record<string, unknown> =>
    path.split('.').reduceRight<unknown>((inner, key) => ({ [key]: inner }), v) as Record<string, unknown>
  const cases: Array<[string, unknown]> = [
    ['lanBind', 'false'],
    ['requireApiKey', null],
    ['autoAllowAll', 'false'],
    ['autoGenerateTitles', 1],
    ['autoMemoryEnabled', 0],
    ['openBrowserOnStart', 'true'],
    ['autoLoadOnStart', null],
    ['showAllEngineModels', 'yes'],
    ['comfyui.enabled', 1],
    ['comfyui.reverseGate', null],
    ['gateway.autoSwap', 'false'],
    ['requestLog.enabled', 0],
    ['requestLog.captureBodies', 'false'],
    ['experimental.memory', 1],
    ['experimental.cloudDeploy', null],
    ['experimental.routines', 'true'],
    ['experimental.turboLink', 0],
    ['experimental.remoteAccess', 'false'],
    ['remoteAccess.cloudflare.requireAccess', null],
    ['machineName', 42],
    ['hfToken', null],
    ['ghToken', null],
    ['tavilyApiKey', 5],
    ['cloudDeploy.runpodTemplateId', 123],
    ['remoteAccess.cloudflare.tunnelToken', null],
    ['remoteAccess.cloudflare.hostname', 5],
    ['remoteAccess.cloudflare.accessTeamDomain', {}],
    ['remoteAccess.cloudflare.accessAud', []],
    ['remoteAccess.ngrok.authtoken', null],
    ['remoteAccess.ngrok.domain', 5],
    ['remoteAccess.custom.publicUrl', 42],
    ['idleTtlMinutes', null],
    ['port', '6997'],
    ['vramHeadroomMb', null],
    ['modelDefaults.ctx', '4096'],
    ['modelDefaults.ngl', null],
    ['modelDefaults.imageMaxTokens', null],
    ['modelDefaults.maxTokens', true],
    ['gateway.keepN', '2'],
    ['remoteAccess.ingressPort', null],
    ['remoteAccess.tailscale.port', '8443'],
    ['build.toolchainDirs', [null]],
    ['code.agentsMdProjectCandidates', [5]],
    ['code.agentsMdGlobalCandidates', [null]],
  ]
  for (const [field, value] of cases) {
    const { cfg, patch } = mkApp()
    const before = structuredClone(cfg)
    const res = await patch(JSON.stringify({ autoLoadOnStart: !cfg.autoLoadOnStart, ...nest(field, value) }))
    const label = `${field}: ${JSON.stringify(value)}`
    assert.equal(res.status, 400, `${label}: ${res.status}`)
    const json = await res.json() as { error: { code: string; message: string } }
    assert.equal(json.error.code, 'invalid_config_value', label)
    assert.ok(json.error.message.startsWith(`${field} must be`), `${label}: ${json.error.message}`)
    assert.deepEqual(cfg, before, `${label}: nothing is written`)
  }
})

test('PATCH /api/v1/settings still takes every such field with its own JSON type, as the Settings screen sends it', async () => {
  const { cfg, patch } = mkApp()
  const res = await patch(JSON.stringify({
    lanBind: false, requireApiKey: true, autoAllowAll: false, autoGenerateTitles: false, autoMemoryEnabled: true,
    openBrowserOnStart: false, autoLoadOnStart: true, showAllEngineModels: true,
    comfyui: { enabled: true, reverseGate: false }, gateway: { autoSwap: true, keepN: 2 },
    requestLog: { enabled: true, captureBodies: true },
    experimental: { memory: true, cloudDeploy: false, routines: true, turboLink: false, remoteAccess: true },
    machineName: ' box ', hfToken: ' hf ', ghToken: '', cloudDeploy: { runpodTemplateId: ' t1 ' },
    idleTtlMinutes: 30, port: 7001, vramHeadroomMb: 0,
    modelDefaults: { ctx: 8192, ngl: 0, imageMaxTokens: 0, maxTokens: 512.9 },
    remoteAccess: {
      ingressPort: 7002,
      cloudflare: { tunnelToken: ' tok ', hostname: 'h.example.com', accessTeamDomain: '', accessAud: '', requireAccess: false },
      ngrok: { authtoken: 'ng', domain: '' }, tailscale: { port: 8443 }, custom: { publicUrl: 'https://x.example.com' },
    },
    build: { toolchainDirs: ['/opt/cuda/bin'] },
    code: { agentsMdProjectCandidates: ['AGENTS.md'], agentsMdGlobalCandidates: [] },
  }))
  assert.equal(res.status, 200)
  assert.equal(cfg.daemon.lanBind, false)
  assert.equal(cfg.daemon.requireApiKey, true)
  assert.equal(cfg.daemon.autoMemoryEnabled, true)
  assert.equal(cfg.daemon.machineName, 'box')
  assert.equal(cfg.daemon.port, 7001)
  assert.equal(cfg.daemon.idleTtlMinutes, 30)
  assert.equal(cfg.autoLoadOnStart, true)
  assert.equal(cfg.vramHeadroomMb, 0)
  assert.equal(cfg.hf.token, 'hf')
  assert.equal(cfg.gh?.token, '')
  assert.equal(cfg.cloudDeploy.runpodTemplateId, 't1')
  assert.deepEqual(cfg.modelDefaults, { ...cfg.modelDefaults, ctx: 8192, ngl: 0, imageMaxTokens: 0, maxTokens: 512 })
  assert.equal(cfg.gateway.keepN, 2)
  assert.equal(cfg.requestLog.captureBodies, true)
  assert.equal(cfg.daemon.experimental.routines, true)
  assert.equal(cfg.remoteAccess.ingressPort, 7002)
  assert.equal(cfg.remoteAccess.cloudflare.tunnelToken, 'tok')
  assert.equal(cfg.remoteAccess.tailscale.port, 8443)
  assert.equal(cfg.remoteAccess.custom.publicUrl, 'https://x.example.com')
  assert.deepEqual(cfg.build.toolchainDirs, ['/opt/cuda/bin'])
  assert.deepEqual(cfg.code.agentsMdProjectCandidates, ['AGENTS.md'])
})
