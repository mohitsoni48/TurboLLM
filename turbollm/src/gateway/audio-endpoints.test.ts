// POST /v1/audio/transcriptions and /v1/audio/translations: OpenAI's speech-to-text API answered by whisper.cpp. The
// voice service is a hand-written fake; the dispatch tests go through the real /v1 gateway handler to pin when voice
// answers and when the request still goes on to the engine as it did before.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { VoiceError, type TranscribeOptions } from '../voice/voice-service'
import { audioEndpointFor, handleAudioRequest, type AudioEndpoint } from './audio-endpoints'
import { gatewayV1Handler, registerGateway } from './gateway'

interface FakeVoiceOptions {
  available?: boolean
  result?: { body: string; contentType: string }
  throws?: unknown
}

function fakeVoice(o: FakeVoiceOptions = {}) {
  const calls: Array<{ audio: Blob; opts: TranscribeOptions }> = []
  const voice = {
    available: () => o.available ?? true,
    transcribe: async (audio: Blob, opts: TranscribeOptions) => {
      calls.push({ audio, opts })
      if (o.throws) throw o.throws
      return o.result ?? { body: '{"text":"hi there"}', contentType: 'application/json' }
    },
  }
  return { voice, calls }
}

function audioApp(voice: unknown, endpoint: AudioEndpoint): Hono {
  const app = new Hono()
  const d = { voice } as unknown as Deps
  app.post('/t', (c) => handleAudioRequest(c, d, endpoint))
  return app
}

function upload(fields: Record<string, string> = {}, bytes: Uint8Array = new Uint8Array([1, 2, 3])): FormData {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'a.wav')
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return form
}

const send = (app: Hono, body: RequestInit['body']) => app.request('/t', { method: 'POST', body })

type OpenAiError = { error: { message: string; type: string; code: string } }

test('audioEndpointFor takes POST on the two audio paths, forgives one trailing slash, and nothing else', () => {
  assert.equal(audioEndpointFor('POST', '/v1/audio/transcriptions'), 'transcriptions')
  assert.equal(audioEndpointFor('POST', '/v1/audio/translations'), 'translations')
  assert.equal(audioEndpointFor('POST', '/v1/audio/transcriptions/'), 'transcriptions')
  assert.equal(audioEndpointFor('POST', '/v1/audio/translations/'), 'translations')
  assert.equal(audioEndpointFor('POST', '/v1/audio/transcriptions//'), null)
  assert.equal(audioEndpointFor('POST', '/v1/audio/speech'), null)
  assert.equal(audioEndpointFor('POST', '/v1/audio'), null)
  assert.equal(audioEndpointFor('POST', '/v1/audio/constructor'), null, 'a name on Object.prototype is not a path')
  assert.equal(audioEndpointFor('GET', '/v1/audio/transcriptions'), null)
  assert.equal(audioEndpointFor('PUT', '/v1/audio/translations'), null)
})

test('language, prompt, temperature and response_format reach transcribe(), and the clip arrives with its bytes', async () => {
  const f = fakeVoice()
  const bytes = new Uint8Array([7, 7, 8, 9])
  const res = await send(audioApp(f.voice, 'transcriptions'), upload({ language: 'de', prompt: 'TurboLLM', temperature: '0.4', response_format: 'verbose_json', model: 'whisper-1' }, bytes))
  assert.equal(res.status, 200)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].opts, { language: 'de', prompt: 'TurboLLM', temperature: 0.4, format: 'verbose_json', translate: false })
  assert.deepEqual(new Uint8Array(await f.calls[0].audio.arrayBuffer()), bytes)
})

test('only the translations endpoint asks for a translation, and the format defaults to json', async () => {
  for (const [endpoint, translate] of [['transcriptions', false], ['translations', true]] as const) {
    const f = fakeVoice()
    await send(audioApp(f.voice, endpoint), upload())
    assert.deepEqual(f.calls[0].opts, { language: undefined, prompt: undefined, temperature: undefined, format: 'json', translate }, endpoint)
  }
})

test('every response_format whisper-server answers in is accepted', async () => {
  for (const format of ['json', 'text', 'srt', 'verbose_json', 'vtt']) {
    const f = fakeVoice()
    const res = await send(audioApp(f.voice, 'transcriptions'), upload({ response_format: format }))
    assert.equal(res.status, 200, format)
    assert.equal(f.calls[0].opts.format, format)
  }
})

test('an unknown response_format is a 400 in the OpenAI error envelope and transcribe() is not called', async () => {
  const f = fakeVoice()
  const res = await send(audioApp(f.voice, 'transcriptions'), upload({ response_format: 'mp3' }))
  assert.equal(res.status, 400)
  const { error } = (await res.json()) as OpenAiError
  assert.equal(error.type, 'invalid_request_error')
  assert.equal(error.code, 'invalid_input')
  assert.match(error.message, /response_format must be one of: json, text, srt, verbose_json, vtt/)
  assert.equal(f.calls.length, 0)
})

test('a temperature that is not a number from 0 to 1 is a 400, since whisper-server answers it with a bare 500', async () => {
  for (const temperature of ['abc', '2', '-0.1', 'Infinity', '1.0001']) {
    const f = fakeVoice()
    const res = await send(audioApp(f.voice, 'transcriptions'), upload({ temperature }))
    assert.equal(res.status, 400, temperature)
    assert.equal(((await res.json()) as OpenAiError).error.type, 'invalid_request_error', temperature)
    assert.equal(f.calls.length, 0, temperature)
  }
  const f = fakeVoice()
  for (const temperature of ['0', '1']) await send(audioApp(f.voice, 'transcriptions'), upload({ temperature }))
  assert.deepEqual(f.calls.map((c) => c.opts.temperature), [0, 1])
})

