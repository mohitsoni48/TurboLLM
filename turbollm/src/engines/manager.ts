// Engine lifecycle state machine (A2, spec 03 §4): stopped → starting → running
// → stopping → stopped, plus error. Owns the single running engine process.
// Ports the verified Go manager to node:child_process.
import { ChildProcess, execFile, spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { ConfigStore, Engine } from '../config/config'
import { mlxServerCommand } from './mlx'
import { rapidMlxServerCommand } from './rapid-mlx'
import { koboldcppServerCommand } from './koboldcpp'
import { llamafileServerCommand } from './llamafile'
import { slotCacheDir } from './slot-cache'
import { vllmServerCommand, vllmServeBlocker } from './vllm'
import { sglangServerCommand, sgLangServeBlocker } from './sglang'

export type State = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface ModelInfo {
  key: string
  name: string
  quant: string
  ctx: number
  vision: boolean
}
export interface ErrInfo {
  code: string
  message: string
  exitCode: number
  logTail: string[]
}
export interface StartOpts {
  engine: Engine
  model: ModelInfo
  modelPath: string
  extraArgs: string[]
  /** vLLM multi-GPU shard count (ADR-054). Only consumed by the vllm branch of
   *  {@link engineCommand}; llama.cpp carries its GPU flags in extraArgs instead. */
  tensorParallelSize?: number
  /** Per-model pinned port (LoadProfile.port), engine-agnostic. Tried first by
   *  allocPort(); falls back to the normal 8081+ walk if unset or already taken. */
  preferredPort?: number
}
export interface Status {
  state: State
  err: ErrInfo | null
  port: number
  pid: number
  model: ModelInfo | null
  loadElapsedMs: number
}

/** Per-completion numbers fed into the running-session accumulator (B4). All
 *  fields are best-effort: a path that can't compute t/s simply omits it. */
export interface CompletionRecord {
  inputTokens?: number
  outputTokens?: number
  promptTps?: number
  genTps?: number
}

/** Live per-request progress for the engine card (spec 11). `phase` is the current
 *  stage of the most-recent in-flight completion; cleared once nothing is generating. */
export interface LiveGen {
  phase: 'prompt' | 'gen'
  /** Prompt-processing percent (0–100) while `phase === 'prompt'`; 0 in gen phase. */
  pct: number
  /** Output tokens produced so far in the gen phase (live, approximate). */
  outputTokens: number
}

/** Live summary of the current running session (B4). Resets on start/stop. */
export interface SessionStats {
  requests: number
  inputTokens: number
  outputTokens: number
  avgPromptTps: number
  avgGenTps: number
  sinceMs: number
  /** Number of completions currently streaming through the engine right now. >0
   *  drives the "Generating…" live indicator in the engine card. */
  activeRequests: number
}

interface SessionAccumulator {
  requests: number
  inputTokens: number
  outputTokens: number
  sumPromptTps: number
  sumGenTps: number
  promptTpsCount: number
  genTpsCount: number
  startedAt: number
}

function freshSession(): SessionAccumulator {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    sumPromptTps: 0,
    sumGenTps: 0,
    promptTpsCount: 0,
    genTpsCount: 0,
    startedAt: Date.now(),
  }
}

function posNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export class BusyError extends Error {
  constructor() {
    super('engine_already_running')
    this.name = 'BusyError'
  }
}

export class Manager {
  /** Global single-load lock (rules 1 & 2). Shared across EVERY Manager instance —
   *  including the gateway keep-N pool's extra slots — so at most ONE model load /
   *  reload is ever in flight at a time, no matter who requests it. Holding it
   *  through readiness (not just spawn) guarantees two engines never spin up at
   *  once and double-allocate VRAM. All load paths funnel through start()/load(),
   *  the only entry points that touch the engine — nothing spawns an engine without
   *  passing this gate (rule 3). */
  private static loadGate: Promise<void> = Promise.resolve()

  /** Acquire the global load gate, run `fn` exclusively, then release it. Queued
   *  callers run in FIFO order; a thrown fn still releases the gate. */
  private static async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = Manager.loadGate
    let release!: () => void
    Manager.loadGate = new Promise<void>((r) => { release = r })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private state: State = 'stopped'
  private opts: StartOpts | null = null
  private port = 0
  private pid = 0
  private child: ChildProcess | null = null
  private startedAt = 0
  private errInfo: ErrInfo | null = null
  private lastCommand: { cmd: string; args: string[] } | null = null
  private lastActivity = 0
  private logPathStr = ''
  private exited: Promise<void> = Promise.resolve()
  private resolveExited: (() => void) | null = null
  private generation = 0
  private liveGen: LiveGen | null = null
  private session: SessionAccumulator = freshSession()

  constructor(private store: ConfigStore) {
    setInterval(() => this.watchdogTick(), 60_000).unref()
  }

