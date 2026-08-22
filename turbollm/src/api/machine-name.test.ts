// Regression tests for the ADR-376 final review's I-2: `daemon.machineName` was a config
// field NOTHING ever wrote — no Settings field, no PATCH key, no default — so every host
// in the world answered `hello` with the literal string "TurboLLM". A peer with two links
// saw two identical rows, and `describeStatus`'s deliberately machine-naming copy ("X is
// offline") named the same constant for both.
//
// Two halves, both tested here: the daemon now RESOLVES an unset name to the OS hostname,
// and the user can now SET one through /api/v1/settings.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { registerLinkApi, resolveMachineName } from '../link/link-routes'
import type { Deps } from '../deps'
import type { HelloResponse } from '../link/types'

function mkConfig(machineName?: string): Record<string, unknown> {
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
    daemon: {
      port: 6996, lanBind: false, requireApiKey: false, theme: 'system', idleTtlMinutes: 30,
      autoGenerateTitles: true, autoMemoryEnabled: false, openBrowserOnStart: true,
      experimental: { memory: false, cloudDeploy: false, routines: false, turboLink: true },
      ...(machineName === undefined ? {} : { machineName }),
    },
  }
}

function mkApp(cfg: Record<string, unknown>) {
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '.' },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  registerApi(app, d)
  return { app, cfg }
}

test('GET /api/v1/settings exposes machineName, and reports "" when the user has not set one', async () => {
  const { app } = mkApp(mkConfig())
  const body = await (await app.request('/api/v1/settings')).json() as { machineName: string }
  assert.equal(body.machineName, '')
})

test('PATCH /api/v1/settings persists a machine name, trimmed', async () => {
  const { app, cfg } = mkApp(mkConfig())
  const res = await app.request('/api/v1/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machineName: '  workstation  ' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json() as { machineName: string }).machineName, 'workstation')
  assert.equal((cfg.daemon as { machineName: string }).machineName, 'workstation')
})

test('PATCH /api/v1/settings accepts "" as a clear — meaning "use the hostname", not an error', async () => {
  const { app, cfg } = mkApp(mkConfig('workstation'))
  const res = await app.request('/api/v1/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machineName: '' }),
  })
  assert.equal(res.status, 200)
  assert.equal((cfg.daemon as { machineName: string }).machineName, '')
})

test('resolveMachineName falls back to the OS hostname, never to a constant every host shares', () => {
  assert.equal(resolveMachineName('workstation'), 'workstation')
  assert.equal(resolveMachineName('  spaced  '), 'spaced')
  assert.equal(resolveMachineName(undefined), hostname())
  assert.equal(resolveMachineName(''), hostname())
})

// ── The value the peer actually receives ─────────────────────────────────────────────

const RAW = 'tllm-hello-machine-name'

function linkApp(machineName?: string) {
  const cfg = mkConfig(machineName)
  ;(cfg.apiKeys as unknown[]).push({
    id: 'k1', name: 'link:peer', hash: createHash('sha256').update(RAW).digest('hex'),
    prefix: RAW.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    grant: { capabilities: ['models:use'] },
  })
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
  } as unknown as Deps
  const app = new Hono()
  registerLinkApi(app, d)
  return app
}

async function hello(app: Hono): Promise<HelloResponse> {
  const res = await app.request('/api/link/v1/hello', { method: 'POST', headers: { 'X-TurboLLM-Auth': RAW } })
  assert.equal(res.status, 200)
  return await res.json() as HelloResponse
}

test('hello reports the OS hostname when no machine name is configured (not "TurboLLM")', async () => {
  const body = await hello(linkApp())
  assert.equal(body.machineName, hostname())
})

test('hello reports the user-configured machine name when there is one', async () => {
  const body = await hello(linkApp('kaggle box'))
  assert.equal(body.machineName, 'kaggle box')
})
