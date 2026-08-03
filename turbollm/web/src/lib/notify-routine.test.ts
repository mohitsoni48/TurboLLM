import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserNotifyRoutineResult, diffNewlyTerminalRuns, useRoutineNotificationPoller,
} from './notify-routine'
import type { RoutineWithLatestRun } from './routine-queries'
import type { Routine, RoutineRun } from './routine-types'

// The poller reads the same query hook the nav badge and the Routines panel use. Mocked wholesale
// so these tests drive poll-to-poll transitions directly instead of simulating a network.
let polled: RoutineWithLatestRun[] = []
vi.mock('./routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./routine-queries')>()
  return {
    ...actual,
    useRoutinesWithLatestRun: () => ({ items: polled, isLoading: false, isError: false, refetch: vi.fn() }),
  }
})

function item(overrides: Partial<RoutineRun> | null = {}, promptOverride = 'Summarize my inbox'): RoutineWithLatestRun {
  const routine: Routine = {
    id: 'r1', flavor: 'chat', status: 'active', prompt: promptOverride, scheduleDisplay: 'd',
    scheduleRule: { kind: 'interval', everyMs: 1000 }, nextFireAt: null, modelKey: 'm',
    createdAt: '', updatedAt: '',
  }
  if (overrides === null) return { routine, latestRun: null }
  return {
    routine,
    latestRun: { id: 'run1', routineId: 'r1', status: 'ok', configSnapshot: '{}', startedAt: '', ...overrides },
  }
}

describe('diffNewlyTerminalRuns', () => {
  it('reports nothing on the very first poll (no prior snapshot to diff against)', () => {
    expect(diffNewlyTerminalRuns([item()], new Map())).toEqual([])
  })

  it('reports a run that just transitioned from running to a terminal status', () => {
    const prev = new Map<string, RoutineRun['status']>([['run1', 'running']])
    const result = diffNewlyTerminalRuns([item({ status: 'ok' })], prev)
    expect(result.map((r) => r.latestRun?.id)).toEqual(['run1'])
  })

  it('does not re-report a run whose terminal status was already seen last poll', () => {
    const prev = new Map<string, RoutineRun['status']>([['run1', 'ok']])
    expect(diffNewlyTerminalRuns([item({ status: 'ok' })], prev)).toEqual([])
  })

  it('does not report a run that is still running', () => {
    const prev = new Map<string, RoutineRun['status']>([['run1', 'running']])
    expect(diffNewlyTerminalRuns([item({ status: 'running' })], prev)).toEqual([])
  })

  it('does not crash on a routine with no runs yet', () => {
    expect(diffNewlyTerminalRuns([item(null)], new Map())).toEqual([])
  })

  /** The rule is "a status we already observed CHANGED", not "we have not notified for this id".
   *  A run id absent from the previous snapshot is never reported, whatever its status — that is
   *  what makes the first poll silent, and it is load-bearing beyond the first poll too, because
   *  `useRoutinesWithLatestRun` resolves in two stages (the routines list first, each routine's
   *  runs a moment later). Treating "unseen" as "new" would fire a notification for every
   *  routine's last completed run every time the app is opened. */
  it('never reports an unseen run id, even one that is already terminal', () => {
    const prev = new Map<string, RoutineRun['status']>([['some-older-run', 'ok']])
    expect(diffNewlyTerminalRuns([item({ status: 'errored' })], prev)).toEqual([])
  })

  it.each(['ok', 'errored', 'skipped', 'needs_approval'] as const)('treats %s as terminal', (status) => {
    const prev = new Map<string, RoutineRun['status']>([['run1', 'running']])
    expect(diffNewlyTerminalRuns([item({ status })], prev)).toHaveLength(1)
  })
})

