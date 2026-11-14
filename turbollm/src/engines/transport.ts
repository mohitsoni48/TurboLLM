// How the Manager reaches an engine (architecture §6.3): its URL, the headers its requests carry, and how it is stopped.
// The Manager's state machine (manager.ts) drives an engine through this seam, so an engine the daemon does not spawn
// (D-6's in-app SDK engine) can sit behind it. SpawnedTransport is the engine process the daemon spawned: the stop and
// kill code below is manager.ts's, moved unchanged. Spawning, the pidfile, the tether, the engine log, the reaper and
// the idle watchdog stay in manager.ts, on the spawned path only.
import { type ChildProcess, execFile } from 'node:child_process'
import { killTetheredTree } from '../util/tether'

export interface EngineTransport {
  /** The engine's base URL, without a trailing slash. */
  target(): string
  /** Headers of the engine's own that every request to it carries. */
  headers(): Record<string, string>
  /** Asks the engine to stop, forcing it after the grace; resolves once it has gone. */
  stop(): Promise<void>
  /** Ends the engine now, without the grace. */
  kill(): void
  /** Whether a stop that outlasts its grace can be forced: kill() ends the engine sooner than stop() does. */
  forcesStop(): boolean
}

/** An engine process the daemon spawned and owns, listening on its own loopback port. `exited` resolves at the
 *  process's 'close'. */
export class SpawnedTransport implements EngineTransport {
  constructor(
    private readonly child: ChildProcess,
    private readonly port: number,
    private readonly exited: Promise<void>,
  ) {}

  target(): string {
    return `http://127.0.0.1:${this.port}`
  }

  headers(): Record<string, string> {
    return {}
  }

  stop(): Promise<void> {
    return gracefulStop(this.child, this.exited)
  }

  kill(): void {
    forceKill(this.child)
  }

  forcesStop(): boolean {
    return true
  }
}

export const SDK_ENGINE_UNAVAILABLE = 'The TurboLLM SDK engine is not running in this app session.'
const SDK_TOKEN_REFUSED = "The app's SDK engine refused the daemon's token (the app was probably restarted)."
const SDK_STATUS_POLL_MS = 500

/** The body of the SDK's `POST /sdk/v1/load` (architecture §4.3): a model file by path, plus what the profile sets. */
export interface SdkLoadRequest {
  path: string
  contextSize?: number
  threads?: number
  backend: 'auto' | 'cpu' | 'gpu'
  /** The SDK engine to load on (ADR-462); absent on the M1 legacy row, which the SDK routes by format. */
  engine?: string
}

/** What the SDK's status reports about the model it has loaded. */
export interface SdkLoadedModel {
  contextSize?: number
}

interface SdkStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  model?: SdkLoadedModel
  error?: { message?: string }
}

interface SdkErrorBody {
  error?: { message?: string }
}

/** The SDK engine refused or failed a request; `code` is the Manager's error code for it. */
export class SdkEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SdkEngineError'
  }
}

/** The in-app TurboLLM SDK engine (kind 'turbollm-sdk'), which the app runs and the daemon reaches over loopback HTTP
 *  with the app's per-process bearer (architecture §6.3). It has no pid, no pidfile, no tether and no log file: a load
 *  is `POST /sdk/v1/load` plus status polling, and a stop is an unload. `token` is read on every request, never kept. */
