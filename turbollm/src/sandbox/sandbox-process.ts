// One sandbox process (GitHub #52): Deno running sandbox-host.mjs, which runs Pyodide from the installed runtime.
//
// The wall is Deno's permission model, launched as option A of the #313 follow-up (verified on Linux, macOS and
// Windows against the 12 escape attacks of #52): no --allow-net, no --allow-env, no --allow-write, no --allow-run, no
// FFI, read access to the Pyodide folder only, and no config, npm or remote module lookups. `--unstable-detect-cjs`
// lets Deno load pyodide.asm.js (CommonJS) with config discovery off; without it Pyodide does not load at all. Deno is
// pinned (runtime-manifest.ts), and every Deno upgrade re-runs the escape tests.
//
// The process is hostile, its stdout included. Every frame is checked (sandbox-frames.ts and checkResult below); a
// frame out of turn, a bad field, a payload that does not add up, or bytes after the process said it failed all kill
// it. "Run finished" is just another frame: the run's time limit is this file's own timer, never the host's word.
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { killTetheredTree, spawnTethered } from '../util/tether'
import { encodeFrame, FrameReader, FrameViolation, type Frame } from './sandbox-frames'

/** Pages of 64 KiB: 8192 is 512 MB of WebAssembly memory, Python's whole heap. A run past it gets a MemoryError. */
export const WASM_MAX_PAGES = 8192
/** How long a cold start may take before the process is killed: measured 9–15 s in CI, up to 55 s on a laptop low on
 *  free memory (#52). */
export const START_TIMEOUT_MS = 120_000
/** How long one run may take, from the moment it is sent (start-up not counted). */
export const RUN_TIMEOUT_MS = 60_000

const TEXT_LIMIT = 64 * 1024 + 64 // the host's cap plus its "[output cut off]" line
const MAX_FILES = 20
const MAX_FILE = 25 * 1024 * 1024
const MAX_TOTAL = 100 * 1024 * 1024
const MAX_SKIPPED = 200
const MAX_RESULT_PAYLOAD = MAX_TOTAL + 2 * TEXT_LIMIT
/** A name the host may give an output. Only ever a label: outputs are stored under ids the daemon makes up. */
const OUTPUT_NAME = /^[A-Za-z0-9._ ()-]{1,128}$/

/** The host script, beside this module: src/sandbox/ under tsx, dist/ once built (package.json's build copies it). */
export function sandboxHostPath(): string {
  return fileURLToPath(new URL('./sandbox-host.mjs', import.meta.url))
}

export type SandboxFailure = 'start_failed' | 'timeout' | 'crashed' | 'violation' | 'busy'

export class SandboxError extends Error {
  constructor(readonly code: SandboxFailure, message: string) {
    super(message)
  }
}

export interface SandboxFile {
  name: string
  bytes: Buffer
}

export interface SandboxRunResult {
  ok: boolean
  /** The Python error's last lines when `ok` is false. */
  error?: string
  stdout: string
  stderr: string
  files: SandboxFile[]
  /** New files the host did not send back: a type outside the allowed ones, or over a limit. */
  skipped: string[]
}

export interface SandboxProcessOptions {
  denoPath: string
  pyodideDir: string
  /** Deno's working folder: the runtime folder, which only the daemon writes. */
  cwd: string
  /** Deno's own cache folder (DENO_DIR), private to the sandbox. */
  denoDir: string
  hostPath?: string
  startTimeoutMs?: number
  runTimeoutMs?: number
  /** Tests start a stand-in host; production always goes through the tether. */
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
}

/** Deno's command line. Exported for the escape suite, which must test exactly what the daemon runs. */
export function denoArgs(pyodideDir: string, hostPath: string): string[] {
  return [
    'run', '--no-prompt', '--no-config', '--no-npm', '--no-remote', '--unstable-detect-cjs',
    `--allow-read=${pyodideDir}`,
    `--v8-flags=--wasm-max-mem-pages=${WASM_MAX_PAGES}`,
    hostPath, pyodideDir,
  ]
}

/** The whole environment Deno gets: none of the daemon's (no keys, no tokens, no paths), only what Deno itself needs. */
export function denoEnv(denoDir: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DENO_DIR: denoDir, DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }
  // Windows system DLLs look up their own folder through it.
  if (platform === 'win32') env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return env
}

type State = 'starting' | 'idle' | 'running' | 'dead'

export class SandboxProcess {
  private child: ChildProcess | null = null
  private state: State = 'starting'
  private reader = new FrameReader(MAX_RESULT_PAYLOAD)
  private waiter: { resolve: (f: Frame) => void; reject: (e: SandboxError) => void } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private exitListeners: Array<() => void> = []
  /** Why the process died, for the run or start that was waiting. */
  private death: SandboxError | null = null
  private exited: Promise<void> = Promise.resolve()

  constructor(private readonly opts: SandboxProcessOptions) {}

  get alive(): boolean {
    return this.state !== 'dead'
  }

  get busy(): boolean {
    return this.state === 'running' || this.state === 'starting'
  }

  onExit(fn: () => void): void {
    this.exitListeners.push(fn)
  }

