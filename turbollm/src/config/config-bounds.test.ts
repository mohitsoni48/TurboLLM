// config-bounds.ts's retention bounds (scalability review 2.4): the settings route and normalize both read them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RETENTION_BOUNDS, isRetentionValue } from './config-bounds'

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
