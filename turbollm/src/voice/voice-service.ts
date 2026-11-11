// Speech-to-text: what the routes (api/voice-routes.ts, gateway/audio-endpoints.ts) ask of whisper.cpp.
//
// It owns the three things a transcription needs and the page shows: which whisper-server to run (whisper-binary.ts),
// which model (the models folder against whisper-catalog.ts), and the server process itself (whisper-server.ts). The
// install and the model download are jobs a page can leave and come back to; status() is what it reads, and it names
// no file path, so a caller who may only chat can read it too.
//
// Settings are read at each call, never cached: a model, the GPU option or the binary changed in Settings takes effect
// on the next transcription, which restarts whisper-server because its launch no longer matches.
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigStore } from '../config/config'
import type { SttModel, SttProgress, SttStatus, TranscribeResult, VoiceStatus } from '../contract/voice'
import { downloadFile, type ProvisionProgress } from '../engines/download'
import { packagedAndroidApp } from '../engines/zip-install'
import { emitInvalidation } from '../events/bus'
import { getSysInfo } from '../sysinfo/sysinfo'
import { withTimeout } from '../util/fetch-timeout'
import {
  installHint, installWhisperServer, removeWhisperServer, resolveWhisperServer, whisperModelsDir, whisperReleaseAsset,
  type ResolvedWhisperServer,
} from './whisper-binary'
import {
  AUTO_LANGUAGE, WHISPER_MODEL_FILE, WHISPER_MODEL_REPO, WHISPER_MODELS, isEnglishOnlyFile, normalizeLanguage, tidyTranscript,
  whisperCatalog, whisperCatalogModel,
} from './whisper-catalog'
import { WhisperServer, WhisperStartError, whisperThreads, type WhisperLaunch } from './whisper-server'

/** A refusal a route answers with as it is: `status`, and `{ code, message }`. */
export class VoiceError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502 | 503, readonly code: string, message: string) {
    super(message)
  }
}

/** The formats whisper-server answers in, which are OpenAI's `response_format` values. */
export const TRANSCRIPT_FORMATS = ['json', 'text', 'srt', 'verbose_json', 'vtt'] as const
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number]

export interface TranscribeOptions {
  /** A whisper language code or `auto`; the saved language when absent. */
  language?: string
  /** Text to bias the decoder with: names and terms the audio is likely to contain. */
  prompt?: string
  temperature?: number
  format?: TranscriptFormat
  /** Translate to English instead of transcribing. */
  translate?: boolean
}

export interface RawTranscript {
  contentType: string
  body: string
}

export interface VoiceServiceDeps {
  store: Pick<ConfigStore, 'read' | 'update' | 'dir'>
  server?: WhisperServer
  resolve?: typeof resolveWhisperServer
  install?: typeof installWhisperServer
  download?: typeof downloadFile
  fetch?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  /** The CPU's fast cores, when it has fast and slow ones (sysinfo's perfCores). */
  perfCores?: () => number | undefined
}

/** How long one transcription may take. whisper-server's own read and write timeouts are ten minutes; a recording
 *  long enough to need more is not a voice message. */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000

/** How long a resolved whisper-server is reused before the disk is asked again. status() is polled while the Voice
 *  settings are open, and resolving walks the install folder and the PATH. */
const RESOLVE_TTL_MS = 3000

const CONTENT_TYPES: Record<TranscriptFormat, string> = {
  json: 'application/json',
  verbose_json: 'application/json',
  // whisper-server labels plain text `text/html`. It is a transcript of whatever was said: never markup.
  text: 'text/plain; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
}

interface Job extends SttProgress {
  abort: AbortController
}

export class VoiceService {
  private readonly store: VoiceServiceDeps['store']
  private readonly server: WhisperServer
  private readonly deps: VoiceServiceDeps
  private resolved: { at: number; customPath: string; value: ResolvedWhisperServer } | null = null
  private installJob: Job | null = null
  private installError: string | null = null
  private downloadJob: (Job & { model: string }) | null = null
  private downloadError: { model: string; message: string } | null = null
  /** The last transcription's failure, shown until one succeeds. A failed start is the server's own error(). */
  private lastError: string | null = null

  constructor(deps: VoiceServiceDeps) {
    this.deps = deps
    this.store = deps.store
    this.server = deps.server ?? new WhisperServer({ dataDir: deps.store.dir(), onChange: announce })
  }

  // ── what the page reads ──

