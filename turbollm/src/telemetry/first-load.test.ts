import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readQueue } from './queue'
import { Emitter } from './emit'
import { reportModelLoad } from './first-load'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-firstload-'))
}

function makeEmitter(dir: string, level = 'anon') {
  const cfg = { telemetry: { level, machineId: '33333333-3333-3333-3333-333333333333' } }
  return new Emitter({
    dataDir: dir,
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } as never,
    version: '1.9.0',
    os: 'win32',
  })
}

function queued(dir: string): Record<string, unknown>[] {
  return readQueue(dir).map((q) => q.event)
}

test('reportModelLoad: a successful first load is reported once', () => {
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, true, null)
    const events = queued(dir)

    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'model_first_load')
    assert.deepEqual(events[0].payload, { outcome: 'ok' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: only the FIRST load is reported, not every subsequent one', () => {
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, true, null)
    reportModelLoad(dir, e, true, null)
    reportModelLoad(dir, e, false, { code: 'readiness_timeout' })

    assert.equal(queued(dir).length, 1, 'model_first_load means first, not every')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: a failure carries an enum reason, never the raw error', () => {
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, false, {
      code: 'model_load_failed',
      message: 'CUDA error: out of memory loading D:/models/private/secret.gguf',
      logTail: ['/home/mo/.ssh/id_rsa'],
    })

    const [event] = queued(dir)
    assert.deepEqual(event.payload, { outcome: 'fail', failReason: 'oom' })
    // The path and the key filename must not survive anywhere in the payload.
    const serialised = JSON.stringify(event)
    assert.doesNotMatch(serialised, /secret\.gguf/)
    assert.doesNotMatch(serialised, /id_rsa/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: a first FAILURE still counts as the first load', () => {
  // The drop-off we care most about is the user whose very first load fails.
  // If failures did not claim the once-key, that user would look like they
  // never attempted a load at all.
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, false, { code: 'readiness_timeout' })
    const [event] = queued(dir)
    assert.deepEqual(event.payload, { outcome: 'fail', failReason: 'timeout' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: consent off means nothing is queued and the claim is not spent', () => {
  const dir = tempDir()
  try {
    reportModelLoad(dir, makeEmitter(dir, 'off'), true, null)
    assert.equal(queued(dir).length, 0)

    // Turning telemetry on later must still capture the next first load —
    // otherwise opting in after setup would permanently lose this event.
    reportModelLoad(dir, makeEmitter(dir, 'anon'), true, null)
    assert.equal(queued(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: never throws', () => {
  assert.doesNotThrow(() => reportModelLoad('\0bad', makeEmitter(tempDir()), true, null))
})
