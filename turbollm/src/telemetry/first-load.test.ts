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
    os: 'win32/x64',
  })
}

function queued(dir: string): Record<string, unknown>[] {
  return readQueue(dir).map((q) => q.event)
}

test('reportModelLoad: a successful first load is reported once', () => {
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, 'ok')
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
    reportModelLoad(dir, e, 'ok')
    reportModelLoad(dir, e, 'ok')
    reportModelLoad(dir, e, 'fail', 'timeout')

    assert.equal(queued(dir).length, 1, 'model_first_load means first, not every')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: a failure carries the caller-classified enum reason', () => {
  // Classification itself moved to the CALLER (Manager uses classifyLoadFailure
  // on a raw error; bench.ts's auto-tune sweep uses a different classifier over
  // aggregate candidate outcomes) — reportModelLoad only emits what it is given.
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, 'fail', 'oom')

    const [event] = queued(dir)
    assert.deepEqual(event.payload, { outcome: 'fail', failReason: 'oom' })
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
    reportModelLoad(dir, e, 'fail', 'timeout')
    const [event] = queued(dir)
    assert.deepEqual(event.payload, { outcome: 'fail', failReason: 'timeout' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: a cancelled first attempt is reported as cancelled, not fail', () => {
  // A user who backs out of a sweep before any candidate committed is not the
  // same signal as one whose load broke — conflating them (as the previous
  // ok:boolean signature structurally forced) would misread a deliberate
  // abandonment as a product defect, the same reasoning already applied to
  // download outcomes.
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, 'cancelled')
    const [event] = queued(dir)
    assert.deepEqual(event.payload, { outcome: 'cancelled' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: a cancelled attempt still claims the once-key', () => {
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportModelLoad(dir, e, 'cancelled')
    reportModelLoad(dir, e, 'ok')
    assert.equal(queued(dir).length, 1, 'the cancelled attempt was still the first one')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: consent off means nothing is queued and the claim is not spent', () => {
  const dir = tempDir()
  try {
    reportModelLoad(dir, makeEmitter(dir, 'off'), 'ok')
    assert.equal(queued(dir).length, 0)

    // Turning telemetry on later must still capture the next first load —
    // otherwise opting in after setup would permanently lose this event.
    reportModelLoad(dir, makeEmitter(dir, 'anon'), 'ok')
    assert.equal(queued(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportModelLoad: never throws', () => {
  assert.doesNotThrow(() => reportModelLoad('\0bad', makeEmitter(tempDir()), 'ok'))
})