  /** Load a model, freeing any currently-loaded one first — the single atomic
   *  swap entry point (rules 1–3). Runs under the global load gate so the stop +
   *  optional pre-start hook (e.g. the ComfyUI VRAM free) + spawn + readiness wait
   *  are one indivisible operation; no other load can interleave. Never throws on a
   *  model that simply fails to load — callers read status() for the running/error
   *  outcome. */
  async load(opts: StartOpts, hooks?: { beforeStart?: () => Promise<void> }): Promise<void> {
    await Manager.runExclusive(async () => {
      try {
        if (this.state === 'running' || this.state === 'starting' || this.state === 'stopping') {
          await this.stopAndWait()
        }
        if (hooks?.beforeStart) await hooks.beforeStart()
        await this.startInternal(opts)
        await this.awaitNotStarting()
      } catch (e) {
        // routes.ts fires load() without awaiting and only console.warns the rejection —
        // without this, a failed swap left `state` wherever it last was (often still
        // 'stopping'), which read to the user as "no model loaded" with no indication
        // anything went wrong or that a retry could help.
        this.state = 'error'
        this.errInfo = { code: 'load_failed', message: e instanceof Error ? e.message : String(e), exitCode: -1, logTail: [] }
        throw e
      }
    })
  }

  /** Start a model assuming nothing is loaded (throws BusyError otherwise). Held by
   *  the global load gate through readiness so concurrent loads can't spin up two
   *  engines at once. Most callers want load() (which stops first); this exists for
   *  paths that have already ensured the engine is free (bench, ComfyUI reload). */
  async start(opts: StartOpts): Promise<void> {
    await Manager.runExclusive(async () => {
      await this.startInternal(opts)
      await this.awaitNotStarting()
    })
  }

  /** Wait until the engine leaves the 'starting' state (→ running or error/stopped),
   *  bounded by the engine kind's readiness window plus a small grace. The internal
   *  readiness loop flips the state and surfaces errors; this just keeps the load
   *  gate held until that resolves. */
  private async awaitNotStarting(): Promise<void> {
    const deadline = Date.now() + readinessTimeoutMs(this.opts?.engine.kind ?? 'llama-server') + 5_000
    while (this.state === 'starting' && Date.now() < deadline) await sleep(200)
  }

