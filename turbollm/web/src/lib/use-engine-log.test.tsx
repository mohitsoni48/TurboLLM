// The live engine-log tail must authenticate like every other API call. It used to be a browser
// EventSource, which cannot send X-TurboLLM-Auth — over LAN-with-a-key or remote access its
// handshake got a 401 and no new line ever appeared (jsdom has no EventSource at all, so the old
// hook cannot even mount here).
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAuthToken } from './api'
import { useEngineLog } from './use-engine-log'

const enc = new TextEncoder()

describe('useEngineLog', () => {
  beforeEach(() => localStorage.setItem('tllm.authToken', 'k-123'))
  afterEach(() => {
    localStorage.removeItem('tllm.authToken')
    vi.unstubAllGlobals()
  })

  it('tails /engine/logs/stream with the API key and appends lines after the initial tail', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/engine/logs/stream')) {
        // An event split between its event: and data: lines, as the network can deliver it.
        const chunks = ['event: ping\ndata: \n\nevent: line\n', 'data: {"line":"ready"}\n\n']
        // Delivered a beat later, so the initial tail GET has landed first (it replaces the list).
        return new Response(new ReadableStream({ start(c) { setTimeout(() => { for (const ch of chunks) c.enqueue(enc.encode(ch)) }, 20) } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ lines: ['starting'] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => useEngineLog(true))
    await waitFor(() => expect(result.current.lines).toEqual(['starting', 'ready']))
    const stream = fetchMock.mock.calls.find(([u]) => u === '/api/v1/engine/logs/stream') as unknown as [string, RequestInit]
    expect(stream[1].headers).toMatchObject({ 'X-TurboLLM-Auth': 'k-123' })
    unmount()
  })

  // The daemon starts a stream with no Last-Event-ID from "now" (routes.ts), so a reopened one
  // that did not send it lost every line written while the tail reconnected.
  it('lines written while the tail reconnects arrive: the reopened stream resumes after the last line it got', async () => {
    vi.useFakeTimers()
    try {
      const sse = (frames: string) => new Response(
        new ReadableStream({ start(c) { setTimeout(() => { c.enqueue(enc.encode(frames)); c.close() }, 20) } }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
      let streams = 0
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.startsWith('/api/v1/engine/logs/stream')) return new Response(JSON.stringify({ lines: ['starting'] }), { status: 200 })
        streams++
        if (streams === 1) return sse('event: line\ndata: {"line":"ready"}\nid: 120:6:00000000000000aa\n\n')
        // A fake daemon: from the cursor it got back, or from "now" (nothing yet) without one.
        const from = (init?.headers as Record<string, string>)['Last-Event-ID']
        return sse(from === '120:6:00000000000000aa' ? 'event: line\ndata: {"line":"written while away"}\nid: 150:6:00000000000000bb\n\n' : '')
      })
      vi.stubGlobal('fetch', fetchMock)

      const { result, unmount } = renderHook(() => useEngineLog(true))
      await act(() => vi.advanceTimersByTimeAsync(50))
      expect(result.current.lines).toEqual(['starting', 'ready'])
      await act(() => vi.advanceTimersByTimeAsync(3100)) // subscribeSse reopens the ended stream
      expect(streams).toBe(2)
      expect(result.current.lines).toEqual(['starting', 'ready', 'written while away'])
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  // The tail GET went out once, at mount. Mounted before a key was stored (the Engines drawer on
  // cached engines, as the daemon starts refusing this browser), it got a 401; the stream reopened
  // with the key once one was stored, but from "now" (no Last-Event-ID), and the log so far was
  // never asked for again: a loaded, quiet engine's panel stayed empty.
  it('loads the log so far once a key is stored, when the tail sent before it was refused', async () => {
    localStorage.removeItem('tllm.authToken')
    const keyed = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.['X-TurboLLM-Auth'] === 'k-new'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!keyed(init)) return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid API key is required.' } }), { status: 401 })
      if (url.startsWith('/api/v1/engine/logs/stream')) {
        // A quiet engine: the stream stays open and only pings.
        return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('event: ping\ndata: \n\n')) } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ lines: ['old line 1', 'old line 2'] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => useEngineLog(true))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === '/api/v1/engine/logs/stream')).toHaveLength(1))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === '/api/v1/engine/logs?tail=200')).toHaveLength(1))
    expect(result.current.lines).toEqual([])

    act(() => setAuthToken('k-new'))

    await waitFor(() => expect(result.current.lines).toEqual(['old line 1', 'old line 2']))
    const tails = fetchMock.mock.calls.filter(([u]) => u === '/api/v1/engine/logs?tail=200')
    expect(tails).toHaveLength(2)
    expect(keyed(tails[1][1])).toBe(true)
    unmount()
  })

  // The stream reopening with a key while the keyless tail GET was still out found it loading and
  // left it be; that GET then came back 401, and nothing asked again until the stream next reopened.
  it('loads the log so far when a key is stored while the tail sent before it is still out', async () => {
    localStorage.removeItem('tllm.authToken')
    const keyed = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.['X-TurboLLM-Auth'] === 'k-new'
    const refused = () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid API key is required.' } }), { status: 401 })
    let answerFirstTail: (r: Response) => void = () => {}
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/v1/engine/logs/stream')) {
        if (!keyed(init)) return refused()
        return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('event: ping\ndata: \n\n')) } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      // The keyless tail GET at mount answers only once the keyed stream has opened.
      if (!keyed(init)) return new Promise<Response>((res) => { answerFirstTail = res })
      return new Response(JSON.stringify({ lines: ['old line 1', 'old line 2'] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => useEngineLog(true))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === '/api/v1/engine/logs/stream')).toHaveLength(1))

    act(() => setAuthToken('k-new'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, init]) => u === '/api/v1/engine/logs/stream' && keyed(init))).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) }) // the keyed stream's response has arrived
    await act(async () => { answerFirstTail(refused()) })

    await waitFor(() => expect(result.current.lines).toEqual(['old line 1', 'old line 2']))
    const tails = fetchMock.mock.calls.filter(([u]) => u === '/api/v1/engine/logs?tail=200')
    expect(tails).toHaveLength(2)
    expect(keyed(tails[1][1])).toBe(true)
    unmount()
  })

  it('does not ask for the log so far again when the stream reopens after it loaded', async () => {
    let streams = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/engine/logs/stream')) {
        streams++
        // The first stream ends at once, so subscribeSse reopens it.
        return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('event: ping\ndata: \nid: 10:6:00000000000000aa\n\n')); if (streams === 1) c.close() } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ lines: ['starting'] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() => useEngineLog(true))
      await act(() => vi.advanceTimersByTimeAsync(50))
      expect(result.current.lines).toEqual(['starting'])
      await act(() => vi.advanceTimersByTimeAsync(3100))
      expect(streams).toBe(2)
      expect(fetchMock.mock.calls.filter(([u]) => u === '/api/v1/engine/logs?tail=200')).toHaveLength(1)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
