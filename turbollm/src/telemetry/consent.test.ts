import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TELEMETRY_ENV } from './disabled'
import { sendConsentChoice } from './consent'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-consent-'))
}

function recorder(ok = true) {
  const sent: unknown[][] = []
  return {
    sent,
    transport: async (events: unknown[]) => {
      sent.push(events)
      return ok
    },
  }
}

test('sendConsentChoice: an Off choice sends one contentless ping', async () => {
  const dir = tempDir()
  try {
    const { transport, sent } = recorder()
    await sendConsentChoice(dir, 'off', transport)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].length, 1)
    assert.deepEqual(sent[0][0], { schema: 1, event: 'consent_choice', level: 'off' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sendConsentChoice: the ping carries nothing that could attribute it', async () => {
  const dir = tempDir()
  try {
    const { transport, sent } = recorder()
    await sendConsentChoice(dir, 'off', transport)

    const ping = sent[0][0] as Record<string, unknown>
    for (const banned of ['machineId', 'app', 'hw', 'ts', 'payload']) {
      assert.equal(banned in ping, false, `ping must not carry ${banned}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sendConsentChoice: sends once ever, even across restarts', async () => {
  const dir = tempDir()
  try {
    const { transport, sent } = recorder()
    await sendConsentChoice(dir, 'off', transport)
    await sendConsentChoice(dir, 'off', transport)
    await sendConsentChoice(dir, 'anon', transport)

    assert.equal(sent.length, 1, 'the consent ping is a one-time event, never a per-change stream')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sendConsentChoice: is never retried — a failed send still counts as spent', async () => {
  const dir = tempDir()
  try {
    const failing = recorder(false)
    await sendConsentChoice(dir, 'off', failing.transport)
    const second = recorder(true)
    await sendConsentChoice(dir, 'off', second.transport)

    assert.equal(second.sent.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sendConsentChoice: the kill switch suppresses even this ping', async () => {
  const dir = tempDir()
  const prev = process.env[TELEMETRY_ENV]
  process.env[TELEMETRY_ENV] = 'off'
  try {
    const { transport, sent } = recorder()
    await sendConsentChoice(dir, 'off', transport)
    assert.equal(sent.length, 0)
  } finally {
    if (prev === undefined) delete process.env[TELEMETRY_ENV]
    else process.env[TELEMETRY_ENV] = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sendConsentChoice: a transport that throws never propagates', async () => {
  const dir = tempDir()
  try {
    await sendConsentChoice(dir, 'off', async () => {
      throw new Error('network down')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sendConsentChoice: an unrecognised level is not sent', async () => {
  const dir = tempDir()
  try {
    const { transport, sent } = recorder()
    await sendConsentChoice(dir, 'unset', transport)
    assert.equal(sent.length, 0, 'unset is the absence of a choice, not a choice')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