  private async startInternal(opts: StartOpts): Promise<void> {
    if (this.state === 'starting' || this.state === 'running' || this.state === 'stopping') {
      throw new BusyError()
    }
    if (!opts.engine.binPath) throw new Error('no_active_engine')
    if (!opts.modelPath) throw new Error('no_such_model')

    // Engine preflight (ADR-080): refuse to spawn vLLM where it can't actually serve (e.g.
    // Windows, where its uvloop/NCCL deps don't exist) and surface a clear, actionable error
    // instead of letting the process crash on import with a raw Python traceback. Mirrors the
    // engine-capability concept: know what the engine can do on this machine before launching it.
    if (opts.engine.kind === 'vllm') {
      const blocker = await vllmServeBlocker(opts.engine.binPath)
      if (blocker) {
        this.state = 'error'
        this.errInfo = { code: 'engine_unsupported', message: blocker, exitCode: -1, logTail: [] }
        return
      }
    }
    if (opts.engine.kind === 'sglang') {
      const blocker = await sgLangServeBlocker(opts.engine.binPath)
      if (blocker) {
        this.state = 'error'
        this.errInfo = { code: 'engine_unsupported', message: blocker, exitCode: -1, logTail: [] }
        return
      }
    }

    const port = await allocPort(opts.preferredPort)
    const logPath = join(this.store.dir(), 'logs', `engine-${opts.engine.id}.log`)
    mkdirSync(dirname(logPath), { recursive: true })
    const logStream = createWriteStream(logPath) // truncates
    // Header so the raw engine log is self-explanatory. `port` is the engine's OWN
    // loopback port (allocated 8081+), DISTINCT from the TurboLLM app/UI port the
    // user configures — surfacing it here stops the "it says 8081 even though I
    // changed the port" confusion, since this log is what the user reads.
    logStream.write(
      `[turbollm] starting engine "${opts.engine.name}" on internal port ${port} ` +
        `(127.0.0.1 only — the engine's own port, NOT the TurboLLM app/UI port).\n`,
    )

    // KV prompt-cache persistence (F-014): when ComfyUI coordination + the opt-in are on
    // and this is a llama.cpp engine whose caps allow the flag, point llama-server at the
    // slot-cache dir via `--slot-save-path`. That arms the slot save/restore endpoints the
    // ComfyUI guard uses to persist the prompt cache across a forced unload/reload. Not
    // passed for mlx/vllm (no cross-restart slot persistence). The dir must exist first.
    const cfg = this.store.snapshot()
    let slotSavePath: string | undefined
    if (cfg.comfyui.enabled && cfg.comfyui.cachePersist && opts.engine.kind === 'llama-server') {
      const flags = opts.engine.capabilities.flags
      if (flags.length === 0 || flags.includes('--slot-save-path')) {
        slotSavePath = slotCacheDir(this.store.dir())
        mkdirSync(slotSavePath, { recursive: true })
      }
    }

    const { cmd, args } = engineCommand(opts, port, slotSavePath)
    // The UNWRAPPED command (before the POSIX-llamafile shell-quoting workaround below) is
    // what a human would actually type in their own terminal — stored for "copy exact launch
    // command" (GitHub Discord ask). Not logged before now: the file only ever had a port-only
    // header line, never the real argv.
    this.lastCommand = { cmd, args }
    const spawned = needsShellWrapper(opts.engine.kind) ? shellWrapped(cmd, args) : { cmd, args }
    const child = spawn(spawned.cmd, spawned.args, { cwd: dirname(cmd), windowsHide: true, env: pyEngineEnv(opts.engine.kind, this.store.dir(), opts.engine.binPath) })
    // end:false — otherwise whichever of stdout/stderr closes first would end the
    // shared log stream and drop the other's output. We close it in onTerminated.
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })

    this.state = 'starting'
    this.session = freshSession() // each running session starts with fresh stats (B4)
    this.opts = opts
    this.port = port
    this.pid = child.pid ?? 0
    // Track the OS process on disk so a daemon that dies WITHOUT running its signal
    // handlers (terminal window closed, killed, crashed) can't leave llama-server
    // orphaned: the next startup reaps it (reapStaleEngines), and the exit handler
    // kills it synchronously (killTrackedEnginesSync). Cleared in onTerminated.
    if (this.pid) writeEnginePid(this.store.dir(), this.pid, port)
    this.child = child
    this.startedAt = Date.now()
    this.errInfo = null
    this.lastActivity = Date.now()
    this.logPathStr = logPath
    this.exited = new Promise<void>((res) => {
      this.resolveExited = res
    })

    child.on('error', (e) => this.onTerminated(child, -1, logStream, e.message))
    child.on('close', (code) => this.onTerminated(child, code ?? -1, logStream, null))
    void this.readiness(child, port)
  }

  stop(): void {
    if (this.state === 'error') {
      this.state = 'stopped'
      this.errInfo = null
    }
    const child = this.child
    if (!child || (this.state !== 'running' && this.state !== 'starting')) return
    this.state = 'stopping'
    void gracefulStop(child, this.exited)
  }

  /** Kill the engine immediately (SIGKILL / taskkill /F) to free VRAM without the
   *  graceful grace period. The `close` handler still runs and resolves `exited`. */
  private forceStop(): void {
    const child = this.child
    if (!child || (this.state !== 'running' && this.state !== 'starting')) return
    this.state = 'stopping'
    forceKill(child)
  }

  async stopAndWait(opts?: { force?: boolean }): Promise<void> {
    const exited = this.exited
    if (this.state === 'running' || this.state === 'starting') {
      // force: SIGKILL immediately rather than the graceful TERM→8s-then-kill path.
      // Used by the ComfyUI guard, which needs the VRAM freed NOW before ComfyUI runs, and by
      // auto-tune's cancel (ADR-220).
      if (opts?.force) this.forceStop()
      else this.stop()
      await this.waitForExit(exited)
    } else if (this.state === 'stopping') {
      // A force request landing while a graceful stop is ALREADY in flight (e.g. auto-tune's
      // cancel arriving in the narrow window right after a probe's own non-forced stop already
      // started) must not just passively wait out the remainder of that graceful timer — kill
      // now. Bypasses forceStop()'s running/starting-only guard by calling the module-level
      // forceKill directly, since state is already 'stopping' (ADR-220).
      if (opts?.force && this.child) forceKill(this.child)
      await this.waitForExit(exited)
    } else if (this.state === 'error') {
      this.state = 'stopped'
      this.errInfo = null
    }
  }

  /** Wait for `exited` up to 10s; if it hasn't resolved by then, force-kill and wait
   *  unconditionally. A bare timeout here previously let stopAndWait() return with the
   *  process still alive and `state` stuck at 'stopping' (e.g. a slow Windows tree-kill) —
   *  the very next startInternal() would then throw BusyError, silently abandoning a model
   *  swap (the caller in routes.ts fires load() without awaiting and only logs the
   *  rejection). Bypasses forceStop()'s running/starting-only guard by calling the
   *  module-level forceKill directly, since by this point state is already 'stopping'. */
  private async waitForExit(exited: Promise<void>): Promise<void> {
    const result = await Promise.race([exited.then(() => 'exited' as const), sleep(10_000).then(() => 'timeout' as const)])
    if (result === 'timeout' && this.child) {
      forceKill(this.child)
      // Bounded too: forceKill's taskkill is fire-and-forget (failures swallowed), so an
      // unbounded await here on an unkillable/zombie process would wedge this forever —
      // and since stopAndWait() runs inside the exclusive load gate, that deadlocks every
      // future load(), which is worse than the 'stuck at stopping' bug this replaced.
      await Promise.race([exited, sleep(5_000)])
    }
  }

  async restart(): Promise<void> {
    const opts = this.opts
    if (!opts?.modelPath) throw new Error('no_such_model')
    // load() stops the current engine (if any) and starts the same opts again, all
    // under the global load gate — so a restart can't race a concurrent swap.
    await this.load(opts)
  }

  /** The exact command last spawned, formatted for copy-paste into a terminal
   *  (GitHub Discord ask — "copy exact launch command"). Only meaningful while this
   *  engine is the one actually running; null once stopped/swapped so a stale
   *  command from a PREVIOUS model can never be copied as if it were current.
   *
   *  Deliberately NOT byte-identical to what TurboLLM itself spawned: the point of
   *  copying it is running the SAME model+config standalone, with llama.cpp/the fork
   *  directly and TurboLLM out of the picture entirely — so `--no-webui` (added only
   *  because TurboLLM serves its own frontend and doesn't want llama-server's built-in
   *  one competing with it, `buildArgs` in this file) is stripped here: for a standalone
   *  run it's the only UI available, so silently carrying it over would hand the user a
   *  server with no way to talk to it. Everything else (model path, offload, KV type,
   *  sampling, extra flags) is copied verbatim — it's what makes the command reproduce
   *  the exact same config. */
  launchCommand(): string | null {
    if (this.state !== 'running' && this.state !== 'starting') return null
    if (!this.lastCommand) return null
    const args = this.lastCommand.args.filter((a) => a !== '--no-webui')
    const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
    return [this.lastCommand.cmd, ...args].map(quote).join(' ')
  }

  status(): Status {
    const st: Status = { state: this.state, err: this.errInfo, port: this.port, pid: this.pid, model: null, loadElapsedMs: 0 }
    if ((this.state === 'running' || this.state === 'starting') && this.opts) {
      st.model = this.opts.model
      if (this.state === 'starting') st.loadElapsedMs = Date.now() - this.startedAt
    }
    return st
  }

  /** Clear a terminal error so a stale failure (e.g. a vLLM load that failed because the
   *  active engine couldn't serve here) doesn't linger in the UI after the user switches
   *  engines. No-op unless currently in 'error' — never disturbs a running/starting engine. */
  clearError(): void {
    if (this.state === 'error') {
      this.state = 'stopped'
      this.errInfo = null
    }
  }

  target(): string | null {
    return this.state === 'running' ? `http://127.0.0.1:${this.port}` : null
  }

  /** The StartOpts of the currently loaded (or loading) model, or null when nothing
   *  is up. Lets an external coordinator (the ComfyUI guard) snapshot what to reload
   *  after it has unloaded the model to free the GPU. */
  currentOpts(): StartOpts | null {
    return (this.state === 'running' || this.state === 'starting') ? this.opts : null
  }

  touch(): void {
    this.lastActivity = Date.now()
  }

  /** Record a completed completion into the running-session accumulator (B4).
   *  Fully fail-safe: callers wrap this in try/catch too, but every field is
   *  individually guarded so a bad number can never corrupt the totals. */
  recordCompletion(rec: CompletionRecord): void {
    const s = this.session
    s.requests += 1
    s.inputTokens += posNum(rec.inputTokens)
    s.outputTokens += posNum(rec.outputTokens)
    const pt = posNum(rec.promptTps)
    if (pt > 0) {
      s.sumPromptTps += pt
      s.promptTpsCount += 1
    }
    const gt = posNum(rec.genTps)
    if (gt > 0) {
      s.sumGenTps += gt
      s.genTpsCount += 1
    }
  }

  /** Computed snapshot of the current running session's stats (B4). */
  sessionStats(): SessionStats {
    const s = this.session
    return {
      requests: s.requests,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      avgPromptTps: s.promptTpsCount > 0 ? s.sumPromptTps / s.promptTpsCount : 0,
      avgGenTps: s.genTpsCount > 0 ? s.sumGenTps / s.genTpsCount : 0,
      sinceMs: Date.now() - s.startedAt,
      activeRequests: this.generation,
    }
  }
  logPath(): string {
    return this.logPathStr
  }
  generationStart(): void {
    this.generation++
  }
  generationEnd(): void {
    this.generation = Math.max(0, this.generation - 1)
    if (this.generation === 0) this.liveGen = null
  }

  /** Publish live progress for the in-flight completion (cheap; called per chunk).
   *  Last-writer-wins — a single slot is enough for the single-model engine card. */
  setLiveGen(g: LiveGen): void {
    this.liveGen = g
  }

  /** Live progress for the engine card, or null when nothing is generating. */
  liveGeneration(): LiveGen | null {
    return this.generation > 0 ? this.liveGen : null
  }

  async shutdown(): Promise<void> {
    const child = this.child
    const running = this.state === 'running' || this.state === 'starting'
    if (!child || !running) return
    this.state = 'stopping'
    await gracefulStop(child, this.exited)
  }

  // ---- internal ----------------------------------------------------------

  private onTerminated(child: ChildProcess, code: number, logStream: NodeJS.WritableStream, errMsg: string | null): void {
    if (this.child !== child) return
    // The process is gone — drop its pidfile so the next startup doesn't try to reap
    // a dead pid (and, on Windows, can't kill a recycled one).
    if (child.pid) clearEnginePid(this.store.dir(), child.pid)
    // Terminal marker so the live engine log can't keep "looking connected" after
    // the process dies. Without it the last line stays "...server is listening on
    // <port>" forever, contradicting the Error state shown above it (the reported bug).
    const cleanStop = this.state === 'stopping' || this.state === 'stopped'
    try {
      logStream.write(
        cleanStop
          ? `\n[turbollm] engine stopped — the model is no longer loaded.\n`
          : `\n[turbollm] engine process exited unexpectedly (exit ${code})` +
              `${errMsg ? ` — ${errMsg}` : ''}. The model did NOT load / is no longer loaded.\n`,
      )
    } catch {
      /* best-effort marker */
    }
    logStream.end()
    if (this.state === 'stopping' || this.state === 'stopped') {
      this.state = 'stopped'
    } else {
      this.state = 'error'
      this.errInfo = {
        code: errMsg ? 'engine_spawn_failed' : 'engine_exited',
        message: errMsg ?? 'The engine process exited unexpectedly.',
        exitCode: code,
        logTail: readTail(this.logPathStr, 20),
      }
    }
    this.child = null
    this.pid = 0
    this.session = freshSession() // session ended — clear stats (B4)
    this.resolveExited?.()
  }

  private async readiness(child: ChildProcess, port: number): Promise<void> {
    const kind = this.opts?.engine.kind ?? 'llama-server'
    const deadline = Date.now() + readinessTimeoutMs(kind)
    for (;;) {
      await sleep(500)
      if (this.child !== child || this.state !== 'starting') return
      // Python engines (mlx/vllm) load the model in a background thread AFTER the HTTP
      // socket binds, so /v1/models answers 200 even when the load crashed — which would
      // otherwise flip us to "running" and then hang every request forever on a dead
      // generation thread. Detect a fatal load-failure traceback in the log and surface
      // it as an engine error instead. (Checked before probeReady so we win the race.)
      if (kind === 'mlx' || kind === 'rapid-mlx' || kind === 'vllm' || kind === 'sglang') {
        const loadErr = detectPyLoadFailure(readTail(this.logPathStr, 200))
        if (loadErr) {
          if (this.child === child && this.state === 'starting') {
            this.state = 'error'
            this.errInfo = { code: 'model_load_failed', message: loadErr, exitCode: -1, logTail: readTail(this.logPathStr, 20) }
            child.kill('SIGKILL')
          }
          return
        }
      }
      if (await probeReady(port)) {
        if (this.child === child && this.state === 'starting') {
          this.state = 'running'
          this.lastActivity = Date.now()
        }
        return
      }
      if (Date.now() > deadline) {
        if (this.child === child && this.state === 'starting') {
          this.state = 'error'
          this.errInfo = {
            code: 'readiness_timeout',
            message: `The model did not become ready within ${Math.round(readinessTimeoutMs(this.opts?.engine.kind ?? 'llama-server') / 1000)} seconds.`,
            exitCode: -1,
            logTail: readTail(this.logPathStr, 20),
          }
          child.kill('SIGKILL')
        }
        return
      }
    }
  }

  private watchdogTick(): void {
    const ttl = this.store.snapshot().daemon.idleTtlMinutes
    if (ttl <= 0) return
    const idle = this.state === 'running' && Date.now() - this.lastActivity > ttl * 60_000 && this.generation === 0
    if (idle) this.stop()
  }
}

