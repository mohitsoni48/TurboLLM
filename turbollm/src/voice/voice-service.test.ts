import assert from 'node:assert/strict'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig, type ConfigStore } from '../config/config'
import type { SttModel } from '../contract/voice'
import { tmpDir } from '../test-support/tmp'
import { VoiceError, VoiceService, activeModel, type VoiceServiceDeps } from './voice-service'
import { ANDROID_WHISPER_SERVER, ANDROID_WHISPER_SERVER_GPU, whisperModelsDir, type ResolvedWhisperServer } from './whisper-binary'
import { WHISPER_MODELS } from './whisper-catalog'
import { WhisperStartError, whisperServerArgs, type WhisperLaunch, type WhisperServer } from './whisper-server'

const BIN = '/opt/whisper/whisper-server'
const FOUND: ResolvedWhisperServer = { ok: true, path: BIN, source: 'system', version: '' }
const PORT = 5555

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function waitFor(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** The part of WhisperServer that VoiceService calls. `use` runs the work against a fixed port, as the real one does. */
function fakeServer(over: { launch?: WhisperLaunch | null; useError?: Error } = {}) {
  const calls: string[] = []
  const launches: WhisperLaunch[] = []
  const server = {
    state: () => 'stopped' as const,
    error: () => null,
    launch: () => over.launch ?? null,
    async use<T>(launch: WhisperLaunch, work: (port: number) => Promise<T>): Promise<T> {
      calls.push('use')
      launches.push(launch)
      if (over.useError) throw over.useError
      return work(PORT)
    },
    async stop() { calls.push('stop') },
    async shutdown() { calls.push('shutdown') },
  }
  return { server: server as unknown as WhisperServer, calls, launches }
}

interface Rig {
  service: VoiceService
  cfg: ReturnType<typeof defaultConfig>
  dir: string
  modelsDir: string
  calls: string[]
  launches: WhisperLaunch[]
}

function rig(deps: Partial<VoiceServiceDeps> = {}, server = fakeServer()): Rig {
  const dir = tmpDir('tllm-voice-')
  const cfg = defaultConfig()
  const store = {
    read: () => cfg,
    update: (fn: (c: typeof cfg) => void) => fn(cfg),
    dir: () => dir,
  } as unknown as ConfigStore
  const service = new VoiceService({ store, server: server.server, resolve: () => FOUND, platform: 'linux', arch: 'x64', env: {},
    // Not this machine's CPU: the launches asserted below must not depend on whether it has fast and slow cores.
    perfCores: () => undefined, ...deps })
  return { service, cfg, dir, modelsDir: whisperModelsDir(dir), calls: server.calls, launches: server.launches }
}

function installModel(r: Rig, file: string, bytes = 'x'): void {
  mkdirSync(r.modelsDir, { recursive: true })
  writeFileSync(join(r.modelsDir, file), bytes)
}

/** A rig with a server, base installed and chosen, and a fetch that records the form it was sent and answers `answer`. */
function transcribeRig(answer: () => Response = () => Response.json({ text: ' hello' })) {
  const sent: { url: string; form: FormData; method?: string }[] = []
  const r = rig({
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, form: init.body as FormData, method: init.method })
      return answer()
    }) as unknown as typeof fetch,
  })
  installModel(r, 'ggml-base.bin')
  r.cfg.speechToText.model = 'base'
  return { ...r, sent }
}

const AUDIO = new Blob(['RIFF'], { type: 'audio/wav' })

// ── status ──

test('status on an empty data dir: not available, no server, no model, every catalog model listed and not installed', () => {
  const { service } = rig({ resolve: () => ({ ok: false, reason: 'none' }) })
  const { stt } = service.status()
  assert.equal(stt.available, false)
  assert.equal(stt.server.source, null)
  assert.equal(stt.server.version, '')
  assert.equal(stt.server.customMissing, false)
  assert.equal(stt.server.installing, null)
  assert.equal(stt.server.installError, null)
  assert.equal(stt.model, '')
  assert.deepEqual(stt.models.map((m) => m.id), WHISPER_MODELS.map((m) => m.id))
  assert.ok(stt.models.every((m) => !m.installed && !m.custom))
  assert.equal(stt.models.filter((m) => m.recommended).length, 1)
  assert.equal(stt.downloading, null)
  assert.equal(stt.downloadError, null)
  assert.equal(stt.error, null)
  assert.equal(stt.state, 'stopped')
})

