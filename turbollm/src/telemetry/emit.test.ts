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
    os: 'win32/x64',
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

test('once: app_first_run fires exactly once, not on every daemon start', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon')
    emitter.once('app_first_run')
    emitter.once('app_first_run')
    assert.equal(names(dir).length, 1)

    // A fresh Emitter over the same data dir is a daemon restart.
    const { emitter: restarted } = makeEmitter(dir, 'anon')
    restarted.once('app_first_run')
    assert.equal(names(dir).length, 1, 'still once after a restart')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('firstUse: consent off does not SPEND the once-claim', () => {
  // Otherwise a user who browses the app before answering the consent card
  // burns every first_use key while telemetry is off, and opting in afterwards
  // permanently loses the entire feature-discovery picture — the exact data
  // ADR-299 exists to collect.
  const dir = tempDir()
  try {
    makeEmitter(dir, 'off').emitter.firstUse('chat')
    assert.deepEqual(names(dir), [])

    makeEmitter(dir, 'anon').emitter.firstUse('chat')
    assert.deepEqual(names(dir), ['feature_first_use'], 'still capturable after opting in')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('once: the kill switch does not spend the claim either', () => {
  const dir = tempDir()
  const prev = process.env[TELEMETRY_ENV]
  process.env[TELEMETRY_ENV] = 'off'
  try {
    makeEmitter(dir, 'anon').emitter.once('app_first_run')
    delete process.env[TELEMETRY_ENV]
    makeEmitter(dir, 'anon').emitter.once('app_first_run')
    assert.deepEqual(names(dir), ['app_first_run'])
  } finally {
    if (prev === undefined) delete process.env[TELEMETRY_ENV]
    else process.env[TELEMETRY_ENV] = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── error (telemetry-review follow-up — previously never wired to anything) ──

test('error: requires full level, not just anon', () => {
  const dir = tempDir()
  try {
    makeEmitter(dir, 'anon').emitter.error('engine_crash')
    assert.deepEqual(names(dir), [], 'anon must not send crash diagnostics')

    makeEmitter(dir, 'full').emitter.error('engine_crash')
    assert.deepEqual(names(dir), ['error'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('error: NOT once-only — every crash after the first is still real data', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'full')
    emitter.error('engine_crash')
    emitter.error('cuda_oom')
    assert.equal(names(dir).length, 2, 'unlike firstUse/once, repeats must not be deduped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── useFeature / flushDailyUsage (feature_used_daily, telemetry-review follow-up) ──

test('useFeature: does not emit on first use — nothing to roll over yet', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon', '2026-07-29')
    emitter.useFeature('chat')
    emitter.useFeature('chat')
    assert.deepEqual(names(dir), [], 'same-day usage has nothing to roll over until the day changes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('useFeature: rolls over a bucketed count for the previous day once the day changes', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon', '2026-07-29')
    for (let i = 0; i < 4; i++) emitter.useFeature('chat') // 4 uses on day 1

    const { emitter: tomorrow } = makeEmitter(dir, 'anon', '2026-07-30')
    tomorrow.useFeature('chat') // first use on day 2 triggers the rollover
    const events = readQueue(dir).map((q) => q.event as { event: string; payload?: Record<string, unknown> })
    const rolled = events.filter((e) => e.event === 'feature_used_daily')
    assert.equal(rolled.length, 1)
    assert.deepEqual(rolled[0].payload, { feature: 'chat', countBucket: '2-5' }, '4 uses buckets to 2-5, never the raw count')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('useFeature: consent off does not spend a count — same reasoning as firstUse', () => {
  const dir = tempDir()
  try {
    makeEmitter(dir, 'off', '2026-07-29').emitter.useFeature('chat')
    const { emitter: tomorrow } = makeEmitter(dir, 'anon', '2026-07-30')
    tomorrow.useFeature('chat')
    assert.deepEqual(names(dir), [], 'no usage was ever recorded while off, so there is nothing to roll over')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushDailyUsage: rolls over a feature used only on the last active day', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon', '2026-07-29')
    emitter.useFeature('code')
    emitter.useFeature('code')
    assert.deepEqual(names(dir), [], 'nothing rolled over yet — code was never used again')

    const { emitter: tomorrow } = makeEmitter(dir, 'anon', '2026-07-30')
    tomorrow.flushDailyUsage()
    const events = readQueue(dir).map((q) => q.event as { event: string; payload?: Record<string, unknown> })
    const rolled = events.filter((e) => e.event === 'feature_used_daily')
    assert.deepEqual(rolled[0].payload, { feature: 'code', countBucket: '2-5' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushDailyUsage: nothing to flush on the same day is a no-op', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon', '2026-07-29')
    emitter.useFeature('chat')
    emitter.flushDailyUsage()
    assert.deepEqual(names(dir), [])
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
    const off = new Emitter({ dataDir: dir, store: offStore as never, version: '1.9.0', os: 'win32/x64' })
    off.emit('app_first_run')
    assert.equal(offStore.cfg.telemetry.machineId, '', 'no id generated while off')

    const onStore = fakeStore('anon', '')
    const on = new Emitter({ dataDir: dir, store: onStore as never, version: '1.9.0', os: 'win32/x64' })
    on.emit('app_first_run')
    assert.match(onStore.cfg.telemetry.machineId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const FULL_BENCH_PAYLOAD = {
  source: 'chat',
  model: { name: 'Test Model', quant: 'Q4_K_M', arch: 'llama', sizeBytes: 1, moe: false },
  engine: { version: 'b1234' },
  params: { ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
  result: { tps: 42, ttftMs: 100, vramMb: null, outcome: 'ok' },
}

test('emitWithExtra: attaches the extra block alongside payload — the only way to carry bench_result.hw at all', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'anon')
    emitter.emitWithExtra('bench_result', FULL_BENCH_PAYLOAD, 'hw', { cpu: 'Test CPU', ramMb: 65536, gpus: [] })
    const queued = readQueue(dir)
    assert.equal(queued.length, 1)
    assert.deepEqual(queued[0].event.payload, FULL_BENCH_PAYLOAD)
    assert.deepEqual(queued[0].event.hw, { cpu: 'Test CPU', ramMb: 65536, gpus: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emitWithExtra: still respects consent and the kill switch, exactly like emit()', () => {
  const dir = tempDir()
  try {
    const { emitter } = makeEmitter(dir, 'off')
    emitter.emitWithExtra('bench_result', FULL_BENCH_PAYLOAD, 'hw', { cpu: 'x', ramMb: 1, gpus: [] })
    assert.deepEqual(names(dir), [], 'off must block emitWithExtra exactly as it blocks emit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
