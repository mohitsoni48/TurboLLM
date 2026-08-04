import { describe, expect, it } from 'vitest'
import { deriveRoutineDisplayStatus } from './routine-status'
import type { Routine, RoutineRun } from './routine-types'

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1', flavor: 'chat', status: 'active', prompt: 'x', scheduleDisplay: 'd',
    scheduleRule: { kind: 'interval', everyMs: 1000 }, nextFireAt: null, modelKey: 'm',
    createdAt: '', updatedAt: '', ...overrides,
  }
}
function run(overrides: Partial<RoutineRun> = {}): RoutineRun {
  return { id: 'run1', routineId: 'r1', status: 'ok', configSnapshot: '{}', startedAt: '', ...overrides }
}

describe('deriveRoutineDisplayStatus', () => {
  it('returns pending_confirmation/paused as-is, ignoring any run', () => {
    expect(deriveRoutineDisplayStatus(routine({ status: 'pending_confirmation' }), null)).toBe('pending_confirmation')
    expect(deriveRoutineDisplayStatus(routine({ status: 'paused' }), run({ status: 'errored' }))).toBe('paused')
  })
  it('an active routine with no runs yet, or a clean/skipped last run, shows active', () => {
    expect(deriveRoutineDisplayStatus(routine(), null)).toBe('active')
    expect(deriveRoutineDisplayStatus(routine(), run({ status: 'ok' }))).toBe('active')
    expect(deriveRoutineDisplayStatus(routine(), run({ status: 'skipped' }))).toBe('active')
  })
  it('an in-flight run does not change an active routine away from active', () => {
    expect(deriveRoutineDisplayStatus(routine(), run({ status: 'running' }))).toBe('active')
  })
  it('an active routine whose latest run needs approval shows needs_approval', () => {
    expect(deriveRoutineDisplayStatus(routine(), run({ status: 'needs_approval' }))).toBe('needs_approval')
  })
  it('an active routine whose latest run errored shows error', () => {
    expect(deriveRoutineDisplayStatus(routine(), run({ status: 'errored' }))).toBe('error')
  })
})
