import type { ScheduleRule } from './schema'

/** The longest interval an 'interval' rule may have: a year. next_fire_at is now + everyMs, written
 *  with toISOString() and compared as a string (listDueRoutines). Past Date's range that throws, so
 *  /confirm and /resume answered 500 and the routine could never be armed; past the year 9999 it
 *  writes a signed six-digit year ('+011533-…'), which sorts before every 4-digit year, so the
 *  routine was due on every tick.
 *  A year keeps every next_fire_at a 4-digit year for millennia. The scheduler polls on a tick
 *  rather than arming a timer per routine, so setTimeout's 24.8-day limit does not apply here.
 *  The web form's check (web/src/lib/routine-form.ts) holds the same value. */
export const ROUTINE_MAX_INTERVAL_MS = 365 * 24 * 60 * 60_000

export function computeNextFireTime(rule: ScheduleRule, now: Date): Date {
  if (rule.kind === 'interval') return new Date(now.getTime() + rule.everyMs)
  if (rule.kind === 'daily') return nextAtTime(now, rule.hour, rule.minute, null)
  return nextAtTime(now, rule.hour, rule.minute, rule.daysOfWeek)
}

function nextAtTime(now: Date, hour: number, minute: number, daysOfWeek: number[] | null): Date {
  const candidate = new Date(now)
  candidate.setHours(hour, minute, 0, 0)
  // setHours is re-applied after every setDate: on a DST spring-forward day a time inside the
  // skipped hour (02:30) lands at 03:30, and setDate keeps that shifted wall-clock time, so every
  // later day's candidate would otherwise fire an hour late too.
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1)
    candidate.setHours(hour, minute, 0, 0)
  }
  if (!daysOfWeek || daysOfWeek.length === 0) return candidate
  for (let i = 0; i < 8; i++) {
    if (daysOfWeek.includes(candidate.getDay())) return candidate
    candidate.setDate(candidate.getDate() + 1)
    candidate.setHours(hour, minute, 0, 0)
  }
  return candidate
}
