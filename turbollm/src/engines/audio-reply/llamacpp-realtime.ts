// llama.cpp's way of speaking: the /v1/realtime WebSocket. /v1/chat/completions accepts `modalities: ["text","audio"]`
// and ignores it (HTTP 200, text only), so a spoken reply can only come from here. Two halves:
//
//   - a PURE collector that folds the server's events into an AudioReply (tested on captured fixtures), and
//   - a transport that opens one session, makes one request and closes it.
//
// The transport's care is all about the engine's slot. A realtime session is one server task that holds a slot for as
// long as it is open, and a disconnect does NOT stop a reply that is still generating (measured: a long reply ran to its
// natural end about three minutes after the client was gone, and a plain chat sent meanwhile waited 87 s on
// `--parallel 1`). So a stop is `response.cancel`, sent again every 300 ms until the engine's `response.done`, because
// llama-server drops a cancel that arrives during prefill; the session stays open until then (a 30 s ceiling, after
// which it is closed anyway). The engine answered in 140 to 255 ms once the reply was under way, and in about 2.4 s when
// the stop landed during prefill, on an idle 4-core CPU. The session is closed the moment `response.done` arrives, and
// every request carries `max_output_tokens`, whose default is unbounded.
import { createRequire } from 'node:module'
import { AudioReplyError, type AudioReply, type AudioReplyRequest } from './types'
import { pcm16ToWav } from './wav'

const require = createRequire(import.meta.url)

/** Where the speech rate is read from when a server never says (llama-server announces 24 kHz in session.created). */
const DEFAULT_OUTPUT_RATE = 24000

/** How much input audio goes in one `input_audio_buffer.append`: about 100 ms, as the engine's own client sends it. */
const INPUT_CHUNK_MS = 100
/** The smallest append: at the lowest rate accepted (wav.ts) 100 ms is already this, so no clip is sent as a flood of tiny messages. */
const MIN_INPUT_CHUNK_BYTES = 3200

/** A leading reasoning block the model wrote before its answer. The text-only run of the spike shows it (the engine
 *  does not strip it from the realtime text), and it is neither something to show nor something to read aloud. An
 *  unclosed block (a reply cut off while thinking) is all reasoning, so it strips to nothing. */
const LEADING_THINK = /^\s*<think>[\s\S]*?(?:<\/think>|$)\s*/

type RealtimeEvent = { type?: unknown; [key: string]: unknown }

export interface RealtimeCollector {
  /** Fold one server event in. Events it does not know are ignored. */
  push(event: unknown): void
  /** `response.done` has arrived. */
  readonly done: boolean
  /** The engine's `error` event, as the error a caller gets. */
  readonly error: AudioReplyError | null
  /** What has arrived so far as a reply; `cancelled` forces that status for a reply stopped before its `response.done`.
   *  Throws the engine's error if one arrived. */
  result(cancelled?: 'cancelled'): AudioReply
}

export function createRealtimeCollector(): RealtimeCollector {
  let rate = 0
  let text = ''
  let finalText: string | null = null
  const audio: Buffer[] = []
  let done = false
  let status: AudioReply['status'] = 'completed'
  let outputTokens: number | undefined
  let error: AudioReplyError | null = null

  return {
    push(raw: unknown): void {
      if (typeof raw !== 'object' || raw === null) return
      const ev = raw as RealtimeEvent
      switch (ev.type) {
        case 'session.created': {
          const r = (ev.session as { audio?: { output?: { format?: { rate?: unknown } } } } | undefined)?.audio?.output?.format?.rate
          if (typeof r === 'number' && r > 0) rate = r
          break
        }
        case 'response.output_text.delta':
          if (typeof ev.delta === 'string') text += ev.delta
          break
        case 'response.output_text.done':
          // The full text, which settles any delta the stream lost.
          if (typeof ev.text === 'string') finalText = ev.text
          break
        case 'response.output_audio.delta':
          if (typeof ev.delta === 'string') audio.push(Buffer.from(ev.delta, 'base64'))
          break
        case 'response.done': {
          done = true
          const response = ev.response as { status?: unknown; usage?: { output_tokens?: unknown } } | undefined
          status = response?.status === 'cancelled' ? 'cancelled' : 'completed'
          const tokens = response?.usage?.output_tokens
          if (typeof tokens === 'number') outputTokens = tokens
          break
        }
        case 'error': {
          const e = ev.error as { type?: unknown; message?: unknown } | undefined
          const message = typeof e?.message === 'string' && e.message ? e.message : 'The audio engine reported an error.'
          error = new AudioReplyError(e?.type === 'invalid_request_error' ? 'invalid_request' : 'engine_error', message)
          break
        }
      }
    },
    get done() {
      return done
    },
    get error() {
      return error
    },
    result(cancelled?: 'cancelled'): AudioReply {
      if (error) throw error
      let pcm = Buffer.concat(audio)
      // PCM16 is two bytes a sample: a stream cut mid-sample loses the half sample rather than playing a click.
      if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1)
      const words = (finalText ?? text).replace(LEADING_THINK, '')
      return {
        text: words.trim() ? words : '',
        audio: pcm.length ? { data: pcm16ToWav(pcm, rate || DEFAULT_OUTPUT_RATE), format: 'wav', sampleRate: rate || DEFAULT_OUTPUT_RATE } : null,
        status: cancelled ?? status,
        ...(outputTokens === undefined ? {} : { outputTokens }),
      }
    },
  }
}

