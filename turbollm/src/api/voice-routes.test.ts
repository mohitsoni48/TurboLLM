// /api/v1/voice: the status, warm-up and transcribe routes, the host-gated whisper-server install, and the model
// downloads. The service is a hand-written fake that records what the routes call on it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { MAX_VOICE_CLIP_BYTES, registerVoiceRoutes } from './voice-routes'
import type { VoiceStatus } from '../contract/voice'
import type { Deps } from '../deps'
import { VoiceError } from '../voice/voice-service'

function status(downloading: string | null = null): VoiceStatus {
  return {
    stt: {
      available: true, state: 'stopped', error: null,
      server: { source: 'managed', version: 'b1', installable: true, hint: null, customMissing: false, installing: null, installError: null },
      model: 'base', models: [],
      downloading: downloading ? { phase: 'downloading', pct: 0.5, model: downloading } : null,
      downloadError: null,
    },
  }
}

interface FakeOptions {
  downloading?: string
  /** Thrown by the named method, once the route calls it. */
  throws?: Partial<Record<'transcribeText' | 'startServerInstall' | 'removeServer' | 'startModelDownload' | 'deleteModel', unknown>>
}

function fakeVoice(o: FakeOptions = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const rec = (method: string, ...args: unknown[]) => {
    calls.push({ method, args })
    if (o.throws && method in o.throws) throw o.throws[method as keyof typeof o.throws]
  }
  const voice = {
    status: () => status(o.downloading ?? null),
    warm: () => rec('warm'),
    transcribeText: async (audio: Blob, opts: { language?: string }) => { rec('transcribeText', audio, opts); return { text: 'hello world', tookMs: 12 } },
    startServerInstall: () => rec('startServerInstall'),
    cancelServerInstall: () => rec('cancelServerInstall'),
    removeServer: async () => rec('removeServer'),
    startModelDownload: (id: string) => rec('startModelDownload', id),
    cancelModelDownload: () => rec('cancelModelDownload'),
    deleteModel: async (id: string) => rec('deleteModel', id),
  }
  return { voice, calls, names: () => calls.map((c) => c.method) }
}

/** `remote` is a peer on an open LAN with no key: app.request() carries no TCP connection, so isLoopback fails closed
 *  to null, which is how a non-host caller looks (the zip upload test uses the same trick). */
function mk(opts: { voice?: ReturnType<typeof fakeVoice>['voice'] | null; remote?: boolean } = {}) {
  const cfg = {
    daemon: { lanBind: opts.remote ?? false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [], links: [],
  }
  const d = { version: 'test', store: { snapshot: () => cfg, read: () => cfg }, voice: opts.voice ?? undefined } as unknown as Deps
  const app = new Hono()
  registerVoiceRoutes(app, d)
  return app
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  return ((await res.json()) as { error: { code: string; message: string } }).error
}

function clip(bytes: Uint8Array = new Uint8Array([1, 2, 3, 4, 5]), fields: Record<string, string> = {}): FormData {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'clip.wav')
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return form
}

const post = (app: Hono, path: string, body?: RequestInit['body']) => app.request(path, { method: 'POST', body })

test('with no voice service every voice route answers 503 stt_unavailable in the error envelope', async () => {
  const app = mk()
  const routes: Array<[string, string]> = [
    ['GET', '/api/v1/voice'],
    ['POST', '/api/v1/voice/transcribe'],
    ['POST', '/api/v1/voice/server/install'],
    ['POST', '/api/v1/voice/server/install/cancel'],
    ['DELETE', '/api/v1/voice/server'],
    ['POST', '/api/v1/voice/models/base/download'],
    ['POST', '/api/v1/voice/models/base/cancel'],
    ['DELETE', '/api/v1/voice/models/base'],
  ]
  for (const [method, path] of routes) {
    const res = await app.request(path, { method, body: method === 'POST' && path.endsWith('transcribe') ? clip() : undefined })
    assert.equal(res.status, 503, `${method} ${path}`)
    assert.equal((await errorOf(res)).code, 'stt_unavailable', `${method} ${path}`)
  }
})

test('POST /voice/warm with no voice service is a 202 no-op, since the page fires it on every recording', async () => {
  const res = await post(mk(), '/api/v1/voice/warm')
  assert.equal(res.status, 202)
})

