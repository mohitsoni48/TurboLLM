// GitHub #288: PATCH /api/v1/settings takes modelDefaults.kvTypeK / kvTypeV. '' is automatic; any
// other value must be a plain cache type name, and a bad one is refused without touching the rest.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'

function mkConfig(): Record<string, unknown> {
  return {
    apiKeys: [],
    links: [],
    modelDirs: [],
    primaryModelDir: '',
    autoLoadOnStart: false,
    vramHeadroomMb: 1024,
    modelDefaults: { ctx: 4096, ngl: 99, imageMaxTokens: 0, maxTokens: 0 },
    comfyui: { enabled: false, url: '', reverseGate: false },
    gateway: { autoSwap: true, keepN: 1 },
    telemetry: { level: 'anon', machineId: 'm' },
    hf: { token: '' },
    tools: { search: { provider: 'tavily' }, toolPolicies: {}, autoAllowAll: false },
    mcp: { servers: [] },
    build: { toolchainDirs: [] },
    code: { agentsMdProjectCandidates: [], agentsMdGlobalCandidates: [], defaultAgent: 'turbollm' },
    cloudDeploy: { runpodTemplateId: '' },
    remoteAccess: {
      enabled: false,
      provider: 'cloudflare-quick',
      ingressPort: 6997,
      cloudflare: { tunnelToken: '', hostname: '', accessTeamDomain: '', accessAud: '', requireAccess: false },
      ngrok: { authtoken: '', domain: '' },
      tailscale: { port: 443 },
      custom: { publicUrl: '' },
      tokenGrant: { capabilities: ['models:use'] },
      lastUrl: '',
    },
    daemon: {
      port: 6996, lanBind: false, requireApiKey: false, theme: 'system', idleTtlMinutes: 30,
      autoGenerateTitles: true, autoMemoryEnabled: false, openBrowserOnStart: true,
      experimental: { memory: false, cloudDeploy: false, routines: false, turboLink: true },
    },
  }
}

function mkApp() {
  const cfg = mkConfig()
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '.' },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  registerApi(app, d)
  const md = () => cfg.modelDefaults as Record<string, unknown>
  return { app, md }
}

const patch = (app: Hono, body: unknown) => app.request('/api/v1/settings', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

test('PATCH stores default K and V cache types, and GET returns them', async () => {
  const { app, md } = mkApp()
  const res = await patch(app, { modelDefaults: { kvTypeK: 'q8_0', kvTypeV: 'q4_0' } })
  assert.equal(res.status, 200)
  assert.equal(md().kvTypeK, 'q8_0')
  assert.equal(md().kvTypeV, 'q4_0')
  assert.equal(md().ctx, 4096, 'a partial patch keeps the other defaults')
  const body = await (await app.request('/api/v1/settings')).json() as { modelDefaults: Record<string, unknown> }
  assert.equal(body.modelDefaults.kvTypeK, 'q8_0')
  assert.equal(body.modelDefaults.kvTypeV, 'q4_0')
})

test('PATCH takes "" back to automatic', async () => {
  const { app, md } = mkApp()
  await patch(app, { modelDefaults: { kvTypeK: 'q8_0' } })
  const res = await patch(app, { modelDefaults: { kvTypeK: '' } })
  assert.equal(res.status, 200)
  assert.equal(md().kvTypeK, '')
})

test('PATCH refuses a cache type that is not a plain name, and stores nothing from that patch', async () => {
  for (const bad of ['q8_0 --mlock', 'Q8_0', '../x', 8, null, 'a'.repeat(17)]) {
    const { app, md } = mkApp()
    const res = await patch(app, { modelDefaults: { ctx: 8192, kvTypeV: bad } })
    assert.equal(res.status, 400, `refused: ${JSON.stringify(bad)}`)
    assert.equal(md().kvTypeV, undefined)
    assert.equal(md().ctx, 4096, 'the valid half of the patch did not land')
  }
})
