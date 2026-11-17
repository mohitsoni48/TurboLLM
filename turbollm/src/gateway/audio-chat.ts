// POST /v1/chat/completions with `modalities` that include "audio": OpenAI's audio output, answered from a local model
// that speaks (engines/audio-reply). llama.cpp's own /v1/chat/completions accepts `modalities` and ignores it, answering
// 200 with text, which for a caller that asked for speech is a silent downgrade. So a request that asks for audio is
// never forwarded to an engine of any kind: it is answered here, or refused with an error that says why. A request that
// does not ask is not touched by anything in this file.
//
// What the request becomes: the system and developer messages and every turn before the last go to the runtime as the
// text `instructions` (the earlier turns as a transcript, never as audio); the last user message is the input, its
// `input_audio` WAV as PCM, or its text when it has no audio. The reply is one finished clip with its transcript in
// OpenAI's shape. Streamed audio is not supported yet, and the stored-audio ids of the hosted API are not kept, so a
// client continuing a conversation should send earlier replies back as text.
import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import type { GenerationGate } from '../agents/gate'
import type { Deps } from '../deps'
import type { Manager } from '../engines/manager'
import {
  audioReplyRuntimeFor, AudioReplyError, DEFAULT_AUDIO_REPLY_MAX_TOKENS,
  type AudioReplyRequest, type AudioReplyRuntime,
} from '../engines/audio-reply'
import { flattenInstructions, SPOKEN_REPLY_PLACEHOLDER, VOICE_MESSAGE_PLACEHOLDER, withUserNote, type TranscriptTurn } from '../engines/audio-reply/instructions'
import { decodeWavClips } from '../engines/audio-reply/wav'
import { servingEngineKind } from '../engines/serving'
import { extractParams, requestLogConfig, summarizeRequest } from '../observability/request-log'
import { classifyGateError } from './gate-errors'
import type { RouteResult } from './model-router'

/** Whether a chat body asks for speech back: `modalities` is an array containing "audio". Anything else is not an audio
 *  request, whatever else the body says. */
export function asksForAudioOutput(body: Record<string, unknown>): boolean {
  return Array.isArray(body.modalities) && body.modalities.includes('audio')
}

/** An error in the gateway's OpenAI envelope. */
interface Refusal {
  status: 400 | 409 | 500 | 502 | 504
  error: { message: string; type: string; code: string; param?: string }
}

const bad = (message: string, code = 'invalid_request_error', param?: string): Refusal => ({
  status: 400,
  error: { message, type: 'invalid_request_error', code, ...(param ? { param } : {}) },
})

/** The request, read, apart from what needs the loaded model: everything the body itself decides. Read before the
 *  router is asked for a model, so a request that could never be answered does not first swap one in. */
export interface ReadAudioRequest {
  format: 'wav' | 'pcm16'
  system: string
  turns: TranscriptTurn[]
  input: AudioReplyRequest['input']
  note: string
  voice?: string
  /** What the caller asked the reply be capped at, if it did. */
  asked?: number
}

/** What the runtime is asked for and how the reply is wanted. */
export interface ParsedAudioRequest {
  request: AudioReplyRequest
  format: 'wav' | 'pcm16'
}

type Part = { type?: unknown; text?: unknown; input_audio?: { data?: unknown; format?: unknown } }

/** A message's content as text parts and audio parts; a plain string is one text part. */
function partsOf(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter((p): p is Part => typeof p === 'object' && p !== null) : []
}

const textOf = (parts: Part[]): string => parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('\n').trim()

