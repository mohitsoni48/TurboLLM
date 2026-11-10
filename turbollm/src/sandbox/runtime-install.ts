// The Python sandbox runtime (GitHub #52): Deno plus Pyodide and 15 wheels, downloaded once into
// `<config dir>/runtimes/sandbox/` when the user turns the sandbox on. Every file is checked against the size and sha256
// pinned in runtime-manifest.ts, never against anything served next to it.
//
// Install is all or nothing: files go into a hidden `.sandbox-<id>.stage` folder beside the runtime, the Deno zip is
// unpacked there (pure Node, no extraction tool to spawn), a marker is written last, and only then is the folder renamed
// into place. A crash, a failed hash or Cancel leaves the previous runtime (or nothing) and a stage folder the next
// install sweeps. No pause and resume: 75 MB restarts quickly, and the engine downloader this reuses has no Range support.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { emitInvalidation } from '../events/bus'
import { downloadFile, renameWithRetry, stripMacOsQuarantine } from '../engines/download'
import { extractZipAll } from '../engines/zip-reader'
import { DENO_VERSION, DENO_ZIPS, PYODIDE_FILES, PYODIDE_VERSION, type RuntimeFile } from './runtime-manifest'
import { sandboxSupported } from './gate'

/** Written last inside the runtime folder; its presence (with matching versions) is what "installed" means. */
export const RUNTIME_MARKER = '.turbollm-sandbox-installed.json'
/** The invalidation key a change to the runtime's state is announced under. */
export const SANDBOX_RUNTIME_KEY = 'sandboxRuntime'

const STAGE_PREFIX = '.sandbox-'
const TRASH_PREFIX = '.sandbox-trash-'

export interface RuntimeFiles {
  deno: RuntimeFile
  pyodide: readonly RuntimeFile[]
}

/** The pinned files for this machine, or null where no Deno build exists (Android, 32-bit, other platforms). */
export function runtimeFilesFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): RuntimeFiles | null {
  if (!sandboxSupported(platform)) return null
  const deno = DENO_ZIPS[`${platform}-${arch}`]
  return deno ? { deno, pyodide: PYODIDE_FILES } : null
}

export interface SandboxRuntimeView {
  /** False on a platform with no pinned Deno build; nothing else applies then. */
  supported: boolean
  installed: { deno: string; pyodide: string } | null
  /** What an install downloads, and roughly what it then takes on disk (Deno unzips to about 2.3 times its zip). */
  downloadBytes: number
  diskBytes: number
  job: {
    state: 'idle' | 'running' | 'error'
    /** Bytes of the pinned files received so far, against `downloadBytes`. */
    doneBytes: number
    error?: { code: string; message: string }
  }
}

interface Marker {
  deno: string
  pyodide: string
}

export class SandboxRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export interface SandboxRuntimeOptions {
  /** The folder holding `sandbox/` (`<config dir>/runtimes`). */
  runtimesDir: () => string
  files?: RuntimeFiles | null
  fetchImpl?: typeof fetch
  announce?: (key: string) => void
  /** Free bytes on the volume holding `dir`; statfs by default. */
  freeBytes?: (dir: string) => number
  platform?: NodeJS.Platform
}

export class SandboxRuntime {
  private readonly files: RuntimeFiles | null
  private readonly fetchImpl: typeof fetch
  private readonly announce: (key: string) => void
  private readonly freeBytes: (dir: string) => number
  private readonly platform: NodeJS.Platform
  private job: SandboxRuntimeView['job'] = { state: 'idle', doneBytes: 0 }
  private controller: AbortController | null = null
  private running: Promise<void> | null = null

  constructor(private readonly opts: SandboxRuntimeOptions) {
    this.platform = opts.platform ?? process.platform
    this.files = opts.files === undefined ? runtimeFilesFor(this.platform) : opts.files
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.announce = opts.announce ?? emitInvalidation
    this.freeBytes = opts.freeBytes ?? ((dir) => { const s = statfsSync(dir); return s.bavail * s.bsize })
  }

  /** `<config dir>/runtimes/sandbox`, where Deno and Pyodide live once installed. */
  dir(): string {
    return join(this.opts.runtimesDir(), 'sandbox')
  }

