import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import {
  cancelWhisperModelDownload, cancelWhisperServerInstall, deleteWhisperModel, downloadWhisperModel, getVoiceStatus,
  installWhisperServer, removeWhisperServer, transcribeClip, warmVoice, type VoiceStatus,
} from './voice-api'
import { voiceInProgress } from './voice-queries'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  localStorage.clear()
})

/** The url and init of the one request the test made. */
const lastRequest = (): { url: string; init: RequestInit } => {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? []
  return { url: String(url), init: init ?? {} }
}
const header = (init: RequestInit, name: string): string | undefined => (init.headers as Record<string, string>)[name]

describe('transcribeClip', () => {
  const clip = new Blob(['RIFF'], { type: 'audio/wav' })

  it('POSTs the clip as a multipart "file" part, and returns the parsed result', async () => {
    fetchMock.mockResolvedValue(json({ text: 'hello world' }))
    const result = await transcribeClip(clip)
    expect(result).toEqual({ text: 'hello world' })
    const { url, init } = lastRequest()
    expect(url).toBe('/api/v1/voice/transcribe')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('voice-message.wav')
    expect(file.size).toBe(clip.size)
    expect(form.has('language')).toBe(false)
  })

  it('adds the language only when one is given', async () => {
    fetchMock.mockImplementation(async () => json({ text: 'hola' }))
    await transcribeClip(clip, { language: 'es' })
    expect((lastRequest().init.body as FormData).get('language')).toBe('es')
    await transcribeClip(clip, { language: '' })
    expect((lastRequest().init.body as FormData).has('language')).toBe(false)
  })

  it('passes the abort signal on', async () => {
    fetchMock.mockResolvedValue(json({ text: '' }))
    const ac = new AbortController()
    await transcribeClip(clip, { signal: ac.signal })
    expect(lastRequest().init.signal).toBe(ac.signal)
  })

  it('sends the saved key, and leaves Content-Type to the browser (the multipart boundary is in it)', async () => {
    localStorage.setItem('tllm.authToken', 'secret-key')
    fetchMock.mockResolvedValue(json({ text: 'x' }))
    await transcribeClip(clip)
    const { init } = lastRequest()
    expect(header(init, 'X-TurboLLM-Auth')).toBe('secret-key')
    expect(Object.keys(init.headers as object).map((k) => k.toLowerCase())).not.toContain('content-type')
  })

  it('sends no auth header without a saved key', async () => {
    fetchMock.mockResolvedValue(json({ text: 'x' }))
    await transcribeClip(clip)
    expect(header(lastRequest().init, 'X-TurboLLM-Auth')).toBeUndefined()
  })

  it('throws an ApiError with the daemon\'s code, message and status', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'stt_unavailable', message: 'No speech model is installed.' } }, 409))
    const error = await transcribeClip(clip).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'stt_unavailable', message: 'No speech model is installed.', status: 409 })
  })

  it('throws http_error for an error that is not the daemon\'s envelope', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }))
    const error = await transcribeClip(clip).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'http_error', message: 'Request failed with status 502.', status: 502 })
  })

  it('throws http_error for an empty error body', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    await expect(transcribeClip(clip)).rejects.toMatchObject({ code: 'http_error', status: 404 })
  })
})

describe('warmVoice', () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('asks the daemon to start whisper', async () => {
    fetchMock.mockResolvedValue(json({}))
    warmVoice()
    await settle()
    expect(lastRequest().url).toBe('/api/v1/voice/warm')
    expect(lastRequest().init.method).toBe('POST')
  })

  it('never throws or rejects, whether the daemon refuses, answers badly or cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(() => warmVoice()).not.toThrow()
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'x', message: 'no' } }, 500))
    expect(() => warmVoice()).not.toThrow()
    fetchMock.mockResolvedValueOnce(new Response('<<<', { status: 200 }))
    expect(() => warmVoice()).not.toThrow()
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('the status and setup calls', () => {
  beforeEach(() => fetchMock.mockImplementation(async () => json({ stt: { available: true } })))

  const cases: Array<[string, () => Promise<VoiceStatus>, string, string]> = [
    ['getVoiceStatus', () => getVoiceStatus(), 'GET', '/api/v1/voice'],
    ['installWhisperServer', () => installWhisperServer(), 'POST', '/api/v1/voice/server/install'],
    ['cancelWhisperServerInstall', () => cancelWhisperServerInstall(), 'POST', '/api/v1/voice/server/install/cancel'],
    ['removeWhisperServer', () => removeWhisperServer(), 'DELETE', '/api/v1/voice/server'],
    ['downloadWhisperModel', () => downloadWhisperModel('large-v3-turbo-q5_0'), 'POST', '/api/v1/voice/models/large-v3-turbo-q5_0/download'],
    ['cancelWhisperModelDownload', () => cancelWhisperModelDownload('base'), 'POST', '/api/v1/voice/models/base/cancel'],
    ['deleteWhisperModel', () => deleteWhisperModel('base'), 'DELETE', '/api/v1/voice/models/base'],
  ]

  it.each(cases)('%s is %s %s', async (_name, call, method, url) => {
    expect(await call()).toEqual({ stt: { available: true } })
    expect(lastRequest().url).toBe(url)
    expect(lastRequest().init.method ?? 'GET').toBe(method)
  })

  it('encodes a model id that is a file name', async () => {
    await downloadWhisperModel('my model/ggml?.bin')
    expect(lastRequest().url).toBe('/api/v1/voice/models/my%20model%2Fggml%3F.bin/download')
    await cancelWhisperModelDownload('a b')
    expect(lastRequest().url).toBe('/api/v1/voice/models/a%20b/cancel')
    await deleteWhisperModel('a#b')
    expect(lastRequest().url).toBe('/api/v1/voice/models/a%23b')
  })

  it('asks for JSON and sends the saved key', async () => {
    localStorage.setItem('tllm.authToken', 'k')
    await getVoiceStatus()
    expect(header(lastRequest().init, 'Accept')).toBe('application/json')
    expect(header(lastRequest().init, 'X-TurboLLM-Auth')).toBe('k')
  })

  it('throws the daemon\'s error from any of them', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'busy', message: 'A download is already running.' } }, 409))
    await expect(downloadWhisperModel('base')).rejects.toMatchObject({ code: 'busy', message: 'A download is already running.', status: 409 })
  })
})

describe('voiceInProgress', () => {
  const status = (over: { downloading?: boolean; installing?: boolean; state?: VoiceStatus['stt']['state'] } = {}): VoiceStatus => ({
    stt: {
      available: true,
      state: over.state ?? 'ready',
      error: null,
      server: {
        source: 'managed', version: 'b1', installable: true, hint: null, customMissing: false,
        installing: over.installing ? { phase: 'downloading', pct: 0.5 } : null, installError: null,
      },
      model: 'base',
      models: [],
      downloading: over.downloading ? { model: 'base', phase: 'downloading', pct: 0.1 } : null,
      downloadError: null,
    },
  })

  it('is true while a model downloads, the server installs, or whisper starts', () => {
    expect(voiceInProgress(status({ downloading: true }))).toBe(true)
    expect(voiceInProgress(status({ installing: true }))).toBe(true)
    expect(voiceInProgress(status({ state: 'starting' }))).toBe(true)
  })

  it('is false when nothing is moving', () => {
    expect(voiceInProgress(status())).toBe(false)
    expect(voiceInProgress(status({ state: 'stopped' }))).toBe(false)
    expect(voiceInProgress(status({ state: 'error' }))).toBe(false)
  })

  it('is false before there is a status', () => {
    expect(voiceInProgress(undefined)).toBe(false)
  })
})
