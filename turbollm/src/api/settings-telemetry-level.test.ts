// `consent_choice` is a once-ever ping (ADR-299 Decision 5): the first send spends a ledger claim
// for good. The Settings screen sends `telemetryLevel` with EVERY save, so PATCH /api/v1/settings
// must only report it when the level actually changed — otherwise saving an unrelated field
// (port, default ctx…) reports a "choice" the user never made, and a later real opt-out is lost.
//
// Only the unchanged-level side is exercised here: a real change sends over the network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function mkConfig(level: string): Record<string, unknown> {
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
    telemetry: { level, machineId: 'm' },
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

function ledger(dir: string): string[] {
  const p = join(dir, 'telemetry', 'ledger.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as string[]) : []
}

test('PATCH /api/v1/settings: saving an unrelated field with the SAME telemetryLevel does not spend consent_choice', async () => {
  const dir = tmpDir('turbollm-settings-consent-')
  try {
    for (const level of ['full', 'anon', 'off']) {
      const cfg = mkConfig(level)
      const app = new Hono()
      registerApi(app, {
        version: 'test',
        store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
        manager: { status: () => ({ state: 'stopped', model: null }) },
      } as unknown as Deps)

      // Exactly what the Settings screen sends when the user only toggled auto-load.
      const res = await app.request('/api/v1/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoLoadOnStart: true, telemetryLevel: level }),
      })

      assert.equal(res.status, 200)
      assert.equal(cfg.autoLoadOnStart, true)
      assert.ok(!ledger(dir).includes('consent_choice_sent'), `level ${level}: the once-ever claim must stay unspent`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