test('status installable and hint follow the platform', () => {
  for (const [platform, arch, installable, hint] of [
    ['linux', 'x64', true, null], ['win32', 'arm64', true, null], ['darwin', 'arm64', false, 'homebrew'], ['freebsd', 'x64', false, 'build'],
  ] as const) {
    const { service } = rig({ platform, arch })
    const { server } = service.status().stt
    assert.equal(server.installable, installable, platform)
    assert.equal(server.hint, hint, platform)
  }
  const android = rig({ platform: 'android', arch: 'arm64', env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/lib' } })
  assert.equal(android.service.status().stt.server.hint, 'android')
  assert.equal(android.service.status().stt.server.installable, false)
})

test('status reports a found server with its source and version, and is available once a model is installed', () => {
  const r = rig({ resolve: () => ({ ok: true, path: BIN, source: 'managed', version: 'b1' }) })
  assert.equal(r.service.status().stt.available, false, 'a server alone is not enough')
  installModel(r, 'ggml-tiny.bin')
  const { stt } = r.service.status()
  assert.equal(stt.available, true)
  assert.equal(r.service.available(), true)
  assert.deepEqual([stt.server.source, stt.server.version], ['managed', 'b1'])
})

test('status flags a saved server path that has no file', () => {
  const r = rig({ resolve: () => ({ ok: false, reason: 'custom_missing' }) })
  const { stt } = r.service.status()
  assert.equal(stt.server.customMissing, true)
  assert.equal(stt.server.source, null)
  assert.equal(stt.available, false)
})

test('status carries no file path of the server or the models', () => {
  const r = rig()
  installModel(r, 'ggml-base.bin')
  assert.ok(!JSON.stringify(r.service.status()).includes(r.dir))
  assert.ok(!JSON.stringify(r.service.status()).includes(BIN))
})

test('a ggml file in the models folder that the catalog does not list is shown as custom with its size on disk', () => {
  const r = rig()
  installModel(r, 'ggml-mine.en.bin', '12345')
  installModel(r, 'ggml-zzz.bin', '1')
  installModel(r, 'ggml-base.bin')
  installModel(r, 'notes.txt', 'not a model')
  installModel(r, 'model.bin', 'not ggml-named')
  mkdirSync(join(r.modelsDir, 'ggml-folder.bin'))
  const { models } = r.service.status().stt
  const custom = models.filter((m) => m.custom)
  assert.deepEqual(custom.map((m) => m.id), ['ggml-mine.en.bin', 'ggml-zzz.bin'])
  assert.deepEqual(custom[0], { id: 'ggml-mine.en.bin', label: 'ggml-mine.en.bin', sizeBytes: 5, multilingual: false, note: '', installed: true, custom: true })
  assert.equal(custom[1].multilingual, true)
  assert.equal(models.find((m) => m.id === 'base')?.installed, true)
  assert.equal(models.filter((m) => m.id === 'base' || m.id === 'ggml-base.bin').length, 1, 'a catalog file is not listed twice')
})

// ── activeModel ──

const model = (id: string, installed: boolean): SttModel => ({ id, label: id, sizeBytes: 1, multilingual: true, note: '', installed })

test('activeModel: the saved model when it is installed, else the first installed one, else empty', () => {
  const list = [model('a', false), model('b', true), model('c', true)]
  assert.equal(activeModel(list, 'c'), 'c')
  assert.equal(activeModel(list, 'a'), 'b', 'saved but not installed falls back')
  assert.equal(activeModel(list, 'gone'), 'b')
  assert.equal(activeModel(list, ''), 'b')
  assert.equal(activeModel([model('a', false)], 'a'), '')
  assert.equal(activeModel([], ''), '')
})

test('status model follows a saved choice whose file was deleted by hand to another installed model', () => {
  const r = rig()
  installModel(r, 'ggml-small.bin')
  r.cfg.speechToText.model = 'base'
  assert.equal(r.service.status().stt.model, 'small')
})

// ── model download ──

function downloadRig(download: VoiceServiceDeps['download']) {
  const calls: { url: string; dest: string; sha256?: string }[] = []
  const r = rig({
    download: async (url, dest, onProgress, signal, f, opts) => {
      calls.push({ url, dest, sha256: opts?.expectedSha256 })
      await download!(url, dest, onProgress, signal, f, opts)
    },
  })
  return { ...r, downloads: calls }
}

test('a model download shows as downloading in flight, then installs and becomes the chosen model', async () => {
  const gate = deferred()
  const r = downloadRig(async (_url, dest, onProgress) => {
    onProgress?.({ phase: 'downloading', pct: 0.5 })
    await gate.promise
    writeFileSync(dest, 'weights')
  })
  r.service.startModelDownload('base')
  assert.deepEqual(r.service.status().stt.downloading, { model: 'base', phase: 'downloading', pct: 0.5 })
  assert.equal(r.service.status().stt.models.find((m) => m.id === 'base')?.installed, false)

  gate.resolve()
  await waitFor('the download to finish', () => r.service.status().stt.downloading === null)
  const { stt } = r.service.status()
  assert.equal(stt.models.find((m) => m.id === 'base')?.installed, true)
  assert.equal(r.cfg.speechToText.model, 'base')
  assert.equal(stt.model, 'base')
  assert.equal(stt.downloadError, null)
  assert.equal(r.downloads.length, 1)
  assert.equal(r.downloads[0].url, 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin')
  assert.equal(r.downloads[0].dest, join(r.modelsDir, 'ggml-base.bin'))
  assert.equal(r.downloads[0].sha256, WHISPER_MODELS.find((m) => m.id === 'base')!.sha256)
})

test('a model download honours TURBOLLM_HF_BASE, trailing slash or not', async () => {
  const dir = tmpDir('tllm-voice-')
  const urls: string[] = []
  const cfg = defaultConfig()
  const store = { read: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => dir } as unknown as ConfigStore
  const service = new VoiceService({
    store, server: fakeServer().server, resolve: () => FOUND, env: { TURBOLLM_HF_BASE: 'http://hf.test:9/' },
    download: async (url, dest) => { urls.push(url); writeFileSync(dest, 'w') },
  })
  service.startModelDownload('tiny')
  await waitFor('the download to finish', () => service.status().stt.downloading === null)
  assert.deepEqual(urls, ['http://hf.test:9/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'])
})

test('a finished download does not replace a model that is already installed and chosen', async () => {
  const r = downloadRig(async (_u, dest) => { writeFileSync(dest, 'w') })
  installModel(r, 'ggml-tiny.bin')
  r.cfg.speechToText.model = 'tiny'
  r.service.startModelDownload('base')
  await waitFor('the download to finish', () => r.service.status().stt.downloading === null)
  assert.equal(r.cfg.speechToText.model, 'tiny')
  assert.equal(r.service.status().stt.models.find((m) => m.id === 'base')?.installed, true)
})

test('a finished download replaces a saved choice whose file is gone', async () => {
  const r = downloadRig(async (_u, dest) => { writeFileSync(dest, 'w') })
  r.cfg.speechToText.model = 'small'
  r.service.startModelDownload('base')
  await waitFor('the download to finish', () => r.service.status().stt.downloading === null)
  assert.equal(r.cfg.speechToText.model, 'base')
})

test('starting a download of an unknown model is a 404', () => {
  const r = rig()
  assert.throws(() => r.service.startModelDownload('nope'), (e: unknown) => e instanceof VoiceError && e.status === 404 && e.code === 'not_found')
})

test('a second, different model while one downloads is a 409, and the same id again is a no-op', async () => {
  const gate = deferred()
  const r = downloadRig(async (_u, dest) => { await gate.promise; writeFileSync(dest, 'w') })
  try {
    r.service.startModelDownload('base')
    r.service.startModelDownload('base')
    assert.throws(() => r.service.startModelDownload('tiny'), (e: unknown) => e instanceof VoiceError && e.status === 409 && e.code === 'download_in_progress')
    assert.equal(r.downloads.length, 1)
  } finally {
    gate.resolve()
    await waitFor('the download to finish', () => r.service.status().stt.downloading === null)
  }
})

test('downloading a model that is already installed does nothing', () => {
  const r = downloadRig(async () => { assert.fail('no download expected') })
  installModel(r, 'ggml-base.bin')
  r.service.startModelDownload('base')
  assert.equal(r.service.status().stt.downloading, null)
  assert.equal(r.downloads.length, 0)
})

test('cancelModelDownload aborts the download and records no downloadError', async () => {
  let seen: AbortSignal | undefined
  const r = downloadRig((_u, _dest, _p, signal) => new Promise<void>((_, reject) => {
    seen = signal
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
  assert.equal(r.service.cancelModelDownload(), false, 'nothing to cancel')
  r.service.startModelDownload('base')
  assert.equal(r.service.cancelModelDownload(), true)
  assert.equal(seen?.aborted, true)
  await waitFor('the download to end', () => r.service.status().stt.downloading === null)
  assert.equal(r.service.status().stt.downloadError, null)
  assert.equal(r.cfg.speechToText.model, '')
})

test('a failing download records downloadError with the model id, and the next download clears it', async () => {
  let fail = true
  const r = downloadRig(async (_u, dest) => {
    if (fail) throw new Error('sha256 mismatch')
    writeFileSync(dest, 'w')
  })
  r.service.startModelDownload('base')
  await waitFor('the download to fail', () => r.service.status().stt.downloading === null)
  assert.deepEqual(r.service.status().stt.downloadError, { model: 'base', message: 'sha256 mismatch' })
  assert.equal(r.cfg.speechToText.model, '')

  fail = false
  r.service.startModelDownload('base')
  assert.equal(r.service.status().stt.downloadError, null)
  await waitFor('the download to finish', () => r.service.status().stt.downloading === null)
  assert.equal(r.service.status().stt.downloadError, null)
})

// ── deleteModel ──

test('deleteModel removes the file and clears the saved choice when it was the chosen model', async () => {
  const r = rig()
  installModel(r, 'ggml-base.bin')
  r.cfg.speechToText.model = 'base'
  await r.service.deleteModel('base')
  assert.equal(existsSync(join(r.modelsDir, 'ggml-base.bin')), false)
  assert.equal(r.cfg.speechToText.model, '')
  assert.equal(r.service.status().stt.models.find((m) => m.id === 'base')?.installed, false)
})

test('deleteModel of another model leaves the saved choice alone, and can delete a custom file by its name', async () => {
  const r = rig()
  installModel(r, 'ggml-base.bin')
  installModel(r, 'ggml-mine.bin')
  r.cfg.speechToText.model = 'base'
  await r.service.deleteModel('ggml-mine.bin')
  assert.equal(existsSync(join(r.modelsDir, 'ggml-mine.bin')), false)
  assert.equal(r.cfg.speechToText.model, 'base')
})

test('deleteModel is a 404 for a model that is not installed, and cannot be pointed at a path outside the models folder', async () => {
  const r = rig()
  writeFileSync(join(r.dir, 'ggml-outside.bin'), 'x')
  for (const id of ['base', 'nope', '../ggml-outside.bin']) {
    await assert.rejects(r.service.deleteModel(id), (e: unknown) => e instanceof VoiceError && e.status === 404, id)
  }
  assert.equal(existsSync(join(r.dir, 'ggml-outside.bin')), true)
})

test('deleteModel stops whisper-server first only when it is running that model', async () => {
  const running = fakeServer()
  const r = rig({}, running)
  installModel(r, 'ggml-base.bin')
  installModel(r, 'ggml-tiny.bin')
  running.server.launch = () => ({ binPath: BIN, modelPath: join(r.modelsDir, 'ggml-base.bin'), gpu: false })

  await r.service.deleteModel('tiny')
  assert.deepEqual(running.calls, [], 'a server running another model is left up')
  await r.service.deleteModel('base')
  assert.deepEqual(running.calls, ['stop'])
})

// ── whisper-server install ──

test('startServerInstall refuses with 400 not_installable on macOS and on the packaged Android app', () => {
  for (const [platform, arch, env] of [['darwin', 'arm64', {}], ['android', 'arm64', { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/lib' }], ['freebsd', 'x64', {}]] as const) {
    let installs = 0
    const r = rig({ platform, arch, env, install: async () => { installs++; return { path: BIN, version: '' } } })
    assert.throws(() => r.service.startServerInstall(), (e: unknown) => e instanceof VoiceError && e.status === 400 && e.code === 'not_installable', platform)
    assert.equal(installs, 0)
    assert.equal(r.service.status().stt.server.installing, null)
  }
})

test('startServerInstall stops whisper-server, runs the install, shows installing with its progress, then re-resolves', async () => {
  const gate = deferred()
  const order: string[] = []
  let resolved: ResolvedWhisperServer = { ok: false, reason: 'none' }
  const fake = fakeServer()
  const r = rig({
    resolve: () => resolved,
    install: async (dataDir, onProgress) => {
      order.push(`install ${dataDir}`)
      onProgress?.({ phase: 'extracting', pct: -1 })
      await gate.promise
      return { path: BIN, version: 'b1' }
    },
  }, fake)
  assert.equal(r.service.status().stt.server.source, null)

  r.service.startServerInstall()
  r.service.startServerInstall() // a second call while installing is ignored
  assert.equal(r.service.status().stt.server.installing?.phase, 'downloading')
  await waitFor('the install to start', () => order.length === 1)
  assert.deepEqual(fake.calls, ['stop'], 'the running server is stopped before its folder is replaced')
  assert.deepEqual(r.service.status().stt.server.installing, { phase: 'extracting', pct: -1 })

  resolved = { ok: true, path: BIN, source: 'managed', version: 'b1' }
  gate.resolve()
  await waitFor('the install to end', () => r.service.status().stt.server.installing === null)
  assert.deepEqual(order, [`install ${r.dir}`])
  assert.equal(r.service.status().stt.server.source, 'managed', 'the cached resolution was dropped')
  assert.equal(r.service.status().stt.server.installError, null)
})

test('a failing install records installError, and the next install clears it', async () => {
  let fail = true
  const r = rig({ install: async () => { if (fail) throw new Error('no space left'); return { path: BIN, version: '' } } })
  r.service.startServerInstall()
  await waitFor('the install to fail', () => r.service.status().stt.server.installing === null)
  assert.equal(r.service.status().stt.server.installError, 'no space left')
  fail = false
  r.service.startServerInstall()
  assert.equal(r.service.status().stt.server.installError, null)
  await waitFor('the install to end', () => r.service.status().stt.server.installing === null)
  assert.equal(r.service.status().stt.server.installError, null)
})

test('cancelServerInstall aborts the install and records no installError', async () => {
  const r = rig({
    install: (_dir, _p, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
  })
  assert.equal(r.service.cancelServerInstall(), false)
  r.service.startServerInstall()
  await waitFor('the install to start', () => r.calls.includes('stop'))
  assert.equal(r.service.cancelServerInstall(), true)
  await waitFor('the install to end', () => r.service.status().stt.server.installing === null)
  assert.equal(r.service.status().stt.server.installError, null)
})

test('removeServer is a 409 while an install runs', async () => {
  const gate = deferred<{ path: string; version: string }>()
  const r = rig({ install: () => gate.promise })
  try {
    r.service.startServerInstall()
    await assert.rejects(r.service.removeServer(), (e: unknown) => e instanceof VoiceError && e.status === 409 && e.code === 'install_in_progress')
  } finally {
    gate.resolve({ path: BIN, version: '' })
    await waitFor('the install to end', () => r.service.status().stt.server.installing === null)
  }
})

// ── transcription ──

function formEntries(form: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v
  return out
}

test('transcribe posts the audio to the server\'s /inference with the saved language and a json response format', async () => {
  const r = transcribeRig()
  r.cfg.speechToText.language = 'de'
  const out = await r.service.transcribe(AUDIO)
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0].url, `http://127.0.0.1:${PORT}/inference`)
  assert.equal(r.sent[0].method, 'POST')
  const file = r.sent[0].form.get('file') as File
  assert.equal(file.name, 'audio')
  assert.equal(await file.text(), 'RIFF')
  assert.deepEqual(formEntries(r.sent[0].form), { response_format: 'json', language: 'de' })
  assert.deepEqual(out, { contentType: 'application/json', body: JSON.stringify({ text: 'hello' }) })
  assert.deepEqual(r.launches, [{ binPath: BIN, modelPath: join(r.modelsDir, 'ggml-base.bin'), gpu: false }])
})

test('transcribe sends auto when the saved language is empty, and starts the server with the GPU option as saved', async () => {
  const r = transcribeRig()
  r.cfg.speechToText.language = ''
  r.cfg.speechToText.gpu = true
  await r.service.transcribe(AUDIO)
  assert.equal(formEntries(r.sent[0].form).language, 'auto')
  assert.equal(r.launches[0].gpu, true)
})

test('transcribe normalises a request language (en-US to en) and prefers it over the saved one', async () => {
  const r = transcribeRig()
  r.cfg.speechToText.language = 'de'
  await r.service.transcribe(AUDIO, { language: 'en-US' })
  await r.service.transcribe(AUDIO, { language: 'auto' })
  assert.deepEqual(r.sent.map((s) => formEntries(s.form).language), ['en', 'auto'])
})

test('transcribe sends prompt, temperature and translate only when given', async () => {
  const r = transcribeRig()
  await r.service.transcribe(AUDIO, { prompt: '', translate: false })
  assert.deepEqual(Object.keys(formEntries(r.sent[0].form)).sort(), ['language', 'response_format'])
  await r.service.transcribe(AUDIO, { prompt: 'Kubernetes, kubectl', temperature: 0, translate: true })
  assert.deepEqual(formEntries(r.sent[1].form), {
    response_format: 'json', language: 'auto', prompt: 'Kubernetes, kubectl', temperature: '0', translate: 'true',
  })
})

test('transcribe asks verbose_json for no language probabilities, and no other format', async () => {
  const r = transcribeRig(() => Response.json({ text: 'x', segments: [] }))
  await r.service.transcribe(AUDIO, { format: 'verbose_json' })
  assert.equal(formEntries(r.sent[0].form).no_language_probabilities, 'true')
  assert.equal(formEntries(r.sent[0].form).response_format, 'verbose_json')
  for (const format of ['json', 'text', 'srt', 'vtt'] as const) {
    await r.service.transcribe(AUDIO, { format })
    assert.equal('no_language_probabilities' in formEntries(r.sent.at(-1)!.form), false, format)
  }
})

test('an unknown language is a 400 invalid_language before anything is sent or started', async () => {
  const r = transcribeRig()
  for (const language of ['klingon', '']) {
    await assert.rejects(r.service.transcribe(AUDIO, { language }), (e: unknown) => e instanceof VoiceError && e.status === 400 && e.code === 'invalid_language', JSON.stringify(language))
  }
  assert.equal(r.sent.length, 0)
  assert.deepEqual(r.calls, [])
})

test('a json answer comes back with its text tidied to one line and its other fields kept', async () => {
  const r = transcribeRig(() => Response.json({ text: ' Hello there.\n [BLANK_AUDIO]\n How are you?', language: 'en' }))
  const out = await r.service.transcribe(AUDIO)
  assert.deepEqual(JSON.parse(out.body), { text: 'Hello there. How are you?', language: 'en' })
})

test('a 200 json answer that is not json is a 502 stt_failed', async () => {
  const r = transcribeRig(() => new Response('<html>oops</html>'))
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 502 && e.code === 'stt_failed')
})

test('text, srt and vtt answers pass through untouched with a text content type of our own', async () => {
  // whisper-server labels its plain text text/html, and a transcript is never markup.
  const r = transcribeRig(() => new Response(' <b>hi</b>\n', { headers: { 'Content-Type': 'text/html' } }))
  assert.deepEqual(await r.service.transcribe(AUDIO, { format: 'text' }), { contentType: 'text/plain; charset=utf-8', body: ' <b>hi</b>\n' })
  assert.equal((await r.service.transcribe(AUDIO, { format: 'srt' })).contentType, 'application/x-subrip; charset=utf-8')
  assert.equal((await r.service.transcribe(AUDIO, { format: 'vtt' })).contentType, 'text/vtt; charset=utf-8')
  assert.equal((await r.service.transcribe(AUDIO, { format: 'verbose_json' })).contentType, 'application/json')
})

test('transcribeText returns the tidied text and how long it took', async () => {
  const r = transcribeRig(() => Response.json({ text: ' one\n two' }))
  const out = await r.service.transcribeText(AUDIO, { language: 'en' })
  assert.equal(out.text, 'one two')
  assert.ok(Number.isInteger(out.tookMs) && out.tookMs >= 0)
  assert.equal(formEntries(r.sent[0].form).response_format, 'json')
})

test('a whisper 400 is a 400 invalid_audio and is not shown as a server error', async () => {
  const r = transcribeRig(() => new Response('Invalid request', { status: 400 }))
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => {
    assert.ok(e instanceof VoiceError)
    assert.equal(e.status, 400)
    assert.equal(e.code, 'invalid_audio')
    assert.doesNotMatch(e.message, /Invalid request/)
    return true
  })
  assert.equal(r.service.status().stt.error, null)
})

test('a whisper 500 is a 502 stt_failed with its reason, shown in status until the next success clears it', async () => {
  let ok = false
  const r = transcribeRig(() => (ok ? Response.json({ text: 'fine' }) : Response.json({ error: 'failed to process audio' }, { status: 500 })))
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => {
    assert.ok(e instanceof VoiceError)
    assert.equal(e.status, 502)
    assert.equal(e.code, 'stt_failed')
    assert.match(e.message, /failed to process audio/)
    return true
  })
  assert.match(r.service.status().stt.error ?? '', /failed to process audio/)
  ok = true
  await r.service.transcribe(AUDIO)
  assert.equal(r.service.status().stt.error, null)
})

test('a server that cannot be reached is a 502 stt_failed, and a failed start is a 503 stt_start_failed', async () => {
  const down = rig({ fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch })
  installModel(down, 'ggml-base.bin')
  await assert.rejects(down.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 502 && e.code === 'stt_failed' && /fetch failed/.test(e.message))

  const broken = rig({}, fakeServer({ useError: new WhisperStartError('whisper-server stopped while starting (exit code 3).', []) }))
  installModel(broken, 'ggml-base.bin')
  await assert.rejects(broken.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 503 && e.code === 'stt_start_failed')
  assert.match(broken.service.status().stt.error ?? '', /exit code 3/)
})

test('a transcription that times out is a 502 stt_failed saying it took too long', async () => {
  const r = rig({ fetch: (async () => { throw new DOMException('timed out', 'TimeoutError') }) as unknown as typeof fetch })
  installModel(r, 'ggml-base.bin')
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 502 && /too long/.test(e.message))
})

test('with no whisper-server the transcription is a 503 stt_unavailable that says the server is missing', async () => {
  const r = rig({ resolve: () => ({ ok: false, reason: 'none' }) })
  installModel(r, 'ggml-base.bin')
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 503 && e.code === 'stt_unavailable' && /no whisper-server/.test(e.message))
  assert.deepEqual(r.calls, [])
})

test('with a saved server path that has no file the 503 says so', async () => {
  const r = rig({ resolve: () => ({ ok: false, reason: 'custom_missing' }) })
  installModel(r, 'ggml-base.bin')
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 503 && /path saved in Settings/.test(e.message))
})

test('with no model the transcription is a 503 stt_unavailable that says the model is missing', async () => {
  const r = rig()
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 503 && e.code === 'stt_unavailable' && /no model/.test(e.message))
  assert.deepEqual(r.calls, [])
})

test('a caller that aborts is not a failure to show: the abort is rethrown and status().stt.error stays empty', async () => {
  const abort = new AbortController()
  const r = rig({
    fetch: (async () => {
      abort.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    }) as unknown as typeof fetch,
  })
  installModel(r, 'ggml-base.bin')
  await assert.rejects(r.service.transcribe(AUDIO, {}, abort.signal), (e: unknown) => e instanceof DOMException && e.name === 'AbortError')
  assert.equal(r.service.status().stt.error, null)
})

test('settings are read at each call: a model chosen in Settings is what the next transcription starts with', async () => {
  const r = transcribeRig()
  installModel(r, 'ggml-tiny.bin')
  await r.service.transcribe(AUDIO)
  r.cfg.speechToText.model = 'tiny'
  await r.service.transcribe(AUDIO)
  assert.deepEqual(r.launches.map((l) => l.modelPath), [join(r.modelsDir, 'ggml-base.bin'), join(r.modelsDir, 'ggml-tiny.bin')])
})

test('warm starts the server with the launch a transcription would use, and says nothing when it cannot', async () => {
  const r = transcribeRig()
  r.service.warm()
  await waitFor('the warm-up', () => r.launches.length === 1)
  assert.equal(r.launches[0].modelPath, join(r.modelsDir, 'ggml-base.bin'))

  const none = rig()
  none.service.warm()
  assert.deepEqual(none.calls, [])
})

test('stop aborts a running download and install and shuts whisper-server down for good', async () => {
  const signals: AbortSignal[] = []
  const hang = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
    if (signal) signals.push(signal)
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
  const r = rig({ download: (_u, _d, _p, signal) => hang(signal), install: (_d, _p, signal) => hang(signal) })
  r.service.startModelDownload('base')
  r.service.startServerInstall()
  await waitFor('both jobs to start', () => signals.length === 2)
  await r.service.stop()
  assert.ok(signals.every((s) => s.aborted))
  assert.ok(r.calls.includes('shutdown'))
  await waitFor('the jobs to end', () => r.service.status().stt.downloading === null && r.service.status().stt.server.installing === null)
})

// ── the Android app's build, threads, and the phone catalog ──

/** A rig as the packaged Android app runs it: its native-lib folder holds the bundled whisper-server, and the real
 *  resolver finds it (no `resolve` override, no saved serverPath, which would take precedence). */
function androidRig(perfCores: () => number | undefined) {
  const nativeDir = tmpDir('tllm-native-')
  writeFileSync(join(nativeDir, ANDROID_WHISPER_SERVER), 'elf')
  const r = rig({
    resolve: undefined, platform: 'android', arch: 'arm64', env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR: nativeDir }, perfCores,
    fetch: (async () => Response.json({ text: 'hi' })) as unknown as typeof fetch,
  })
  // `rig` spreads deps after its own resolve default, so an explicit undefined falls back to the real resolver.
  installModel(r, 'ggml-base.bin')
  r.cfg.speechToText.model = 'base'
  r.cfg.speechToText.serverPath = ''
  return { ...r, nativeDir }
}