  status(): VoiceStatus {
    const cfg = this.store.read().speechToText
    const server = this.resolveServer()
    const models = this.models()
    const model = activeModel(models, cfg.model)
    const hint = installHint(this.deps.platform, this.deps.arch, this.deps.env)
    const stt: SttStatus = {
      available: server.ok && model !== '',
      state: this.server.state(),
      error: this.server.error() ?? this.lastError,
      server: {
        source: server.ok ? server.source : null,
        version: server.ok ? server.version : '',
        installable: hint === null,
        hint,
        customMissing: !server.ok && server.reason === 'custom_missing',
        installing: this.installJob ? { phase: this.installJob.phase, pct: this.installJob.pct } : null,
        installError: this.installError,
      },
      model,
      models,
      downloading: this.downloadJob ? { model: this.downloadJob.model, phase: this.downloadJob.phase, pct: this.downloadJob.pct } : null,
      downloadError: this.downloadError,
    }
    return { stt }
  }

  /** Whether a recording can be transcribed right now. */
  available(): boolean {
    return this.resolveServer().ok && activeModel(this.models(), this.store.read().speechToText.model) !== ''
  }

  // ── transcription ──

  /** Start whisper-server now, so it has its model loaded by the time a recording ends. Nothing to report: a failed
   *  start is in status(), and the transcription that follows fails with the same reason. */
  warm(): void {
    let launch: WhisperLaunch
    try {
      launch = this.launch()
    } catch {
      return
    }
    this.server.use(launch, async () => {}).catch(() => {})
  }

  /** The transcript of `audio` as text, for the chat box. */
  async transcribeText(audio: Blob, opts: Pick<TranscribeOptions, 'language' | 'prompt'> = {}, signal?: AbortSignal): Promise<TranscribeResult> {
    const started = Date.now()
    const raw = await this.transcribe(audio, { ...opts, format: 'json' }, signal)
    return { text: (JSON.parse(raw.body) as { text: string }).text, tookMs: Date.now() - started }
  }

