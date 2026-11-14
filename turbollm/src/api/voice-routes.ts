// /api/v1/voice: speech-to-text for the web UI (voice/voice-service.ts).
//
// The page records, sends the clip here and gets its text back; the rest is setup: installing whisper.cpp's
// whisper-server, and downloading, choosing and deleting whisper models. API clients transcribe through the
// OpenAI-compatible POST /v1/audio/transcriptions instead (gateway/audio-endpoints.ts), which runs on the same service.
//
// Who may do what:
//  - reading the status, warming up and transcribing: anyone who may chat (auth.ts requiredCapability maps them to
//    `models:use`). The status names no file path.
//  - installing or removing whisper-server: the host, or a caller with a full API key (isLocalOrAuthenticated), as
//    for every route that ends in running a downloaded binary.
//  - model downloads: any caller lanAuth admits except a scoped remote-access token (unmapped in
//    requiredCapability). The download is a fixed file from a fixed list, not a URL the caller chooses.
//  - model deletes: the host or a caller with a full API key, like deleting a chat model. A hand-placed ggml file
//    cannot be fetched again.
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isLocalOrAuthenticated } from '../auth'
import type { VoiceStatus, TranscribeResult } from '../contract/voice'
import type { Deps } from '../deps'
import { VoiceError, type VoiceService } from '../voice/voice-service'
import { err } from './http'

/** The largest clip the page may send: about half an hour of the 16 kHz mono WAV it records. whisper-server holds the
 *  whole upload in memory and has no limit of its own. */
export const MAX_VOICE_CLIP_BYTES = 64 * 1024 * 1024

const NOT_RUNNING = 'Speech-to-text is not available in this daemon.'

export function registerVoiceRoutes(app: Hono, d: Deps): void {
  /** The service, or the refusal for a daemon built without one (a test's, an embedded one). */
  const voice = (): VoiceService | null => d.voice ?? null

  app.get('/api/v1/voice', (c) => {
    const v = voice()
    if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
    return c.json(v.status() satisfies VoiceStatus)
  })

  // Called as a recording starts, so whisper-server is loading its model while the user is still speaking.
  app.post('/api/v1/voice/warm', (c) => {
    voice()?.warm()
    return c.json({ ok: true }, 202)
  })

  app.post(
    '/api/v1/voice/transcribe',
    bodyLimit({
      maxSize: MAX_VOICE_CLIP_BYTES + 1024 * 1024,
      onError: (c) => err(c, 413, 'clip_too_large', `A voice clip can be at most ${MAX_VOICE_CLIP_BYTES / (1024 * 1024)} MB.`),
    }),
    async (c) => {
      const v = voice()
      if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
      let form: Record<string, unknown>
      try {
        form = await c.req.parseBody()
      } catch {
        return err(c, 400, 'invalid_input', 'A multipart form with one "file" field is required.')
      }
      const file = form.file
      // Blob, not File: the Android app's Node 18 has no global File, and a multipart part is a Blob either way.
      if (!(file instanceof Blob) || file.size === 0) return err(c, 400, 'invalid_input', 'A multipart form with one "file" field is required.')
      const language = typeof form.language === 'string' && form.language.trim() ? form.language : undefined
      try {
        return c.json((await v.transcribeText(file, { language }, c.req.raw.signal)) satisfies TranscribeResult)
      } catch (e) {
        return voiceErr(c, e)
      }
    },
  )

  app.post('/api/v1/voice/server/install', (c) => {
    const v = voice()
    if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', 'Installing whisper-server requires a valid API key from a non-host device.')
    try {
      v.startServerInstall()
    } catch (e) {
      return voiceErr(c, e)
    }
    return c.json(v.status() satisfies VoiceStatus, 202)
  })

  app.post('/api/v1/voice/server/install/cancel', (c) => {
    const v = voice()
    if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', 'Cancelling the whisper-server install requires a valid API key from a non-host device.')
    v.cancelServerInstall()
    return c.json(v.status() satisfies VoiceStatus)
  })

  app.delete('/api/v1/voice/server', async (c) => {
    const v = voice()
    if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', 'Removing whisper-server requires a valid API key from a non-host device.')
    try {
      await v.removeServer()
    } catch (e) {
      return voiceErr(c, e)
    }
    return c.json(v.status() satisfies VoiceStatus)
  })

  app.post('/api/v1/voice/models/:id/download', (c) => {
    const v = voice()
    if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
    try {
      v.startModelDownload(c.req.param('id'))
    } catch (e) {
      return voiceErr(c, e)
    }
    return c.json(v.status() satisfies VoiceStatus, 202)
  })

  app.post('/api/v1/voice/models/:id/cancel', (c) => {
    const v = voice()
    if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
    if (v.status().stt.downloading?.model === c.req.param('id')) v.cancelModelDownload()
    return c.json(v.status() satisfies VoiceStatus)
  })

  app.delete('/api/v1/voice/models/:id', async (c) => {
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', 'Deleting a whisper model requires a valid API key from a non-host device.')
    const v = voice()
    if (!v) return err(c, 503, 'stt_unavailable', NOT_RUNNING)
    try {
      await v.deleteModel(c.req.param('id'))
    } catch (e) {
      return voiceErr(c, e)
    }
    return c.json(v.status() satisfies VoiceStatus)
  })
}

function voiceErr(c: Parameters<typeof err>[0], e: unknown) {
  if (e instanceof VoiceError) return err(c, e.status, e.code, e.message)
  // The client hung up mid-transcription: nobody reads this, and it is not a server fault to log as one.
  if (c.req.raw.signal.aborted) return err(c, 400, 'cancelled', 'The request was cancelled.')
  return err(c, 500, 'internal', e instanceof Error ? e.message : String(e))
}
