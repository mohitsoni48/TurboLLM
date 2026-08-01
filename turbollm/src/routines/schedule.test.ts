import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeNextFireTime } from './schedule'

test('interval schedule fires exactly everyMs later', () => {
  const now = new Date('2026-08-01T10:00:00')
  const next = computeNextFireTime({ kind: 'interval', everyMs: 60_000 }, now)
  assert.equal(next.getTime() - now.getTime(), 60_000)
})

test('daily schedule fires today if the time has not passed yet', () => {
  const now = new Date('2026-08-01T08:00:00')
  const next = computeNextFireTime({ kind: 'daily', hour: 9, minute: 0 }, now)
  assert.equal(next.getDate(), 1)
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
})

test('daily schedule rolls to tomorrow if the time has already passed', () => {
  const now = new Date('2026-08-01T10:00:00')
  const next = computeNextFireTime({ kind: 'daily', hour: 9, minute: 0 }, now)
  assert.equal(next.getDate(), 2)
  assert.equal(next.getHours(), 9)
})

test('daily schedule rolls over a month boundary correctly', () => {
  const now = new Date('2026-08-31T10:00:00')
  const next = computeNextFireTime({ kind: 'daily', hour: 9, minute: 0 }, now)
  assert.equal(next.getMonth(), 8) // September (0-indexed)
  assert.equal(next.getDate(), 1)
})

test('weekly schedule picks the next matching day of week, not today', () => {
  const now = new Date('2026-08-01T10:00:00')
  const targetDay = (now.getDay() + 2) % 7 // some day two days out, whatever "now" actually is
  const next = computeNextFireTime({ kind: 'weekly', daysOfWeek: [targetDay], hour: 9, minute: 0 }, now)
  assert.equal(next.getDay(), targetDay)
  assert.equal(next.getDate(), now.getDate() + 2)
})

test('weekly schedule fires today if today matches and the time has not passed', () => {
  const now = new Date('2026-08-01T08:00:00')
  const next = computeNextFireTime({ kind: 'weekly', daysOfWeek: [now.getDay()], hour: 9, minute: 0 }, now)
  assert.equal(next.getDate(), now.getDate())
  assert.equal(next.getHours(), 9)
})

test('weekly schedule skips today if today matches but the time already passed', () => {
  const now = new Date('2026-08-01T10:00:00')
  const next = computeNextFireTime({ kind: 'weekly', daysOfWeek: [now.getDay()], hour: 9, minute: 0 }, now)
  assert.notEqual(next.getDate(), now.getDate())
  assert.equal(next.getDay(), now.getDay()) // same weekday, one week later
})
