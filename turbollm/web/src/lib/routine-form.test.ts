import { describe, expect, it } from 'vitest'
import { describeScheduleRule, emptyRoutineDraft, isRoutineDraftComplete, routineToDraft } from './routine-form'
import type { Routine } from './routine-types'

describe('describeScheduleRule', () => {
  it('describes an interval rule in minutes', () => {
    expect(describeScheduleRule({ kind: 'interval', everyMs: 5 * 60_000 })).toBe('Runs every 5 minutes')
  })
  it('describes an interval rule in hours once it crosses 60 minutes', () => {
    expect(describeScheduleRule({ kind: 'interval', everyMs: 3 * 60 * 60_000 })).toBe('Runs every 3 hours')
  })
  it('keeps minutes for an interval that is not a whole number of hours', () => {
    expect(describeScheduleRule({ kind: 'interval', everyMs: 90 * 60_000 })).toBe('Runs every 90 minutes')
  })
  it('describes a sub-minute interval in seconds instead of rounding it to a wrong minute count', () => {
    // A model calling create_routine can send any everyMs; Math.round(30_000 / 60_000) would
    // render "1 minute" and 20_000 would render "0 minutes", then get persisted as scheduleDisplay.
    expect(describeScheduleRule({ kind: 'interval', everyMs: 30_000 })).toBe('Runs every 30 seconds')
  })
  it('describes a daily rule with 12-hour time formatting', () => {
    expect(describeScheduleRule({ kind: 'daily', hour: 9, minute: 0 })).toBe('Runs daily at 9:00 AM')
    expect(describeScheduleRule({ kind: 'daily', hour: 13, minute: 30 })).toBe('Runs daily at 1:30 PM')
  })
  it('describes a weekly rule listing the picked days in order', () => {
    expect(describeScheduleRule({ kind: 'weekly', daysOfWeek: [1, 3, 5], hour: 9, minute: 0 })).toBe('Runs Mon, Wed, Fri at 9:00 AM')
  })
  it('flags a weekly rule with no days picked instead of silently showing an empty list', () => {
    expect(describeScheduleRule({ kind: 'weekly', daysOfWeek: [], hour: 9, minute: 0 })).toBe('Runs weekly at 9:00 AM (pick at least one day)')
  })
})

describe('isRoutineDraftComplete', () => {
  it('an empty draft is incomplete', () => {
    expect(isRoutineDraftComplete(emptyRoutineDraft())).toBe(false)
  })
  it('a chat routine needs prompt + modelKey + agentId', () => {
    const d = { ...emptyRoutineDraft(), prompt: 'Summarize my inbox', modelKey: 'm', agentId: 'agent-1' }
    expect(isRoutineDraftComplete(d)).toBe(true)
    expect(isRoutineDraftComplete({ ...d, agentId: undefined })).toBe(false)
  })
  it('a code routine needs workspacePath + a valid codingAgent, not agentId', () => {
    const base = { ...emptyRoutineDraft(), flavor: 'code' as const, prompt: 'Fix the build', modelKey: 'm' }
    expect(isRoutineDraftComplete(base)).toBe(false)
    expect(isRoutineDraftComplete({ ...base, workspacePath: 'D:/repo' })).toBe(false)
    expect(isRoutineDraftComplete({ ...base, workspacePath: 'D:/repo', codingAgent: 'pi' })).toBe(true)
  })
  it('a weekly schedule with zero days picked is incomplete even with everything else filled', () => {
    const d = { ...emptyRoutineDraft(), prompt: 'x', modelKey: 'm', agentId: 'a', scheduleRule: { kind: 'weekly' as const, daysOfWeek: [], hour: 9, minute: 0 } }
    expect(isRoutineDraftComplete(d)).toBe(false)
  })
  it('a non-positive interval is incomplete — the server rejects it, and it would fire every tick', () => {
    const d = { ...emptyRoutineDraft(), prompt: 'x', modelKey: 'm', agentId: 'a' }
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'interval', everyMs: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'interval', everyMs: -1 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'interval', everyMs: 60_000 } })).toBe(true)
  })
  it('a non-finite interval is incomplete — validateScheduleRule rejects it with a 400', () => {
    const d = { ...emptyRoutineDraft(), prompt: 'x', modelKey: 'm', agentId: 'a' }
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'interval', everyMs: Infinity } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'interval', everyMs: NaN } })).toBe(false)
  })
  it('an out-of-range or non-integer hour/minute is incomplete on daily and weekly rules', () => {
    const d = { ...emptyRoutineDraft(), prompt: 'x', modelKey: 'm', agentId: 'a' }
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'daily', hour: 24, minute: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'daily', hour: -1, minute: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'daily', hour: 9.5, minute: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'daily', hour: 9, minute: 60 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'daily', hour: 9, minute: -1 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'weekly', daysOfWeek: [1], hour: 24, minute: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'daily', hour: 23, minute: 59 } })).toBe(true)
  })
  it('a daysOfWeek entry outside 0-6 is incomplete even though the array is non-empty', () => {
    const d = { ...emptyRoutineDraft(), prompt: 'x', modelKey: 'm', agentId: 'a' }
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'weekly', daysOfWeek: [7], hour: 9, minute: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'weekly', daysOfWeek: [-1], hour: 9, minute: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'weekly', daysOfWeek: [1, 2.5], hour: 9, minute: 0 } })).toBe(false)
    expect(isRoutineDraftComplete({ ...d, scheduleRule: { kind: 'weekly', daysOfWeek: [0, 6], hour: 9, minute: 0 } })).toBe(true)
  })
})

describe('routineToDraft', () => {
  it('carries every client-controlled field across and drops the server-owned ones', () => {
    const routine: Routine = {
      id: 'r1', flavor: 'code', status: 'active', prompt: 'Fix the build', scheduleDisplay: 'Runs daily at 9:00 AM',
      scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, nextFireAt: '2026-08-02T09:00:00.000Z', modelKey: 'm',
      workspacePath: 'D:/repo', codingAgent: 'claude_cli', permissionMode: 'plan',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }
    expect(routineToDraft(routine)).toEqual({
      flavor: 'code', prompt: 'Fix the build', scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'm',
      agentId: undefined, workspacePath: 'D:/repo', codingAgent: 'claude_cli', permissionMode: 'plan',
    })
    expect(isRoutineDraftComplete(routineToDraft(routine))).toBe(true)
  })
})
