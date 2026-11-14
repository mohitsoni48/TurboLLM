// The app's one invalidation stream (GET /api/v1/events, review 4.14): keys the daemon sends become
// invalidateQueries calls, a reopened stream resyncs everything, and the polls it replaces slow down only
// while it is really open.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatKeys, memoryKeys } from './chat-queries'
import { codeKeys } from './code-queries'
import { queryKeys } from './queries'
import { routineKeys } from './routine-queries'
import {
  EVENT_FALLBACK_POLL_MS, invalidationTargets, liveEventsConnected, pollWhileLive, useLiveInvalidation,
} from './live-events'

const enc = new TextEncoder()
const invalidate = (keys: string[]) => enc.encode(`event: invalidate\ndata: ${JSON.stringify(keys)}\n\n`)

/** An event stream the test feeds and ends by hand. */
function controllableStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream({ start(c) { ctl = c } }), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })
  return { response, send: (keys: string[]) => ctl.enqueue(invalidate(keys)), end: () => ctl.close() }
}

function mount(qc: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return renderHook(() => useLiveInvalidation(), { wrapper })
}

/** The cached queries an invalidation key marks stale, by key. */
function invalidatedBy(key: string, cached: ReadonlyArray<readonly unknown[]>): unknown[][] {
  const qc = new QueryClient()
  for (const queryKey of cached) qc.setQueryData(queryKey, {})
  for (const filters of invalidationTargets(key)) void qc.invalidateQueries({ ...filters, refetchType: 'none' })
  return qc.getQueryCache().getAll().filter((q) => q.state.isInvalidated).map((q) => [...q.queryKey])
}

describe('invalidationTargets', () => {
  it('maps each family key onto the query keys the screens use', () => {
    expect(invalidationTargets('status')).toEqual([{ queryKey: queryKeys.status }])
    expect(invalidationTargets('memory')).toEqual([{ queryKey: memoryKeys.list }])
    expect(invalidationTargets('downloads')).toEqual([{ queryKey: queryKeys.downloads }])
    expect(invalidationTargets('models')).toEqual([{ queryKey: queryKeys.models }])
    expect(invalidationTargets('engines')).toEqual([{ queryKey: queryKeys.engines }, { queryKey: queryKeys.engineUpdates }])
    expect(invalidationTargets('code-sessions')).toEqual([{ queryKey: ['code-sessions'] }, { queryKey: ['code-session'] }])
    expect(invalidationTargets('settings')).toEqual([{ queryKey: ['settings'] }])
    expect(invalidationTargets('sandboxRuntime')).toEqual([{ queryKey: queryKeys.sandboxRuntime }])
  })

  // The sidebar polls the list's first page alone and refetches every loaded page only when that page changed
  // (useConversationListPoll); a key that refetched every page itself undid that on every announced write.
  it('maps conversations onto the list heads and the folders, never the loaded pages', () => {
    const cached = [
      chatKeys.list(''), chatKeys.listHead(''), chatKeys.list('tea'), chatKeys.listHead('tea'), chatKeys.folders, chatKeys.detail('c1'),
    ]
    expect(invalidatedBy('conversations', cached)).toEqual([chatKeys.listHead(''), chatKeys.listHead('tea'), chatKeys.folders])
  })

  // Every scheduler fire writes a run, which names its own routine's runs; the routines family is the routines
  // themselves, so it no longer refetches every routine's runs.
  it('maps routines onto the routine list and details, not their runs', () => {
    const cached = [routineKeys.list, routineKeys.detail('r1'), routineKeys.runs('r1'), routineKeys.history('r1')]
    expect(invalidatedBy('routines', cached)).toEqual([routineKeys.list, routineKeys.detail('r1')])
    expect(invalidatedBy('routine-runs:r1', cached)).toEqual([routineKeys.runs('r1'), routineKeys.history('r1')])
  })

  it('maps a scoped key onto that one entity, and ignores keys it does not know', () => {
    expect(invalidationTargets('conversation:c1')).toEqual([{ queryKey: chatKeys.detail('c1') }])
    expect(invalidationTargets('routine-runs:r1')).toEqual([{ queryKey: routineKeys.runs('r1') }])
    expect(invalidationTargets('something-new')).toEqual([])
  })

  it('keeps the prefixes matching the query families they invalidate', () => {
    expect(chatKeys.list('x').slice(0, 1)).toEqual(['conversations'])
    expect(chatKeys.listHead('x')[2]).toBe('head')
    expect(routineKeys.detail('x').slice(0, 1)).toEqual(['routine'])
    expect(codeKeys.list('all').slice(0, 1)).toEqual(['code-sessions'])
    expect(codeKeys.detail('x').slice(0, 1)).toEqual(['code-session'])
  })
})

