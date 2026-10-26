// The shared SSE parser (sse.ts) and the chat generators built on it. The regression these
// guard: the old per-read parser reset its `event` state at every network read, so a frame the
// transport split — between hono's `event:` and `data:` lines, or mid-way through a large
// `data:` line — was silently dropped (a dropped `awaiting_approval` tool_call hangs the chat).
// Every case feeds the SAME frames as several reads, the way TCP/fetch can deliver them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSseStream, subscribeSse, type SseMessage } from './sse'
import { setAuthToken } from './api'
import { continueConversation, sendMessage } from './chat-api'

// The listeners subscribeSse has waiting on a key (api.ts subscribeAuthToken), to tell a tail that
// waits for one from a tail that ended.
const { keyListeners } = vi.hoisted(() => ({ keyListeners: new Set<() => void>() }))
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    subscribeAuthToken: (listener: () => void) => {
      const off = actual.subscribeAuthToken(listener)
      keyListeners.add(listener)
      return () => { keyListeners.delete(listener); off() }
    },
  }
})

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
  // Each test's tails, closed after it even when it fails before its own close(): a tail left
  // running went on fetching into the next test, with that test's fetch, and failed it too.
  const tails: Array<() => void> = []
  const tail = (...args: Parameters<typeof subscribeSse>) => {
    const close = subscribeSse(...args)
    tails.push(close)
    return close
  }
  afterEach(() => {
    tails.splice(0).forEach((close) => close())
    vi.useRealTimers()
    localStorage.removeItem('tllm.authToken')
  })

  // hono's streamSSE (the daemon's two tails) always sends this content type.
  const ok = (chunks: string[]) => new Response(body(chunks), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

  it('sends the API key header and delivers messages split across reads', async () => {
    const fetchMock = vi.fn(async () => ok(['event: line\nda', 'ta: {"line":"a"}\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const got: SseMessage[] = []
    const close = tail('/api/v1/engine/logs/stream', (m) => got.push(m))
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
    const close = tail('/s', () => {})
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
    const close = tail('/s', (m) => seen.push(m.data), { onOpen: () => seen.push('open') })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual(['open', '1'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toEqual(['open', '1', 'open', '2'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(seen).toEqual(['open', '1', 'open', '2'])
    close()
  })

  // The engine-log tail resumes from this id: a reopened stream that did not send it started from
  // "now", and the lines written while it reconnected were lost.
  it('a reopened stream sends the id of the last message that had one as Last-Event-ID, as EventSource does', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(['event: line\ndata: a\nid: c1\n\n', 'event: ping\ndata: \nid: c2\n\nevent: other\ndata: x\n\n']))
      .mockImplementation(async () => ok([]))
    vi.stubGlobal('fetch', fetchMock)
    const close = tail('/s', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const headersOf = (i: number) => (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(headersOf(0)['Last-Event-ID']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(headersOf(1)).toMatchObject({ 'Last-Event-ID': 'c2', 'X-TurboLLM-Auth': 'k-123' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(headersOf(2)['Last-Event-ID']).toBe('c2')
    close()
  })

  // A tail that met a proxy's error while the daemon restarted, or a 401 before the key was
  // entered, used to stop for good, as EventSource does on any non-200, and stayed dead until the
  // panel was closed and opened again.
  it('retries a 5xx (a proxy while the daemon restarts) or a dropped connection with a backoff, until a stream opens', async () => {
    const badGateway = new Response('Bad Gateway', { status: 502 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(badGateway)
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce(new Response('{"error":{"code":"engine_unavailable"}}', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(ok(['event: line\ndata: back\n\n']))
      .mockImplementation(async () => ok([]))
    vi.stubGlobal('fetch', fetchMock)
    const got: string[] = []
    const close = tail('/s', (m) => got.push(m.data))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 3 s, then twice as long each time, up to 30 s.
    for (const [wait, calls] of [[3000, 2], [6000, 3], [12_000, 4], [24_000, 5], [30_000, 6], [30_000, 7]]) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(fetchMock).toHaveBeenCalledTimes(calls - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchMock).toHaveBeenCalledTimes(calls)
    }
    expect(got).toEqual(['back'])
    // The error's body is let go, not held through the wait.
    expect(badGateway.bodyUsed).toBe(true)
    // A stream that opened starts the backoff over: the next reconnect is 3 s away again.
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    close()
  })

  it('a 401 or 403 waits for a key: the stream reopens at once with the key the key prompt stores', async () => {
    const refused: Response[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['X-TurboLLM-Auth']
      if (key === 'k-right') return ok(['event: line\ndata: a\n\n'])
      const res = new Response('{"error":{"code":"unauthorized"}}', { status: key === 'k-remote' ? 403 : 401 })
      refused.push(res)
      return res
    })
    vi.stubGlobal('fetch', fetchMock)
    const got: string[] = []
    const close = tail('/s', (m) => got.push(m.data))
    // Not before (a refusal is asked again only every 30 s, the next test).
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    setAuthToken('k-remote')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The refusals' bodies are let go, not held while the tail waits for a key.
    expect(refused.map((r) => r.bodyUsed)).toEqual([true, true])
    setAuthToken('k-right')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(got).toEqual(['a'])
    close()
    setAuthToken('k-other')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // The refused tail woke only on setAuthToken in its own tab. A key the prompt of another tab
  // stored (the key is in localStorage, shared by every tab of the origin), or a daemon that
  // stopped refusing (Require an API key turned off again on the host), left it dead for good,
  // while the rest of the page, which reads the key afresh per request, recovered.
  it('a 401 or 403 tail reopens at once when another tab stores a key', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['X-TurboLLM-Auth']
      return key === 'k-right' ? ok(['event: line\ndata: a\n\n']) : new Response('{"error":{"code":"unauthorized"}}', { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const got: string[] = []
    tail('/s', (m) => got.push(m.data))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Another key in that storage wakes nothing.
    window.dispatchEvent(new StorageEvent('storage', { key: 'tllm.theme', newValue: 'dark', storageArea: localStorage }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // What the browser does here when another tab's key prompt stores a key.
    localStorage.setItem('tllm.authToken', 'k-right')
    window.dispatchEvent(new StorageEvent('storage', { key: 'tllm.authToken', oldValue: 'k-123', newValue: 'k-right', storageArea: localStorage }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-TurboLLM-Auth': 'k-right' })
    expect(got).toEqual(['a'])
    // Another tab clearing the storage (key null) wakes it too.
    fetchMock.mockImplementation(async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('a 401 or 403 is asked again every 30 s, so a refusal the daemon dropped is noticed with the same key', async () => {
    let refusing = true
    const fetchMock = vi.fn(async () => (refusing ? new Response('{"error":{"code":"unauthorized"}}', { status: 401 }) : ok(['event: line\ndata: back\n\n'])))
    vi.stubGlobal('fetch', fetchMock)
    const got: string[] = []
    tail('/s', (m) => got.push(m.data))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Still refused: the next one is 30 s later again, two a minute at most.
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    refusing = false
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-TurboLLM-Auth': 'k-123' })
    expect(got).toEqual(['back'])
  })

  it('a key stored while the refused request was out is used at once', async () => {
    let answer: (r: Response) => void = () => {}
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve }))
      .mockImplementation(async () => ok([]))
    vi.stubGlobal('fetch', fetchMock)
    const close = tail('/s', () => {})
    await vi.advanceTimersByTimeAsync(0)
    setAuthToken('k-new')
    answer(new Response('{"error":{"code":"unauthorized"}}', { status: 401 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-TurboLLM-Auth': 'k-new' })
    close()
  })

  // In a browser the answer is read as soon as it comes in, but a close() between the two left
  // the closed tail waiting on the next key, its listener held, rather than ending.
  it('closed before a refused answer is read, it ends rather than waiting for a key', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const close = tail('/s', () => {})
    close()
    await vi.advanceTimersByTimeAsync(0)
    expect(keyListeners.size).toBe(0)
    setAuthToken('k-new')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('closed while it waits for a key, it lets go of its key listener, its storage listener and its 30 s timer', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const removed = vi.spyOn(window, 'removeEventListener')
    const close = tail('/s', () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(keyListeners.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    close()
    await vi.advanceTimersByTimeAsync(0)
    expect(keyListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(removed.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1)
    localStorage.setItem('tllm.authToken', 'k-new')
    window.dispatchEvent(new StorageEvent('storage', { key: 'tllm.authToken', newValue: 'k-new', storageArea: localStorage }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up for good on any other HTTP error (a 404 from a daemon without the route), as EventSource does on a non-200', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"code":"not_found"}}', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const close = tail('/s', () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    close()
  })

  it('gives up for good on a 200 that is not an event stream (a proxy\'s HTML page), as EventSource does', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>Sign in to continue</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    vi.stubGlobal('fetch', fetchMock)
    const got: SseMessage[] = []
    const close = tail('/s', (m) => got.push(m))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(got).toEqual([])
    close()
  })
})
