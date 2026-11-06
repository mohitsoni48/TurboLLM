// The SETTINGS table (scalability item 5.3). The route built on it is pinned against the hand-written one it replaced by
// api/settings-equivalence.test.ts; these cover the table's own rules and the settings it exposed for the first time.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig, type Config } from './config'
import { DOWNLOAD_CONCURRENCY, ENGINE_LOAD_STALL_SECONDS, GATEWAY_MAX_BODY_MB } from './config-bounds'
import { Refusal, SETTINGS, hostOnlyChange, parseSettingsPatch, settingsView, type PatchContext } from './settings-schema'

const ctx = (stored: Config = defaultConfig()): PatchContext => ({ stored })

/** The config a body leaves, or the refusal. */
function patched(body: Record<string, unknown>, stored: Config = defaultConfig()): Config | Refusal {
  const parsed = parseSettingsPatch(body, ctx(stored))
  if (parsed instanceof Refusal) return parsed
  const after = structuredClone(stored)
  parsed.apply(after)
  return after
}

const NEW_SETTINGS = [
  { key: 'downloadConcurrency', bound: DOWNLOAD_CONCURRENCY, body: (v: unknown) => ({ downloadConcurrency: v }), read: (c: Config) => c.downloadConcurrency },
  { key: 'engineLoadStallSeconds', bound: ENGINE_LOAD_STALL_SECONDS, body: (v: unknown) => ({ engineLoadStallSeconds: v }), read: (c: Config) => c.engineLoadStallSeconds },
  { key: 'gateway.maxBodyMb', bound: GATEWAY_MAX_BODY_MB, body: (v: unknown) => ({ gateway: { maxBodyMb: v } }), read: (c: Config) => c.gateway.maxBodyMb },
]

for (const s of NEW_SETTINGS) {
  test(`${s.key}: a whole number inside its bound is stored, edges included`, () => {
    for (const v of [s.bound.min, s.bound.max]) {
      const after = patched(s.body(v))
      assert.ok(!(after instanceof Refusal), `${v}: ${after instanceof Refusal ? after.message : ''}`)
      assert.equal(s.read(after), v)
    }
  })

  test(`${s.key}: anything else is a 400 with the bound's message, and nothing is applied`, () => {
    for (const v of [s.bound.min - 1, s.bound.max + 1, s.bound.min + 0.5, String(s.bound.default), null, true]) {
      const r = patched({ ...s.body(v), theme: 'dark' })
      assert.ok(r instanceof Refusal, String(v))
      assert.deepEqual({ status: r.status, code: r.code, message: r.message }, { status: 400, code: 'invalid_config_value', message: s.bound.message })
    }
  })

  test(`${s.key}: host-only, named by its own key`, () => {
    const before = defaultConfig()
    const after = patched(s.body(s.bound.max), before) // every default is below its max
    assert.ok(!(after instanceof Refusal))
    assert.equal(hostOnlyChange(before, after)?.field, s.key)
    // The stored value echoed back unchanged is no change.
    const echoed = patched(s.body(s.read(before)), before)
    assert.ok(!(echoed instanceof Refusal))
    assert.equal(hostOnlyChange(before, echoed), null)
  })
}

test('the new settings are in the GET payload, read from the stored config', () => {
  const c = defaultConfig()
  c.downloadConcurrency = 6
  c.engineLoadStallSeconds = 0
  c.gateway.maxBodyMb = 512
  const v = settingsView(c)
  assert.deepEqual([v.downloadConcurrency, v.engineLoadStallSeconds, v.gateway.maxBodyMb], [6, 0, 512])
})

test('every host-only setting the hand-written route listed is still host-only, under the same field and label', () => {
  const declared = new Map(SETTINGS.flatMap((row) => [
    ...(row.hostOnly ? [[row.key, row.hostOnly.label] as const] : []),
    ...row.fields.flatMap((f) => (f.hostOnly ? [[f.key, f.hostOnly.label] as const] : [])),
  ]))
  const legacy: Record<string, string> = {
    lanBind: 'LAN access', requireApiKey: '"Require an API key"', port: 'the port', 'experimental.remoteAccess': 'remote access',
    remoteAccess: 'remote access', 'build.toolchainDirs': 'the build toolchain folders', toolPolicies: 'tool permissions',
    autoAllowAll: '"Auto-allow all"', 'requestLog.enabled': 'the request log', 'requestLog.captureBodies': '"Log prompts and responses"',
    'retention.enabled': 'data retention', 'retention.apiUsageRawDays': 'data retention', 'retention.routineRunsKept': 'data retention',
    hfToken: 'the Hugging Face token', ghToken: 'the GitHub token', 'search.tavilyApiKey': 'the Tavily API key',
    'search.kagiApiKey': 'the Kagi API key', 'search.searxngUrl': 'the SearXNG URL',
  }
  for (const [field, label] of Object.entries(legacy)) assert.equal(declared.get(field), label, field)
})

test('a field the body names marks its row\'s side effect; one it leaves out does not', () => {
  const effects = (body: Record<string, unknown>) => {
    const p = parseSettingsPatch(body, ctx())
    assert.ok(!(p instanceof Refusal))
    return p.effects
  }
  assert.deepEqual(effects({ theme: 'dark' }), [])
  assert.deepEqual(effects({ search: {} }), ['rebuildTools'])
  assert.deepEqual(effects({ tavilyApiKey: 'k', search: { provider: 'kagi' } }), ['rebuildTools'])
  assert.deepEqual(effects({ telemetryLevel: 'off', requireApiKey: true }), ['reportConsent', 'endStaleStreams'])
  assert.deepEqual(effects({ experimental: { memory: true } }), ['stopRemoteAccess'])
})

test('a type error anywhere wins over a value error anywhere, as the hand-written route checked them', () => {
  const r = parseSettingsPatch({ theme: 'neon', autoAllowAll: 'yes' }, ctx())
  assert.ok(r instanceof Refusal)
  assert.equal(r.message, 'autoAllowAll must be true or false.')
})

test('row keys are unique, and so are PATCH keys', () => {
  const rows = SETTINGS.map((r) => r.key)
  assert.equal(new Set(rows).size, rows.length)
  const fields = SETTINGS.flatMap((r) => r.fields.map((f) => f.key))
  assert.equal(new Set(fields).size, fields.length)
})
