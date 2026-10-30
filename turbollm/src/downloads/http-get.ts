// The HTTP client model downloads stream with: node:http / node:https, not the global fetch.
//
// The daemon's global fetch runs on npm undici 7.x's Agent (server.ts setGlobalDispatcher). Its
// HTTP/1.1 parser pauses while the body's reader is behind, and when the last chunk of a response
// is read from a socket the server then closes (HTTP/1.0, or `Connection: close`, as
// `python3 -m http.server` on a LAN PC answers), the socket's 'end' and 'close' handlers call its
// finish() with the parser still paused: `assert(!this.paused)` throws from an event handler, as
// an uncaught exception that takes the whole daemon down. A model download is exactly that case
// whenever the file write is slower than the network. undici 7.30.1 has the same assert; 8.x fixes
// it but needs Node 22.19+, and the Android app runs Node 18.20.4.
//
// So the one place that streams large files from hosts the user picks uses Node's own client,
// returning a standard Response so DownloadManager.run() reads it exactly as it read fetch's. It
// keeps what fetch did for those requests: redirects followed (at most 20), a relative Location
// resolved against the current URL, Authorization (and the other headers fetch drops) left off
// once a redirect changes origin, Range and If-Range kept across them, an abort honoured at every
// hop (rejecting with the signal's AbortError, and destroying the body), and undici's Agent
// timeouts (10 s to connect, 300 s without headers or body data). Everything else keeps fetch.
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** What DownloadManager.run() calls for a model file: fetch's shape, for the part of it run()
 *  uses (a GET with these headers, redirects followed, aborted by the signal). */
export type DownloadGet = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

export interface HttpGetInit {
  headers: Record<string, string>
  signal: AbortSignal
  /** ms to connect (TCP, and TLS for https) to each host; undici's 10 s by default. */
  connectTimeout?: number
  /** ms with no progress: waiting for a hop's response headers, or for body data while the
   *  reader wants more; undici's 300 s headersTimeout and bodyTimeout by default. */
  stallTimeout?: number
}

const CONNECT_TIMEOUT = 10_000
const STALL_TIMEOUT = 300_000
/** fetch's redirect limit (WHATWG Fetch, HTTP-redirect fetch step 5). */
const MAX_REDIRECTS = 20
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Statuses whose Response has a null body, as fetch gives them. */
const NULL_BODY_STATUSES = new Set([204, 205, 304])
/** What fetch removes from a redirected request whose new URL has another origin (scheme, host
 *  or port): an HF token must never reach the CDN Hugging Face redirects to, or another host. */
const CROSS_ORIGIN_DROPPED = new Set(['authorization', 'proxy-authorization', 'cookie', 'host'])
/** The content codings fetch decoded (and so produced other bytes than the server sent). */
const COMPRESSIONS = new Set(['gzip', 'x-gzip', 'deflate', 'x-deflate', 'br', 'zstd', 'compress', 'x-compress'])
/** How much body is read ahead of the reader before the socket is paused. Counted in bytes: Node
 *  18's Readable.toWeb counts chunks instead, so with a slow SD card it buffered ~16000 of them
 *  (hundreds of MB) in memory. */
const BODY_HIGH_WATER_MARK = 64 * 1024