// ---- helpers ---------------------------------------------------------------

/** True when `kind`'s binary needs shell interpretation to run correctly on this platform.
 *  llamafile ships as an "Actually Portable Executable" (Cosmopolitan libc) — a polyglot whose
 *  leading bytes look like a DOS/PE header, which a POSIX shell dispatches to the right native
 *  format for the current OS. Node's `spawn()` calls `execve()` directly (no shell), which fails
 *  with ENOEXEC on macOS/Linux for this format — confirmed live on macOS: the daemon accepted
 *  the start request but the process never spawned, while running the identical binary through
 *  a shell worked immediately. Windows already recognizes the leading MZ/PE header natively, so
 *  no wrapping is needed there. */
export function needsShellWrapper(kind: string): boolean {
  return kind === 'llamafile' && process.platform !== 'win32'
}

/** Wrap cmd+args to run through /bin/sh with no manual argument quoting/escaping needed: `"$0"`
 *  and `"$@"` are populated from spawn's own argv array (never string-concatenated), so a path
 *  or flag containing spaces/special characters passes through unmangled with no shell-injection
 *  risk from argument content. */
export function shellWrapped(cmd: string, args: string[]): { cmd: string; args: string[] } {
  return { cmd: '/bin/sh', args: ['-c', 'exec "$0" "$@"', cmd, ...args] }
}