describe('useLiveInvalidation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('invalidates what each key names, resyncs everything when the stream reopens, and slows polls only while open', async () => {
    const streams = [controllableStream(), controllableStream()]
    let opened = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('/api/v1/events')
      return streams[opened++].response
    }))
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { unmount } = mount(qc)

    await vi.advanceTimersByTimeAsync(0)
    expect(liveEventsConnected()).toBe(true)
    expect(pollWhileLive(4000)).toBe(EVENT_FALLBACK_POLL_MS)
    expect(spy).not.toHaveBeenCalled()

    streams[0].send(['conversation:c1', 'unknown'])
    await vi.advanceTimersByTimeAsync(0)
    expect(spy.mock.calls).toEqual([[{ queryKey: chatKeys.detail('c1') }]])

    streams[0].end()
    await vi.advanceTimersByTimeAsync(0)
    expect(liveEventsConnected()).toBe(false)
    expect(pollWhileLive(4000)).toBe(4000)
    expect(spy.mock.calls.slice(1), 'a dropped stream refetches once, so each poll restarts at its fast cadence').toEqual([[]])

    await vi.advanceTimersByTimeAsync(3000)
    expect(liveEventsConnected()).toBe(true)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy).toHaveBeenLastCalledWith()

    streams[1].send(['*'])
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(4)
    expect(spy).toHaveBeenLastCalledWith()

    unmount()
    await vi.advanceTimersByTimeAsync(0)
    expect(liveEventsConnected()).toBe(false)
  })
})

describe('useLiveInvalidation in a hidden tab', () => {
  let visibility: DocumentVisibilityState = 'visible'
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state
    document.dispatchEvent(new Event('visibilitychange'))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // The daemon speaks HTTP/1.1: a browser holds at most 6 connections to it across every tab, so an idle stream per
  // hidden tab left the visible one's requests queued behind them.
  it('lets the stream go while hidden, and on return reopens it and resyncs everything once', async () => {
    const streams = [controllableStream(), controllableStream()]
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!)
      return streams[signals.length - 1].response
    }))
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { unmount } = mount(qc)
    await vi.advanceTimersByTimeAsync(0)
    expect(liveEventsConnected()).toBe(true)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(0)
    expect(signals[0].aborted, 'no connection held while hidden').toBe(true)
    expect(liveEventsConnected()).toBe(false)
    expect(pollWhileLive(4000), 'the paused polls of a hidden tab keep their own cadence').toBe(4000)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(signals).toHaveLength(1)
    expect(spy, 'no refetch while hidden').not.toHaveBeenCalled()

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toHaveLength(2)
    expect(liveEventsConnected()).toBe(true)
    expect(spy.mock.calls).toEqual([[]])

    unmount()
  })

  it('opens no stream for a tab mounted hidden until it shows', async () => {
    visibility = 'hidden'
    const stream = controllableStream()
    const fetchMock = vi.fn(async () => stream.response)
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = mount(new QueryClient())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).not.toHaveBeenCalled()

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(liveEventsConnected()).toBe(true)
    unmount()
  })
})
