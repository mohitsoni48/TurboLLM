// The shared SSE parser (sse.ts) and the chat generators built on it. The regression these
// guard: the old per-read parser reset its `event` state at every network read, so a frame the
// transport split — between hono's `event:` and `data:` lines, or mid-way through a large
// `data:` line — was silently dropped (a dropped `awaiting_approval` tool_call hangs the chat).
// Every case feeds the SAME frames as several reads, the way TCP/fetch can deliver them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSseStream, subscribeSse, type SseMessage } from './sse'
import { continueConversation, sendMessage } from './chat-api'

const enc = new TextEncoder()

/** A body that delivers `chunks` as separate reads. */
function body(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  })
}

async function collect(chunks: string[]): Promise<SseMessage[]> {
  const out: SseMessage[] = []
  for await (const m of readSseStream(body(chunks))) out.push(m)
  return out
}

/** Every 2-way split point of `s` — the parser must give the same result for all of them. */
function splits(s: string): string[][] {
  return Array.from({ length: s.length - 1 }, (_, i) => [s.slice(0, i + 1), s.slice(i + 1)])
}

describe('readSseStream', () => {
  it('dispatches a frame however the transport splits it', async () => {
    const frame = 'event: tool_call\ndata: {"id":"t1","status":"awaiting_approval"}\n\n'
    for (const chunks of splits(frame)) {
      expect(await collect(chunks)).toEqual([{ event: 'tool_call', data: '{"id":"t1","status":"awaiting_approval"}', id: undefined }])
    }
  })

  it('reads hono\'s id-after-data from the SAME block, not the previous one', async () => {
    const frames = 'event: meta\ndata: {}\n\nevent: delta\ndata: "a"\nid: 7\n\nevent: delta\ndata: "b"\nid: 8\n\n'
    expect((await collect([frames])).map((m) => [m.event, m.id])).toEqual([['meta', undefined], ['delta', '7'], ['delta', '8']])
  })

  it('joins multi-line data with \\n, accepts CRLF and no-space fields, skips comments', async () => {
    const msgs = await collect([': keep-alive\r\nevent:x\r\ndata: one\r\n', 'data:two\r\n\r\n'])
    expect(msgs).toEqual([{ event: 'x', data: 'one\ntwo', id: undefined }])
  })

  it('discards an incomplete trailing block at end of stream', async () => {
    expect(await collect(['event: a\ndata: 1\n\nevent: b\ndata: 2\n'])).toEqual([{ event: 'a', data: '1', id: undefined }])
  })
})

describe('chat stream generators', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const frames = [
    'event: meta\ndata: {"userMessageId":"u1","assistantMessageId":"a1"}\n\n',
    'event: tool_call\ndata: {"id":"t1","name":"run_code","args":{"code":"' + 'x'.repeat(5000) + '"},"status":"awaiting_approval"}\n\n',
    'event: ping\ndata: \n\n',
    'event: done\ndata: {"message":{"id":"a1"}}\n\n',
  ].join('')
  // Split between an event: and its data: line, and again mid-way through the big data line.
  const cut1 = frames.indexOf('data: {"id":"t1"')
  const cut2 = frames.indexOf('xxxx') + 2000
  const chunks = [frames.slice(0, cut1), frames.slice(cut1, cut2), frames.slice(cut2)]

  for (const [name, run] of [
    ['sendMessage', (signal: AbortSignal) => sendMessage('c1', 'hi', signal)],
    ['continueConversation', (signal: AbortSignal) => continueConversation('c1', signal)],
  ] as const) {
    it(`${name} yields every event even when frames are split across reads`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body(chunks), { status: 200 })))
      const got: string[] = []
      for await (const ev of run(new AbortController().signal)) got.push(ev.event)
      // `ping` has empty (non-JSON) data and is skipped, as before.
      expect(got).toEqual(['meta', 'tool_call', 'done'])
    })
  }
})

// The engine-log / request-log live tails used `new EventSource(url)`, which cannot send the API
// key — over LAN-with-a-key or remote access the handshake 401s and the tail is silently dead.
describe('subscribeSse', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    localStorage.setItem('tllm.authToken', 'k-123')
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.removeItem('tllm.authToken')
  })

  // hono's streamSSE (the daemon's two tails) always sends this content type.
  const ok = (chunks: string[]) => new Response(body(chunks), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

  it('sends the API key header and delivers messages split across reads', async () => {
    const fetchMock = vi.fn(async () => ok(['event: line\nda', 'ta: {"line":"a"}\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const got: SseMessage[] = []
    const close = subscribeSse('/api/v1/engine/logs/stream', (m) => got.push(m))
    await vi.advanceTimersByTimeAsync(0)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/engine/logs/stream')
    expect(init.headers).toMatchObject({ 'X-TurboLLM-Auth': 'k-123', Accept: 'text/event-stream' })
    expect(got).toEqual([{ event: 'line', data: '{"line":"a"}', id: undefined }])
    close()
  })

  it('reconnects after the stream ends or drops, like EventSource, until closed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockImplementation(async () => ok([]))
    vi.stubGlobal('fetch', fetchMock)
    const close = subscribeSse('/s', () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('calls onOpen each time a stream opens, before its first message, and not for an error response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(['event: entry\ndata: 1\n\n']))
      .mockResolvedValueOnce(ok(['event: entry\ndata: 2\n\n']))
      .mockImplementation(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const seen: string[] = []
    const close = subscribeSse('/s', (m) => seen.push(m.data), { onOpen: () => seen.push('open') })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual(['open', '1'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toEqual(['open', '1', 'open', '2'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(seen).toEqual(['open', '1', 'open', '2'])
    close()
  })

  it('gives up for good on an HTTP error, as EventSource does on a non-200', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const close = subscribeSse('/s', () => {})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    close()
  })

  it('gives up for good on a 200 that is not an event stream (a proxy\'s HTML page), as EventSource does', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>Sign in to continue</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    vi.stubGlobal('fetch', fetchMock)
    const got: SseMessage[] = []
    const close = subscribeSse('/s', (m) => got.push(m))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(got).toEqual([])
    close()
  })
})