// ── transport ───────────────────────────────────────────────────────────────────────────

/** The part of the `ws` WebSocket this file uses, so a test can inject a stand-in. */
export interface RealtimeSocket {
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  send(data: string): void
  close(): void
  terminate(): void
}

export interface RealtimeDeps {
  /** The socket constructor; the `ws` package by default. */
  WebSocket?: new (url: string) => RealtimeSocket
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** The whole request's budget. Generous: a reply on a CPU takes seconds, a long one minutes. */
  timeoutMs?: number
  /** The ceiling on how long a stop waits for the engine's `response.done` before settling with what it has and closing
   *  anyway. A stop normally ends in a fraction of a second, or a couple of seconds when it lands during prefill. */
  cancelWaitMs?: number
  /** How often an unacknowledged `response.cancel` is sent again while a stop waits. */
  cancelResendMs?: number
  /** How long the connection and `session.update` may take before the engine is taken to be not answering. */
  handshakeMs?: number
  /** How long a close waits for the engine to answer before the socket is destroyed. */
  closeWaitMs?: number
}

export const REALTIME_TIMEOUT_MS = 10 * 60_000
export const REALTIME_CANCEL_WAIT_MS = 30_000
export const REALTIME_CANCEL_RESEND_MS = 300
export const REALTIME_HANDSHAKE_MS = 15_000
export const REALTIME_CLOSE_WAIT_MS = 1000

