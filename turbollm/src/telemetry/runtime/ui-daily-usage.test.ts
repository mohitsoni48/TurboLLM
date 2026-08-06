import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordUiAction, flushStaleUiUsage, persistUiDailyUsage } from './ui-daily-usage'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-ui-daily-usage-'))
}

test('recordUiAction: first-ever click for a screen has nothing to roll over', () => {
  const dir = tempDir()
  try {
    const rolled = recordUiAction(dir, 'engines', 'install_engine', '2026-08-05')
    assert.equal(rolled, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordUiAction: same-day repeats accumulate actions but dedupe distinctActions', () => {
  const dir = tempDir()
  try {
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-05')
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-05')
    const rolled = recordUiAction(dir, 'engines', 'enable_engine', '2026-08-06') // day rolls over here
    assert.deepEqual(rolled, { day: '2026-08-05', actions: 2, distinctActions: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordUiAction: distinctActions counts unique action names, not total clicks', () => {
  const dir = tempDir()
  try {
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-05')
    recordUiAction(dir, 'engines', 'enable_engine', '2026-08-05')
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-05') // repeat — not a new distinct action
    const rolled = recordUiAction(dir, 'engines', 'update_engine', '2026-08-06')
    assert.deepEqual(rolled, { day: '2026-08-05', actions: 3, distinctActions: 2 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordUiAction: distinct screens are tracked independently', () => {
  const dir = tempDir()
  try {
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-05')
    recordUiAction(dir, 'settings', 'save_settings', '2026-08-05')
    const engRolled = recordUiAction(dir, 'engines', 'enable_engine', '2026-08-06')
    const setRolled = recordUiAction(dir, 'settings', 'save_settings', '2026-08-06')
    assert.deepEqual(engRolled, { day: '2026-08-05', actions: 1, distinctActions: 1 })
    assert.deepEqual(setRolled, { day: '2026-08-05', actions: 1, distinctActions: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushStaleUiUsage: rolls over every screen whose day is earlier than today, in one call', () => {
  const dir = tempDir()
  try {
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-05')
    recordUiAction(dir, 'settings', 'save_settings', '2026-08-05')
    const rolled = flushStaleUiUsage(dir, '2026-08-06')
    assert.equal(rolled.length, 2)
    assert.deepEqual(
      rolled.find((r) => r.screen === 'engines'),
      { screen: 'engines', day: '2026-08-05', actions: 1, distinctActions: 1 },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushStaleUiUsage: a screen already on today is left alone', () => {
  const dir = tempDir()
  try {
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-06')
    assert.deepEqual(flushStaleUiUsage(dir, '2026-08-06'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistUiDailyUsage: writes the in-memory tally to disk as-is, for a crash between rollovers to recover from', () => {
  const dir = tempDir()
  try {
    recordUiAction(dir, 'engines', 'install_engine', '2026-08-05')
    recordUiAction(dir, 'engines', 'enable_engine', '2026-08-05')
    persistUiDailyUsage(dir)
    // Read the file directly rather than calling recordUiAction again — the module-level
    // cache is keyed by dataDir and would already hold this state in memory regardless of
    // whether persistUiDailyUsage wrote anything, so only inspecting the actual file on disk
    // proves the write happened.
    const onDisk = JSON.parse(readFileSync(join(dir, 'telemetry', 'ui-daily-usage.json'), 'utf8'))
    assert.deepEqual(onDisk.engines, { day: '2026-08-05', actions: 2, distinctActions: ['install_engine', 'enable_engine'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistUiDailyUsage: nothing recorded this process is a safe no-op, not a fresh empty-file write', () => {
  const dir = tempDir()
  try {
    persistUiDailyUsage(dir)
    assert.throws(() => readFileSync(join(dir, 'telemetry', 'ui-daily-usage.json'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordUiAction: never throws on an unwritable data dir', () => {
  assert.doesNotThrow(() => recordUiAction('\0invalid', 'engines', 'install_engine', '2026-08-05'))
})
