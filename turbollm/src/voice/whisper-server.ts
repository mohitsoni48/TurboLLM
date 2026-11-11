// One whisper.cpp `whisper-server` process, started when a recording needs transcribing and stopped once it has gone
// unused for a while.
//
// It is not kept up with the daemon: a loaded whisper model holds memory (and VRAM, with the GPU option on) that the
// chat model was fitted around, and most sessions never dictate. The cost is the first transcription after a quiet
// spell, which waits for the model to load; the page asks for a warm-up as recording starts, so the load overlaps the
// speaking.
//
// The server binds 127.0.0.1 on a port the OS picks. It has no authentication and answers any origin, which is why
// nothing but this daemon is ever told that port: the page and API clients reach it through the daemon's own routes.
import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { RotatingLogStream, readTail } from '../engines/engine-log'
import { killTetheredTree, spawnTethered } from '../util/tether'
import { whisperServerEnv } from './whisper-binary'

/** What a whisper-server was started with. A different one (another model, the GPU option flipped, another binary)
 *  needs another process: whisper-server takes them on its command line. */
export interface WhisperLaunch {
  binPath: string
  modelPath: string
  gpu: boolean
  /** How many threads whisper computes on; absent leaves it whisper's own choice (four, or fewer on a smaller CPU). */
  threads?: number
}

export type WhisperState = 'stopped' | 'starting' | 'ready' | 'error'

export interface WhisperServerOptions {
  dataDir: string
  /** Stop the server after this long without a transcription. */
  idleMs?: number
  /** How long a start may take before it is given up on: a multi-gigabyte model read from a slow disk takes a while. */
  startTimeoutMs?: number
  /** Called whenever {@link WhisperServer.state} changes. */
  onChange?: () => void
  spawn?: typeof spawnTethered
}

const DEFAULT_IDLE_MS = 10 * 60_000
const DEFAULT_START_TIMEOUT_MS = 180_000
const HEALTH_POLL_MS = 150
/** whisper-server gets this long to exit on SIGTERM before it is killed. */
const STOP_GRACE_MS = 3000
const LOG_MAX_BYTES = 5 * 1024 * 1024

export class WhisperStartError extends Error {
  constructor(message: string, readonly logTail: string[]) {
    super(message)
  }
}

interface Running {
  child: ChildProcess
  launch: WhisperLaunch
  exited: Promise<void>
  /** Its port once /health has answered; null while it is still loading its model. */
  port: number | null
  /** stop() asked it to end: its exit, mid-start included, is not a failure to report. */
  stopping: boolean
}

export class WhisperServer {
  private running: Running | null = null
  /** The start in flight, so callers that want the same server share it and the rest wait their turn. */
  private pending: { launch: WhisperLaunch; port: Promise<number> } | null = null
  private current: WhisperState = 'stopped'
  private errorMessage: string | null = null
  private inFlight = 0
  private closed = false
  private idleTimer: NodeJS.Timeout | null = null
  private readonly idleMs: number
  private readonly startTimeoutMs: number
  private readonly logPath: string

