import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { bucketCount, recordFeatureUse, flushStaleDailyUsage, persistDailyUsage } from './daily-usage'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-daily-usage-'))
}

test('bucketCount: never returns the raw number — always one of COUNT_BUCKETS', () => {
  assert.equal(bucketCount(0), '1')
  assert.equal(bucketCount(1), '1')
  assert.equal(bucketCount(2), '2-5')
  assert.equal(bucketCount(5), '2-5')
  assert.equal(bucketCount(6), '6-20')
  assert.equal(bucketCount(20), '6-20')
  assert.equal(bucketCount(21), '21-100')
  assert.equal(bucketCount(100), '21-100')
  assert.equal(bucketCount(101), '100+')
  assert.equal(bucketCount(50_000), '100+')
})

test('recordFeatureUse: first use ever returns null — nothing to roll over yet', () => {
  const dir = tempDir()
  try {
    assert.equal(recordFeatureUse(dir, 'chat', '2026-07-29'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordFeatureUse: same-day repeats accumulate silently, still no rollover', () => {
  const dir = tempDir()
  try {
    recordFeatureUse(dir, 'chat', '2026-07-29')
    assert.equal(recordFeatureUse(dir, 'chat', '2026-07-29'), null)
    assert.equal(recordFeatureUse(dir, 'chat', '2026-07-29'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordFeatureUse: a day change rolls over the PREVIOUS day\'s bucketed tally', () => {
  const dir = tempDir()
  try {
    for (let i = 0; i < 3; i++) recordFeatureUse(dir, 'chat', '2026-07-29') // 3 uses on day 1
    const rolled = recordFeatureUse(dir, 'chat', '2026-07-30') // 1st use on day 2
    assert.deepEqual(rolled, { day: '2026-07-29', bucket: '2-5' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordFeatureUse: after a rollover, today starts a fresh count of 1', () => {
  const dir = tempDir()
  try {
    for (let i = 0; i < 3; i++) recordFeatureUse(dir, 'chat', '2026-07-29')
    recordFeatureUse(dir, 'chat', '2026-07-30') // rolls over, starts day 2 at 1
    assert.equal(recordFeatureUse(dir, 'chat', '2026-07-30'), null, 'still day 2, second use — no rollover yet')
    const rolled = recordFeatureUse(dir, 'chat', '2026-07-31')
    assert.deepEqual(rolled, { day: '2026-07-30', bucket: '2-5' }, 'day 2 had exactly 2 uses, not 1 carried over from day 1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordFeatureUse: distinct features are tracked independently', () => {
  const dir = tempDir()
  try {
    recordFeatureUse(dir, 'chat', '2026-07-29')
    for (let i = 0; i < 10; i++) recordFeatureUse(dir, 'code', '2026-07-29')
    const chatRolled = recordFeatureUse(dir, 'chat', '2026-07-30')
    const codeRolled = recordFeatureUse(dir, 'code', '2026-07-30')
    assert.deepEqual(chatRolled, { day: '2026-07-29', bucket: '1' })
    assert.deepEqual(codeRolled, { day: '2026-07-29', bucket: '6-20' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordFeatureUse: never throws, even against an unwritable dataDir', () => {
  assert.doesNotThrow(() => recordFeatureUse('\0bad', 'chat', '2026-07-29'))
})

test('flushStaleDailyUsage: rolls over every feature not from today, and clears them', () => {
  const dir = tempDir()
  try {
    recordFeatureUse(dir, 'chat', '2026-07-29')
    recordFeatureUse(dir, 'chat', '2026-07-29')
    recordFeatureUse(dir, 'code', '2026-07-29')

    const rolled = flushStaleDailyUsage(dir, '2026-07-30')
    const byFeature = Object.fromEntries(rolled.map((r) => [r.feature, r.bucket]))
    assert.deepEqual(byFeature, { chat: '2-5', code: '1' })

    // Flushed entries are gone — a second flush on the same day finds nothing left.
    assert.deepEqual(flushStaleDailyUsage(dir, '2026-07-30'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushStaleDailyUsage: a feature already on today is left untouched', () => {
  const dir = tempDir()
  try {
    recordFeatureUse(dir, 'chat', '2026-07-30')
    assert.deepEqual(flushStaleDailyUsage(dir, '2026-07-30'), [])
    // Still there, still countable — flushing today's entry didn't clear it.
    const rolled = recordFeatureUse(dir, 'chat', '2026-07-31')
    assert.deepEqual(rolled, { day: '2026-07-30', bucket: '1' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushStaleDailyUsage: never throws, even against an unwritable dataDir', () => {
  assert.doesNotThrow(() => flushStaleDailyUsage('\0bad', '2026-07-29'))
})

test('flushStaleDailyUsage: nothing recorded yet is a no-op', () => {
  const dir = tempDir()
  try {
    assert.deepEqual(flushStaleDailyUsage(dir, '2026-07-29'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// persistDailyUsage (PR #105 review finding — hot-path fix): same-day counts are
// in-memory only, to avoid a disk write on every matching API request. This is
// the periodic-flush half that gets them onto disk before a possible crash.
test('persistDailyUsage: writes today\'s in-progress (not yet rolled-over) count to disk', () => {
  const dir = tempDir()
  try {
    recordFeatureUse(dir, 'chat', '2026-07-29')
    recordFeatureUse(dir, 'chat', '2026-07-29')
    recordFeatureUse(dir, 'chat', '2026-07-29')
    // Nothing on disk yet — same-day increments never touch it.
    assert.throws(() => readFileSync(dir + '/telemetry/daily-usage.json', 'utf8'))

    persistDailyUsage(dir)
    const onDisk = JSON.parse(readFileSync(dir + '/telemetry/daily-usage.json', 'utf8'))
    assert.deepEqual(onDisk, { chat: { day: '2026-07-29', count: 3 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistDailyUsage: nothing recorded this process is a no-op, never throws', () => {
  const dir = tempDir()
  try {
    assert.doesNotThrow(() => persistDailyUsage(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistDailyUsage: never throws, even against an unwritable dataDir', () => {
  recordFeatureUse('\0bad-persist', 'chat', '2026-07-29')
  assert.doesNotThrow(() => persistDailyUsage('\0bad-persist'))
})