/** PURE: reads a chat body that asks for audio, or says why it cannot be answered, whatever model is loaded. */
export function readAudioChatRequest(body: Record<string, unknown>): ReadAudioRequest | Refusal {
  if (body.stream === true) {
    return bad('Streamed audio replies are not supported yet; send `stream: false`.', 'audio_stream_unsupported', 'stream')
  }
  const audio = body.audio
  if (typeof audio !== 'object' || audio === null || Array.isArray(audio)) {
    return bad('`audio` is required when `modalities` includes "audio": send { voice, format }.', 'invalid_request_error', 'audio')
  }
  const format = (audio as { format?: unknown }).format
  if (format !== 'wav' && format !== 'pcm16') {
    return bad('`audio.format` must be "wav" or "pcm16"; other formats cannot be produced here.', 'audio_format_unsupported', 'audio.format')
  }
  const voice = (audio as { voice?: unknown }).voice
  if (voice != null && typeof voice !== 'string') return bad('`audio.voice` must be a string.', 'invalid_type', 'audio.voice')
  if (!Array.isArray(body.messages) || body.messages.length === 0) return bad('`messages` must be a non-empty array.', 'invalid_request_error', 'messages')

  const messages = body.messages.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
  const last = messages.at(-1)
  if (last?.role !== 'user') return bad('The last message must be a user message.', 'invalid_request_error', 'messages')

  const head: string[] = []
  const turns: TranscriptTurn[] = []
  for (const m of messages.slice(0, -1)) {
    const parts = partsOf(m.content)
    if (m.role === 'system' || m.role === 'developer') {
      const text = textOf(parts)
      if (text) head.push(text)
    } else if (m.role === 'user') {
      // An earlier voice message is named, not heard again.
      turns.push({ role: 'user', text: textOf(parts) || (parts.some((p) => p.type === 'input_audio') ? VOICE_MESSAGE_PLACEHOLDER : '') })
    } else if (m.role === 'assistant') {
      const spoken = typeof m.audio === 'object' && m.audio !== null ? (m.audio as { id?: unknown; transcript?: unknown }) : undefined
      const transcript = typeof spoken?.transcript === 'string' ? spoken.transcript.trim() : ''
      // The hosted API's stored audio ids mean nothing here, so a reply that was only an id is `[Spoken reply]`.
      turns.push({ role: 'assistant', text: textOf(parts) || transcript || (spoken?.id ? SPOKEN_REPLY_PLACEHOLDER : '') })
    }
  }

  const lastParts = partsOf(last.content)
  if (lastParts.some((p) => p.type === 'image_url')) return bad('Images cannot be sent with an audio reply.', 'invalid_request_error', 'messages')
  const clips = lastParts.filter((p) => p.type === 'input_audio')
  const typed = textOf(lastParts)
  let input: AudioReplyRequest['input']
  let note = ''
  if (clips.length) {
    const wavs: Buffer[] = []
    for (const clip of clips) {
      const data = clip.input_audio?.data
      if (typeof data !== 'string' || !data) return bad('`input_audio.data` must be base64 audio.', 'invalid_request_error', 'messages')
      if (clip.input_audio?.format !== 'wav') {
        return bad('`input_audio.format` must be "wav" for an audio reply; MP3 cannot be read here. Send a WAV.', 'audio_format_unsupported', 'messages')
      }
      wavs.push(Buffer.from(data, 'base64'))
    }
    try {
      const { pcm16, sampleRate } = decodeWavClips(wavs)
      input = { kind: 'audio', pcm16, sampleRate }
    } catch (e) {
      return bad((e as Error).message, 'audio_format_unsupported', 'messages')
    }
    note = typed
  } else {
    if (!typed) return bad('The last user message has no text or audio to answer.', 'invalid_request_error', 'messages')
    input = { kind: 'text', text: typed }
  }
  const asked = [body.max_completion_tokens, body.max_tokens].find((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
  return { format, system: head.join('\n\n'), turns, input, note, ...(voice ? { voice } : {}), ...(asked === undefined ? {} : { asked }) }
}

/** PURE: what the runtime is asked for, once the loaded model's window (`ctxMax`, which bounds the transcript) and the
 *  settings' cap on a reply (`maxTokensLimit`, 0: none) are known. */
export function buildAudioChatRequest(read: ReadAudioRequest, ctxMax: number, maxTokensLimit: number): ParsedAudioRequest {
  const wanted = read.asked ?? DEFAULT_AUDIO_REPLY_MAX_TOKENS
  return {
    format: read.format,
    request: {
      instructions: withUserNote(flattenInstructions(read.system, read.turns, ctxMax), read.note),
      input: read.input,
      ...(read.voice ? { voice: read.voice } : {}),
      maxOutputTokens: maxTokensLimit > 0 ? Math.min(wanted, maxTokensLimit) : wanted,
    },
  }
}

/** Both steps at once, for a caller that has the window already. */
export function parseAudioChatRequest(body: Record<string, unknown>, ctxMax: number, maxTokensLimit: number): ParsedAudioRequest | Refusal {
  const read = readAudioChatRequest(body)
  return 'error' in read ? read : buildAudioChatRequest(read, ctxMax, maxTokensLimit)
}

/** The error to answer with, as the gateway's own response. */
export function audioRefusalResponse(c: Context, refusal: Refusal): Response {
  return c.json({ error: refusal.error }, refusal.status)
}

/** PURE: OpenAI's chat.completion for a spoken reply. `data` is the base64 WAV for `wav`, or the PCM16 without its
 *  header for `pcm16`. */
export function audioChatCompletion(args: {
  model: string
  text: string
  audio: { data: Buffer; sampleRate: number }
  format: 'wav' | 'pcm16'
  outputTokens: number
  maxOutputTokens: number
  now?: number
}): Record<string, unknown> {
  const created = args.now ?? Math.floor(Date.now() / 1000)
  const bytes = args.format === 'wav' ? args.audio.data : args.audio.data.subarray(44)
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created,
    model: args.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        refusal: null,
        audio: { id: `audio_${randomUUID().replace(/-/g, '')}`, data: bytes.toString('base64'), expires_at: created + 3600, transcript: args.text },
      },
      finish_reason: args.outputTokens >= args.maxOutputTokens ? 'length' : 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: args.outputTokens, total_tokens: args.outputTokens },
  }
}

