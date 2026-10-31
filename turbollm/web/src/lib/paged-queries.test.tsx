// The paged list hooks (conversations, memory facts, routine runs). Each is a cursor-paged infinite query whose
// consumers still read a flat list. The behaviour that matters is what the 4-15s polls do to pages the user already
// loaded: a refresh re-reads every loaded page in order, so nothing already shown disappears and nothing repeats,
// even when rows arrive or vanish at the top between two polls.
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversations, useMemoryFacts } from './chat-queries'
import { useRoutineRuns } from './routine-queries'

const PAGE = 2
/** A server-side list newest-first; a cursor is the offset the next page starts at. */
let rows: Array<{ id: string }> = []
function serve<K extends string>(key: K, cursor?: string | null) {
  const start = cursor ? Number(cursor) : 0
  const end = start + PAGE
  return { [key]: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null } as Record<K, Array<{ id: string }>> & { nextCursor: string | null }
}
const ids = (n: number, prefix = 'x') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

const listConversations = vi.fn(async (_q?: string, cursor?: string | null) => serve('conversations', cursor))
const listMemoryFacts = vi.fn(async (cursor?: string | null) => serve('facts', cursor))
const listRoutineRunsPage = vi.fn(async (_id: string, before?: string | null) => {
  const { runs, nextCursor } = serve('runs', before)
  return { runs, nextCursor }
})

vi.mock('./chat-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chat-api')>()),
  listConversations: (...a: [string?, (string | null)?]) => listConversations(...a),
  listMemoryFacts: (...a: [(string | null)?]) => listMemoryFacts(...a),
}))
vi.mock('./routine-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./routine-api')>()),
  listRoutineRunsPage: (...a: [string, (string | null)?]) => listRoutineRunsPage(...a),
}))

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { vi.clearAllMocks(); rows = ids(5) })

describe('useConversations', () => {
  it('serves page one as a flat list and reports there is more', async () => {
    const { result } = renderHook(() => useConversations(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.conversations.map((c) => c.id)).toEqual(['x0', 'x1']))
    expect(result.current.hasNextPage).toBe(true)
  })

  it('appends the next page, and the last page ends the paging', async () => {
    const { result } = renderHook(() => useConversations(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.conversations).toHaveLength(2))
    expect(result.current.hasNextPage).toBe(true)
    await act(async () => { await result.current.fetchNextPage() })
    await act(async () => { await result.current.fetchNextPage() })
    await waitFor(() => expect(result.current.data?.conversations.map((c) => c.id)).toEqual(['x0', 'x1', 'x2', 'x3', 'x4']))
    expect(result.current.hasNextPage).toBe(false)
  })

  it('a refresh keeps the loaded pages and does not repeat a row that slid down a page', async () => {
    const { result } = renderHook(() => useConversations(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.conversations).toHaveLength(2))
    expect(result.current.hasNextPage).toBe(true)
    await act(async () => { await result.current.fetchNextPage() })
    await waitFor(() => expect(result.current.data?.conversations).toHaveLength(4))
    rows = [{ id: 'new' }, ...rows] // a new chat lands at the top; every row slides down one place
    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.data?.conversations.map((c) => c.id)).toEqual(['new', 'x0', 'x1', 'x2']))
  })

  it('never repeats a row even when a page boundary moves between two reads', async () => {
    const { result } = renderHook(() => useConversations(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.conversations).toHaveLength(2))
    expect(result.current.hasNextPage).toBe(true)
    await act(async () => { await result.current.fetchNextPage() })
    await waitFor(() => expect(result.current.data?.conversations).toHaveLength(4))
    // Boundary drift: the server answers the second page starting one row early, so x1 is in both pages.
    listConversations.mockImplementationOnce(async () => serve('conversations'))
    listConversations.mockImplementationOnce(async () => ({ conversations: [{ id: 'x1' }, { id: 'x2' }] as never, nextCursor: null }))
    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.data?.conversations.map((c) => c.id)).toEqual(['x0', 'x1', 'x2']))
  })

  it('the 4s poll reads only the first page, not every loaded one; a change there refreshes the loaded pages', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { result } = renderHook(() => useConversations(), { wrapper: wrapper() })
      await waitFor(() => expect(result.current.data?.conversations).toHaveLength(2))
      await act(async () => { await result.current.fetchNextPage() })
      await act(async () => { await result.current.fetchNextPage() })
      await waitFor(() => expect(result.current.data?.conversations).toHaveLength(5))
      await act(async () => { await vi.advanceTimersByTimeAsync(4100) })

      listConversations.mockClear()
      await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
      expect(listConversations.mock.calls).toEqual([[undefined, null]])

      rows = [{ id: 'new' }, ...rows]
      await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
      await waitFor(() => expect(result.current.data?.conversations.map((c) => c.id)).toEqual(['new', 'x0', 'x1', 'x2', 'x3', 'x4']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('searches unpaged: one request, no cursor, nothing more to load', async () => {
    listConversations.mockImplementationOnce(async () => ({ conversations: ids(3, 's') as never, nextCursor: null }))
    const { result } = renderHook(() => useConversations('cats'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.conversations).toHaveLength(3))
    expect(listConversations).toHaveBeenCalledWith('cats', null)
    expect(result.current.hasNextPage).toBe(false)
  })
})

describe('useMemoryFacts', () => {
  it('pages like the conversation list, still handing back { facts }', async () => {
    const { result } = renderHook(() => useMemoryFacts(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.facts.map((f) => f.id)).toEqual(['x0', 'x1']))
    await act(async () => { await result.current.fetchNextPage() })
    await waitFor(() => expect(result.current.data?.facts.map((f) => f.id)).toEqual(['x0', 'x1', 'x2', 'x3']))
    expect(result.current.hasNextPage).toBe(true)
  })
})

describe('useRoutineRuns', () => {
  it('hands back the runs as one flat array and loads older ones on demand', async () => {
    const { result } = renderHook(() => useRoutineRuns('rt'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.map((r) => r.id)).toEqual(['x0', 'x1']))
    expect(result.current.hasNextPage).toBe(true)
    await act(async () => { await result.current.fetchNextPage() })
    expect(listRoutineRunsPage).toHaveBeenLastCalledWith('rt', '2')
    await waitFor(() => expect(result.current.data?.map((r) => r.id)).toEqual(['x0', 'x1', 'x2', 'x3']))
  })

  it('does not fetch without a routine id', () => {
    renderHook(() => useRoutineRuns(undefined), { wrapper: wrapper() })
    expect(listRoutineRunsPage).not.toHaveBeenCalled()
  })
})