/** Build the spawn command for an engine, branching on its kind (spec 03 §2b).
 *  `slotSavePath` (F-014) is appended only for llama.cpp; mlx/vllm don't support it. */
function engineCommand(opts: StartOpts, port: number, slotSavePath?: string): { cmd: string; args: string[] } {
  if (opts.engine.kind === 'mlx') {
    // MLX: run the mlx-lm OpenAI server via the provisioned venv python. For MLX,
    // opts.extraArgs carries mlx-lm's OWN flags (sampling defaults), built by the
    // callers via mlxSamplingArgs — never llama.cpp profile flags.
    return mlxServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1', opts.extraArgs)
  }
  if (opts.engine.kind === 'rapid-mlx') {
    // Rapid-MLX: run its own OpenAI server binary (venv-installed console script) directly —
    // it has no launch-time sampling flags to pass (per-request only, vLLM-style).
    return rapidMlxServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1')
  }
  if (opts.engine.kind === 'vllm') {
    // vLLM: run the OpenAI server via the provisioned venv python. modelPath is an
    // HF repo id or a local safetensors dir; llama.cpp LoadProfile flags don't apply,
    // but the multi-GPU shard count (ADR-054) maps to --tensor-parallel-size.
    return vllmServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1', opts.tensorParallelSize, opts.extraArgs)
  }
  if (opts.engine.kind === 'sglang') {
    // SGLang: run the OpenAI server via the provisioned venv python. modelPath is an
    // HF repo id or a local safetensors dir; llama.cpp LoadProfile flags don't apply.
    return sglangServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1', opts.extraArgs)
  }
  if (opts.engine.kind === 'koboldcpp') {
    // KoboldCpp: a single binary with its OWN flag names. opts.extraArgs carries the
    // KoboldCpp arg-map (koboldcppProfileToArgs) built by the router; no slot-save path
    // (that's a llama-server-only flag).
    return koboldcppServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1', opts.extraArgs)
  }
  if (opts.engine.kind === 'llamafile') {
    // llamafile: llama.cpp's server in a single multi-mode binary. extraArgs carries the
    // standard llama.cpp profileToArgs flags; llamafileServerCommand prepends
    // `--server --no-webui` to switch the binary into server mode.
    return llamafileServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1', opts.extraArgs)
  }
  return { cmd: opts.engine.binPath, args: buildArgs(opts, port, slotSavePath) }
}