function realtimeUrl(baseUrl: string): string {
  const u = new URL(baseUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/v1/realtime'
  u.search = ''
  return u.toString()
}

/** Asks the llama-server at `baseUrl` for one spoken reply. Resolves when the engine says `response.done` (and closes
 *  the session at once, which frees the slot), or with `cancelled` and whatever arrived when `signal` fires. Rejects
 *  with an AudioReplyError: `engine_unreachable` when it cannot connect, `invalid_request` or `engine_error` with the
 *  engine's own message when it answers with an `error` event, `timeout` when the budget runs out. */
export function requestRealtimeAudioReply(
  baseUrl: string,
  req: AudioReplyRequest,
  signal: AbortSignal,
  deps: RealtimeDeps = {},
): Promise<AudioReply> {
  const Socket = deps.WebSocket ?? (require('ws') as { WebSocket: new (url: string) => RealtimeSocket }).WebSocket
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const cancelTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const timeoutMs = deps.timeoutMs ?? REALTIME_TIMEOUT_MS
  const cancelWaitMs = deps.cancelWaitMs ?? REALTIME_CANCEL_WAIT_MS
  const cancelResendMs = deps.cancelResendMs ?? REALTIME_CANCEL_RESEND_MS
  const handshakeMs = deps.handshakeMs ?? REALTIME_HANDSHAKE_MS
  const closeWaitMs = deps.closeWaitMs ?? REALTIME_CLOSE_WAIT_MS

  if (signal.aborted) return Promise.resolve({ text: '', audio: null, status: 'cancelled' })

  return new Promise<AudioReply>((resolve, reject) => {
    const collector = createRealtimeCollector()
    let ws: RealtimeSocket
    try {
      ws = new Socket(realtimeUrl(baseUrl))
    } catch (err) {
      reject(new AudioReplyError('engine_unreachable', `Could not reach the audio engine: ${(err as Error).message}`))
      return
    }
    let settled = false
    let sessionSeen = false
    let requested = false
    let stopping: 'abort' | 'timeout' | 'error' | null = null
    /** The engine's own error, for a reply that failed after it had been asked for: told to the caller once it has stopped. */
    let engineError: AudioReplyError | null = null
    let cancelTimerHandle: unknown = null
    let resendHandle: unknown = null
    let handshakeHandle: unknown = null
    let closeTimerHandle: unknown = null
    let closed = false
    const send = (o: unknown) => ws.send(JSON.stringify(o))

    const close = () => {
      if (closed || closeTimerHandle !== null) return
      try {
        ws.close()
      } catch {
        ws.terminate()
        return
      }
      // close() waits on the peer's closing handshake, which an engine busy with a reply does not answer.
      closeTimerHandle = later(() => ws.terminate(), closeWaitMs)
    }
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      cancelTimer(overall)
      if (cancelTimerHandle !== null) cancelTimer(cancelTimerHandle)
      if (resendHandle !== null) cancelTimer(resendHandle)
      if (handshakeHandle !== null) cancelTimer(handshakeHandle)
      settle()
      close()
    }
    const resolveWith = (cancelled?: 'cancelled') => {
      try {
        const reply = collector.result(cancelled)
        finish(() => resolve(reply))
      } catch (err) {
        // A stopped reply that also drew an error has nothing to keep.
        finish(() => (cancelled ? resolve({ text: '', audio: null, status: 'cancelled' }) : reject(err)))
      }
    }
    const timedOut = () => new AudioReplyError('timeout', 'The audio engine did not answer in time.')
    // A stop (the caller's, or the budget running out). llama-server drops a `response.cancel` that arrives before the
    // reply is under way (during prefill, measured), and a disconnect does not stop a reply, so the cancel is sent again
    // every `cancelResendMs` until the engine says `response.done`, and the session stays open until it has: closing
    // early would leave the reply generating on the engine's only slot. Only the ceiling, or a socket that is gone,
    // ends the wait without it. A socket that has not got as far as asking for a reply has nothing to cancel.
    const stop = (why: 'abort' | 'timeout' | 'error') => {
      if (settled || stopping) return
      stopping = why
      if (!requested) {
        finish(() => (why === 'timeout' ? reject(timedOut()) : resolve({ text: '', audio: null, status: 'cancelled' })))
        return
      }
      const cancel = () => {
        if (settled) return
        try {
          send({ type: 'response.cancel' })
        } catch {
          // The socket is already gone: its close event settles the stop.
        }
        resendHandle = later(cancel, cancelResendMs)
      }
      cancel()
      cancelTimerHandle = later(() => settleStopped(), cancelWaitMs)
    }
    const settleStopped = () => {
      if (stopping === 'timeout') finish(() => reject(timedOut()))
      else if (stopping === 'error') finish(() => reject(engineError))
      else resolveWith('cancelled')
    }
    const onAbort = () => stop('abort')
    const overall = later(() => stop('timeout'), timeoutMs)
    handshakeHandle = later(() => {
      if (requested || settled) return
      finish(() => reject(new AudioReplyError(sessionSeen ? 'engine_error' : 'engine_unreachable', sessionSeen ? 'The audio engine did not accept the session settings in time.' : 'The audio engine accepted the connection but did not start a session.')))
    }, handshakeMs)
    signal.addEventListener('abort', onAbort, { once: true })

    ws.on('message', (data) => {
      if (settled) return
      let ev: RealtimeEvent
      try {
        ev = JSON.parse(String(data)) as RealtimeEvent
      } catch {
        return
      }
      // An error that lands while a stop is in flight is not the end of the wait: the cancel is sent again and the
      // reply's own `response.done` (or the ceiling) ends it. It is not kept, so what arrived is not lost to it.
      if (stopping && ev.type === 'error') return
      collector.push(ev)
      if (collector.error) {
        // After the reply was asked for it may still be generating on the engine's only slot, and closing does not stop
        // it: it is cancelled as a stop is, then the caller is told the engine's error. Before that (an unknown voice
        // answers `session.update` with one) there is nothing to cancel.
        if (requested && !collector.done) {
          engineError = collector.error
          stop('error')
        } else finish(() => reject(collector.error))
        return
      }
      if (ev.type === 'session.created') {
        sessionSeen = true
        // ["audio"] alone loses the transcript, so the text is always asked for too.
        const session: Record<string, unknown> = {
          output_modalities: ['text', 'audio'],
          instructions: req.instructions,
          max_output_tokens: req.maxOutputTokens,
          audio: {
            ...(req.input.kind === 'audio' ? { input: { format: { type: 'audio/pcm', rate: req.input.sampleRate } } } : {}),
            ...(req.voice ? { output: { voice: req.voice } } : {}),
          },
        }
        send({ type: 'session.update', session })
      } else if (ev.type === 'session.updated') {
        if (requested || stopping) return
        requested = true
        if (handshakeHandle !== null) cancelTimer(handshakeHandle)
        if (req.input.kind === 'audio') {
          const chunkBytes = Math.max(MIN_INPUT_CHUNK_BYTES, Math.floor((req.input.sampleRate * INPUT_CHUNK_MS) / 1000) * 2)
          for (let i = 0; i < req.input.pcm16.length; i += chunkBytes) {
            send({ type: 'input_audio_buffer.append', audio: req.input.pcm16.subarray(i, i + chunkBytes).toString('base64') })
          }
          send({ type: 'input_audio_buffer.commit' })
        } else {
          send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: req.input.text }] } })
        }
        send({ type: 'response.create' })
      } else if (collector.done) {
        // A reply that ended after the budget ran out is still a timeout to the caller, whatever the engine made of the cancel.
        if (stopping === 'timeout') finish(() => reject(timedOut()))
        else if (stopping === 'error') finish(() => reject(engineError))
        else resolveWith()
      }
    })
    ws.on('error', (err) => {
      if (settled) return
      if (stopping) return settleStopped()
      finish(() => reject(sessionSeen
        ? new AudioReplyError('engine_error', `The audio engine's connection failed: ${err.message}`)
        : new AudioReplyError('engine_unreachable', `Could not reach the audio engine: ${err.message}`)))
    })
    ws.on('close', () => {
      closed = true
      if (closeTimerHandle !== null) cancelTimer(closeTimerHandle)
      if (settled) return
      if (stopping) return settleStopped()
      finish(() => reject(new AudioReplyError(sessionSeen ? 'engine_error' : 'engine_unreachable', 'The audio engine closed the connection before the reply finished.')))
    })
  })
}