  /** Starts Deno and waits for the host's ready frame. Rejects (and leaves the process dead) on anything else. */
  async start(): Promise<void> {
    const o = this.opts
    const spawn = o.spawn ?? ((file, args, options) => spawnTethered(file, args, options, { kind: 'sandbox' }))
    const child = spawn(o.denoPath, denoArgs(o.pyodideDir, o.hostPath ?? sandboxHostPath()), {
      cwd: o.cwd,
      env: denoEnv(o.denoDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stderr?.on('data', () => { /* Deno's own warnings; nothing is read from it */ })
    child.stdin?.on('error', () => { /* a dead host's pipe; the exit handler reports it */ })
    child.on('error', (e) => this.die(new SandboxError('start_failed', `Could not start the sandbox: ${e.message}`)))
    child.on('exit', () => this.die(this.death ?? new SandboxError('crashed', 'The sandbox stopped unexpectedly.')))
    const frame = await this.expect(o.startTimeoutMs ?? START_TIMEOUT_MS, 'start_failed', 'The sandbox took too long to start.')
    if (frame.header.t === 'fatal') {
      const why = typeof frame.header.error === 'string' ? frame.header.error.slice(0, 500) : 'unknown error'
      this.kill(new SandboxError('start_failed', `The sandbox could not load Python: ${why}`))
      throw this.death!
    }
    if (frame.header.t !== 'ready' || frame.header.size !== 0) this.violation('expected ready')
    this.state = 'idle'
  }

  /** Runs `code` with `files` in its working folder. Rejects with 'timeout' (the process is killed), 'crashed',
   *  'violation' or 'busy'. A Python error is not a rejection: it resolves with `ok: false`. */
  async run(code: string, files: SandboxFile[] = []): Promise<SandboxRunResult> {
    if (this.state !== 'idle') throw new SandboxError('busy', 'The sandbox is not ready for another run.')
    this.state = 'running'
    const frame = encodeFrame({ t: 'run', code, files: files.map((f) => ({ name: f.name, size: f.bytes.length })) }, files.map((f) => f.bytes))
    const waiting = this.expect(this.opts.runTimeoutMs ?? RUN_TIMEOUT_MS, 'timeout', `The code ran longer than ${Math.round((this.opts.runTimeoutMs ?? RUN_TIMEOUT_MS) / 1000)} seconds and was stopped.`)
    this.child?.stdin?.write(frame)
    const result = checkResult(await waiting)
    if (!result) this.violation('bad result frame')
    this.state = 'idle'
    return result!
  }

  /** Resolves once the OS process has gone (or never started), or after `ms` regardless. */
  whenExited(ms = 5000): Promise<void> {
    return Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, ms).unref?.())])
  }

  /** Kills the process and everything it started. Idempotent. */
  kill(reason: SandboxError = new SandboxError('crashed', 'The sandbox was stopped.')): void {
    this.death ??= reason
    if (this.child && this.state !== 'dead') {
      if (this.opts.spawn) this.child.kill('SIGKILL')
      else killTetheredTree(this.child, 'SIGKILL')
    }
    this.die(reason)
  }

  private expect(ms: number, code: SandboxFailure, message: string): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      if (this.state === 'dead') return reject(this.death)
      this.waiter = { resolve, reject }
      this.timer = setTimeout(() => this.kill(new SandboxError(code, message)), ms)
      this.timer.unref?.()
    })
  }

  private onData(chunk: Buffer): void {
    if (this.state === 'dead') return
    let frames: Frame[]
    try {
      frames = this.reader.push(chunk)
    } catch (e) {
      this.breach(e instanceof FrameViolation ? e.message : 'unreadable output')
      return
    }
    for (const f of frames) {
      // Exactly one frame is expected at a time: a frame with no one waiting for it is out of turn.
      const w = this.waiter
      if (!w) {
        this.breach(`unexpected ${String(f.header.t)} frame`)
        return
      }
      this.waiter = null
      if (this.timer) clearTimeout(this.timer)
      w.resolve(f)
    }
  }

  /** Kills the process for breaking the protocol. Never throws: it runs inside the stdout handler too. */
  private breach(what: string): void {
    this.kill(new SandboxError('violation', `The sandbox broke its protocol (${what}) and was stopped.`))
  }

  private violation(what: string): never {
    this.breach(what)
    throw this.death!
  }

  private die(reason: SandboxError): void {
    if (this.state === 'dead') return
    this.death ??= reason
    this.state = 'dead'
    if (this.timer) clearTimeout(this.timer)
    const w = this.waiter
    this.waiter = null
    w?.reject(this.death)
    for (const fn of this.exitListeners) fn()
  }
}

/** The run's result, or null when any field is off. Sizes must add up to the payload exactly. */
export function checkResult(frame: Frame): SandboxRunResult | null {
  const h = frame.header
  if (h.t !== 'result' || typeof h.ok !== 'boolean') return null
  if (h.error !== undefined && typeof h.error !== 'string') return null
  const sizeOk = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max
  if (!sizeOk(h.stdout, TEXT_LIMIT) || !sizeOk(h.stderr, TEXT_LIMIT)) return null
  if (!Array.isArray(h.files) || h.files.length > MAX_FILES) return null
  const skipped = h.skipped ?? []
  if (!Array.isArray(skipped) || skipped.length > MAX_SKIPPED || !skipped.every((s) => typeof s === 'string' && s.length <= 256)) return null
  let total = 0
  const named: Array<{ name: string; size: number }> = []
  for (const f of h.files as unknown[]) {
    const { name, size } = (f ?? {}) as { name?: unknown; size?: unknown }
    if (typeof name !== 'string' || !OUTPUT_NAME.test(name) || name === '.' || name === '..' || !sizeOk(size, MAX_FILE)) return null
    total += size
    named.push({ name, size })
  }
  if (total > MAX_TOTAL || h.stdout + h.stderr + total !== frame.payload.length) return null
  let off = 0
  const slice = (n: number) => frame.payload.subarray(off, (off += n))
  const stdout = slice(h.stdout).toString('utf8')
  const stderr = slice(h.stderr).toString('utf8')
  const files = named.map((f) => ({ name: f.name, bytes: Buffer.from(slice(f.size)) }))
  return { ok: h.ok, error: h.ok ? undefined : (h.error as string | undefined)?.slice(0, 4000), stdout, stderr, files, skipped: skipped as string[] }
}