test('GET /voice returns the status the service reports', async () => {
  const f = fakeVoice({ downloading: 'small' })
  const res = await mk({ voice: f.voice }).request('/api/v1/voice')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), status('small'))
})

test('POST /voice/warm calls warm() and answers 202', async () => {
  const f = fakeVoice()
  const res = await post(mk({ voice: f.voice }), '/api/v1/voice/warm')
  assert.equal(res.status, 202)
  assert.deepEqual(f.names(), ['warm'])
})

test('POST /voice/transcribe hands the clip to transcribeText as a Blob with the same bytes and returns its result', async () => {
  const f = fakeVoice()
  const bytes = new Uint8Array([9, 8, 7, 6, 5, 4])
  const res = await post(mk({ voice: f.voice }), '/api/v1/voice/transcribe', clip(bytes))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { text: 'hello world', tookMs: 12 })
  const audio = f.calls[0].args[0] as Blob
  assert.ok(audio instanceof Blob)
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes)
})

test('POST /voice/transcribe passes the language field through and leaves it out when blank', async () => {
  const f = fakeVoice()
  const app = mk({ voice: f.voice })
  await post(app, '/api/v1/voice/transcribe', clip(undefined, { language: 'de' }))
  await post(app, '/api/v1/voice/transcribe', clip(undefined, { language: '  ' }))
  await post(app, '/api/v1/voice/transcribe', clip())
  assert.deepEqual(f.calls.map((c) => (c.args[1] as { language?: string }).language), ['de', undefined, undefined])
})

test('POST /voice/transcribe refuses a missing file, an empty file and a body that is not multipart with 400 invalid_input', async () => {
  const f = fakeVoice()
  const app = mk({ voice: f.voice })
  const noFile = new FormData()
  noFile.append('language', 'en')
  const textFile = new FormData()
  textFile.append('file', 'not a file part')
  const bodies: Array<[string, FormData | Blob]> = [
    ['no file field', noFile],
    ['a file field that is plain text', textFile],
    ['an empty file', clip(new Uint8Array(0))],
    ['a JSON body', new Blob(['{"file":1}'], { type: 'application/json' })],
  ]
  for (const [label, body] of bodies) {
    const res = await app.request('/api/v1/voice/transcribe', { method: 'POST', body, headers: body instanceof Blob ? { 'Content-Type': 'application/json' } : undefined })
    assert.equal(res.status, 400, label)
    assert.equal((await errorOf(res)).code, 'invalid_input', label)
  }
  assert.deepEqual(f.calls, [], 'the service is never asked to transcribe nothing')
})

test('POST /voice/transcribe answers a body over the limit with 413 clip_too_large before reading it', async () => {
  const f = fakeVoice()
  // Declared, not sent: bodyLimit judges a Content-Length before it buffers anything, so no 64 MB is allocated.
  const res = await mk({ voice: f.voice }).request('/api/v1/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(MAX_VOICE_CLIP_BYTES + 2 * 1024 * 1024) },
    body: '--x--',
  })
  assert.equal(res.status, 413)
  assert.equal((await errorOf(res)).code, 'clip_too_large')
  assert.deepEqual(f.calls, [])
})

test('POST /voice/transcribe maps a VoiceError to its own status, code and message', async () => {
  const f = fakeVoice({ throws: { transcribeText: new VoiceError(503, 'stt_not_ready', 'whisper-server is still loading.') } })
  const res = await post(mk({ voice: f.voice }), '/api/v1/voice/transcribe', clip())
  assert.equal(res.status, 503)
  assert.deepEqual(await errorOf(res), { code: 'stt_not_ready', message: 'whisper-server is still loading.' })
})

test('POST /voice/transcribe answers an error that is not a VoiceError with 500 internal', async () => {
  const f = fakeVoice({ throws: { transcribeText: new Error('disk on fire') } })
  const res = await post(mk({ voice: f.voice }), '/api/v1/voice/transcribe', clip())
  assert.equal(res.status, 500)
  assert.deepEqual(await errorOf(res), { code: 'internal', message: 'disk on fire' })
})

