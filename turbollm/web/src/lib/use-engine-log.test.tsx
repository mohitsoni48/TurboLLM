// The live engine-log tail must authenticate like every other API call. It used to be a browser
// EventSource, which cannot send X-TurboLLM-Auth — over LAN-with-a-key or remote access its
// handshake got a 401 and no new line ever appeared (jsdom has no EventSource at all, so the old
// hook cannot even mount here).
import { renderHook, waitFor } from '@testing-library/react'
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
})
