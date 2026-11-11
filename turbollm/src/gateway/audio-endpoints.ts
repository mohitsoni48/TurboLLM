// POST /v1/audio/transcriptions and /v1/audio/translations: OpenAI's speech-to-text API, answered by whisper.cpp
// (voice/voice-service.ts). The same shape the OpenAI SDKs send (`client.audio.transcriptions.create(...)`), so a tool
// written for the hosted Whisper API points here and keeps the audio on this machine.
//
// Dispatched from the single /v1/* handler like the Jev endpoints (jev-endpoints.ts), not registered as routes of
// their own, for the same registration-order reason. They are taken only while speech-to-text is set up here; with no
// whisper-server or no model the request goes on to the engine exactly as it did before this existed, because some
// engines answer these paths themselves (a recent llama-server with a speech model loaded, KoboldCpp).
//
// What is honoured: `file`, `language`, `prompt`, `temperature`, `response_format` (json, text, srt, verbose_json,
// vtt). `model` is accepted and ignored: one whisper model is loaded at a time, the one chosen in Settings → Voice.
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { TRANSCRIPT_FORMATS, VoiceError, type TranscriptFormat } from '../voice/voice-service'

export type AudioEndpoint = 'transcriptions' | 'translations'

const PATHS: Readonly<Record<string, AudioEndpoint>> = {
  '/v1/audio/transcriptions': 'transcriptions',
  '/v1/audio/translations': 'translations',
}

/** Which audio endpoint a request is for: POST on the exact path, one trailing slash forgiven as for the Jev ones. */
export function audioEndpointFor(method: string, pathname: string): AudioEndpoint | null {
  if (method !== 'POST') return null
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return Object.hasOwn(PATHS, path) ? PATHS[path] : null
}

function refuse(c: Context, status: 400 | 502 | 503, message: string, code: string): Response {
  const type = status === 400 ? 'invalid_request_error' : 'server_error'
  return c.json({ error: { message, type, code } }, status)
}

export async function handleAudioRequest(c: Context, d: Deps, endpoint: AudioEndpoint): Promise<Response> {
  const voice = d.voice
  if (!voice) return refuse(c, 503, 'Speech-to-text is not available in this daemon.', 'stt_unavailable')

  let form: Record<string, unknown>
  try {
    form = await c.req.parseBody()
  } catch {
    return refuse(c, 400, 'The request must be multipart/form-data with a "file" field.', 'invalid_input')
  }
  const file = form.file
  if (!(file instanceof Blob) || file.size === 0) return refuse(c, 400, 'The request must be multipart/form-data with a "file" field.', 'invalid_input')

  const text = (key: string): string | undefined => {
    const v = form[key]
    return typeof v === 'string' && v.trim() ? v : undefined
  }
  const format = text('response_format') ?? 'json'
  if (!(TRANSCRIPT_FORMATS as readonly string[]).includes(format)) {
    return refuse(c, 400, `response_format must be one of: ${TRANSCRIPT_FORMATS.join(', ')}.`, 'invalid_input')
  }
  let temperature: number | undefined
  const rawTemperature = text('temperature')
  if (rawTemperature !== undefined) {
    temperature = Number(rawTemperature)
    // Checked here: whisper-server answers a number it cannot parse with a bare 500.
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) return refuse(c, 400, 'temperature must be a number from 0 to 1.', 'invalid_input')
  }

  try {
    const out = await voice.transcribe(file, {
      language: text('language'),
      prompt: text('prompt'),
      temperature,
      format: format as TranscriptFormat,
      translate: endpoint === 'translations',
    }, c.req.raw.signal)
    return c.body(out.body, 200, { 'Content-Type': out.contentType })
  } catch (e) {
    if (e instanceof VoiceError) return refuse(c, e.status === 400 || e.status === 404 || e.status === 409 ? 400 : e.status, e.message, e.code)
    if (c.req.raw.signal.aborted) return refuse(c, 400, 'The request was cancelled.', 'cancelled')
    return refuse(c, 502, e instanceof Error ? e.message : String(e), 'stt_failed')
  }
}
