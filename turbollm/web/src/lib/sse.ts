// The one Server-Sent Events parser every fetch-based stream in the web UI shares (chat send /
// continue, the Code run stream, and the engine-log / request-log live tails).
//
// Parsed per the WHATWG event-stream rules rather than line-by-line per network read: field
// state lives OUTSIDE the read loop, `data:` lines accumulate, and a message is dispatched only
// on the blank line that ends its block. TCP and the fetch reader can split a frame anywhere —
// between hono's `event:` and `data:` lines, or mid-way through a large `data:` line — so a
// parser that resets its state per read silently drops those events (e.g. a tool call awaiting
// approval, leaving the chat hung). The `id:` hono writes AFTER `data:` is read from the same
// block, so each message carries its own id rather than the previous one's.

import { authHeaders } from './api'

/** One dispatched SSE message. `data` is the raw (unparsed) payload. */
export interface SseMessage {
  /** The block's `event:` field — '' when it had none (callers here skip unnamed messages). */
  event: string
  data: string
  /** The block's own `id:` field, if it had one. Deliberately per-message rather than the spec's
   *  sticky last-event-id: callers use it as a replay cursor, and an un-id'd frame (the Code
   *  stream's synthesized meta/queue snapshots) must not look like it re-carries an earlier seq. */
  id?: string
}

/** Reads `body` as an SSE stream, yielding each complete message. An incomplete trailing block
 *  at end-of-stream is discarded (per spec). Line endings: LF and CRLF (all the daemon emits). */
export async function* readSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event = ''
  let data = ''
  let hasData = false
  let id: string | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line === '') {
          if (hasData) yield { event, data, id }
          event = ''
          data = ''
          hasData = false
          id = undefined
          continue
        }
        if (line.startsWith(':')) continue // comment / keep-alive
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') { data = hasData ? `${data}\n${value}` : value; hasData = true }
        else if (field === 'id') id = value
        // `retry:` and unknown fields are ignored.
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** EventSource's default reconnection delay (the spec leaves it to the UA; browsers use ~3 s). */
const SSE_RETRY_MS = 3000

/** A fetch-based stand-in for `new EventSource(url)` for the GET live tails (engine log, request
 *  log). A browser EventSource cannot send headers, so over LAN-with-a-key or remote access its
 *  handshake gets a 401 and the tail is silently dead — the daemon accepts credentials only from
 *  headers. This sends `authHeaders()` like every other API call, and keeps EventSource's reconnect
 *  behaviour: a stream that ends or drops is reopened after {@link SSE_RETRY_MS}, with the id of
 *  the last message that had one as `Last-Event-ID`; an HTTP error response, or a 200 that isn't
 *  `text/event-stream`, fails it for good (as EventSource does). The engine-log tail resumes from
 *  that id, so the lines written while it reconnected still arrive (it used to start a reopened
 *  stream from "now" and they were lost). The request-log tail sends no ids and live events only.
 *  `onOpen` runs each time a stream's response arrives, before its first message (EventSource's
 *  `open` event), so a caller that also loads a snapshot loads it from there, the first time and
 *  after every reconnect. Returns the close function. */
export function subscribeSse(
  url: string,
  onMessage: (msg: SseMessage) => void,
  opts: { onOpen?: () => void } = {},
): () => void {
  const ac = new AbortController()
  const { signal } = ac
  let lastEventId: string | undefined
  void (async () => {
    while (!signal.aborted) {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream', ...authHeaders() }
        if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId
        const res = await fetch(url, { headers, signal })
        // Like EventSource, a 200 that isn't an event stream (a proxy's HTML login/interstitial
        // page) fails for good too, rather than being re-downloaded every few seconds.
        if (!res.ok || !res.body || !/^text\/event-stream/i.test(res.headers.get('content-type') ?? '')) return
        opts.onOpen?.()
        for await (const msg of readSseStream(res.body)) {
          if (msg.id !== undefined) lastEventId = msg.id
          onMessage(msg)
        }
      } catch {
        /* network drop, daemon restart, or our own abort — the loop condition sorts out which */
      }
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(t); signal.removeEventListener('abort', wake); resolve() }
        const t = setTimeout(wake, SSE_RETRY_MS)
        signal.addEventListener('abort', wake)
      })
    }
  })()
  return () => ac.abort()
}
