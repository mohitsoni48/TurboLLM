// The live engine-log tail must authenticate like every other API call. It used to be a browser
// EventSource, which cannot send X-TurboLLM-Auth — over LAN-with-a-key or remote access its
// handshake got a 401 and no new line ever appeared (jsdom has no EventSource at all, so the old
// hook cannot even mount here).
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
})
