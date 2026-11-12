// The test daemon's own promises: it is inert, and it stays out of the user's install.
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { test } from 'node:test'
import { TELEMETRY_ENV, telemetryDisabled } from '../telemetry/disabled'
import { bootTestDaemon } from './test-daemon'

test('the test daemon binds a free port (never 6996 or 6997), in a temp data dir, with telemetry off and no engine', async () => {
  const d = await bootTestDaemon()
  try {
    assert.ok(d.deps.bindPort && ![6996, 6997].includes(d.deps.bindPort), `bound ${d.deps.bindPort}`)
    assert.ok(d.dataDir.startsWith(tmpdir()), 'a temp data dir, never ~/.turbollm')
    assert.ok(!d.dataDir.startsWith(`${homedir()}/.turbollm`))
    assert.equal(telemetryDisabled(), true)
    assert.equal(d.deps.store.snapshot().defaultEngineSeeded, true, 'the first-run engine seed downloads nothing')
    assert.equal(d.deps.manager.status().state, 'stopped')
  } finally {
    await d.stop()
  }
})

test('stop() restores the telemetry env var as it was before the first test daemon booted, even with several at once', async () => {
  const before = process.env[TELEMETRY_ENV]
  delete process.env[TELEMETRY_ENV]
  try {
    const a = await bootTestDaemon()
    const b = await bootTestDaemon()
    assert.equal(process.env[TELEMETRY_ENV], 'off')
    await a.stop()
    assert.equal(process.env[TELEMETRY_ENV], 'off', 'another test daemon is still running')
    await b.stop()
    assert.equal(process.env[TELEMETRY_ENV], undefined, 'the last stop restores the original (unset)')
    process.env[TELEMETRY_ENV] = 'on'
    const c = await bootTestDaemon()
    await c.stop()
    assert.equal(process.env[TELEMETRY_ENV], 'on', 'a set value comes back too')
  } finally {
    if (before === undefined) delete process.env[TELEMETRY_ENV]
    else process.env[TELEMETRY_ENV] = before
  }
})
