import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueue, readQueue } from './queue'
import { flush, type Transport } from './uploader'
import { readSentLog } from './log'
import { TELEMETRY_ENV } from './disabled'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-uploader-'))
}

function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    event: 'app_first_run',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.9.0', os: 'win32/x64' },
    ...over,
  }
}

/** Records what was sent instead of touching the network. */
function fakeTransport(result: 'ok' | 'fail' | 'throw' = 'ok') {
  const sent: unknown[][] = []
  const transport: Transport = async (events) => {
    sent.push(events)
    if (result === 'throw') throw new Error('network down')
    return result === 'ok'
  }
  return { transport, sent }
}

test('flush: sends queued events and clears them from the queue', async () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    enqueue(dir, validEvent({ event: 'daily_active' }))
    const { transport, sent } = fakeTransport('ok')

    await flush(dir, 'anon', transport)

    assert.equal(sent.length, 1, 'one batched request')
    assert.equal(sent[0].length, 2)
    assert.equal(readQueue(dir).length, 0, 'queue drained')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: keeps events queued when the send fails, so nothing is lost offline', async () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    const { transport } = fakeTransport('fail')

    await flush(dir, 'anon', transport)

    assert.equal(readQueue(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: a transport that throws is swallowed and the events survive', async () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    const { transport } = fakeTransport('throw')

    await flush(dir, 'anon', transport) // must not reject

    assert.equal(readQueue(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: a successful send is recorded in the submission log, verbatim', async () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    const { transport } = fakeTransport('ok')

    await flush(dir, 'anon', transport)

    const log = readSentLog(dir)
    assert.equal(log.length, 1)
    assert.equal((log[0].event as { event: string }).event, 'app_first_run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: a FAILED send is not recorded — the log means "actually transmitted"', async () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    const { transport } = fakeTransport('fail')

    await flush(dir, 'anon', transport)

    assert.deepEqual(readSentLog(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: an empty queue makes no request at all', async () => {
  const dir = tempDir()
  try {
    const { transport, sent } = fakeTransport('ok')
    await flush(dir, 'anon', transport)
    assert.equal(sent.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: consent off DISCARDS anything still queued rather than sending it', async () => {
  // The realistic case: events were queued while consent was on, then the user
  // turned telemetry off. Those events must never be transmitted, and must not
  // sit on disk waiting for consent to be re-enabled either.
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    const { transport, sent } = fakeTransport('ok')

    await flush(dir, 'off', transport)

    assert.equal(sent.length, 0, 'nothing sent')
    assert.equal(readQueue(dir).length, 0, 'queue purged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: consent unset also sends nothing — an undecided user has not opted in', async () => {
  const dir = tempDir()
  try {
    enqueue(dir, validEvent())
    const { transport, sent } = fakeTransport('ok')

    await flush(dir, 'unset', transport)

    assert.equal(sent.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: the --no-telemetry kill switch overrides even a granted "anon" consent', async () => {
  // Found in Opus pre-release review: flush() never checked telemetryDisabled()
  // at all — only emit.ts and consent.ts honoured it. An install started with
  // --no-telemetry but a stored consent of 'anon' would still upload anything
  // already queued (e.g. by a bench run, which ALSO never checked it).
  const dir = tempDir()
  const prev = process.env[TELEMETRY_ENV]
  process.env[TELEMETRY_ENV] = 'off'
  try {
    enqueue(dir, validEvent())
    const { transport, sent } = fakeTransport('ok')

    await flush(dir, 'anon', transport)

    assert.equal(sent.length, 0, 'the kill switch must stop the send outright')
  } finally {
    if (prev === undefined) delete process.env[TELEMETRY_ENV]
    else process.env[TELEMETRY_ENV] = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: the kill switch purges the queue too, same as consent being off', async () => {
  // The switch must not leave events sitting on disk waiting for the flag to
  // be removed later — matching the existing off/unset purge semantics exactly.
  const dir = tempDir()
  const prev = process.env[TELEMETRY_ENV]
  process.env[TELEMETRY_ENV] = 'off'
  try {
    enqueue(dir, validEvent())
    const { transport } = fakeTransport('ok')

    await flush(dir, 'anon', transport)

    assert.equal(readQueue(dir).length, 0)
  } finally {
    if (prev === undefined) delete process.env[TELEMETRY_ENV]
    else process.env[TELEMETRY_ENV] = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