/** Readiness deadline by engine kind. Python engines cold-start far slower than
 *  llama.cpp: vLLM loads weights, compiles CUDA graphs, and warms up — routinely
 *  minutes for a large model — so it gets a longer window before we declare a
 *  readiness timeout. */
function readinessTimeoutMs(kind: string): number {
  return kind === 'vllm' || kind === 'sglang' ? 600_000 : 120_000
}

/** Environment for a spawned engine. For native engines (llama.cpp, koboldcpp, llamafile) on
 *  Linux, points `LD_LIBRARY_PATH` at the binary's own directory: a source build compiled
 *  with CUDA bundles its runtime `.so` files there (build-runner.ts `copyCudaRuntimeLibs`),
 *  but unlike Windows the dynamic linker doesn't search the executable's directory by
 *  default — without this, a self-built engine fails to start with missing-library errors.
 *  Harmless when nothing is bundled there. Native engines on Windows still inherit the
 *  daemon env unchanged (undefined). For Python engines we:
 *   - prepend the venv's bin dir to PATH so venv-installed tools (notably `ninja`,
 *     used by FlashInfer's JIT kernel compiler) are found without a system install
 *     (BUG-005),
 *   - force HuggingFace OFFLINE so a model load / request can never block on a network
 *     call (TurboLLM downloads models itself; it is offline-first), and
 *   - point the HF cache at a real, created dir inside the TurboLLM data dir so mlx-lm's
 *     `/v1/models` (which calls huggingface_hub `scan_cache_dir()`) doesn't crash with
 *     CacheNotFound when `~/.cache/huggingface/hub` is absent. */
function pyEngineEnv(kind: string, dataDir: string, binPath: string): NodeJS.ProcessEnv | undefined {
  if (kind !== 'mlx' && kind !== 'rapid-mlx' && kind !== 'vllm' && kind !== 'sglang') {
    if (process.platform === 'win32') return undefined
    const dir = dirname(binPath)
    // Append the existing value only if it's non-empty — glibc's dynamic linker treats an
    // empty LD_LIBRARY_PATH entry (a bare trailing ':') as "search the current working
    // directory", which a trailing `:${undefined ?? ''}` would otherwise produce whenever
    // LD_LIBRARY_PATH wasn't already set.
    const existing = process.env.LD_LIBRARY_PATH
    return { ...process.env, LD_LIBRARY_PATH: existing ? `${dir}:${existing}` : dir }
  }
  const hfHome = join(dataDir, 'hf-cache')
  const hubCache = join(hfHome, 'hub')
  mkdirSync(hubCache, { recursive: true })
  const venvBin = dirname(binPath)
  const pathSep = process.platform === 'win32' ? ';' : ':'
  return {
    ...process.env,
    PATH: `${venvBin}${pathSep}${process.env.PATH ?? ''}`,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HOME: hfHome,
    HF_HUB_CACHE: hubCache,
  }
}

