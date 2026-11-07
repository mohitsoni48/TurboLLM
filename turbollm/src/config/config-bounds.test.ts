// config-bounds.ts's retention bounds (scalability review 2.4): the settings route and normalize both read them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_APPROVAL_WAIT_MINUTES, DOWNLOAD_CONCURRENCY, ENGINE_LOAD_STALL_SECONDS, GATEWAY_MAX_BODY_MB, RETENTION_BOUNDS, isRetentionValue,
  isWholeInBounds, loadBounded,
} from './config-bounds'
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

// Scalability item 5.3: one bound declares both how a hand-edited value loads (normalize) and what the settings route takes.
test('loadBounded applies the load policy the bound declares: integer, floor or clamp', () => {
  // integer: a whole in-range value, anything else the default (a fraction is not floored).
  assert.equal(loadBounded(5, DOWNLOAD_CONCURRENCY), 5)
  for (const bad of [3.5, 0, 9, '4', null, undefined]) assert.equal(loadBounded(bad, DOWNLOAD_CONCURRENCY), DOWNLOAD_CONCURRENCY.default, String(bad))
  // floor: an in-range number floored, anything else the default.
  assert.equal(loadBounded(90.9, RETENTION_BOUNDS.apiUsageRawDays), 90)
  assert.equal(loadBounded(1440, CHAT_APPROVAL_WAIT_MINUTES), 1440)
  for (const bad of [1441, -1, '30', null]) assert.equal(loadBounded(bad, CHAT_APPROVAL_WAIT_MINUTES), CHAT_APPROVAL_WAIT_MINUTES.default, String(bad))
  // clamp: at least min is floored and capped at max; below min or not a number is the default.
  assert.equal(loadBounded(9999, GATEWAY_MAX_BODY_MB), GATEWAY_MAX_BODY_MB.max)
  assert.equal(loadBounded(64.7, GATEWAY_MAX_BODY_MB), 64)
  for (const bad of [0.5, -3, '64', null]) assert.equal(loadBounded(bad, GATEWAY_MAX_BODY_MB), GATEWAY_MAX_BODY_MB.default, String(bad))
})

test('isWholeInBounds takes a whole JSON number inside the bound, nothing else', () => {
  for (const b of [DOWNLOAD_CONCURRENCY, ENGINE_LOAD_STALL_SECONDS, GATEWAY_MAX_BODY_MB]) {
    for (const ok of [b.min, b.default, b.max]) assert.equal(isWholeInBounds(ok, b), true, String(ok))
    for (const bad of [b.min - 1, b.max + 1, b.min + 0.5, String(b.default), null, true]) assert.equal(isWholeInBounds(bad, b), false, String(bad))
  }
})
