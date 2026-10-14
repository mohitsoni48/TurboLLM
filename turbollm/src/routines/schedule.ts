import type { ScheduleRule } from './schema'

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
