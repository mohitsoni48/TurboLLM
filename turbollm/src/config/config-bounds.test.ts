// config-bounds.ts's retention bounds (scalability review 2.4): the settings route and normalize both read them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOWNLOAD_CONCURRENCY, ENGINE_LOAD_STALL_SECONDS, RETENTION_BOUNDS, isRetentionValue } from './config-bounds'
import { ConfigStore, defaultConfig } from './config'
import { tmpDir } from '../test-support/tmp'

test('isRetentionValue takes a whole JSON number inside the field\'s bounds, nothing else', () => {
  for (const field of ['apiUsageRawDays', 'routineRunsKept'] as const) {
    const { min, max, default: dflt } = RETENTION_BOUNDS[field]
    assert.ok(min <= dflt && dflt <= max, `${field}: the default is in range`)
    for (const ok of [min, dflt, max]) assert.equal(isRetentionValue(field, ok), true, `${field} ${ok}`)
    for (const bad of [min - 1, max + 1, min + 0.5, String(dflt), null, undefined, true, Number.NaN]) {
      assert.equal(isRetentionValue(field, bad), false, `${field} ${String(bad)}`)
    }
  }
})

test('the raw gateway rows outlive the dashboards\' widest range (30 days)', () => {
  assert.ok(RETENTION_BOUNDS.apiUsageRawDays.min > 30)
})

// Scalability review 4.9: how many files download at once is config-only; 2 stays the default.
test('downloadConcurrency: 2 by default, a whole in-range value kept, anything else loads as the default', () => {
  assert.equal(DOWNLOAD_CONCURRENCY.default, 2)
  assert.equal(defaultConfig().downloadConcurrency, 2)
  const dir = tmpDir('tllm-cfg-dlc-')
  const path = join(dir, 'config.json')
  const loaded = (value: unknown): number | undefined => {
    writeFileSync(path, JSON.stringify({ downloadConcurrency: value }))
    return ConfigStore.load(path).read().downloadConcurrency
  }
  assert.equal(loaded(DOWNLOAD_CONCURRENCY.max), DOWNLOAD_CONCURRENCY.max)
  assert.equal(loaded(DOWNLOAD_CONCURRENCY.min), DOWNLOAD_CONCURRENCY.min)
  for (const bad of [0, DOWNLOAD_CONCURRENCY.max + 1, 2.5, '4', null, true]) assert.equal(loaded(bad), 2, String(bad))
  assert.equal(ConfigStore.load(join(dir, 'missing.json')).read().downloadConcurrency, 2)
})

test('engineLoadStallSeconds: 120 by default, 0 (off) and any whole in-range value kept, anything else loads as the default', () => {
  assert.equal(ENGINE_LOAD_STALL_SECONDS.default, 120)
  assert.equal(defaultConfig().engineLoadStallSeconds, 120)
  const dir = tmpDir('tllm-cfg-els-')
  const path = join(dir, 'config.json')
  const loaded = (value: unknown): number | undefined => {
    writeFileSync(path, JSON.stringify({ engineLoadStallSeconds: value }))
    return ConfigStore.load(path).read().engineLoadStallSeconds
  }
  assert.equal(loaded(0), 0)
  assert.equal(loaded(ENGINE_LOAD_STALL_SECONDS.max), ENGINE_LOAD_STALL_SECONDS.max)
  for (const bad of [-1, ENGINE_LOAD_STALL_SECONDS.max + 1, 90.5, '30', null, true]) assert.equal(loaded(bad), 120, String(bad))
  assert.equal(ConfigStore.load(join(dir, 'missing.json')).read().engineLoadStallSeconds, 120)
})
