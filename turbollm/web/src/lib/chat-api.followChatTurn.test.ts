// followChatTurn (chat-api.ts): how a page follows one chat reply to its end now that the daemon runs the reply and
// the page is only a viewer of it. A dropped connection resumes by GET from the reply's own cursor and never sends the
// message again (a second POST would be a second generation). Mocked at the browser boundary (fetch) with real SSE
// bodies, so the frames go through readSseStream and each one's `id:` is the cursor, as in the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { followChatTurn, sendMessage } from './chat-api'
import type { ChatFrame } from './chat-types'

type Wire = { id?: number; event: string; data: unknown }
const enc = new TextEncoder()
const wire = (f: Wire) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n${f.id !== undefined ? `id: ${f.id}\n` : ''}\n`

/** An SSE body that hands over `frames` one read at a time, then: the daemon ends it (close), the connection drops
 *  (drop, as fetch fails a body whose socket went), or nothing more comes until the request is aborted (hang). */
function sseBody(frames: Wire[], end: 'close' | 'drop' | 'hang', signal?: AbortSignal): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    start(c) {
      signal?.addEventListener('abort', () => { try { c.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* closed */ } })
    },
    pull(c) {
      if (i < frames.length) { c.enqueue(enc.encode(wire(frames[i++]))); return }
      if (end === 'close') c.close()
      else if (end === 'drop') c.error(new TypeError('network error'))
      else return new Promise<void>(() => {})
    },
  })
}

type Reply = (signal?: AbortSignal) => Response
const requests: Array<{ method: string; url: string }> = []
let replies: Reply[] = []
const stream = (frames: Wire[], end: 'close' | 'drop' | 'hang' = 'close'): Reply => (signal) =>
  new Response(sseBody(frames, end, signal), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const refuse = (status: number, code: string, message: string): Reply => () =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } })
/** The daemon cannot be reached at all (fetch rejects). */
const unreachable: Reply = () => { throw new TypeError('Failed to fetch') }

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  requests.length = 0
  replies = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? 'GET', url: String(url) })
    const reply = replies.shift()
    if (!reply) throw new Error(`no reply queued for ${init?.method ?? 'GET'} ${url}`)
    return reply(init?.signal ?? undefined)
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const meta = (seq?: number): Wire => ({ id: seq, event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' } })
const delta = (seq: number, text: string): Wire => ({ id: seq, event: 'delta', data: { delta: text } })
const done = (seq: number): Wire => ({ id: seq, event: 'done', data: { message: { id: 'a1', content: 'whole reply' } } })

/** The page's send: POST /messages through the real sendMessage, with followChatTurn's acceptance callback. */
const send = (signal: AbortSignal) => (accepted: () => void) => sendMessage('c1', 'hi', signal, undefined, undefined, undefined, undefined, undefined, undefined, accepted)

/** Every frame followChatTurn yields, as [event, seq], until it returns or throws. */
async function follow(gen: AsyncGenerator<ChatFrame>): Promise<{ frames: Array<[string, number | undefined]>; error?: unknown }> {
  const frames: Array<[string, number | undefined]> = []
  try {
    for await (const f of gen) frames.push([f.event, f.seq])
  } catch (error) {
    return { frames, error }
  }
  return { frames }
}

/** Runs `p` while fake time moves on, so followChatTurn's backoff between tries passes. */
async function withTimePassing<T>(p: Promise<T>): Promise<T> {
  let settled = false
  void p.finally(() => { settled = true }).catch(() => {})
  while (!settled) await vi.advanceTimersByTimeAsync(500)
  return p
}

describe('followChatTurn', () => {
  it('follows the POST to its done, the cursor riding on each numbered frame, and returns', async () => {
    replies = [stream([meta(0), delta(1, 'Hel'), delta(2, 'lo'), done(3)])]
    const { frames, error } = await follow(followChatTurn('c1', send(new AbortController().signal), new AbortController().signal))
    expect(error).toBeUndefined()
    expect(frames).toEqual([['meta', 0], ['delta', 1], ['delta', 2], ['done', 3]])
    expect(requests).toEqual([{ method: 'POST', url: '/api/v1/conversations/c1/messages' }])
  })

  it('a drop after the meta resumes by GET with the reply and the next seq, and never sends the message again', async () => {
    replies = [
      stream([meta(0), delta(1, 'Hel'), delta(2, 'lo')], 'drop'),
      stream([delta(3, ' there'), done(4)]),
    ]
    const ac = new AbortController()
    const { frames, error } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(error).toBeUndefined()
    expect(frames).toEqual([['meta', 0], ['delta', 1], ['delta', 2], ['delta', 3], ['done', 4]])
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET'])
    expect(requests[1].url).toBe('/api/v1/conversations/c1/stream?run=a1&fromSeq=3')
  })

  it('a resume whose replay does not start at the cursor (the daemon no longer has it) yields reset first', async () => {
    replies = [
      stream([meta(0), delta(1, 'a'), delta(2, 'b')], 'drop'),
      // The window has moved past seq 3: the daemon replays from the oldest frame it kept.
      stream([delta(5, 'c'), delta(6, 'd'), done(7)]),
    ]
    const ac = new AbortController()
    const { frames } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(frames).toEqual([['meta', 0], ['delta', 1], ['delta', 2], ['reset', undefined], ['delta', 5], ['delta', 6], ['done', 7]])
  })

  it('a resume that replays from below the cursor (the run restarted from its start) yields reset too', async () => {
    replies = [
      stream([meta(0), delta(1, 'a')], 'drop'),
      stream([meta(0), delta(1, 'a'), done(2)]),
    ]
    const ac = new AbortController()
    const { frames } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(frames).toEqual([['meta', 0], ['delta', 1], ['reset', undefined], ['meta', 0], ['delta', 1], ['done', 2]])
  })

  it('a drop before the daemon answered the POST is thrown as it is: the send may not have been stored', async () => {
    replies = [unreachable]
    const ac = new AbortController()
    const { frames, error } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(frames).toEqual([])
    expect(error).toBeInstanceOf(TypeError)
    expect(requests.map((r) => r.method)).toEqual(['POST'])
  })

  it('a refused POST (409) is thrown as it is and not retried', async () => {
    replies = [refuse(409, 'generation_in_flight', 'A generation is already running for this conversation.')]
    const ac = new AbortController()
    const { error } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect(requests).toHaveLength(1)
  })

  it('a drop after the POST\'s 200 but before its meta resumes by a fresh GET: the turn exists', async () => {
    replies = [
      stream([], 'drop'),
      // A fresh attach: the run's synthesized meta (no id), then its frames from frame 0.
      stream([meta(), meta(0), delta(1, 'Hi'), done(2)]),
    ]
    const ac = new AbortController()
    const { frames, error } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(error).toBeUndefined()
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/v1/conversations/c1/messages', 'GET /api/v1/conversations/c1/stream'])
    expect(frames).toEqual([['meta', undefined], ['reset', undefined], ['meta', 0], ['delta', 1], ['done', 2]])
  })

  it('attaching (no POST) reads the reply that runs now, and returns when the daemon ends the stream', async () => {
    replies = [stream([meta(), meta(0), delta(1, 'so far'), done(2)])]
    const { frames } = await follow(followChatTurn('c1', null, new AbortController().signal))
    expect(requests).toEqual([{ method: 'GET', url: '/api/v1/conversations/c1/stream' }])
    expect(frames.map(([e]) => e)).toEqual(['meta', 'reset', 'meta', 'delta', 'done'])
  })

  it('an empty stream (no reply runs, or the daemon no longer has it) ends cleanly', async () => {
    replies = [stream([])]
    const { frames, error } = await follow(followChatTurn('c1', null, new AbortController().signal))
    expect(error).toBeUndefined()
    expect(frames).toEqual([])
  })

  it('a resume refused with a 4xx (the chat was deleted) is thrown at once', async () => {
    replies = [stream([meta(0), delta(1, 'a')], 'drop'), refuse(404, 'not_found', 'Conversation not found.')]
    const ac = new AbortController()
    const { error } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect((error as ApiError).status).toBe(404)
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET'])
  })

  it('a daemon that stays unreachable is tried 6 times with a growing wait, then the drop is thrown', async () => {
    vi.useFakeTimers()
    replies = [stream([meta(0), delta(1, 'a')], 'drop'), unreachable, unreachable, unreachable, unreachable, unreachable, unreachable]
    const ac = new AbortController()
    const { frames, error } = await withTimePassing(follow(followChatTurn('c1', send(ac.signal), ac.signal)))
    expect(frames).toEqual([['meta', 0], ['delta', 1]])
    expect(error).toBeInstanceOf(TypeError)
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET'])
    expect(new Set(requests.slice(1).map((r) => r.url))).toEqual(new Set(['/api/v1/conversations/c1/stream?run=a1&fromSeq=2']))
  })

  it('a resume that gets frames through starts the count of tries over', async () => {
    vi.useFakeTimers()
    replies = [
      stream([meta(0)], 'drop'),
      unreachable, unreachable, unreachable, unreachable, unreachable,
      stream([delta(1, 'a')], 'drop'), // 5 failed tries, then one that delivered: the count starts over
      unreachable, unreachable, unreachable, unreachable, unreachable,
      stream([delta(2, 'b'), done(3)]),
    ]
    const ac = new AbortController()
    const { frames, error } = await withTimePassing(follow(followChatTurn('c1', send(ac.signal), ac.signal)))
    expect(error).toBeUndefined()
    expect(frames.map(([e]) => e)).toEqual(['meta', 'delta', 'delta', 'done'])
  })

  it('a viewer the daemon dropped for falling behind (lagged) resumes from its cursor at once', async () => {
    replies = [
      stream([meta(0), delta(1, 'a'), { event: 'lagged', data: {} }]),
      stream([delta(2, 'b'), done(3)]),
    ]
    const ac = new AbortController()
    const { frames } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(frames).toEqual([['meta', 0], ['delta', 1], ['delta', 2], ['done', 3]])
    expect(requests[1].url).toBe('/api/v1/conversations/c1/stream?run=a1&fromSeq=2')
  })

  it('an error frame ends it, as done does', async () => {
    replies = [stream([meta(0), { id: 1, event: 'error', data: { code: 'engine_error', message: 'boom' } }, done(2)])]
    const ac = new AbortController()
    const { frames } = await follow(followChatTurn('c1', send(ac.signal), ac.signal))
    expect(frames).toEqual([['meta', 0], ['error', 1]])
  })

  it('the page stopping following (abort) is thrown, with no resume', async () => {
    replies = [stream([meta(0), delta(1, 'a')], 'hang')]
    const ac = new AbortController()
    const following = follow(followChatTurn('c1', send(ac.signal), ac.signal))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    const { frames, error } = await following
    expect(frames).toEqual([['meta', 0], ['delta', 1]])
    expect((error as Error).name).toBe('AbortError')
    expect(requests).toHaveLength(1)
  })
})