/** Scan a Python engine's log tail for a fatal model-load failure. mlx-lm loads the
 *  model in a background "_generate" thread; if `load_weights` throws (e.g. a model
 *  architecture or quantization the installed mlx-lm version doesn't support), that
 *  thread dies but the HTTP server keeps answering /v1/models, so chat requests queue
 *  to a dead thread and hang forever. We catch the crash and return a concise message;
 *  null when no such failure is present. */
function detectPyLoadFailure(lines: string[]): string | null {
  const text = lines.join('\n')
  // Gate on the load path specifically so unrelated tracebacks (e.g. the /v1/models
  // CacheNotFound handler) never false-trigger this.
  const isLoadCrash =
    /Exception in thread[^\n]*_generate/.test(text) ||
    /in load_default\b/.test(text) ||
    /in load_model\b/.test(text) ||
    /load_weights/.test(text)
  if (!isLoadCrash) return null
  // The final "SomeError: message" / "SomeException: message" line is the useful detail.
  const errLine = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception):/.test(l.trim()))
  const detail = (errLine ? errLine.trim() : 'the model failed to load').slice(0, 200)
  return (
    `MLX could not load this model — ${detail} ` +
    `This usually means the installed mlx-lm version does not support this model's architecture or quantization.`
  )
}

function buildArgs(opts: StartOpts, port: number, slotSavePath?: string): string[] {
  const args = ['-m', opts.modelPath, '--host', '127.0.0.1', '--port', String(port)]
  const flags = opts.engine.capabilities.flags
  if (flags.length === 0 || flags.includes('--metrics')) args.push('--metrics')
  if (flags.includes('--no-webui')) args.push('--no-webui')
  // KV prompt-cache persistence (F-014): arms the slot save/restore endpoints. The caller
  // only supplies a path once it has checked the cap (caps.flags allow it) and made the dir.
  if (slotSavePath) args.push('--slot-save-path', slotSavePath)
  args.push(...opts.extraArgs)
  return args
}

/** Checks a single port for availability without the 8081+ walk — used to try a
 *  user-pinned {@link StartOpts.preferredPort} first, falling back to the normal
 *  walk (never rejecting) if it's already taken. */
function portFree(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function allocPort(preferredPort?: number): Promise<number> {
  if (preferredPort && preferredPort > 0 && (await portFree(preferredPort))) return preferredPort
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > 8181) return reject(new Error('no_free_port'))
      const srv = createServer()
      srv.once('error', () => tryPort(p + 1))
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(p)))
    }
    tryPort(8081)
  })
}

// Readiness means the MODEL is loaded, not merely that the HTTP port is open. For
// llama-server, /health returns 503 while the model loads and 200 only once it is
// ready, so we trust it exclusively. /v1/models returns 200 the instant the socket
// binds (before the weights finish loading), so it is NOT a readiness signal:
// falling back to it made the engine flip to "running" prematurely and then to
// "error" when the load actually failed — the contradictory-status bug users hit.
// We use /v1/models only for engines that genuinely lack /health (e.g. mlx-lm,
// which 404/501s the route).
export async function probeReady(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
    if (r.status === 200) return true
    // 404/501 → this engine has no /health route; fall through to /v1/models below.
    // 503 (still loading) or any other status → not ready yet, keep polling.
    if (r.status !== 404 && r.status !== 501) return false
  } catch {
    return false // connection refused / not up yet → keep polling
  }
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) })
    return r.status === 200
  } catch {
    return false
  }
}

async function gracefulStop(child: ChildProcess, exited: Promise<void>): Promise<void> {
  signalTerm(child)
  const forced = sleep(8000).then(() => 'timeout' as const)
  const result = await Promise.race([exited.then(() => 'exited' as const), forced])
  if (result === 'timeout') {
    forceKill(child)
    await exited
  }
}

function signalTerm(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T'], () => {})
  } else {
    child.kill('SIGTERM')
  }
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/F', '/T'], () => {})
  } else {
    child.kill('SIGKILL')
  }
}

// ── Engine process tracking (orphan prevention) ─────────────────────────────
// Each running engine records a pidfile under <dataDir>/run named by its OS pid and
// carrying its loopback port AND its owner — the pid of the daemon that spawned it.
// This is the safety net for the case the signal handlers can't cover: a daemon killed
// without a clean shutdown (terminal window closed on Windows, SIGKILL, crash, a
// force-exiting restart watchdog) would otherwise orphan llama-server — it keeps the
// model in RAM/VRAM and drains its request queue while a freshly started daemon reports
// "no model loaded". The next startup reaps these.
//
// The run dir is SHARED across daemon instances, and during a self-restart the old and
// new daemons are briefly alive together. So both operations are OWNER-AWARE: an engine
// is an orphan only when its owner daemon is gone (reapStaleEngines), and a daemon's exit
// handler kills only the engines IT owns (killTrackedEnginesSync). That keeps a dying old
// daemon from reaping the new daemon's freshly-loaded engine, and vice-versa.

