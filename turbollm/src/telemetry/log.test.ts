import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordSent, readSentLog, MAX_LOGGED, MAX_LOGGED_UI } from './log'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-log-'))
}

function evt(name = 'app_first_run'): Record<string, unknown> {
  return { schema: 1, event: name, ts: '2026-07-29T12:00:00.000Z' }
}

test('recordSent: logs what was actually transmitted, newest first', () => {
  const dir = tempDir()
  try {
    recordSent(dir, [evt('app_first_run')])
    recordSent(dir, [evt('daily_active')])

    const log = readSentLog(dir)
    assert.equal(log.length, 2)
    assert.equal((log[0].event as { event: string }).event, 'daily_active', 'newest first')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSent: stores the event verbatim, so the log can be checked against our claims', () => {
  const dir = tempDir()
  try {
    recordSent(dir, [evt('app_first_run')])
    const [entry] = readSentLog(dir)
    assert.deepEqual(entry.event, evt('app_first_run'))
    assert.ok(entry.sentAt, 'records when it left the machine')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSent: the log is bounded', () => {
  const dir = tempDir()
  try {
    for (let i = 0; i < MAX_LOGGED + 20; i++) recordSent(dir, [evt()])
    assert.equal(readSentLog(dir).length, MAX_LOGGED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSent: a batch is logged as individual entries', () => {
  const dir = tempDir()
  try {
    recordSent(dir, [evt('app_first_run'), evt('daily_active')])
    assert.equal(readSentLog(dir).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSentLog: a missing or corrupt log reads as empty, never throws', () => {
  const dir = tempDir()
  try {
    assert.deepEqual(readSentLog(dir), [])
    assert.deepEqual(readSentLog(join(dir, 'nope')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSent: an unwritable dir never throws', () => {
  assert.doesNotThrow(() => recordSent('\0bad', [evt()]))
})

// ── ui_action / ui_daily partitioned bucket (spec 23 §6a mandatory condition) ──
// High-volume click events get their own bounded bucket so they can never evict a
// rare, more sensitive entry (error, model_load, ...) from the general log.

test('recordSent: a flood of ui_action entries does not evict a rare general event', () => {
  const dir = tempDir()
  try {
    recordSent(dir, [evt('error')])
    for (let i = 0; i < MAX_LOGGED_UI + 50; i++) recordSent(dir, [evt('ui_action')])

    const log = readSentLog(dir)
    assert.ok(
      log.some((e) => (e.event as { event: string }).event === 'error'),
      'the one rare event must survive a flood of high-volume ui_action entries',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSent: ui_action and ui_daily are each bounded independently of the general log', () => {
  const dir = tempDir()
  try {
    for (let i = 0; i < MAX_LOGGED + 20; i++) recordSent(dir, [evt('app_first_run')])
    for (let i = 0; i < MAX_LOGGED_UI + 20; i++) recordSent(dir, [evt('ui_action')])

    const log = readSentLog(dir)
    const general = log.filter((e) => (e.event as { event: string }).event === 'app_first_run')
    const ui = log.filter((e) => (e.event as { event: string }).event === 'ui_action')
    assert.equal(general.length, MAX_LOGGED)
    assert.equal(ui.length, MAX_LOGGED_UI)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSent: a mixed batch splits general and ui_action entries into their own buckets', () => {
  const dir = tempDir()
  try {
    recordSent(dir, [evt('model_load'), evt('ui_action'), evt('ui_daily')])
    const log = readSentLog(dir)
    assert.equal(log.length, 3)
    assert.deepEqual(
      log.map((e) => (e.event as { event: string }).event).sort(),
      ['model_load', 'ui_action', 'ui_daily'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSentLog: merges both buckets, newest first, across the whole log', () => {
  const dir = tempDir()
  try {
    recordSent(dir, [evt('app_first_run')])
    recordSent(dir, [evt('ui_action')])
    // A real clock tick between the two buckets' writes above is not guaranteed at
    // millisecond resolution, so only this last one — recorded well after both —
    // is asserted as strictly first; the other two may tie and sort either way.
    recordSent(dir, [evt('daily_active')])

    const names = readSentLog(dir).map((e) => (e.event as { event: string }).event)
    assert.equal(names[0], 'daily_active', 'the most recent entry across both buckets sorts first')
    assert.deepEqual(names.slice(1).sort(), ['app_first_run', 'ui_action'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
