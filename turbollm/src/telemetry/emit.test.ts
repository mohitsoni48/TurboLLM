import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readQueue } from './queue'
import { TELEMETRY_ENV } from './disabled'
import { Emitter } from './emit'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-emit-'))
}

/** Minimal store double — the emitter only needs the consent level, the machine
 *  id, and somewhere to persist a regenerated id. */
function fakeStore(level: string, machineId = '22222222-2222-2222-2222-222222222222') {
  const cfg = { telemetry: { level, machineId } }
  return {
    snapshot: () => cfg,
    update: (fn: (c: typeof cfg) => void) => fn(cfg),
    cfg,
  }
}

function makeEmitter(dir: string, level: string, today = '2026-07-29') {
  const store = fakeStore(level)
  const emitter = new Emitter({
    dataDir: dir,
    store: store as never,
    version: '1.9.0',
    os: 'win32',
    today: () => today,
  })
  return { emitter, store }
}

function names(dir: string): string[] {
  return readQueue(dir).map((q) => (q.event as { event: string }).event)
}

test('emit: queues an event when consent is anon', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon')
    emitter.emit('app_first_run')
    assert.deepEqual(names(dir), ['app_first_run'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit: queues nothing when consent is off', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'off')
    emitter.emit('app_first_run')
    assert.deepEqual(names(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit: queues nothing when consent is unset — undecided is not consent', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'unset')
    emitter.emit('app_first_run')
    assert.deepEqual(names(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit: the kill switch beats stored consent', () => {
  const dir = tempDir()
  const prev = process.env[TELEMETRY_ENV]
  process.env[TELEMETRY_ENV] = 'off'
  try {
    const { emitter } = makeEmitter(dir, 'full')
    emitter.emit('app_first_run')
    assert.deepEqual(names(dir), [])
  } finally {
    if (prev === undefined) delete process.env[TELEMETRY_ENV]
    else process.env[TELEMETRY_ENV] = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit: error events require the full level, not merely anon', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon')
    emitter.emit('error', { fingerprint: 'cuda_oom' })
    assert.deepEqual(names(dir), [], 'anon must not send crash diagnostics')

    const { emitter: full } = makeEmitter(dir, 'full')
    full.emit('error', { fingerprint: 'cuda_oom' })
    assert.deepEqual(names(dir), ['error'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit: a payload the schema rejects is dropped rather than queued', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon')
    emitter.emit('feature_first_use', { feature: 'not-a-real-feature' })
    assert.deepEqual(names(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('firstUse: emits once per feature, and stays deduped across a restart', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon')
    emitter.firstUse('chat')
    emitter.firstUse('chat')
    assert.deepEqual(names(dir), ['feature_first_use'], 'second call is a no-op')

    // A fresh Emitter over the same data dir is what a daemon restart looks like.
    const { emitter: restarted } = makeEmitter(dir, 'anon')
    restarted.firstUse('chat')
    assert.equal(names(dir).length, 1, 'ledger survives restart')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('firstUse: distinct features each emit once', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon')
    emitter.firstUse('chat')
    emitter.firstUse('code')
    assert.equal(names(dir).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dailyActive: once per day, again the next day', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon', '2026-07-29')
    emitter.dailyActive()
    emitter.dailyActive()
    assert.equal(names(dir).length, 1, 'same day is a no-op')

    const { emitter: tomorrow } = makeEmitter(dir, 'anon', '2026-07-30')
    tomorrow.dailyActive()
    assert.equal(names(dir).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit: an unwritable data dir never throws', () => {
  const { emitter } = makeEmitter('\0invalid', 'anon')
  assert.doesNotThrow(() => emitter.emit('app_first_run'))
})

test('emit: mints a machineId lazily, and never while consent is off', () => {
  const dir = tempDir()
  try {
    const offStore = fakeStore('off', '')
    const off = new Emitter({ dataDir: dir, store: offStore as never, version: '1.9.0', os: 'win32' })
    off.emit('app_first_run')
    assert.equal(offStore.cfg.telemetry.machineId, '', 'no id generated while off')

    const onStore = fakeStore('anon', '')
    const on = new Emitter({ dataDir: dir, store: onStore as never, version: '1.9.0', os: 'win32' })
    on.emit('app_first_run')
    assert.match(onStore.cfg.telemetry.machineId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