test('on the Android app the bundled server runs without the GPU option even when it is saved on, and with the fast-core threads', async () => {
  const r = androidRig(() => 2)
  r.cfg.speechToText.gpu = true
  assert.equal(r.service.status().stt.server.source, 'bundled')
  await r.service.transcribe(AUDIO)
  assert.equal(r.launches.length, 1)
  assert.equal(r.launches[0].gpu, false)
  assert.equal(r.launches[0].threads, 2)
  assert.equal(r.launches[0].binPath, join(r.nativeDir, ANDROID_WHISPER_SERVER))
  const args = whisperServerArgs(r.launches[0], PORT)
  assert.ok(args.includes('-ng'))
  assert.equal(args[args.indexOf('-t') + 1], '2')
})

test('a CPU without fast and slow cores gets no thread count, and warm() starts the same launch', async () => {
  const r = androidRig(() => undefined)
  r.cfg.speechToText.gpu = true
  r.service.warm()
  await waitFor('the warm-up', () => r.launches.length === 1)
  assert.equal('threads' in r.launches[0], false)
  assert.ok(!whisperServerArgs(r.launches[0], PORT).includes('-t'))
})

test('the thread count is capped at 8', async () => {
  const r = androidRig(() => 12)
  await r.service.transcribe(AUDIO)
  assert.equal(r.launches[0].threads, 8)
})

