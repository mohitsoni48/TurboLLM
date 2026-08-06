import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyRollup } from './rollup'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-rollup-'))
}

type ChatCounters = { conversations: number; messages: number }

const ZERO: ChatCounters = { conversations: 0, messages: 0 }

test('DailyRollup: starts at zero and bump() accumulates in memory', () => {
  const dir = tempDir()
  try {
    const r = new DailyRollup(dir, 'chat_daily', ZERO, () => '2026-08-05')
    r.bump('messages')
    r.bump('messages')
    r.bump('conversations')
    assert.equal(r.takeRolledOver(), null, 'same day — nothing to roll over yet')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DailyRollup: takeRolledOver returns the previous day totals once the date moves, and resets to zero', () => {
  const dir = tempDir()
  try {
    let today = '2026-08-05'
    const r = new DailyRollup(dir, 'chat_daily', ZERO, () => today)
    r.bump('messages', 3)
    r.bump('conversations')

    today = '2026-08-06'
    const rolled = r.takeRolledOver()
    assert.deepEqual(rolled, { day: '2026-08-05', counters: { conversations: 1, messages: 3 } })

    // The new day starts fresh, not carrying yesterday's counts forward.
    assert.equal(r.takeRolledOver(), null)
    r.bump('messages')
    const rolled2 = r.takeRolledOver()
    assert.equal(rolled2, null, 'still the same day as the reset — no second rollover yet')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DailyRollup: persist() writes the in-memory state without rolling over', () => {
  const dir = tempDir()
  try {
    const r = new DailyRollup(dir, 'chat_daily', ZERO, () => '2026-08-05')
    r.bump('messages', 5)
    r.persist()

    const onDisk = JSON.parse(readFileSync(join(dir, 'telemetry', 'rollup-chat_daily.json'), 'utf8'))
    assert.deepEqual(onDisk, { day: '2026-08-05', counters: { conversations: 0, messages: 5 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DailyRollup: persist() before any bump() is a no-op, not a zero-state write', () => {
  const dir = tempDir()
  try {
    const r = new DailyRollup(dir, 'chat_daily', ZERO, () => '2026-08-05')
    r.persist()
    assert.throws(() => readFileSync(join(dir, 'telemetry', 'rollup-chat_daily.json'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DailyRollup: a fresh instance rehydrates same-day state from disk rather than losing it', () => {
  const dir = tempDir()
  try {
    const r1 = new DailyRollup(dir, 'chat_daily', ZERO, () => '2026-08-05')
    r1.bump('messages', 7)
    r1.persist()

    const r2 = new DailyRollup(dir, 'chat_daily', ZERO, () => '2026-08-05')
    r2.bump('messages', 1)
    r2.persist()

    const onDisk = JSON.parse(readFileSync(join(dir, 'telemetry', 'rollup-chat_daily.json'), 'utf8'))
    assert.equal(onDisk.counters.messages, 8, 'r2 must rehydrate the 7 already on disk, not start from zero')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DailyRollup: a corrupt state file is treated as a fresh day, never throws', () => {
  const dir = tempDir()
  try {
    const r = new DailyRollup(dir, 'nonexistent-key-with-no-file', ZERO, () => '2026-08-05')
    assert.doesNotThrow(() => r.bump('messages'))
    assert.doesNotThrow(() => r.persist())
    assert.doesNotThrow(() => r.takeRolledOver())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DailyRollup: independent keys in the same dataDir do not collide', () => {
  const dir = tempDir()
  try {
    const chat = new DailyRollup(dir, 'chat_daily', ZERO, () => '2026-08-05')
    const gateway = new DailyRollup(dir, 'gateway_daily', { requests: 0 }, () => '2026-08-05')
    chat.bump('messages', 2)
    gateway.bump('requests', 9)
    chat.persist()
    gateway.persist()

    const chatOnDisk = JSON.parse(readFileSync(join(dir, 'telemetry', 'rollup-chat_daily.json'), 'utf8'))
    const gatewayOnDisk = JSON.parse(readFileSync(join(dir, 'telemetry', 'rollup-gateway_daily.json'), 'utf8'))
    assert.equal(chatOnDisk.counters.messages, 2)
    assert.equal(gatewayOnDisk.counters.requests, 9)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
