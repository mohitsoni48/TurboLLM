import { test } from 'node:test'
import assert from 'node:assert/strict'
import { telemetryDisabled, TELEMETRY_ENV } from './disabled'

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env[TELEMETRY_ENV]
  if (value === undefined) delete process.env[TELEMETRY_ENV]
  else process.env[TELEMETRY_ENV] = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env[TELEMETRY_ENV]
    else process.env[TELEMETRY_ENV] = prev
  }
}

test('telemetryDisabled: unset env leaves telemetry governed by stored consent', () => {
  withEnv(undefined, () => assert.equal(telemetryDisabled(), false))
})

test('telemetryDisabled: off disables it', () => {
  withEnv('off', () => assert.equal(telemetryDisabled(), true))
})

test('telemetryDisabled: the usual ways of writing "no" all work', () => {
  for (const v of ['0', 'false', 'no', 'OFF', 'False']) {
    withEnv(v, () => assert.equal(telemetryDisabled(), true, `expected ${v} to disable`))
  }
})

test('telemetryDisabled: an affirmative value does NOT force telemetry on', () => {
  // This switch may only ever turn telemetry off. Consent is the sole thing
  // that turns it on — an env var must never be able to opt a user in.
  withEnv('on', () => assert.equal(telemetryDisabled(), false))
  withEnv('1', () => assert.equal(telemetryDisabled(), false))
})

test('telemetryDisabled: surrounding whitespace is tolerated', () => {
  withEnv('  off  ', () => assert.equal(telemetryDisabled(), true))
})
