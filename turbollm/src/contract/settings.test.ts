// The settings contract against the payload the daemon builds from its SETTINGS table. The type side is checked by tsc
// (the assignments below, and the exact-keys check in settings-schema.ts); this pins that every declared key is sent.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig } from '../config/config'
import { settingsView } from '../config/settings-schema'
import type { DaemonSettings, SettingsPatchResponse } from './settings'

/** Every top-level key DaemonSettings declares, required or optional; `satisfies` fails to compile if one is missing. */
const DECLARED = {
  idleTtlMinutes: 1, port: 1, theme: 1, machineName: 1, autoGenerateTitles: 1, autoMemoryEnabled: 1, openBrowserOnStart: 1,
  autoLoadOnStart: 1, showAllEngineModels: 1, vramHeadroomMb: 1, lanBind: 1, requireApiKey: 1, telemetryLevel: 1,
  modelDefaults: 1, comfyui: 1, gateway: 1, requestLog: 1, retention: 1, hfTokenSet: 1, ghTokenSet: 1, tavilyKeySet: 1,
  search: 1, mcp: 1, build: 1, code: 1, cloudDeploy: 1, experimental: 1, toolPolicies: 1, autoAllowAll: 1,
  chatApprovalWaitMinutes: 1, remoteAccess: 1, downloadConcurrency: 1, engineLoadStallSeconds: 1,
} satisfies Record<keyof DaemonSettings, 1>

test('the daemon sends every key the settings contract declares, and no other', () => {
  const payload: DaemonSettings = settingsView(defaultConfig())
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(DECLARED).sort())
})

test('the payload carries the config-only settings exposed by item 5.3', () => {
  const cfg = defaultConfig()
  const payload: SettingsPatchResponse = settingsView(cfg)
  assert.equal(payload.downloadConcurrency, cfg.downloadConcurrency)
  assert.equal(payload.engineLoadStallSeconds, cfg.engineLoadStallSeconds)
  assert.equal(payload.gateway.maxBodyMb, cfg.gateway.maxBodyMb)
})