interface EnginePidRecord {
  pid: number
  port: number
  owner: number
  file: string
}

function enginePidDir(dataDir: string): string {
  return join(dataDir, 'run')
}

function writeEnginePid(dataDir: string, pid: number, port: number): void {
  try {
    const dir = enginePidDir(dataDir)
    mkdirSync(dir, { recursive: true })
    // owner = this daemon's pid, so another instance can tell "managed by a live daemon"
    // apart from "true orphan whose daemon is gone".
    writeFileSync(join(dir, `engine-${pid}.pid`), JSON.stringify({ pid, port, owner: process.pid }))
  } catch {
    /* best-effort — tracking is a safety net, never block a load on it */
  }
}

function clearEnginePid(dataDir: string, pid: number): void {
  try {
    rmSync(join(enginePidDir(dataDir), `engine-${pid}.pid`), { force: true })
  } catch {
    /* best-effort */
  }
}

/** True if a pid is currently a running process. signal 0 only probes existence; EPERM
 *  means it exists but is owned elsewhere (still "alive" for our purposes). */
function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Parse the run dir into engine records, skipping/cleaning anything malformed. `owner`
 *  is 0 for legacy pidfiles written before owner tracking (treated as ownerless). */
function readEnginePidFiles(dataDir: string): EnginePidRecord[] {
  const dir = enginePidDir(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^engine-\d+\.pid$/.test(n))
  } catch {
    return [] // no run dir yet → nothing to reap
  }
  const out: EnginePidRecord[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const { pid, port, owner } = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; port?: number; owner?: number }
      if (typeof pid === 'number' && pid > 0) {
        out.push({ pid, port: typeof port === 'number' ? port : 0, owner: typeof owner === 'number' ? owner : 0, file })
      } else rmSync(file, { force: true })
    } catch {
      try { rmSync(file, { force: true }) } catch { /* best-effort */ }
    }
  }
  return out
}

/** True if something is currently listening on 127.0.0.1:port (a quick TCP connect).
 *  Used to confirm a tracked pid is really our orphaned engine before we kill it —
 *  guards against killing an unrelated process that recycled the pid (common on
 *  Windows). Engine ports (8081+) belong to us, so a live one means the orphan is up. */
function portAlive(port: number, timeoutMs = 600): Promise<boolean> {
  if (!port) return Promise.resolve(false)
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (alive: boolean) => {
      sock.destroy()
      resolve(alive)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/** Reap engine processes left behind by a previous daemon that didn't shut down
 *  cleanly. Called once at startup BEFORE anything loads a model. An engine is an orphan
 *  ONLY if its owner daemon is gone — an engine still owned by a live daemon (another
 *  running instance, or the outgoing daemon during a restart overlap) is left untouched.
 *  Among true orphans we still kill only when the recorded engine port is alive, so we
 *  never kill a recycled pid; otherwise just clear the stale file. Returns orphans killed. */
export async function reapStaleEngines(dataDir: string): Promise<number> {
  let killed = 0
  for (const { pid, port, owner, file } of readEnginePidFiles(dataDir)) {
    // Owner still running → a live daemon manages this engine; not ours to reap.
    if (owner && pidAlive(owner)) continue
    if (await portAlive(port)) {
      killPidTree(pid)
      killed++
    }
    try { rmSync(file, { force: true }) } catch { /* best-effort */ }
  }
  return killed
}

/** Synchronous best-effort kill of the engines THIS daemon owns, for a process 'exit'
 *  handler (which can't await). A last line of defence on top of the signal handlers; the
 *  startup reap is the real guarantee. Owner-scoped so a daemon exiting during a restart
 *  overlap never kills the incoming daemon's engine. */
export function killTrackedEnginesSync(dataDir: string): void {
  for (const { pid, owner, file } of readEnginePidFiles(dataDir)) {
    if (owner !== process.pid) continue // not ours — leave another daemon's engine + file alone
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'])
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch {
      /* process already gone */
    }
    try { rmSync(file, { force: true }) } catch { /* best-effort */ }
  }
}

/** Kill a process tree by pid (async, fire-and-forget). taskkill /T on Windows takes
 *  the whole tree; SIGKILL on POSIX. */
function killPidTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/F', '/T'], () => {})
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

function readTail(path: string, n: number): string[] {
  if (!path || !existsSync(path)) return []
  try {
    const lines = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '').split('\n').map((l) => l.replace(/\r$/, ''))
    return lines.length > n ? lines.slice(-n) : lines
  } catch {
    return []
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
