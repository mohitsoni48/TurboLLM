import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordSent, readSentLog, MAX_LOGGED } from './log'

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
