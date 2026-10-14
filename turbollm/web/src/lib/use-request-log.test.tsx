// The live request tail must authenticate like every other API call. It used to be a browser
// EventSource, which cannot send X-TurboLLM-Auth — over LAN-with-a-key or remote access its
// handshake got a 401 and no new request ever appeared (jsdom has no EventSource at all, so the
// old hook cannot even mount here).
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRequestLog } from './use-request-log'

const enc = new TextEncoder()
const entry = (id: string, status: number | null) => ({ id, ts: 1, status })

describe('useRequestLog', () => {
  beforeEach(() => localStorage.setItem('tllm.authToken', 'k-123'))
  afterEach(() => {
    localStorage.removeItem('tllm.authToken')
    vi.unstubAllGlobals()
  })

  it('tails /requests/stream with the API key and upserts entries by id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/requests/stream')) {
        const frames = [entry('r1', null), entry('r1', 200)].map((e) => `event: entry\ndata: ${JSON.stringify(e)}\n\n`)
        // Delivered a beat later, so the initial history GET has landed first (it replaces the list).
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
})
