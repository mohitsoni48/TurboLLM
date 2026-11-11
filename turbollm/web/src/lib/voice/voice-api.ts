// Speech-to-text on the daemon (src/api/voice-routes.ts, src/voice): the clip a recording becomes goes up, its text
// comes back; plus the setup calls Settings → Voice makes.
//
// `request()` in api.ts is module-private, so this follows the sibling API modules (jev-api.ts, link-api.ts) and
// keeps its own copy against the shared ApiError/authHeaders.
import type { TranscribeResult, VoiceStatus } from '@contract/voice'
import { ApiError, authHeaders } from '../api'

export type { SttModel, SttStatus, TranscribeResult, VoiceStatus } from '@contract/voice'

export function getVoiceStatus(): Promise<VoiceStatus> {
  return request<VoiceStatus>('/api/v1/voice')
}

/** Ask the daemon to start whisper now, so its model is loaded by the time the recording ends. Never fails the
 *  caller: a start that cannot happen is reported by the transcription that follows. */
export function warmVoice(): void {
  void request('/api/v1/voice/warm', { method: 'POST' }).catch(() => {})
}

/** The text of a recorded clip. `language` overrides the saved one for this clip. */
export function transcribeClip(clip: Blob, opts: { language?: string; signal?: AbortSignal } = {}): Promise<TranscribeResult> {
  const form = new FormData()
  form.append('file', clip, 'voice-message.wav')
  if (opts.language) form.append('language', opts.language)
  return request<TranscribeResult>('/api/v1/voice/transcribe', { method: 'POST', body: form, signal: opts.signal })
}

export function installWhisperServer(): Promise<VoiceStatus> {
  return request<VoiceStatus>('/api/v1/voice/server/install', { method: 'POST' })
}

export function cancelWhisperServerInstall(): Promise<VoiceStatus> {
  return request<VoiceStatus>('/api/v1/voice/server/install/cancel', { method: 'POST' })
}

export function removeWhisperServer(): Promise<VoiceStatus> {
  return request<VoiceStatus>('/api/v1/voice/server', { method: 'DELETE' })
}

export function downloadWhisperModel(id: string): Promise<VoiceStatus> {
  return request<VoiceStatus>(`/api/v1/voice/models/${encodeURIComponent(id)}/download`, { method: 'POST' })
}

export function cancelWhisperModelDownload(id: string): Promise<VoiceStatus> {
  return request<VoiceStatus>(`/api/v1/voice/models/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

export function deleteWhisperModel(id: string): Promise<VoiceStatus> {
  return request<VoiceStatus>(`/api/v1/voice/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // No Content-Type: for a FormData body the browser writes it, boundary included.
  const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...authHeaders() } })
  const text = await res.text()
  const data = text ? safeJson(text) : undefined
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
