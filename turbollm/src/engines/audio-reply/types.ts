// The neutral shape of a spoken reply, whatever runtime produced it.
//
// llama.cpp returns speech only over its /v1/realtime WebSocket; a runtime that answers /v1/chat/completions with
// `message.audio` (vLLM-Omni) would produce the same thing from a different wire. Everything outside this folder, the
// chat route and the gateway, speaks these types and never a runtime's own events: a second runtime is a new adapter
// registered in index.ts, not a change to its callers.

/** What the model said: the transcript and the clip, either of which may be missing. */
export interface AudioReply {
  /** The reply's words. Empty when the model produced no text (an audio-only reply has none to give). */
  text: string
  /** The speech as a finished WAV, or null when the engine returned none. `sampleRate` is the clip's own rate, read
   *  from the engine, never assumed. */
  audio: { data: Buffer; format: 'wav'; sampleRate: number } | null
  /** `cancelled` when a stop cut the reply short: whatever arrived before it is kept. */
  status: 'completed' | 'cancelled'
  /** What the engine counted as generated, when it said. */
  outputTokens?: number
}

/** What a runtime is asked for: the whole context as text, and one new turn that is either a finished clip or text. */
export interface AudioReplyRequest {
  /** The conversation so far as text: the system prompt, a summary if any, and the earlier turns as a transcript.
   *  Earlier turns are never sent as audio, so this is the only route history takes. */
  instructions: string
  input: { kind: 'audio'; pcm16: Buffer; sampleRate: number } | { kind: 'text'; text: string }
  /** A voice the model offers; an unknown one is the engine's error to report. */
  voice?: string
  /** Always set: an engine's default is unbounded, and a reply nobody can stop holds the engine's only slot. */
  maxOutputTokens: number
}

export type AudioReplyErrorCode = 'engine_error' | 'engine_unreachable' | 'timeout' | 'invalid_request'

/** A failure to get a reply, with the engine's own message so a caller can show it. */
export class AudioReplyError extends Error {
  readonly code: AudioReplyErrorCode
  constructor(code: AudioReplyErrorCode, message: string) {
    super(message)
    this.name = 'AudioReplyError'
    this.code = code
  }
}

/** One runtime's way of getting a spoken reply from a local engine. */
export interface AudioReplyRuntime {
  /** Ask the engine at `baseUrl` (`http://127.0.0.1:<port>`) for a reply. `signal` aborts it: the engine is told to
   *  stop, and what had arrived resolves as a `cancelled` reply rather than rejecting. */
  reply(baseUrl: string, req: AudioReplyRequest, signal: AbortSignal): Promise<AudioReply>
}