describe('browserNotifyRoutineResult', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function stubNotification(permission: string, impl?: () => void) {
    const spy = vi.fn(impl)
    vi.stubGlobal('Notification', Object.assign(spy, { permission, requestPermission: vi.fn() }))
    return spy
  }

  it('fires a Notification when permission is granted', () => {
    const NotificationSpy = stubNotification('granted')
    const { routine, latestRun } = item({ status: 'needs_approval' })
    browserNotifyRoutineResult(routine, latestRun!)
    expect(NotificationSpy).toHaveBeenCalledWith(
      'Routine needs approval',
      expect.objectContaining({ body: expect.stringContaining('Summarize my inbox') }),
    )
  })

  it.each([
    ['ok', 'Routine finished'],
    ['errored', 'Routine errored'],
    ['skipped', 'Routine skipped'],
    ['needs_approval', 'Routine needs approval'],
  ] as const)('titles a %s run "%s"', (status, title) => {
    const NotificationSpy = stubNotification('granted')
    const { routine, latestRun } = item({ status })
    browserNotifyRoutineResult(routine, latestRun!)
    expect(NotificationSpy).toHaveBeenCalledWith(title, expect.anything())
  })

  it('does nothing when permission was never granted (best-effort, never throws)', () => {
    const NotificationSpy = stubNotification('denied')
    const { routine, latestRun } = item({ status: 'ok' })
    expect(() => browserNotifyRoutineResult(routine, latestRun!)).not.toThrow()
    expect(NotificationSpy).not.toHaveBeenCalled()
  })

  /** 'default' is the untouched state — permission has been neither granted nor refused. This
   *  module must stay silent AND must not prompt: asking for notification permission is a separate,
   *  explicit user action elsewhere, deliberately out of this phase's scope. */
  it('stays silent and never prompts when permission is still "default"', () => {
    const NotificationSpy = stubNotification('default')
    const { routine, latestRun } = item({ status: 'ok' })
    browserNotifyRoutineResult(routine, latestRun!)
    expect(NotificationSpy).not.toHaveBeenCalled()
    expect((globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission)
      .not.toHaveBeenCalled()
  })

  it('never calls requestPermission even when it is allowed to notify', () => {
    stubNotification('granted')
    const { routine, latestRun } = item({ status: 'ok' })
    browserNotifyRoutineResult(routine, latestRun!)
    expect((globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission)
      .not.toHaveBeenCalled()
  })

  it('does nothing when the Notification API does not exist at all (no crash on older/unsupported environments)', () => {
    vi.stubGlobal('Notification', undefined)
    const { routine, latestRun } = item({ status: 'ok' })
    expect(() => browserNotifyRoutineResult(routine, latestRun!)).not.toThrow()
  })

  /** Some embedders expose the constructor but throw on construction (a permissions-policy-blocked
   *  iframe, for instance). Still a silent no-op — the durable in-app inbox is the real channel. */
  it('swallows a constructor that throws', () => {
    stubNotification('granted', () => { throw new Error('notifications blocked by permissions policy') })
    const { routine, latestRun } = item({ status: 'ok' })
    expect(() => browserNotifyRoutineResult(routine, latestRun!)).not.toThrow()
  })

  /** ...and the same embedder can throw on merely READING `permission`, before there is any
   *  constructor call to wrap. This is why the guard covers the whole body rather than just the
   *  `new Notification(...)` line. */
  it('swallows an environment that throws on reading Notification.permission', () => {
    const spy = vi.fn()
    Object.defineProperty(spy, 'permission', { get() { throw new Error('blocked by permissions policy') } })
    vi.stubGlobal('Notification', spy)
    const { routine, latestRun } = item({ status: 'ok' })
    expect(() => browserNotifyRoutineResult(routine, latestRun!)).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  /** A partial polyfill: the global exists but carries no `permission` property at all. Reading it
   *  yields undefined, which must be treated as "not granted" rather than throwing or firing. */
  it('treats a Notification global with no permission property as not granted', () => {
    const spy = vi.fn()
    vi.stubGlobal('Notification', spy)
    const { routine, latestRun } = item({ status: 'ok' })
    expect(() => browserNotifyRoutineResult(routine, latestRun!)).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('useRoutineNotificationPoller', () => {
  const notify = vi.fn()
  beforeEach(() => { notify.mockReset(); notify.mockImplementation(() => {}); polled = [] })

  /** Each call re-renders the SAME hook instance, so the ref holding the previous poll's statuses
   *  survives — that is the thing under test. */
  function poll(next: RoutineWithLatestRun[], rerender?: () => void) {
    polled = next
    if (rerender) rerender()
  }

  it('notifies nothing on the first poll, however many finished runs already exist', () => {
    poll([item({ status: 'ok' })])
    renderHook(() => useRoutineNotificationPoller(notify))
    expect(notify).not.toHaveBeenCalled()
  })

  /** The real mount sequence: `useRoutinesWithLatestRun` resolves the routines list before any
   *  per-routine runs query, so the first render genuinely sees `latestRun: null` and the second
   *  sees a long-finished run. Nothing "became" terminal — the app was merely opened. */
  it('stays silent when runs resolve a render after the routines list', () => {
    poll([item(null)])
    const { rerender } = renderHook(() => useRoutineNotificationPoller(notify))
    poll([item({ status: 'ok' })], rerender)
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies exactly once when a run reaches a terminal status, and never again for that status', () => {
    poll([item({ status: 'running' })])
    const { rerender } = renderHook(() => useRoutineNotificationPoller(notify))
    expect(notify).not.toHaveBeenCalled()

    poll([item({ status: 'ok' })], rerender)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[1]).toMatchObject({ id: 'run1', status: 'ok' })

    // Three more polls returning the identical finished run — the exact repeat-poll case.
    poll([item({ status: 'ok' })], rerender)
    poll([item({ status: 'ok' })], rerender)
    poll([item({ status: 'ok' })], rerender)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  /** needs_approval is terminal for notification purposes but not for the run: approving resumes
   *  it, so the SAME run id legitimately notifies a second time when it later finishes. */
  it('notifies again when the same run moves from needs_approval to a final status', () => {
    poll([item({ status: 'running' })])
    const { rerender } = renderHook(() => useRoutineNotificationPoller(notify))
    poll([item({ status: 'needs_approval' })], rerender)
    poll([item({ status: 'needs_approval' })], rerender)
    expect(notify).toHaveBeenCalledTimes(1)

    poll([item({ status: 'running' })], rerender)
    poll([item({ status: 'ok' })], rerender)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]?.[1]).toMatchObject({ status: 'ok' })
  })

  /** A notification implementation that throws must not break the app shell the poller is mounted
   *  in, AND must not leave the run un-recorded — otherwise every subsequent poll would retry it
   *  forever. */
  it('survives a notify implementation that throws, without retrying it on the next poll', () => {
    notify.mockImplementation(() => { throw new Error('dispatch exploded') })
    poll([item({ status: 'running' })])
    const { rerender } = renderHook(() => useRoutineNotificationPoller(notify))
    expect(() => poll([item({ status: 'ok' })], rerender)).not.toThrow()
    expect(notify).toHaveBeenCalledTimes(1)

    expect(() => poll([item({ status: 'ok' })], rerender)).not.toThrow()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('tracks each routine independently', () => {
    const other = (status: RoutineRun['status']): RoutineWithLatestRun => ({
      routine: { ...item().routine, id: 'r2', prompt: 'Tidy the repo' },
      latestRun: { id: 'run2', routineId: 'r2', status, configSnapshot: '{}', startedAt: '' },
    })
    poll([item({ status: 'running' }), other('running')])
    const { rerender } = renderHook(() => useRoutineNotificationPoller(notify))

    poll([item({ status: 'running' }), other('errored')], rerender)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ id: 'r2' })

    poll([item({ status: 'ok' }), other('errored')], rerender)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]?.[0]).toMatchObject({ id: 'r1' })
  })

  /** The poller never touches the Notification API itself — it only ever calls the injected
   *  implementation, which is the whole point of the seam (a future Electron build swaps in a
   *  native-OS dispatcher without this hook changing). */
  it('routes every dispatch through the injected implementation', () => {
    const NotificationSpy = vi.fn()
    vi.stubGlobal('Notification', Object.assign(NotificationSpy, { permission: 'granted' }))
    poll([item({ status: 'running' })])
    const { rerender } = renderHook(() => useRoutineNotificationPoller(notify))
    poll([item({ status: 'ok' })], rerender)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(NotificationSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
