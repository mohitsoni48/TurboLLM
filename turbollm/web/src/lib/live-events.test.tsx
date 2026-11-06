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

describe('invalidationTargets', () => {
  it('maps each family key onto the query keys the screens use', () => {
    expect(invalidationTargets('status')).toEqual([queryKeys.status])
    expect(invalidationTargets('conversations')).toEqual([['conversations'], chatKeys.folders])
    expect(invalidationTargets('memory')).toEqual([memoryKeys.list])
    expect(invalidationTargets('routines')).toEqual([routineKeys.list, ['routine'], ['routine-runs']])
    expect(invalidationTargets('downloads')).toEqual([queryKeys.downloads])
    expect(invalidationTargets('models')).toEqual([queryKeys.models])
    expect(invalidationTargets('engines')).toEqual([queryKeys.engines, queryKeys.engineUpdates])
    expect(invalidationTargets('code-sessions')).toEqual([['code-sessions'], ['code-session']])
    expect(invalidationTargets('settings')).toEqual([['settings']])
  })

  it('maps a scoped key onto that one entity, and ignores keys it does not know', () => {
    expect(invalidationTargets('conversation:c1')).toEqual([chatKeys.detail('c1')])
    expect(invalidationTargets('routine-runs:r1')).toEqual([routineKeys.runs('r1')])
    expect(invalidationTargets('something-new')).toEqual([])
  })

  it('keeps the prefixes matching the query families they invalidate', () => {
    expect(chatKeys.list('x').slice(0, 1)).toEqual(['conversations'])
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

    await vi.advanceTimersByTimeAsync(3000)
    expect(liveEventsConnected()).toBe(true)
    expect(spy).toHaveBeenLastCalledWith()

    streams[1].send(['*'])
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy).toHaveBeenLastCalledWith()

    unmount()
    await vi.advanceTimersByTimeAsync(0)
    expect(liveEventsConnected()).toBe(false)
  })
})