  /** The Deno binary inside an installed runtime. */
  denoPath(): string {
    return join(this.dir(), `deno-${DENO_VERSION}`, this.platform === 'win32' ? 'deno.exe' : 'deno')
  }

  /** Pyodide's indexURL inside an installed runtime. */
  pyodideDir(): string {
    return join(this.dir(), `pyodide-${PYODIDE_VERSION}`)
  }

  view(): SandboxRuntimeView {
    const download = this.files ? this.files.deno.size + sum(this.files.pyodide) : 0
    const disk = this.files ? Math.round(this.files.deno.size * 2.3) + sum(this.files.pyodide) : 0
    return { supported: this.files !== null, installed: this.installed(), downloadBytes: download, diskBytes: disk, job: { ...this.job } }
  }

  private installed(): Marker | null {
    try {
      const m = JSON.parse(readFileSync(join(this.dir(), RUNTIME_MARKER), 'utf8')) as Marker
      return m.deno === DENO_VERSION && m.pyodide === PYODIDE_VERSION && existsSync(this.denoPath()) ? { deno: m.deno, pyodide: m.pyodide } : null
    } catch {
      return null
    }
  }

  /** Starts an install unless one is running or the runtime is already in place. Resolves when it settles; callers
   *  that answer at once (the route) do not await it. */
  install(): Promise<void> {
    if (!this.files) throw new SandboxRuntimeError('sandbox_unsupported', 'There is no sandbox runtime for this platform.')
    if (this.running) return this.running
    if (this.installed()) return Promise.resolve()
    const files = this.files
    this.controller = new AbortController()
    this.setJob({ state: 'running', doneBytes: 0 })
    this.running = this.run(files, this.controller.signal)
      .then(() => this.setJob({ state: 'idle', doneBytes: 0 }))
      .catch((e: unknown) => this.setJob({ state: 'error', doneBytes: 0, error: describe(e) }))
      .finally(() => { this.running = null; this.controller = null })
    return this.running
  }

  /** Cancels a running install; the previous state stays as it was. */
  cancel(): boolean {
    if (!this.controller) return false
    this.controller.abort()
    return true
  }

