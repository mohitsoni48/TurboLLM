// Requests per minute from an idle, open UI (scalability review 4.14): the polls the chat screen and the
// app shell keep running (status, hardware bar, models, downloads, the conversation list and the open
// conversation, the routines nav badge), counted over 60 s of fake time with the invalidation stream
// refused (as before GET /api/v1/events existed: every poll at its old cadence) and with it open.
import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../query-client'
import { useConversation, useConversations } from './chat-queries'
import { useLiveInvalidation } from './live-events'
import { useDownloads, useHwUsage, useModels, useStatus } from './queries'
import { useRoutinesWithLatestRun } from './routine-queries'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** What an idle daemon answers: nothing loaded, nothing generating, two routines. */
function idleDaemon(url: string, eventsOpen: boolean): Response {
  if (url.startsWith('/api/v1/events')) {
    return eventsOpen
      ? new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      : json({ error: { code: 'not_found', message: 'Unknown endpoint.' } })
  }
  if (url.startsWith('/api/v1/status')) return json({ engine: { state: 'stopped' }, engineStats: { activeRequests: 0 } })
  if (url.startsWith('/api/v1/hwstats')) return json({})
  if (url.startsWith('/api/v1/models')) return json({ models: [], scanning: false, lastScanAt: 'x' })
  if (url.startsWith('/api/v1/downloads')) return json({ downloads: [] })
  if (url.startsWith('/api/v1/conversations/c1')) return json({ id: 'c1', messages: [] })
  if (url.startsWith('/api/v1/conversations')) return json({ conversations: [], nextCursor: null })
  if (/^\/api\/v1\/routines\/[^/]+\/runs/.test(url)) return json([])
  if (url.startsWith('/api/v1/routines')) return json([{ id: 'r1' }, { id: 'r2' }])
  return json({})
}

/** The hardware bar's poll is left fast on purpose (GPU/CPU usage changes continuously), so it is
 *  measured both ways. */
function IdleChatScreen({ hardwareBar }: { hardwareBar: boolean }) {
  useLiveInvalidation()
  useStatus()
  useHwUsage(hardwareBar)
  useModels()
  useDownloads()
  useConversations()
  useConversation('c1')
  useRoutinesWithLatestRun(true)
  return null
}

async function requestsInOneIdleMinute(eventsOpen: boolean, hardwareBar: boolean): Promise<number> {
  const fetchMock = vi.fn(async (url: string) => idleDaemon(url, eventsOpen))
  vi.stubGlobal('fetch', fetchMock)
  const qc = createQueryClient()
  const { unmount } = render(<QueryClientProvider client={qc}><IdleChatScreen hardwareBar={hardwareBar} /></QueryClientProvider>)
  await vi.advanceTimersByTimeAsync(10_000)
  const settled = polls(fetchMock)
  await vi.advanceTimersByTimeAsync(60_000)
  const perMinute = polls(fetchMock) - settled
  unmount()
  qc.clear()
  return perMinute
}

/** Requests other than the event stream itself. */
function polls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => !String(url).startsWith('/api/v1/events')).length
}

describe('idle request rate', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('drops from 72 to 14 a minute once the invalidation stream is open', async () => {
    vi.useFakeTimers()
    const before = await requestsInOneIdleMinute(false, false)
    const after = await requestsInOneIdleMinute(true, false)
    expect({ before, after }).toEqual({ before: 72, after: 14 })
  })

  it('drops from 102 to 44 a minute with the hardware bar on, whose 2 s poll stays', async () => {
    vi.useFakeTimers()
    const before = await requestsInOneIdleMinute(false, true)
    const after = await requestsInOneIdleMinute(true, true)
    expect({ before, after }).toEqual({ before: 102, after: 44 })
  })
})

// A hidden tab holds no connection and sends nothing: its polls are paused, and its invalidation stream is let go
// (the daemon is HTTP/1.1, and a browser keeps at most 6 connections to it across every tab).
describe('idle request rate of a hidden tab', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends nothing for a minute and holds no stream open', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => idleDaemon(url, true))
    vi.stubGlobal('fetch', fetchMock)
    const qc = createQueryClient()
    const { unmount } = render(<QueryClientProvider client={qc}><IdleChatScreen hardwareBar /></QueryClientProvider>)
    await vi.advanceTimersByTimeAsync(10_000)

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    const before = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    const streams = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/v1/events'))

    expect({ requests: fetchMock.mock.calls.length - before, streamsHeld: streams.filter(([, init]) => !init?.signal?.aborted).length })
      .toEqual({ requests: 0, streamsHeld: 0 })
    unmount()
    qc.clear()
  })
})
