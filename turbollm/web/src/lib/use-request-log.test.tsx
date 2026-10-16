// The live request tail must authenticate like every other API call. It used to be a browser
// EventSource, which cannot send X-TurboLLM-Auth — over LAN-with-a-key or remote access its
// handshake got a 401 and no new request ever appeared (jsdom has no EventSource at all, so the
// old hook cannot even mount here).
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRequestLog } from './use-request-log'

const enc = new TextEncoder()
const entry = (id: string, status: number | null, ts = 1) => ({ id, ts, status })
const frame = (e: object) => enc.encode(`event: entry\ndata: ${JSON.stringify(e)}\n\n`)
const sseResponse = (start: (c: ReadableStreamDefaultController<Uint8Array>) => void) =>
  new Response(new ReadableStream({ start }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

describe('useRequestLog', () => {
  beforeEach(() => localStorage.setItem('tllm.authToken', 'k-123'))
  afterEach(() => {
    vi.useRealTimers()
    localStorage.removeItem('tllm.authToken')
    vi.unstubAllGlobals()
  })

  it('tails /requests/stream with the API key and upserts entries by id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/requests/stream')) {
        const frames = [entry('r1', null), entry('r1', 200)].map((e) => `event: entry\ndata: ${JSON.stringify(e)}\n\n`)
        // Delivered a beat later, after the history GET that the stream's opening sends has landed.
        return new Response(new ReadableStream({ start(c) { setTimeout(() => { for (const f of frames) c.enqueue(enc.encode(f)) }, 20) } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ entries: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => useRequestLog(true))
    await waitFor(() => expect(result.current.entries).toEqual([entry('r1', 200)]))
    const stream = fetchMock.mock.calls.find(([u]) => u === '/api/v1/requests/stream') as unknown as [string, RequestInit]
    expect(stream[1].headers).toMatchObject({ 'X-TurboLLM-Auth': 'k-123' })
    unmount()
  })

  // The history GET and the live tail race. A request finalizes once, so a finalize the stream
  // delivered before the GET's response landed was overwritten by the GET's older pending copy,
  // and the row said "pending" until the panel was reopened.
  it('keeps a finalize the stream delivered before the history GET landed', async () => {
    let releaseGet!: () => void
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/requests/stream')) {
        return sseResponse((c) => { c.enqueue(frame(entry('r1', null))); c.enqueue(frame(entry('r1', 200))) })
      }
      // The snapshot was taken while r1 was still running; its response is slow to arrive.
      await new Promise<void>((r) => { releaseGet = r })
      return new Response(JSON.stringify({ entries: [entry('r0', 200, 0), entry('r1', null)] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => useRequestLog(true))
    await waitFor(() => expect(result.current.entries).toEqual([entry('r1', 200)]))
    await waitFor(() => expect(releaseGet).toBeTypeOf('function'))
    await act(async () => { releaseGet(); await new Promise((r) => setTimeout(r, 20)) })
    // r0 comes from the history, r1 keeps its final status, and the rows stay in ts order.
    expect(result.current.entries).toEqual([entry('r0', 200, 0), entry('r1', 200)])
    unmount()
  })

  // Nothing replays the events a dropped stream missed. A request whose finalize was sent while
  // the tail was reconnecting stayed "pending" for good, as did one the daemon no longer holds
  // (a restarted daemon, an evicted row), whose finalize never comes.
  it('reloads the history when the stream reconnects: a missed finalize lands, a row the daemon dropped goes', async () => {
    vi.useFakeTimers()
    let streams = 0
    let gets = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/requests/stream')) {
        // The first stream carries the start of r2 and r3, then drops. The second one is quiet:
        // r2 finalized while the tail was down, and r3 is gone from the daemon.
        if (++streams === 1) return sseResponse((c) => { c.enqueue(frame(entry('r2', null, 2))); c.enqueue(frame(entry('r3', null, 3))); c.close() })
        return sseResponse(() => {})
      }
      return new Response(JSON.stringify({ entries: ++gets === 1 ? [] : [entry('r2', 200, 2)] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => useRequestLog(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(result.current.entries).toEqual([entry('r2', null, 2), entry('r3', null, 3)])
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(streams).toBe(2)
    expect(result.current.entries).toEqual([entry('r2', 200, 2)])
    unmount()
  })
})