  constructor(private readonly opts: WhisperServerOptions) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.logPath = join(opts.dataDir, 'logs', 'whisper-server.log')
  }

  state(): WhisperState {
    return this.current
  }

  /** Why the last start failed, until the next one. */
  error(): string | null {
    return this.errorMessage
  }

  /** The launch the running (or starting) server was started with. */
  launch(): WhisperLaunch | null {
    return this.running?.launch ?? null
  }

  /** The port of a server running `launch`, starting one (and stopping one started otherwise) as needed. Callers
   *  that want the same launch share one start. */
  async ensure(launch: WhisperLaunch): Promise<number> {
    for (;;) {
      const pending = this.pending
      if (pending) {
        if (sameLaunch(pending.launch, launch)) return pending.port
        await pending.port.catch(() => {}) // another launch is starting: let it settle, then look again
        continue
      }
      const running = this.running
      if (running && running.port !== null && sameLaunch(running.launch, launch)) return running.port
      if (running) {
        await this.stop()
        continue
      }
      const port = this.start(launch)
      this.pending = { launch, port }
      const settle = (): void => { if (this.pending?.port === port) this.pending = null }
      port.then(settle, settle)
      return port
    }
  }

  /** Run `work` against the server's port, holding the idle stop off until it settles. */
  async use<T>(launch: WhisperLaunch, work: (port: number) => Promise<T>): Promise<T> {
    this.inFlight++
    this.clearIdle()
    try {
      return await work(await this.ensure(launch))
    } finally {
      this.inFlight--
      this.armIdle()
    }
  }

  /** Stop the server, if one is up. Resolves once its process has gone. */
  async stop(): Promise<void> {
    this.clearIdle()
    const running = this.running
    if (!running) return
    this.running = null
    running.stopping = true
    this.set('stopped', null)
    const { child, exited } = running
    if (process.platform === 'win32') {
      // A console program with no window ignores a polite close; see ChildTunnel.stop.
      killTetheredTree(child, 'SIGKILL')
    } else {
      killTetheredTree(child, 'SIGTERM')
      const grace = setTimeout(() => killTetheredTree(child, 'SIGKILL'), STOP_GRACE_MS)
      void exited.then(() => clearTimeout(grace))
    }
    await exited
  }

  /** Stop for good, at daemon shutdown: nothing starts after it. */
  async shutdown(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  private async start(launch: WhisperLaunch): Promise<number> {
    if (this.closed) throw new WhisperStartError('TurboLLM is shutting down.', [])
    this.set('starting', null)
    const port = await freePort()
    if (this.closed) {
      this.set('stopped', null)
      throw new WhisperStartError('TurboLLM is shutting down.', [])
    }
    mkdirSync(dirname(this.logPath), { recursive: true })
    const log = new RotatingLogStream(this.logPath, LOG_MAX_BYTES)
    // Best-effort, like the engine log: an unlistened write error (a full disk) would take the daemon down.
    log.on('error', () => {})
    const args = whisperServerArgs(launch, port)
    log.write(`[turbollm] starting ${launch.binPath} ${args.join(' ')}\n`)

    const child = (this.opts.spawn ?? spawnTethered)(
      launch.binPath, args,
      { cwd: dirname(launch.binPath), windowsHide: true, env: whisperServerEnv(launch.binPath), stdio: ['ignore', 'pipe', 'pipe'] },
      // 'engine', as an inference engine is: a program that starts nothing of its own, which is what lets the Android
      // app run it under its death-signal helper (util/tether.ts), and one its owner stops (close() calls stop()).
      { kind: 'engine' },
    )
    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })
    log.once('error', () => {
      child.stdout?.resume()
      child.stderr?.resume()
    })

    let spawnError: Error | null = null
    let exitCode: number | null | undefined
    const exited = new Promise<void>((resolve) => {
      // A binary that cannot be started at all (deleted, not executable, the wrong architecture) reports 'error' and
      // never 'exit'. Unlistened, Node would throw it as an uncaught exception.
      child.once('error', (e) => {
        if (child.pid !== undefined) return
        spawnError = e
        resolve()
      })
      child.once('exit', (code) => {
        exitCode = code
        resolve()
      })
    })
    void exited.then(() => {
      log.end()
      // An exit nobody asked for (a crash, the user killing it): the next transcription starts a fresh one.
      if (this.running?.child === child) {
        this.running = null
        if (this.current === 'ready') this.set('stopped', null)
      }
    })

    const running: Running = { child, launch, exited, port: null, stopping: false }
    this.running = running
    try {
      await this.waitReady(port, exited, () => spawnError, () => exitCode)
    } catch (e) {
      if (this.running === running) this.running = null
      // The start failed, unless stop() ended it on purpose. Told apart by the flag, not by `running` having been
      // cleared: a process that dies while loading is cleared by its own exit before this runs, and that is exactly
      // the failure to show (a model file whisper cannot read).
      if (!running.stopping) this.set('error', e instanceof Error ? e.message : String(e))
      killTetheredTree(child, 'SIGKILL')
      throw e
    }
    if (running.stopping) throw new WhisperStartError('whisper-server was stopped while it was starting.', [])
    running.port = port
    this.set('ready', null)
    this.armIdle()
    return port
  }

  /** whisper-server loads its model before it opens its port, so "not ready" is a refused connection, and only a 200
   *  from /health means a transcription will be answered. */
  private async waitReady(
    port: number, exited: Promise<void>, spawnError: () => Error | null, exitCode: () => number | null | undefined,
  ): Promise<number> {
    const deadline = Date.now() + this.startTimeoutMs
    let gone = false
    void exited.then(() => { gone = true })
    for (;;) {
      if (gone) {
        const e = spawnError()
        if (e) throw new WhisperStartError(`whisper-server could not be started: ${e.message}`, [])
        const tail = readTail(this.logPath, 20)
        throw new WhisperStartError(startFailureMessage(exitCode(), tail), tail)
      }
      if (await healthy(port)) return port
      if (Date.now() > deadline) {
        throw new WhisperStartError(
          `whisper-server did not become ready within ${Math.round(this.startTimeoutMs / 1000)} seconds.`,
          readTail(this.logPath, 20),
        )
      }
      await Promise.race([sleep(HEALTH_POLL_MS), exited])
    }
  }

  private set(state: WhisperState, error: string | null): void {
    if (this.current === state && this.errorMessage === error) return
    this.current = state
    this.errorMessage = error
    this.opts.onChange?.()
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.inFlight > 0 || !this.running || this.idleMs <= 0) return
    this.idleTimer = setTimeout(() => { void this.stop() }, this.idleMs)
    this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