export class AttachedTransport implements EngineTransport {
  /** Resolves once the unload has settled, however it ended: the engine's model is gone as far as the daemon goes. */
  readonly ended: Promise<void>
  private markEnded: () => void = () => {}
  private unloading: Promise<void> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly token: () => string | undefined,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.ended = new Promise<void>((resolve) => { this.markEnded = resolve })
  }

  target(): string {
    return this.baseUrl
  }

  headers(): Record<string, string> {
    const token = this.token()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  /** Asks the SDK to load the model and waits for it to be ready within `budgetMs`. Rejects with an
   *  {@link SdkEngineError}; nothing is retried. */
  async start(request: SdkLoadRequest, budgetMs: number): Promise<SdkLoadedModel> {
    const deadline = Date.now() + budgetMs
    await this.answer(await this.send('POST', '/sdk/v1/load', request))
    for (;;) {
      await sleep(SDK_STATUS_POLL_MS)
      if (this.unloading) throw new SdkEngineError('load_abandoned', 'The load was stopped.')
      const status = (await this.answer(await this.send('GET', '/sdk/v1/status'))) as SdkStatus
      if (status.state === 'ready') return status.model ?? {}
      if (status.state === 'error') throw new SdkEngineError('model_load_failed', sdkMessage(status, 'The model did not load.'))
      if (Date.now() > deadline) {
        throw new SdkEngineError('readiness_timeout', `The model did not become ready within ${Math.round(budgetMs / 1000)} seconds.`)
      }
    }
  }

  stop(): Promise<void> {
    return this.unload()
  }

  kill(): void {
    void this.unload()
  }

  /** No: the SDK's unload waits for a native load in progress, and kill() is that same unload. */
  forcesStop(): boolean {
    return false
  }

  private unload(): Promise<void> {
    this.unloading ??= this.send('POST', '/sdk/v1/unload', {}).then(
      () => this.markEnded(),
      () => this.markEnded(),
    )
    return this.unloading
  }

  private async send(method: 'GET' | 'POST', path: string, body?: object): Promise<Response> {
    const headers = { ...this.headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) }
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    } catch {
      throw new SdkEngineError('engine_unavailable', SDK_ENGINE_UNAVAILABLE)
    }
  }

  /** The reply's JSON body, or the refusal as an {@link SdkEngineError}. Typed load errors all map onto
   *  `model_load_failed` (architecture §6.3), except a 401: the app no longer holds the daemon's token. */
  private async answer(res: Response): Promise<unknown> {
    const body: unknown = await res.json().catch(() => ({}))
    if (res.ok) return body
    if (res.status === 401) throw new SdkEngineError('engine_auth_failed', SDK_TOKEN_REFUSED)
    throw new SdkEngineError('model_load_failed', sdkMessage(body as SdkErrorBody, `The TurboLLM SDK engine answered HTTP ${res.status}.`))
  }
}

function sdkMessage(body: SdkErrorBody, fallback: string): string {
  return body?.error?.message || fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function gracefulStop(child: ChildProcess, exited: Promise<void>): Promise<void> {
  signalTerm(child)
  const result = await exitedWithin(exited, 8000)
  if (result === 'timeout') {
    forceKill(child)
    await exited
  }
}

/** 'exited' once `exited` resolves, or 'timeout' after `ms`. The timer is cleared once the race is decided: a bare
 *  sleep() left its ref'd timer running after a prompt exit, which held the event loop (a test file, a CLI run) open
 *  for the rest of it. A prompt exit left two per stopAndWait(): gracefulStop's 8 s grace and waitForExit's 10 s. */
export async function exitedWithin(exited: Promise<void>, ms: number): Promise<'exited' | 'timeout'> {
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => { grace = setTimeout(() => resolve('timeout'), ms) }),
    ])
  } finally {
    clearTimeout(grace)
  }
}

function signalTerm(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Force the tree at once. A plain `taskkill /PID <pid> /T` (no /F) only posts WM_CLOSE to the process's windows,
    // and the engines are console programs with none (spawned windowsHide with piped stdio), so Windows refuses it
    // ("This process can only be terminated forcefully (with /F option)") and every Stop, model swap, pool eviction
    // and update stop sat out the whole 8 s grace in 'stopping', with every load queued behind the gate waiting too,
    // before forceKill ended it anyway. llama-server, KoboldCpp and llamafile exit cleanly only on a console
    // Ctrl+C, which taskkill never sends, so there is no gentler request to make from here.
    forceKill(child)
  } else {
    child.kill('SIGTERM')
  }
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Not once Node has seen the engine exit (a worker holding its stdout keeps 'close', and so the stop, waiting):
    // libuv has closed the process handle that kept the pid from being reused, so `/PID <pid> /T` may name another
    // process tree by then, as in killTetheredTree (util/tether.ts). An exited root is no tree for taskkill anyway.
    if (child.exitCode !== null || child.signalCode !== null) return
    execFile('taskkill', ['/PID', String(child.pid), '/F', '/T'], () => {})
  } else {
    // The engine's whole group (its workers too); the pid alone when it leads none (the Android helper).
    killTetheredTree(child, 'SIGKILL')
  }
}