/** What the gateway lends the handler of its own bookkeeping: the engine whose request this is (its generation count,
 *  stats and gate) and how to write the finished request into the usage ledgers. */
export interface AudioChatAccounting {
  manager: Manager
  gate: GenerationGate | undefined
  recordUsage: (completionTokens: number, durationMs: number) => void
}

export interface AudioChatArgs {
  body: Record<string, unknown>
  /** The request as read before routing (readAudioChatRequest). */
  read: ReadAudioRequest
  route: Extract<RouteResult, { target: string }>
  requestedModel: string
  harness: string | null
  codeSessionId: string | null
  signal: AbortSignal
  accounting: AudioChatAccounting
}

/** Answers a chat request that asks for audio. Called once the router has chosen where the request goes. */
export async function handleAudioChatCompletion(c: Context, d: Deps, args: AudioChatArgs): Promise<Response> {
  const { route, accounting } = args
  // The probes behind `audioOut` run just after a load turns ready: a model swapped in for this very request has to
  // have been asked before it can be said not to speak.
  await d.manager.whenModalitiesKnown()
  const primary = !route.remote && !route.manager
  const status = d.manager.status()
  const runtime: AudioReplyRuntime | null = primary && status.model?.audioOut === true ? audioReplyRuntimeFor(route.engineKind ?? servingEngineKind(d)) : null
  if (!runtime) {
    return audioRefusalResponse(c, {
      status: 409,
      error: {
        message: `'${args.requestedModel || status.model?.name || 'This model'}' cannot answer with audio. Audio output needs a local model that speaks, loaded on an engine that can return it.`,
        type: 'invalid_request_error',
        code: 'audio_output_unsupported',
      },
    })
  }
  const maxLimit = d.store.read().modelDefaults.maxTokens ?? 0
  const parsed = buildAudioChatRequest(args.read, status.model?.ctx ?? 4096, maxLimit)

  // The same gate and bookkeeping a proxied chat request goes through (gateway.ts): one engine slot, so a spoken reply
  // queues behind a running generation rather than on top of it, and counts as one on the engine card meanwhile.
  let release: (() => void) | null = null
  if (accounting.gate) {
    try {
      release = await accounting.gate.acquire('bg', { signal: args.signal, timeoutMs: 600_000 })
    } catch (e) {
      const failure = classifyGateError(e)
      return c.json({ error: { message: failure.message, type: failure.type, code: failure.status === 400 ? 'client_disconnected' : 'engine_busy' } }, failure.status)
    }
  }
  const cfg = requestLogConfig(d)
  const logId = d.requestLog && cfg.enabled
    ? d.requestLog.start({
        source: 'openai', harness: args.harness, codeSessionId: args.codeSessionId, modelKey: args.requestedModel || null, remote: null, stream: false,
        params: extractParams(args.body), counts: summarizeRequest(args.body),
      })
    : null
  const startedAt = Date.now()
  accounting.manager.generationStart()
  const finish = (): void => {
    accounting.manager.generationEnd()
    release?.()
  }
  try {
    const reply = await runtime.reply(route.target, parsed.request, args.signal)
    if (reply.status === 'cancelled' || args.signal.aborted) {
      logId && d.requestLog!.finalize(logId, { status: 400, error: { code: 'client_disconnected', message: 'Client disconnected before the reply finished.' }, durationMs: Date.now() - startedAt })
      return audioRefusalResponse(c, { status: 400, error: { message: 'Client disconnected before the reply finished.', type: 'api_error', code: 'client_disconnected' } })
    }
    if (!reply.audio) {
      // An engine that was asked for speech and gave none is an error, never the text with the audio left off.
      const message = `The engine returned a transcript of ${reply.text.length} characters but no audio.`
      logId && d.requestLog!.finalize(logId, { status: 502, error: { code: 'audio_not_returned', message }, durationMs: Date.now() - startedAt })
      return audioRefusalResponse(c, { status: 502, error: { message, type: 'api_error', code: 'audio_not_returned' } })
    }
    const tokens = reply.outputTokens ?? 0
    const durationMs = Date.now() - startedAt
    accounting.recordUsage(tokens, durationMs)
    logId && d.requestLog!.finalize(logId, {
      status: 200, promptTokens: 0, completionTokens: tokens, durationMs,
      finishReason: tokens >= parsed.request.maxOutputTokens ? 'length' : 'stop',
    })
    return c.json(audioChatCompletion({
      model: args.requestedModel || route.modelName || status.model?.name || '',
      text: reply.text,
      audio: reply.audio,
      format: parsed.format,
      outputTokens: tokens,
      maxOutputTokens: parsed.request.maxOutputTokens,
    }))
  } catch (e) {
    const failure = failureOf(e)
    logId && d.requestLog!.finalize(logId, { status: failure.status, error: { code: failure.error.code, message: failure.error.message }, durationMs: Date.now() - startedAt })
    return audioRefusalResponse(c, failure)
  } finally {
    finish()
  }
}

/** The engine's refusal of the request (an unknown voice) is the caller's to fix, so it is a 400 with the engine's own
 *  message; everything else is the engine's failure. */
function failureOf(e: unknown): Refusal {
  if (e instanceof AudioReplyError) {
    if (e.code === 'invalid_request') return bad(e.message, 'invalid_request_error')
    if (e.code === 'timeout') return { status: 504, error: { message: e.message, type: 'api_error', code: 'timeout' } }
    if (e.code === 'engine_unreachable') return { status: 500, error: { message: e.message, type: 'api_error', code: 'engine_unreachable' } }
    return { status: 502, error: { message: e.message, type: 'api_error', code: 'engine_error' } }
  }
  return { status: 502, error: { message: (e as Error)?.message || 'The audio reply failed.', type: 'api_error', code: 'engine_error' } }
}