test('a missing, empty or non-multipart file is a 400 invalid_input in the OpenAI envelope', async () => {
  const f = fakeVoice()
  const app = audioApp(f.voice, 'transcriptions')
  const noFile = new FormData()
  noFile.append('language', 'en')
  const bodies: RequestInit['body'][] = [noFile, upload({}, new Uint8Array(0))]
  for (const body of bodies) {
    const res = await send(app, body)
    assert.equal(res.status, 400)
    const { error } = (await res.json()) as OpenAiError
    assert.equal(error.type, 'invalid_request_error')
    assert.equal(error.code, 'invalid_input')
  }
  const json = await app.request('/t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"file":"x"}' })
  assert.equal(json.status, 400)
  assert.equal(((await json.json()) as OpenAiError).error.code, 'invalid_input')
  assert.equal(f.calls.length, 0)
})

test('the response body and Content-Type are exactly what transcribe() returned', async () => {
  const srt = '1\n00:00:00,000 --> 00:00:01,000\nhello\n'
  const f = fakeVoice({ result: { body: srt, contentType: 'application/x-subrip; charset=utf-8' } })
  const res = await send(audioApp(f.voice, 'transcriptions'), upload({ response_format: 'srt' }))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/x-subrip; charset=utf-8')
  assert.equal(await res.text(), srt)
})

test('a VoiceError keeps its code: 503 is a server_error and 400 an invalid_request_error', async () => {
  const unavailable = fakeVoice({ throws: new VoiceError(503, 'stt_not_ready', 'whisper-server is still loading.') })
  const res503 = await send(audioApp(unavailable.voice, 'transcriptions'), upload())
  assert.equal(res503.status, 503)
  assert.deepEqual(await res503.json(), { error: { message: 'whisper-server is still loading.', type: 'server_error', code: 'stt_not_ready' } })

  const bad = fakeVoice({ throws: new VoiceError(400, 'invalid_audio', 'whisper could not read that audio.') })
  const res400 = await send(audioApp(bad.voice, 'transcriptions'), upload())
  assert.equal(res400.status, 400)
  assert.deepEqual(await res400.json(), { error: { message: 'whisper could not read that audio.', type: 'invalid_request_error', code: 'invalid_audio' } })
})

test('a VoiceError 404 or 409 is shown as a 400, and an error that is not a VoiceError as a 502 stt_failed', async () => {
  for (const status of [404, 409] as const) {
    const f = fakeVoice({ throws: new VoiceError(status, 'model_missing', 'No model.') })
    assert.equal((await send(audioApp(f.voice, 'transcriptions'), upload())).status, 400, String(status))
  }
  const f = fakeVoice({ throws: new Error('socket hang up') })
  const res = await send(audioApp(f.voice, 'transcriptions'), upload())
  assert.equal(res.status, 502)
  assert.deepEqual(await res.json(), { error: { message: 'socket hang up', type: 'server_error', code: 'stt_failed' } })
})

test('handleAudioRequest with no voice service is a 503 stt_unavailable', async () => {
  const res = await send(audioApp(undefined, 'transcriptions'), upload())
  assert.equal(res.status, 503)
  assert.equal(((await res.json()) as OpenAiError).error.code, 'stt_unavailable')
})

/** A real engine socket that counts the requests the pass-through sends it. */
async function withEngine(): Promise<{ url: string; hits: () => string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"text":"from the engine"}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

function gatewayDeps(target: string, voice: unknown): Deps {
  const config = { modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target }) },
    store: { snapshot: () => config, read: () => config },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Model', key: 'model' } }),
      target: () => target,
      currentOpts: () => null,
      generationStart: () => {}, generationEnd: () => {}, recordCompletion: () => {}, setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
    voice,
  } as unknown as Deps
}

test('through the gateway, voice answers /v1/audio/transcriptions only while it is available', async () => {
  const engine = await withEngine()
  try {
    const f = fakeVoice({ available: true })
    const app = new Hono()
    registerGateway(app, gatewayDeps(engine.url, f.voice))
    const res = await app.request('/v1/audio/transcriptions', { method: 'POST', body: upload() })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { text: 'hi there' })
    assert.equal(f.calls.length, 1)
    assert.deepEqual(engine.hits(), [])
  } finally { await engine.close() }
})

test('through the gateway, an unavailable or absent voice service leaves /v1/audio/transcriptions to the engine as before', async () => {
  for (const voice of [fakeVoice({ available: false }), undefined]) {
    const engine = await withEngine()
    try {
      const app = new Hono()
      registerGateway(app, gatewayDeps(engine.url, voice?.voice))
      const res = await app.request('/v1/audio/transcriptions', { method: 'POST', body: upload() })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { text: 'from the engine' })
      assert.deepEqual(engine.hits(), ['POST /v1/audio/transcriptions'])
      assert.equal(voice?.calls.length ?? 0, 0, 'whisper is not asked while it is not set up')
    } finally { await engine.close() }
  }
})

test('through the gateway, a Turbo Link peer request is never answered by voice even while it is available', async () => {
  const engine = await withEngine()
  try {
    const f = fakeVoice({ available: true })
    const d = gatewayDeps(engine.url, f.voice)
    const app = new Hono()
    // The façade (link-routes.ts) mounts the same handler under its own prefix with origin 'link'.
    app.post('/api/link/v1/audio/transcriptions', (c) => gatewayV1Handler(c, d, { origin: 'link', pathname: '/v1/audio/transcriptions' }))
    const res = await app.request('/api/link/v1/audio/transcriptions', { method: 'POST', body: upload() })
    assert.equal(f.calls.length, 0, 'the peer transcribes on its own daemon, not on this one')
    assert.notDeepEqual(await res.json().catch(() => null), { text: 'hi there' })
  } finally { await engine.close() }
})