  /** Deletes the runtime. The folder is renamed aside first, so the runtime is gone at once and a slow delete never
   *  holds the daemon; the trash is removed in the background and swept by the next install if that fails. */
  async remove(): Promise<boolean> {
    if (this.running) throw new SandboxRuntimeError('sandbox_runtime_busy', 'Wait for the download to finish or cancel it first.')
    if (!existsSync(this.dir())) return false
    const trash = join(this.opts.runtimesDir(), `${TRASH_PREFIX}${randomUUID().slice(0, 8)}`)
    await renameWithRetry(this.dir(), trash)
    this.setJob({ state: 'idle', doneBytes: 0 })
    void rm(trash, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    return true
  }

  private async run(files: RuntimeFiles, signal: AbortSignal): Promise<void> {
    const runtimes = this.opts.runtimesDir()
    mkdirSync(runtimes, { recursive: true })
    sweepLeftovers(runtimes)
    const download = files.deno.size + sum(files.pyodide)
    const need = Math.round(download + files.deno.size * 2.5 * 1.1)
    const free = this.freeBytes(runtimes)
    if (free < need) {
      throw new SandboxRuntimeError('insufficient_disk', `The sandbox needs about ${mb(need)} MB free during the download; ${mb(free)} MB is free.`)
    }
    const stage = join(runtimes, `${STAGE_PREFIX}${randomUUID().slice(0, 8)}.stage`)
    const out = join(stage, 'sandbox')
    const denoDir = join(out, `deno-${DENO_VERSION}`)
    const pyDir = join(out, `pyodide-${PYODIDE_VERSION}`)
    mkdirSync(denoDir, { recursive: true })
    mkdirSync(pyDir, { recursive: true })
    try {
      let done = 0
      const fetchFile = async (f: RuntimeFile, dest: string) => {
        const before = done
        await downloadFile(f.url, dest, (p) => this.setProgress(before + Math.round(p.pct * f.size)), signal, exactSize(this.fetchImpl, f), { expectedSha256: f.sha256 })
        done = before + f.size
        this.setProgress(done)
      }
      const zip = join(stage, files.deno.path)
      await fetchFile(files.deno, zip)
      await extractZipAll(await readFile(zip), denoDir)
      rmSync(zip, { force: true })
      const bin = join(denoDir, this.platform === 'win32' ? 'deno.exe' : 'deno')
      if (!existsSync(bin)) throw new SandboxRuntimeError('extract_failed', 'The Deno download did not contain the deno binary.')
      if (this.platform !== 'win32') chmodSync(bin, 0o755)
      if (this.platform === 'darwin') stripMacOsQuarantine(denoDir)
      for (const f of files.pyodide) {
        throwIfAborted(signal)
        await fetchFile(f, join(pyDir, f.path))
      }
      throwIfAborted(signal)
      // Deno reads pyodide.asm.js as an ES module unless the folder says otherwise, and it is CommonJS.
      writeFileSync(join(pyDir, 'package.json'), '{"type":"commonjs"}\n')
      writeFileSync(join(out, RUNTIME_MARKER), JSON.stringify({ deno: DENO_VERSION, pyodide: PYODIDE_VERSION } satisfies Marker))
      // An older or half-removed runtime moves aside first, so the rename below never lands inside it.
      if (existsSync(this.dir())) renameSync(this.dir(), join(runtimes, `${TRASH_PREFIX}${randomUUID().slice(0, 8)}`))
      await renameWithRetry(out, this.dir())
    } finally {
      void rm(stage, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  }

  private setJob(job: SandboxRuntimeView['job']): void {
    this.job = job
    this.announce(SANDBOX_RUNTIME_KEY)
  }

  /** Announced per tenth of the download, not per chunk. */
  private setProgress(doneBytes: number): void {
    const total = this.files ? this.files.deno.size + sum(this.files.pyodide) : 1
    const tenth = (b: number) => Math.floor((b / total) * 10)
    const announce = tenth(doneBytes) !== tenth(this.job.doneBytes)
    this.job = { ...this.job, doneBytes }
    if (announce) this.announce(SANDBOX_RUNTIME_KEY)
  }
}

/** A fetch that refuses a body other than the pinned size: a declared length that differs is refused before a byte is
 *  written, and a body that runs past it is cut off, so a wrong file can never fill the disk before its hash fails.
 *  A compressed response (jsdelivr sends the .wasm with Content-Encoding) declares its compressed length while fetch
 *  hands over the decoded bytes, so only an uncompressed length is compared; the cap and the hash cover the rest. */
function exactSize(fetchImpl: typeof fetch, f: RuntimeFile): typeof fetch {
  return async (input, init) => {
    const res = await fetchImpl(input, init)
    const declared = res.headers.get('content-length')
    const encoding = (res.headers.get('content-encoding') ?? 'identity').toLowerCase()
    if (declared !== null && encoding === 'identity' && Number(declared) !== f.size) {
      await res.body?.cancel()
      throw new SandboxRuntimeError('size_mismatch', `${f.path}: expected ${f.size} bytes, the server announced ${declared}.`)
    }
    if (!res.body) return res
    let seen = 0
    const capped = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > f.size) controller.error(new SandboxRuntimeError('size_mismatch', `${f.path}: more than the expected ${f.size} bytes.`))
        else controller.enqueue(chunk)
      },
    }))
    return new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}

/** Stage and trash folders left by a crash or a delete that failed. */
function sweepLeftovers(runtimes: string): void {
  for (const name of readdirSync(runtimes)) {
    if (name.startsWith(STAGE_PREFIX)) void rm(join(runtimes, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The download was cancelled.', 'AbortError')
}

function describe(e: unknown): { code: string; message: string } {
  if (e instanceof SandboxRuntimeError) return { code: e.code, message: e.message }
  if (e instanceof Error && e.name === 'AbortError') return { code: 'cancelled', message: 'The download was cancelled.' }
  const message = e instanceof Error ? e.message : String(e)
  if (message.startsWith('checksum_failed')) return { code: 'checksum_failed', message: 'A downloaded file did not match its pinned SHA-256, so nothing was installed.' }
  return { code: 'download_failed', message }
}

const sum = (files: readonly RuntimeFile[]) => files.reduce((n, f) => n + f.size, 0)
const mb = (bytes: number) => Math.ceil(bytes / 1e6)
