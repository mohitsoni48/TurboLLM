import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enabledFeatures, isFeatureEnabled } from './features'

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.TURBOLLM_FEATURES
  if (value === undefined) delete process.env.TURBOLLM_FEATURES
  else process.env.TURBOLLM_FEATURES = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.TURBOLLM_FEATURES
    else process.env.TURBOLLM_FEATURES = prev
  }
}

test('enabledFeatures: unset env var → no features enabled', () => {
  withEnv(undefined, () => {
    assert.deepEqual(enabledFeatures(), [])
  })
})

test('enabledFeatures: a known flag turns on', () => {
  withEnv('cloud-deploy', () => {
    assert.deepEqual(enabledFeatures(), ['cloud-deploy'])
  })
})

test('enabledFeatures: unknown flags are silently ignored, not half-enabled', () => {
  withEnv('cloud-deploy,totally-made-up-flag', () => {
    assert.deepEqual(enabledFeatures(), ['cloud-deploy'])
  })
})

test('enabledFeatures: whitespace and empty entries are tolerated', () => {
  withEnv(' cloud-deploy , , ', () => {
    assert.deepEqual(enabledFeatures(), ['cloud-deploy'])
  })
})

test('enabledFeatures: garbage-only value enables nothing', () => {
  withEnv('nonsense,another-nonsense', () => {
    assert.deepEqual(enabledFeatures(), [])
  })
})

test('isFeatureEnabled: true only when the flag is present', () => {
  withEnv('cloud-deploy', () => {
    assert.equal(isFeatureEnabled('cloud-deploy'), true)
  })
  withEnv(undefined, () => {
    assert.equal(isFeatureEnabled('cloud-deploy'), false)
  })
})
