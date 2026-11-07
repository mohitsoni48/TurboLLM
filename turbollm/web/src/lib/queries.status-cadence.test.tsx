// How often the status bar refetches (useStatus). While the invalidation stream is open an idle status waits 15 s,
// since the daemon announces its changes; work whose progress moves second by second with no announcement for each
// step (a backend download, a model still loading) keeps the 1 s poll.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Status } from './types'
import { useLiveInvalidation } from './live-events'
import { statusChangesEverySecond, useStatus } from './queries'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const idle = { engine: { state: 'stopped' }, engineStats: { activeRequests: 0 } }

function StatusBar() {
  useLiveInvalidation()
  useStatus()
  return null
}

/** Status requests over 10 s of fake time, with the invalidation stream open and the daemon answering `status`. */
async function statusPollsInTenSeconds(status: unknown): Promise<number> {
  const fetchMock = vi.fn(async (url: string) => (url.startsWith('/api/v1/events')
    ? new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    : json(status)))
  vi.stubGlobal('fetch', fetchMock)
  const qc = new QueryClient()
  const { unmount } = render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>)
  await vi.advanceTimersByTimeAsync(1_000)
  const settled = statusCalls(fetchMock)
  await vi.advanceTimersByTimeAsync(10_000)
  const polls = statusCalls(fetchMock) - settled
  unmount()
  qc.clear()
  return polls
}

function statusCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/v1/status')).length
}

describe('statusChangesEverySecond', () => {
  it('is true for each kind of work whose progress nothing announces step by step', () => {
    const cases: Array<Partial<Status>> = [
      { bench: { running: true } },
      { engineBuild: { active: true } as Status['engineBuild'] },
      { engineProvision: { active: true } as Status['engineProvision'] },
      { engineStats: { activeRequests: 1 } as Status['engineStats'] },
      { engine: { state: 'starting' } as Status['engine'] },
      { laya: { state: 'starting' } as Status['laya'] },
      { jev: { state: 'starting' } as Status['jev'] },
    ]
    for (const busy of cases) expect(statusChangesEverySecond({ ...idle, ...busy } as Status), JSON.stringify(busy)).toBe(true)
  })

  it('is false for an idle status, a running engine, or none yet', () => {
    expect(statusChangesEverySecond(idle as Status)).toBe(false)
    expect(statusChangesEverySecond({ ...idle, engine: { state: 'running' } } as Status)).toBe(false)
    expect(statusChangesEverySecond(undefined)).toBe(false)
  })
})

describe('useStatus cadence with the invalidation stream open', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('polls every second while an engine backend downloads, and every 15 s when idle', async () => {
    expect(await statusPollsInTenSeconds({ ...idle, engineProvision: { active: true, phase: 'downloading', pct: 0.3 } })).toBe(10)
    expect(await statusPollsInTenSeconds({ ...idle, engine: { state: 'starting' } })).toBe(10)
    expect(await statusPollsInTenSeconds(idle)).toBe(0)
  })
})