/** GET `url` over node:http/https, following redirects, and resolve with its final Response. */
export async function httpGet(url: string, init: HttpGetInit): Promise<Response> {
  const connect = init.connectTimeout ?? CONNECT_TIMEOUT
  const stall = init.stallTimeout ?? STALL_TIMEOUT
  // The defaults fetch sent, except Accept-Encoding: fetch asked for `gzip, deflate` on a fresh
  // download and decoded what came back, which a size check against Content-Length and a sha256
  // cannot follow, so these always ask for the file's own bytes (as fetch did on a resume).
  const headers: Record<string, string> = { Accept: '*/*', 'User-Agent': 'node', ...init.headers, 'Accept-Encoding': 'identity' }
  let current = new URL(url)
  for (let redirects = 0; ; redirects++) {
    const res = await send(current, headers, init.signal, connect, stall)
    const location = res.headers.location
    if (!REDIRECT_STATUSES.has(res.statusCode ?? 0) || location === undefined) {
      return toResponse(res, current, init.signal, stall)
    }
    res.destroy()
    if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`)
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new Error(`${current.host} redirected to an invalid URL.`)
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`${current.host} redirected to a non-HTTP URL.`)
    if (next.origin !== current.origin) {
      for (const name of Object.keys(headers)) if (CROSS_ORIGIN_DROPPED.has(name.toLowerCase())) delete headers[name]
    }
    current = next
  }
}

/** One hop: resolves with the response once its headers arrive. */
function send(url: URL, headers: Record<string, string>, signal: AbortSignal, connect: number, stall: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers })
    let timer: NodeJS.Timeout | undefined
    const settle = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (e: Error) => {
      settle()
      reject(e)
      req.destroy()
    }
    const onAbort = () => fail(abortError(signal))
    const giveUpIn = (ms: number, message: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(new Error(message)), ms)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    giveUpIn(connect, `Could not connect to ${url.host} within ${seconds(connect)}.`)
    req.on('socket', (socket) => {
      const connected = () => giveUpIn(stall, `${url.host} did not answer within ${seconds(stall)}.`)
      // A kept-alive socket is connected already; a new one connects (and for https finishes its
      // TLS handshake) first, as undici's connect timeout counts both.
      if (socket.connecting) socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
      else connected()
    })
    req.on('response', (res) => {
      settle()
      resolve(res)
    })
    // Stays attached for the request's whole life: a socket error mid-body is emitted on the
    // request too (the body sees it as well, see bodyStream), and an 'error' with no listener
    // would be the uncaught exception this module exists to avoid.
    req.on('error', (e) => {
      settle()
      reject(e)
    })
    req.end()
  })
}

function toResponse(res: IncomingMessage, url: URL, signal: AbortSignal, stall: number): Response {
  const status = res.statusCode ?? 0
  if (status < 200 || status > 599) {
    res.destroy()
    throw new Error(`${url.host} answered with an invalid HTTP status (${status}).`)
  }
  // A server that compresses although asked not to: fetch decoded it, so the file's bytes were
  // not the ones Content-Length counts. Raw, they would pass that size check and land in the
  // library as a compressed file that no engine loads.
  const coding = res.headers['content-encoding']
  if (status < 300 && coding && coding.split(',').some((c) => COMPRESSIONS.has(c.trim().toLowerCase()))) {
    res.destroy()
    throw new Error(`${url.host} sent the file compressed (Content-Encoding: ${coding}) instead of as its own bytes.`)
  }
  const headers = new Headers()
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    try {
      headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
    } catch {
      // A header Headers will not hold; nothing run() reads.
    }
  }
  let body: ReadableStream<Uint8Array> | null = null
  if (NULL_BODY_STATUSES.has(status)) res.destroy()
  else body = bodyStream(res, url, signal, stall)
  return new Response(body, { status, statusText: res.statusMessage ?? '', headers })
}

/** The response body as a web stream with real backpressure: the socket is paused once
 *  BODY_HIGH_WATER_MARK bytes wait for the reader and resumed when it asks for more. */
function bodyStream(res: IncomingMessage, url: URL, signal: AbortSignal, stall: number): ReadableStream<Uint8Array> {
  let timer: NodeJS.Timeout | undefined
  let over = false
  const waitForData = () => {
    clearTimeout(timer)
    timer = setTimeout(() => res.destroy(new Error(`The download stalled: ${url.host} sent nothing for ${seconds(stall)}.`)), stall)
  }
  const onAbort = () => res.destroy(abortError(signal))
  const end = () => {
    over = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        // Every handler checks `over` first: enqueue() or close() on a cancelled stream throws, and
        // from an event handler that is an uncaught exception again.
        res.on('data', (chunk: Buffer) => {
          if (over) return
          controller.enqueue(chunk)
          if ((controller.desiredSize ?? 0) > 0) return waitForData()
          res.pause()
          // A reader that is behind (the file write) is not a stall, as undici's paused parser did
          // not count one either. A body nobody reads (run() refused the reply before streaming
          // it) keeps the timer, so its connection still closes after the stall time.
          if (body.locked) clearTimeout(timer)
          else waitForData()
        })
        res.on('end', () => {
          if (over) return
          end()
          controller.close()
        })
        res.on('error', (e: NodeJS.ErrnoException) => {
          if (over) return
          end()
          // Node's own word for a body cut short is "aborted", which reads like a cancel.
          controller.error(e.code === 'ECONNRESET' && e.message === 'aborted' ? closedEarly(url) : e)
        })
        res.on('close', () => {
          if (over) return
          end()
          controller.error(closedEarly(url))
        })
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        waitForData()
      },
      pull() {
        if (over || !res.isPaused()) return
        res.resume()
        waitForData()
      },
      cancel() {
        end()
        res.destroy()
      },
    },
    { highWaterMark: BODY_HIGH_WATER_MARK, size: (chunk) => chunk.byteLength },
  )
  return body
}

function closedEarly(url: URL): Error {
  return new Error(`${url.host} closed the connection before the whole file arrived.`)
}

/** What fetch rejects with on an abort: the signal's reason (an AbortError for a bare abort()). */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError')
}

function seconds(ms: number): string {
  return `${ms / 1000} s`
}