test('a server that is not the bundled one follows the GPU option', async () => {
  for (const source of ['system', 'managed', 'custom'] as const) {
    const r = rig({
      resolve: () => ({ ok: true, path: BIN, source, version: '' }),
      perfCores: () => undefined,
      fetch: (async () => Response.json({ text: 'hi' })) as unknown as typeof fetch,
    })
    installModel(r, 'ggml-base.bin')
    r.cfg.speechToText.model = 'base'
    r.cfg.speechToText.gpu = true
    await r.service.transcribe(AUDIO)
    assert.equal(r.launches[0].gpu, true, source)
    assert.ok(!whisperServerArgs(r.launches[0], PORT).includes('-ng'), source)
    r.cfg.speechToText.gpu = false
    await r.service.transcribe(AUDIO)
    assert.equal(r.launches[1].gpu, false, source)
  }
})

test('the packaged Android app lists base-q5_1 first and recommended, and base is no longer recommended', () => {
  const r = rig({ platform: 'android', env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/data/app/lib' } })
  const { models } = r.service.status().stt
  assert.equal(models[0].id, 'base-q5_1')
  assert.equal(models[0].recommended, true)
  assert.equal(models.find((m) => m.id === 'base')?.recommended, undefined)
  assert.deepEqual(models.filter((m) => m.recommended).map((m) => m.id), ['base-q5_1'])
  assert.equal(models.length, WHISPER_MODELS.length)
})

test('Android without the packaged app\'s native-lib folder, and other platforms, keep base first and recommended', () => {
  for (const deps of [{ platform: 'android' as const, env: {} }, { platform: 'linux' as const, env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/x' } }, { platform: 'win32' as const }]) {
    const { models } = rig(deps).service.status().stt
    assert.equal(models[0].id, 'base')
    assert.equal(models[0].recommended, true)
    assert.deepEqual(models.filter((m) => m.recommended).map((m) => m.id), ['base'])
  }
})

test('liveDownload is null with no download, names the running one with bytes from its progress, and is null again after', async () => {
  const gate = deferred()
  const r = downloadRig(async (_url, dest, onProgress) => {
    onProgress?.({ phase: 'downloading', pct: 0.5 })
    await gate.promise
    writeFileSync(dest, 'weights')
  })
  assert.equal(r.service.liveDownload(), null)
  r.service.startModelDownload('base')
  const base = WHISPER_MODELS.find((m) => m.id === 'base')!
  assert.deepEqual(r.service.liveDownload(), { name: `Speech model ${base.label}`, received: Math.round(0.5 * base.sizeBytes), total: base.sizeBytes })
  gate.resolve()
  await waitFor('the download to finish', () => r.service.status().stt.downloading === null)
  assert.equal(r.service.liveDownload(), null)
})

test('liveDownload counts a negative progress as nothing received, and is null after a cancel', async () => {
  let report: ((p: { phase: 'downloading'; pct: number }) => void) | undefined
  const r = rig({
    download: (_u, _d, onProgress, signal) => new Promise<never>((_, reject) => {
      report = onProgress as typeof report
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
  })
  r.service.startModelDownload('tiny')
  await waitFor('the download to start', () => report !== undefined)
  report!({ phase: 'downloading', pct: -0.2 })
  const tiny = WHISPER_MODELS.find((m) => m.id === 'tiny')!
  assert.deepEqual(r.service.liveDownload(), { name: `Speech model ${tiny.label}`, received: 0, total: tiny.sizeBytes })
  report!({ phase: 'downloading', pct: 1 })
  assert.equal(r.service.liveDownload()?.received, tiny.sizeBytes)
  r.service.cancelModelDownload()
  await waitFor('the download to end', () => r.service.status().stt.downloading === null)
  assert.equal(r.service.liveDownload(), null)
})

// ── the Android app's GPU build, and falling back from it ──

/** A WhisperServer double whose `use` is `handler`'s: it is told each launch and the work, so a test can fail one
 *  launch and run another. Every launch it sees is recorded. */
function scriptedServer(handler: <T>(launch: WhisperLaunch, work: (port: number) => Promise<T>) => Promise<T>) {
  const launches: WhisperLaunch[] = []
  const server = {
    state: () => 'stopped' as const,
    error: () => null,
    launch: () => null,
    async use<T>(launch: WhisperLaunch, work: (port: number) => Promise<T>): Promise<T> {
      launches.push(launch)
      return handler(launch, work)
    },
    async stop() {},
    async shutdown() {},
  }
  return { server: server as unknown as WhisperServer, launches }
}

/** The Android app with its CPU server, and its Vulkan one beside it when `vk`. `onUse` decides each launch's fate. */
function gpuRig(vk: boolean, onUse?: <T>(launch: WhisperLaunch, work: (port: number) => Promise<T>) => Promise<T>, answer: () => Response = () => Response.json({ text: 'hi' })) {
  const nativeDir = tmpDir('tllm-native-')
  writeFileSync(join(nativeDir, ANDROID_WHISPER_SERVER), 'elf')
  if (vk) writeFileSync(join(nativeDir, ANDROID_WHISPER_SERVER_GPU), 'elf')
  const scripted = scriptedServer(onUse ?? ((_l, work) => work(PORT)))
  const r = rig({
    resolve: undefined, platform: 'android', arch: 'arm64', env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR: nativeDir },
    fetch: (async () => answer()) as unknown as typeof fetch,
  }, { ...scripted, calls: [] })
  installModel(r, 'ggml-base.bin')
  r.cfg.speechToText.model = 'base'
  r.cfg.speechToText.serverPath = ''
  return { ...r, launches: scripted.launches, cpu: join(nativeDir, ANDROID_WHISPER_SERVER), vkPath: join(nativeDir, ANDROID_WHISPER_SERVER_GPU) }
}

test('status gpu: Android bundled is true only with the Vulkan build, no bundled server is false, desktop is true', () => {
  assert.equal(gpuRig(false).service.status().stt.server.gpu, false)
  assert.equal(gpuRig(true).service.status().stt.server.gpu, true)

  // The Android app with nothing bundled (hint 'android').
  const empty = tmpDir('tllm-native-')
  const none = rig({ resolve: undefined, platform: 'android', arch: 'arm64', env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR: empty } })
  assert.equal(none.service.status().stt.server.source, null)
  assert.equal(none.service.status().stt.server.gpu, false)

  for (const source of ['managed', 'system', 'custom'] as const) {
    const r = rig({ resolve: () => ({ ok: true, path: BIN, source, version: '' }) })
    assert.equal(r.service.status().stt.server.gpu, true, source)
  }
  assert.equal(rig({ resolve: () => ({ ok: false, reason: 'none' }) }).service.status().stt.server.gpu, true)
  assert.equal(gpuRig(true).service.status().stt.server.gpuError, null)
})

test('launch on the Android pair: the option off or no Vulkan build is the CPU launch, the option with it is the Vulkan one', async () => {
  const off = gpuRig(true)
  off.cfg.speechToText.gpu = false
  await off.service.transcribe(AUDIO)
  assert.equal(off.launches[0].binPath, off.cpu)
  assert.equal(off.launches[0].gpu, false)

  const noVk = gpuRig(false)
  noVk.cfg.speechToText.gpu = true
  await noVk.service.transcribe(AUDIO)
  assert.equal(noVk.launches[0].binPath, noVk.cpu)
  assert.equal(noVk.launches[0].gpu, false)
  // The option changes nothing without the second build, so it must not make a different launch either.
  const noVkOff = gpuRig(false)
  noVkOff.cfg.speechToText.gpu = false
  await noVkOff.service.transcribe(AUDIO)
  assert.deepEqual({ ...noVk.launches[0], binPath: '', modelPath: '' }, { ...noVkOff.launches[0], binPath: '', modelPath: '' })
  assert.equal(noVk.launches[0].binPath.endsWith(ANDROID_WHISPER_SERVER), true)

  const on = gpuRig(true)
  on.cfg.speechToText.gpu = true
  await on.service.transcribe(AUDIO)
  assert.equal(on.launches[0].binPath, on.vkPath)
  assert.equal(on.launches[0].gpu, true)
  assert.ok(!whisperServerArgs(on.launches[0], PORT).includes('-ng'))
})

test('on desktop the launch uses the one binary and the GPU option as saved', async () => {
  for (const gpu of [true, false]) {
    const r = transcribeRig()
    r.cfg.speechToText.gpu = gpu
    await r.service.transcribe(AUDIO)
    assert.equal(r.launches[0].binPath, BIN)
    assert.equal(r.launches[0].gpu, gpu)
  }
})

/** A `use` that fails launches on `binPath` with `error`, and runs the work for the rest. */
function failingGpu(vkPath: () => string, error: () => unknown) {
  return <T,>(launch: WhisperLaunch, work: (port: number) => Promise<T>): Promise<T> =>
    launch.binPath === vkPath() ? Promise.reject(error()) : work(PORT)
}

test('a GPU build that fails to start falls back to the CPU build, says why in status, and is not tried again', async () => {
  let vk = ''
  const r = gpuRig(true, failingGpu(() => vk, () => new WhisperStartError('vulkan device lost', [])))
  vk = r.vkPath
  r.cfg.speechToText.gpu = true
  const out = await r.service.transcribe(AUDIO)
  assert.deepEqual(JSON.parse(out.body), { text: 'hi' })
  assert.deepEqual(r.launches.map((l) => [l.binPath, l.gpu]), [[r.vkPath, true], [r.cpu, false]])
  const { server } = r.service.status().stt
  assert.match(server.gpuError ?? '', /GPU/)
  assert.match(server.gpuError ?? '', /vulkan device lost/)

  await r.service.transcribe(AUDIO)
  assert.deepEqual(r.launches.slice(2).map((l) => l.binPath), [r.cpu])
})

test('a connection that broke (the process died mid-request) on the GPU build also falls back', async () => {
  let vk = ''
  const r = gpuRig(true, failingGpu(() => vk, () => new TypeError('fetch failed')))
  vk = r.vkPath
  r.cfg.speechToText.gpu = true
  assert.deepEqual(JSON.parse((await r.service.transcribe(AUDIO)).body), { text: 'hi' })
  assert.deepEqual(r.launches.map((l) => l.binPath), [r.vkPath, r.cpu])
  assert.match(r.service.status().stt.server.gpuError ?? '', /fetch failed/)
})

test('whisper refusing the audio on the GPU build is not a fallback: it surfaces and the GPU build stays in use', async () => {
  const r = gpuRig(true, undefined, () => new Response('Invalid request', { status: 400 }))
  r.cfg.speechToText.gpu = true
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 400)
  assert.equal(r.service.status().stt.server.gpuError, null)
  await assert.rejects(r.service.transcribe(AUDIO), VoiceError)
  assert.deepEqual(r.launches.map((l) => l.binPath), [r.vkPath, r.vkPath])
})

test('an aborted caller, with a TypeError or a TimeoutError, is not a GPU failure', async () => {
  for (const error of [() => new TypeError('fetch failed'), () => new DOMException('slow', 'TimeoutError')]) {
    let vk = ''
    const ac = new AbortController()
    const r = gpuRig(true, failingGpu(() => vk, () => { ac.abort(); return error() }))
    vk = r.vkPath
    r.cfg.speechToText.gpu = true
    await assert.rejects(r.service.transcribe(AUDIO, {}, ac.signal))
    assert.equal(r.launches.length, 1)
    assert.equal(r.service.status().stt.server.gpuError, null)
  }
})

test('a GPU build that gives no answer in time (a driver that hangs) falls back too, and is not tried again', async () => {
  let vk = ''
  const r = gpuRig(true, failingGpu(() => vk, () => new DOMException('The operation timed out', 'TimeoutError')))
  vk = r.vkPath
  r.cfg.speechToText.gpu = true
  assert.deepEqual(JSON.parse((await r.service.transcribe(AUDIO)).body), { text: 'hi' })
  assert.deepEqual(r.launches.map((l) => l.binPath), [r.vkPath, r.cpu])
  assert.match(r.service.status().stt.server.gpuError ?? '', /GPU/)

  // Left on the GPU build, every later recording would wait out the same timeout.
  await r.service.transcribe(AUDIO)
  assert.deepEqual(r.launches.slice(2).map((l) => l.binPath), [r.cpu])
})

test('whisper taking too long on the CPU build is still the timeout it was', async () => {
  const r = gpuRig(false, () => Promise.reject(new DOMException('slow', 'TimeoutError')))
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.status === 502 && /too long/.test(e.message))
  assert.equal(r.launches.length, 1)
})

test('a failure on the CPU build after a fallback is thrown as usual, with no further attempt', async () => {
  let vk = ''
  const r = gpuRig(true, (launch) => Promise.reject(new WhisperStartError(launch.binPath === vk ? 'gpu boom' : 'cpu boom', [])))
  vk = r.vkPath
  r.cfg.speechToText.gpu = true
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.code === 'stt_start_failed' && /cpu boom/.test(e.message))
  assert.deepEqual(r.launches.map((l) => l.binPath), [r.vkPath, r.cpu])
})

test('warm() on a GPU build that fails to start falls back to the CPU build and records why', async () => {
  let vk = ''
  const r = gpuRig(true, failingGpu(() => vk, () => new WhisperStartError('no vulkan', [])))
  vk = r.vkPath
  r.cfg.speechToText.gpu = true
  r.service.warm()
  await waitFor('the fallback launch', () => r.launches.length === 2)
  assert.deepEqual(r.launches.map((l) => l.binPath), [r.vkPath, r.cpu])
  assert.match(r.service.status().stt.server.gpuError ?? '', /no vulkan/)
})

test('switching the GPU option off clears the failure, and back on tries the GPU build again', async () => {
  let vk = ''
  const r = gpuRig(true, failingGpu(() => vk, () => new WhisperStartError('driver', [])))
  vk = r.vkPath
  r.cfg.speechToText.gpu = true
  await r.service.transcribe(AUDIO)
  assert.notEqual(r.service.status().stt.server.gpuError, null)
  r.cfg.speechToText.gpu = false
  assert.equal(r.service.status().stt.server.gpuError, null)
  r.cfg.speechToText.gpu = true
  r.launches.length = 0
  await r.service.transcribe(AUDIO)
  assert.deepEqual(r.launches.map((l) => l.binPath), [r.vkPath, r.cpu])
})

test('on desktop a start failure is not retried: it propagates as before', async () => {
  const scripted = scriptedServer(() => Promise.reject(new WhisperStartError('cannot start', [])))
  const r = rig({
    fetch: (async () => Response.json({ text: 'x' })) as unknown as typeof fetch,
  }, { ...scripted, calls: [] })
  installModel(r, 'ggml-base.bin')
  r.cfg.speechToText.model = 'base'
  r.cfg.speechToText.gpu = true
  await assert.rejects(r.service.transcribe(AUDIO), (e: unknown) => e instanceof VoiceError && e.code === 'stt_start_failed')
  assert.equal(scripted.launches.length, 1)
  assert.equal(r.service.status().stt.server.gpuError, null)
})