test('whisper-server install, cancel and remove run for a local caller and answer with the status', async () => {
  const f = fakeVoice()
  const app = mk({ voice: f.voice })
  const install = await post(app, '/api/v1/voice/server/install')
  assert.equal(install.status, 202)
  assert.deepEqual(await install.json(), status())
  const cancel = await post(app, '/api/v1/voice/server/install/cancel')
  assert.equal(cancel.status, 200)
  const remove = await app.request('/api/v1/voice/server', { method: 'DELETE' })
  assert.equal(remove.status, 200)
  assert.deepEqual(await remove.json(), status())
  assert.deepEqual(f.names(), ['startServerInstall', 'cancelServerInstall', 'removeServer'])
})

test('whisper-server install, cancel and remove are refused with 403 api_key_required for a non-host caller, and never reach the service', async () => {
  const f = fakeVoice()
  const app = mk({ voice: f.voice, remote: true })
  const attempts: Array<[string, string]> = [
    ['POST', '/api/v1/voice/server/install'],
    ['POST', '/api/v1/voice/server/install/cancel'],
    ['DELETE', '/api/v1/voice/server'],
  ]
  for (const [method, path] of attempts) {
    const res = await app.request(path, { method })
    assert.equal(res.status, 403, `${method} ${path}`)
    assert.equal((await errorOf(res)).code, 'api_key_required', `${method} ${path}`)
  }
  assert.deepEqual(f.calls, [], 'running a downloaded binary is not for an anonymous LAN peer')
})

test('install and remove map a VoiceError from the service through', async () => {
  const f = fakeVoice({ throws: {
    startServerInstall: new VoiceError(409, 'install_in_progress', 'Already installing.'),
    removeServer: new VoiceError(409, 'server_busy', 'whisper-server is transcribing.'),
  } })
  const app = mk({ voice: f.voice })
  const install = await post(app, '/api/v1/voice/server/install')
  assert.equal(install.status, 409)
  assert.equal((await errorOf(install)).code, 'install_in_progress')
  const remove = await app.request('/api/v1/voice/server', { method: 'DELETE' })
  assert.equal(remove.status, 409)
  assert.equal((await errorOf(remove)).code, 'server_busy')
})

test('POST /voice/models/:id/download calls startModelDownload with the id and answers 202 with the status', async () => {
  const f = fakeVoice()
  const res = await post(mk({ voice: f.voice }), '/api/v1/voice/models/small-q5_1/download')
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), status())
  assert.deepEqual(f.calls, [{ method: 'startModelDownload', args: ['small-q5_1'] }])
})

test('a model download for an unknown id or while another runs maps the service 404 and 409 through', async () => {
  for (const [status404or409, code] of [[404, 'unknown_model'], [409, 'download_in_progress']] as const) {
    const f = fakeVoice({ throws: { startModelDownload: new VoiceError(status404or409, code, 'nope') } })
    const res = await post(mk({ voice: f.voice }), '/api/v1/voice/models/base/download')
    assert.equal(res.status, status404or409)
    assert.deepEqual(await errorOf(res), { code, message: 'nope' })
  }
})

test('POST /voice/models/:id/cancel cancels only the download that is running under that id', async () => {
  const f = fakeVoice({ downloading: 'small' })
  const app = mk({ voice: f.voice })
  const other = await post(app, '/api/v1/voice/models/base/cancel')
  assert.equal(other.status, 200)
  assert.deepEqual(f.names(), [], 'a stale cancel for another model leaves the running download alone')
  const same = await post(app, '/api/v1/voice/models/small/cancel')
  assert.equal(same.status, 200)
  assert.deepEqual(f.names(), ['cancelModelDownload'])
})

test('DELETE /voice/models/:id calls deleteModel with the id, and maps its VoiceError through', async () => {
  const f = fakeVoice()
  const ok = await mk({ voice: f.voice }).request('/api/v1/voice/models/base', { method: 'DELETE' })
  assert.equal(ok.status, 200)
  assert.deepEqual(f.calls, [{ method: 'deleteModel', args: ['base'] }])

  const g = fakeVoice({ throws: { deleteModel: new VoiceError(404, 'unknown_model', 'No such model.') } })
  const missing = await mk({ voice: g.voice }).request('/api/v1/voice/models/zzz', { method: 'DELETE' })
  assert.equal(missing.status, 404)
  assert.equal((await errorOf(missing)).code, 'unknown_model')
})
