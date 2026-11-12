// Data retention (config.retention, scalability review 2.4): on by default, raw gateway usage kept 90 days before it
// folds into daily totals, the newest 200 runs kept per routine. Bounds in config-bounds.ts (RETENTION_BOUNDS).
// Stored by PATCH /api/v1/settings field by field and served by GET; a config written before it, or hand-edited out of
// range, loads with the defaults.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ConfigStore } from '../config/config'
import { RETENTION_BOUNDS } from '../config/config-bounds'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function app(store: ConfigStore) {
  const a = new Hono()
  registerApi(a, { version: 'test', store, manager: { status: () => ({ state: 'stopped', model: null }) } } as unknown as Deps)
  return a
}

const patch = (a: Hono, body: unknown) => a.request('/api/v1/settings', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

const DEFAULTS = { enabled: true, apiUsageRawDays: 90, routineRunsKept: 200 }

test('retention is on by default (90 days raw, 200 runs), and PATCH stores each field on its own', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-retention-'), 'config.json'))
  const a = app(store)
  const get = async () => ((await (await a.request('/api/v1/settings')).json()) as { retention?: unknown }).retention

  assert.deepEqual(await get(), DEFAULTS)
  assert.equal((await patch(a, { retention: { apiUsageRawDays: 31 } })).status, 200)
  assert.equal((await patch(a, { retention: { routineRunsKept: 100_000 } })).status, 200)
  assert.equal((await patch(a, { retention: { enabled: false } })).status, 200)
  const expected = { enabled: false, apiUsageRawDays: 31, routineRunsKept: 100_000 }
  assert.deepEqual(await get(), expected)
  assert.deepEqual(store.snapshot().retention, expected)
  assert.equal((await patch(a, { retention: { apiUsageRawDays: 3650, routineRunsKept: 10, enabled: true } })).status, 200)
  assert.deepEqual(await get(), { enabled: true, apiUsageRawDays: 3650, routineRunsKept: 10 })
})

test('PATCH refuses a retention value out of bounds, a fraction or another JSON type, and stores nothing', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-retention-'), 'config.json'))
  const a = app(store)
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ apiUsageRawDays: 30 }, RETENTION_BOUNDS.apiUsageRawDays.message],
    [{ apiUsageRawDays: 3651 }, RETENTION_BOUNDS.apiUsageRawDays.message],
    [{ apiUsageRawDays: 45.5 }, RETENTION_BOUNDS.apiUsageRawDays.message],
    [{ apiUsageRawDays: '90' }, RETENTION_BOUNDS.apiUsageRawDays.message],
    [{ routineRunsKept: 9 }, RETENTION_BOUNDS.routineRunsKept.message],
    [{ routineRunsKept: 100_001 }, RETENTION_BOUNDS.routineRunsKept.message],
    [{ routineRunsKept: null }, RETENTION_BOUNDS.routineRunsKept.message],
    [{ enabled: 'false' }, 'retention.enabled must be true or false.'],
  ]
  for (const [retention, message] of cases) {
    const before = store.snapshot().autoLoadOnStart
    const res = await patch(a, { retention: { ...retention, enabled: retention.enabled ?? false }, autoLoadOnStart: !before })
    assert.equal(res.status, 400, JSON.stringify(retention))
    const { error } = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(error.code, 'invalid_config_value')
    assert.equal(error.message, message)
    assert.deepEqual(store.snapshot().retention, DEFAULTS, `${JSON.stringify(retention)}: unchanged`)
    assert.equal(store.snapshot().autoLoadOnStart, before, 'nothing else is written either')
  }
})

test('a config written before retention, or hand-edited out of range, loads with the defaults; a fraction is floored', () => {
  const dir = tmpDir('tllm-retention-')
  const cases: Array<[unknown, typeof DEFAULTS]> = [
    [undefined, DEFAULTS],
    [{}, DEFAULTS],
    [{ enabled: false, apiUsageRawDays: 400, routineRunsKept: 50 }, { enabled: false, apiUsageRawDays: 400, routineRunsKept: 50 }],
    [{ enabled: 'no', apiUsageRawDays: 5, routineRunsKept: -1 }, DEFAULTS],
    [{ apiUsageRawDays: 45.9, routineRunsKept: 'many' }, { ...DEFAULTS, apiUsageRawDays: 45 }],
  ]
  for (const [value, expected] of cases) {
    const path = join(dir, 'config.json')
    const raw = JSON.parse(JSON.stringify(ConfigStore.load(join(dir, 'seed.json')).snapshot())) as Record<string, unknown>
    if (value === undefined) delete raw.retention
    else raw.retention = value
    writeFileSync(path, JSON.stringify(raw))
    assert.deepEqual(ConfigStore.load(path).snapshot().retention, expected, JSON.stringify(value))
  }
})