/** PURE: whisper-server's command line. `-l auto` is only the default for a request that names no language (ours
 *  always do); `-ng` keeps whisper off the GPU. */
export function whisperServerArgs(launch: WhisperLaunch, port: number): string[] {
  return [
    '--host', '127.0.0.1',
    '--port', String(port),
    '-m', launch.modelPath,
    '-l', 'auto',
    ...(launch.threads && launch.threads > 0 ? ['-t', String(Math.floor(launch.threads))] : []),
    ...(launch.gpu ? [] : ['-ng']),
  ]
}

/** whisper gains little past this many threads, and the chat model is on the same cores. */
const MAX_THREADS = 8

/** PURE: the thread count to start whisper with, or undefined to leave it whisper's default of four. Only a CPU with
 *  fast and slow cores is told: every step waits for its slowest thread, so on a phone with two fast cores four
 *  threads are slower than two, and on one with more than four the default leaves fast cores idle. */
export function whisperThreads(sys: { perfCores?: number }): number | undefined {
  return sys.perfCores && sys.perfCores > 0 ? Math.min(MAX_THREADS, Math.floor(sys.perfCores)) : undefined
}

/** PURE: a start that ended with the process exiting, as a sentence. whisper-server prints why on its last lines. */
export function startFailureMessage(exitCode: number | null | undefined, logTail: string[]): string {
  const reason = [...logTail].reverse().find((line) => /error|failed|cannot|not found|no such/i.test(line))
  const code = typeof exitCode === 'number' ? ` (exit code ${exitCode})` : ''
  return reason
    ? `whisper-server stopped while starting${code}: ${reason.trim().slice(0, 300)}`
    : `whisper-server stopped while starting${code}.`
}

function sameLaunch(a: WhisperLaunch, b: WhisperLaunch): boolean {
  return a.binPath === b.binPath && a.modelPath === b.modelPath && a.gpu === b.gpu && (a.threads ?? 0) === (b.threads ?? 0)
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    await res.body?.cancel()
    return res.status === 200
  } catch {
    return false
  }
}

/** A loopback port nothing is listening on, chosen by the OS. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no_free_port'))))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