  /** The transcript of `audio` in `opts.format`, as whisper-server wrote it (the `json` form with its text tidied).
   *  `audio` is a WAV, MP3, FLAC or Ogg Vorbis file at any sample rate: whisper-server decodes and resamples it. */
  async transcribe(audio: Blob, opts: TranscribeOptions = {}, signal?: AbortSignal): Promise<RawTranscript> {
    const launch = this.launch()
    const format = opts.format ?? 'json'
    const language = opts.language === undefined ? this.store.read().speechToText.language : normalizeLanguage(opts.language)
    if (language === null) throw new VoiceError(400, 'invalid_language', `whisper does not know the language "${opts.language}". Use a code such as en, de or pt, or auto.`)

    const form = new FormData()
    form.append('file', audio, 'audio')
    form.append('response_format', format)
    form.append('language', language || AUTO_LANGUAGE)
    if (opts.prompt) form.append('prompt', opts.prompt)
    if (opts.temperature !== undefined) form.append('temperature', String(opts.temperature))
    if (opts.translate) form.append('translate', 'true')
    // verbose_json would otherwise run a second pass over the audio just to rank every language it might be.
    if (format === 'verbose_json') form.append('no_language_probabilities', 'true')

    try {
      const answer = await this.server.use(launch, async (port) => {
        const res = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:${port}/inference`, {
          method: 'POST', body: form, signal: withTimeout(signal, TRANSCRIBE_TIMEOUT_MS),
        })
        return { status: res.status, body: await res.text() }
      })
      if (answer.status !== 200) throw refusalFrom(answer.status, answer.body)
      this.setLastError(null)
      return { contentType: CONTENT_TYPES[format], body: format === 'json' ? tidyJson(answer.body) : answer.body }
    } catch (e) {
      if (signal?.aborted) throw e // the caller went away: not a failure to show
      const failure = asVoiceError(e)
      // What the user sent (a file whisper cannot read) is theirs to fix; only a failure of the server is shown.
      if (failure.status >= 500) this.setLastError(failure.message)
      throw failure
    }
  }

  /** What to start whisper-server with, or the refusal that says what is missing. */
  private launch(): WhisperLaunch {
    const cfg = this.store.read().speechToText
    const server = this.resolveServer()
    if (!server.ok) {
      throw server.reason === 'custom_missing'
        ? new VoiceError(503, 'stt_unavailable', 'The whisper-server path saved in Settings → Voice does not exist.')
        : new VoiceError(503, 'stt_unavailable', 'Speech-to-text is not set up: no whisper-server was found. Set it up in Settings → Voice.')
    }
    const model = activeModel(this.models(), cfg.model)
    if (!model) throw new VoiceError(503, 'stt_unavailable', 'Speech-to-text has no model yet. Download one in Settings → Voice.')
    const threads = whisperThreads({ perfCores: (this.deps.perfCores ?? (() => getSysInfo().perfCores))() })
    return {
      binPath: server.path,
      modelPath: this.modelPath(model),
      // The build inside the Android app has no GPU backend: the option, saved from another machine's habits, would
      // only make it a different launch.
      gpu: cfg.gpu && server.source !== 'bundled',
      ...(threads ? { threads } : {}),
    }
  }

  /** The model download in progress, as a download the Android app's poll counts as work (api/active-work.ts): a
   *  speech model takes minutes on a phone's connection, and the app is left meanwhile. */
  liveDownload(): { name: string; received: number; total: number } | null {
    const job = this.downloadJob
    const model = job ? whisperCatalogModel(job.model) : undefined
    if (!job || !model) return null
    return { name: `Speech model ${model.label}`, received: Math.round(Math.max(0, job.pct) * model.sizeBytes), total: model.sizeBytes }
  }

  // ── the whisper-server install ──

  /** Install whisper.cpp's release build. Returns at once; status().stt.server.installing follows it. */
  startServerInstall(): void {
    if (this.installJob) return
    if (installHint(this.deps.platform, this.deps.arch, this.deps.env) !== null || !whisperReleaseAsset(this.deps.platform, this.deps.arch)) {
      throw new VoiceError(400, 'not_installable', 'whisper.cpp publishes no whisper-server build that can be installed on this machine.')
    }
    const job: Job = { phase: 'downloading', pct: 0, abort: new AbortController() }
    this.installJob = job
    this.installError = null
    announce()
    void (async () => {
      try {
        // The install replaces the folder a managed whisper-server runs from, which Windows refuses while it runs.
        await this.server.stop()
        await (this.deps.install ?? installWhisperServer)(this.store.dir(), (p) => this.progress(job, p), job.abort.signal)
      } catch (e) {
        if (!job.abort.signal.aborted) this.installError = messageOf(e)
      } finally {
        this.installJob = null
        this.resolved = null
        announce()
      }
    })()
  }

  cancelServerInstall(): boolean {
    if (!this.installJob) return false
    this.installJob.abort.abort()
    return true
  }

  /** Remove the managed install. A whisper-server found elsewhere is not TurboLLM's to delete. */
  async removeServer(): Promise<void> {
    if (this.installJob) throw new VoiceError(409, 'install_in_progress', 'whisper-server is being installed.')
    if (this.server.launch()) await this.server.stop()
    await removeWhisperServer(this.store.dir())
    this.resolved = null
    announce()
  }

  // ── models ──

  /** Download a catalog model. Returns at once; status().stt.downloading follows it. One at a time. */
  startModelDownload(id: string): void {
    const model = whisperCatalogModel(id)
    if (!model) throw new VoiceError(404, 'not_found', `No whisper model is called "${id}".`)
    if (this.downloadJob?.model === id) return
    if (this.downloadJob) throw new VoiceError(409, 'download_in_progress', 'Another whisper model is downloading. Wait for it, or cancel it first.')
    const dir = whisperModelsDir(this.store.dir())
    const dest = join(dir, model.file)
    if (isFile(dest)) return
    const job = { model: id, phase: 'downloading' as const, pct: 0, abort: new AbortController() }
    this.downloadJob = job
    this.downloadError = null
    announce()
    void (async () => {
      try {
        mkdirSync(dir, { recursive: true })
        const url = `${hfBaseUrl(this.deps.env)}/${WHISPER_MODEL_REPO}/resolve/main/${model.file}`
        await (this.deps.download ?? downloadFile)(url, dest, (p) => this.progress(job, p), job.abort.signal, fetch, { expectedSha256: model.sha256 })
        // The first model, or the replacement for one that is gone, becomes the one in use: otherwise a fresh setup
        // needed a second step that only ever has one answer.
        const chosen = this.store.read().speechToText.model
        if (!this.models().some((m) => m.installed && m.id === chosen)) this.store.update((c) => { c.speechToText.model = id })
      } catch (e) {
        if (!job.abort.signal.aborted) this.downloadError = { model: id, message: messageOf(e) }
      } finally {
        this.downloadJob = null
        announce()
      }
    })()
  }

  cancelModelDownload(): boolean {
    if (!this.downloadJob) return false
    this.downloadJob.abort.abort()
    return true
  }

  /** Delete an installed model's file. The one in use is stopped first. */
  async deleteModel(id: string): Promise<void> {
    const model = this.models().find((m) => m.id === id)
    if (!model?.installed) throw new VoiceError(404, 'not_found', `The whisper model "${id}" is not installed.`)
    const path = this.modelPath(id)
    if (this.server.launch()?.modelPath === path) await this.server.stop()
    await rm(path, { force: true })
    if (this.store.read().speechToText.model === id) this.store.update((c) => { c.speechToText.model = '' })
    announce()
  }

  /** Stop whisper-server for good: the daemon is shutting down. */
  async stop(): Promise<void> {
    this.installJob?.abort.abort()
    this.downloadJob?.abort.abort()
    await this.server.shutdown()
  }

  // ── internals ──

  /** The catalog with what is installed marked, then the ggml files in the models folder that it does not list. */
  private models(): SttModel[] {
    const onDisk = new Map<string, number>()
    try {
      const dir = whisperModelsDir(this.store.dir())
      for (const name of readdirSync(dir)) {
        if (!WHISPER_MODEL_FILE.test(name)) continue
        try {
          const st = statSync(join(dir, name))
          if (st.isFile()) onDisk.set(name, st.size)
        } catch {
          /* gone between the listing and the stat */
        }
      }
    } catch {
      /* no models folder yet */
    }
    const out: SttModel[] = whisperCatalog(packagedAndroidApp(this.deps.platform, this.deps.env)).map((m) => ({
      id: m.id, label: m.label, sizeBytes: m.sizeBytes, multilingual: m.multilingual, note: m.note,
      installed: onDisk.has(m.file), ...(m.recommended ? { recommended: true } : {}),
    }))
    const listed = new Set(WHISPER_MODELS.map((m) => m.file))
    for (const [name, size] of [...onDisk].sort(([a], [b]) => a.localeCompare(b))) {
      if (listed.has(name)) continue
      out.push({ id: name, label: name, sizeBytes: size, multilingual: !isEnglishOnlyFile(name), note: '', installed: true, custom: true })
    }
    return out
  }

  /** The file behind a model id models() returned: a catalog entry's, or the id itself for a file it does not list
   *  (those ids are file names of the one shape WHISPER_MODEL_FILE allows). */
  private modelPath(id: string): string {
    return join(whisperModelsDir(this.store.dir()), whisperCatalogModel(id)?.file ?? id)
  }

  private resolveServer(): ResolvedWhisperServer {
    const customPath = this.store.read().speechToText.serverPath
    const cached = this.resolved
    if (cached && cached.customPath === customPath && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.value
    const value = (this.deps.resolve ?? resolveWhisperServer)({
      dataDir: this.store.dir(), customPath, platform: this.deps.platform, env: this.deps.env,
    })
    this.resolved = { at: Date.now(), customPath, value }
    return value
  }

  private progress(job: SttProgress, p: ProvisionProgress): void {
    job.phase = p.phase
    job.pct = p.pct
    announce()
  }

  private setLastError(message: string | null): void {
    if (this.lastError === message) return
    this.lastError = message
    announce()
  }
}

/** The model a transcription uses: the saved one when it is installed, else the first installed in the list's order
 *  (the catalog's, recommended first). A saved model that was deleted by hand must not leave voice input dead while
 *  another model sits installed. '' when none is. */
export function activeModel(models: readonly SttModel[], saved: string): string {
  const installed = models.filter((m) => m.installed)
  return (installed.find((m) => m.id === saved) ?? installed[0])?.id ?? ''
}

/** whisper-server's `json` answer with its text as one tidy line. */
function tidyJson(body: string): string {
  try {
    const parsed = JSON.parse(body) as { text?: unknown }
    return JSON.stringify({ ...parsed, text: tidyTranscript(typeof parsed.text === 'string' ? parsed.text : '') })
  } catch {
    throw new VoiceError(502, 'stt_failed', 'whisper-server answered with something that is not a transcript.')
  }
}

/** whisper-server's refusal as ours: 400 for audio it cannot read, 500 with `{"error": "..."}` for a decode that
 *  failed. */
function refusalFrom(status: number, body: string): VoiceError {
  let reason = ''
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string') reason = parsed.error
  } catch {
    reason = body.trim().slice(0, 200)
  }
  if (status >= 400 && status < 500) {
    // Its HTTP library replaces every 400's body with the bare text "Invalid request", which says nothing more.
    const detail = reason && reason !== 'Invalid request' ? ` (${reason})` : ''
    return new VoiceError(400, 'invalid_audio', `whisper could not read this audio${detail}. Send a WAV, MP3, FLAC or Ogg Vorbis file.`)
  }
  return new VoiceError(502, 'stt_failed', `whisper could not transcribe this audio${reason ? `: ${reason}` : '.'}`)
}

function asVoiceError(e: unknown): VoiceError {
  if (e instanceof VoiceError) return e
  if (e instanceof WhisperStartError) return new VoiceError(503, 'stt_start_failed', e.message)
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new VoiceError(502, 'stt_failed', 'whisper took too long to transcribe this audio.')
  }
  return new VoiceError(502, 'stt_failed', `whisper-server did not answer: ${messageOf(e)}`)
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Hugging Face's origin, overridable as downloads.ts's is (TURBOLLM_HF_BASE: the Docker E2E harness's fixture server). */
function hfBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TURBOLLM_HF_BASE?.trim()
  return override ? override.replace(/\/+$/, '') : 'https://huggingface.co'
}

/** The page's voice status changed: tell the pages that show it (events/bus.ts; keys only, they refetch). */
function announce(): void {
  emitInvalidation('voice')
}
