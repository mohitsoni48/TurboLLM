// Engine lifecycle state machine (A2, spec 03 §4): stopped → starting → running
// → stopping → stopped, plus error. Owns the single running engine process.
// Ports the verified Go manager to node:child_process.
import { type ChildProcess, execFile, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { ConfigStore, Engine } from '../config/config'
import type { LoadProfile } from '../models/profile'
import { mlxServerCommand } from './mlx'
import { RotatingLogStream, readTail } from './engine-log'
import { rapidMlxServerCommand } from './rapid-mlx'
import { layaServerCommand } from './laya'
import { mlxVlmServerCommand } from './mlx-vlm'
import { koboldcppServerCommand } from './koboldcpp'
import { llamafileServerCommand } from './llamafile'
import { slotCacheDir } from './slot-cache'
import { emitInvalidation } from '../events/bus'
import { probeAudioInput } from './modalities'
import { rememberLitertLmModel, type LitertLmRequestInfo } from './litert-lm-request'
import { litertlmHeaderFromFile } from '../models/litertlm'
import { isTetheredGroupLeader, killTetheredTree, spawnTethered } from '../util/tether'
import { START_TIME_TOLERANCE_MS, processStartTimes } from '../util/process-start-time'
import { hostUname, vllmModelRunnerEnv, vllmServerCommand, vllmServeBlocker } from './vllm'
import { sglangServerCommand, sgLangServeBlocker } from './sglang'
import {
  isNativeLitertLm,
  litertLmConfigPath,
  litertLmLoadFailureMessage,
  litertLmPathBlocker,
  litertLmServeBlockerCached,
  litertLmServerCommand,
  warmUpLitertLm,
  writeLitertLmConfig,
  type LitertLmConfig,
} from './litert-lm'

export type State = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface ModelInfo {
  key: string
  name: string
  quant: string
  ctx: number
  vision: boolean
  /** The model takes audio as input (a chat message's `input_audio` part). At load it is what the model file itself
   *  declares, where the engine is known to honour it; status() replaces it with the running engine's own answer once
   *  it has one (modalities.ts). Absent = no. */
  audio?: boolean
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
  /** LiteRT-LM backend/context/threads (litertLmProfileToConfig). Written to a per-port JSON file and passed with
   *  `--config`; only consumed by the litert-lm branch of {@link engineCommand}. */
  litertLmConfig?: LitertLmConfig
  /** LiteRT-LM: what each request to the model carries from this load (the sampling the user set for it, the bundle's
   *  own sampler); recorded at start for the request shaping (litert-lm-request.ts). */
  litertLmRequest?: LitertLmRequestInfo
  /** Per-model pinned port (LoadProfile.port), engine-agnostic. Tried first by
   *  allocPort(); falls back to the normal 8081+ walk if unset or already taken. */
  preferredPort?: number
  /** The resolved config this load was built from, when the caller has one
   *  (routes.ts's load route, cli.ts's startup resume, model-router.ts's
   *  gateway switch — all resolve a real `LoadProfile` before calling
   *  `load()`). Absent for the transitional dev-model fallback path, which
   *  has no profile at all. Purely additive and telemetry-only (`model_load`,
   *  ADR-333/spec 23 §3.3) — nothing in `Manager` itself reads this; `extraArgs`
   *  remains the only thing that actually reaches the spawned process. */
  profile?: LoadProfile
  /** Who initiated this load — set by the caller, since `Manager` itself has
   *  no way to distinguish a UI click from a gateway auto-switch from a
   *  startup resume. Telemetry-only, same as `profile`. */
  trigger?: 'manual' | 'gateway_switch' | 'resume'
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

/** Hooks a load or start runs inside the global load gate. `beforeStart` runs first, before the start's own awaits
 *  (the vLLM/SGLang/LiteRT-LM preflight, the port allocation). `beforeSpawn` runs after the last of them, in the same
 *  tick as the spawn, so whatever it checks still holds when the engine starts. A throw from either starts nothing and
 *  rejects the load; a {@link LoadPausedError} is not reported as a failed load. */
export interface LoadHooks {
  /** load() only: the first thing it runs under the global load lock, before it stops the engine. A throw rejects the
   *  load and leaves the engine exactly as it was (no stop, no 'error'): keep-N eviction re-checks there that its
   *  victim is still idle, since a request can reach it while the load waits for the lock (review M1). */
  beforeStop?: () => void
  beforeStart?: () => Promise<void>
  beforeSpawn?: () => void
}

/** A hook's refusal that is a pause, not the load failing: the ComfyUI guard's while a render holds the GPU, whose
 *  release resumes the load. load() keeps it as the engine's error, as any throw (the guard recognises its message
 *  there), but does not report it to onLoadSettled: telemetry's model_load counted every load a render paused as a
 *  failed one (load_failed), once per refusal, and the resumed load then reported its own outcome as well. */
export class LoadPausedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoadPausedError'
  }
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

  private engineState: State = 'stopped'
  /** Every state change is announced: /status and the models list (its `loaded` flags) both read it. */
  private get state(): State {
    return this.engineState
  }
  private set state(next: State) {
    if (next === this.engineState) return
    this.engineState = next
    announceEngineChange()
  }
  private opts: StartOpts | null = null
  private port = 0
  private pid = 0
  private child: ChildProcess | null = null
  private startedAt = 0
  private errInfo: ErrInfo | null = null
  /** Optional observer for load outcomes, wired in cli.ts (ADR-299). Kept as a
   *  plain callback so Manager has no telemetry dependency and tests need no
   *  stub. A throwing observer must never break a load. `opts` is the exact
   *  `StartOpts` this attempt was called with (spec 23 §3.3's `model_load`
   *  needs the resolved config) — passed explicitly by the caller rather than
   *  read off `this.opts`, so the report never depends on where `this.opts`
   *  is assigned: an early preflight failure (vLLM/SGLang unsupported) once
   *  returned before that assignment and reported the PREVIOUS load's config
   *  for a failure that had nothing to do with it. */
  onLoadSettled?: (ok: boolean, err: ErrInfo | null, opts: StartOpts) => void
  /** Whether work the idle watchdog cannot see still needs the loaded model, wired in cli.ts on the primary
   *  Manager: a chat whose turn holds its slot (generating, compacting, or waiting for a tool-call approval
   *  within Settings' approval wait), or whose finished reply's auto-title or memory call is still pending
   *  (chat-routes.ts chatHoldsEngine). The watchdog does not unload while it says so. The generation count
   *  alone missed the auto-compaction a turn runs before its first request, a manual compaction, and those calls
   *  after the turn's end, none of which holds a generationStart: once the TTL had passed since the load (or the
   *  last gateway request) the watchdog unloaded the model under them, the compaction failed, and the reply's
   *  title and memory were lost. While either holds, each watchdog tick restarts the idle clock, so the timeout
   *  counts from when the last of that work let go (to within the watchdog's minute). Unset (a pool slot, a test),
   *  the watchdog reads only the generation count, as before. */
  holdsEngine?: () => boolean
  private lastCommand: { cmd: string; args: string[] } | null = null
  private lastActivity = 0
  private logPathStr = ''
  /** The engine log's write stream errored during this run: the log no longer grows, so log growth proves nothing
   *  about a load and the stall watch stands down (readiness). Reset at each spawn. */
  private logStreamFailed = false
  private exited: Promise<void> = Promise.resolve()
  private resolveExited: (() => void) | null = null
  private generation = 0
  /** Holds taken with hold(): work that needs the engine between its requests, which is not a generation. */
  private holds = 0
  private liveGen: LiveGen | null = null
  private session: SessionAccumulator = freshSession()
  /** Whether the running engine says its model takes audio (modalities.ts); null until it has answered, and for an
   *  engine that does not say. */
  private audioInput: boolean | null = null
  /** The idle watchdog (watchdogTick), armed only while an engine process is alive. An interval armed for the
   *  Manager's whole life kept every pool-slot Manager the gateway dropped (and its per-minute config clone) alive
   *  forever; armed this way, a stopped Manager holds no timer and is collected once nothing references it. */
  private watchdog: ReturnType<typeof setInterval> | null = null
  private readonly poolSlot: boolean
  /** The load() in flight, or a start() that reports (`report`), from its entry into the load gate until it reports.
   *  A ComfyUI render's stop marks it paused (stopAndWait's `onPausedLoad`): it then reports nothing, as a load the
   *  guard's hooks refuse does not (LoadPausedError), and the guard reports the reload of it instead. */
  private reporting: { paused: boolean } | null = null

  /** `poolSlot`: this Manager runs a gateway pool slot (ModelRouter) beside the primary, often on the same
   *  engine, so its engine log gets a file of its own (see startInternal). */
  constructor(private store: ConfigStore, options: { poolSlot?: boolean } = {}) {
    this.poolSlot = options.poolSlot ?? false
  }

  /** Load a model, freeing any currently-loaded one first — the single atomic
   *  swap entry point (rules 1–3). Runs under the global load gate so the stop +
   *  optional pre-start hook (e.g. the ComfyUI VRAM free) + spawn + readiness wait
   *  are one indivisible operation; no other load can interleave. Never throws on a
   *  model that simply fails to load — callers read status() for the running/error
   *  outcome. */
  async load(opts: StartOpts, hooks?: LoadHooks): Promise<void> {
    // Declared outside the try so the catch block below also reports whichever opts were
    // actually last attempted — a throw from the fallback's own startInternal() must not
    // fall back to reporting the original (mmproj-attached) opts, same defect class this
    // whole fallback mechanism exists to fix.
    let effectiveOpts = opts
    await Manager.runExclusive(async () => {
      // Synchronous, and in the same tick as the stop below, so nothing can start on the engine between the two.
      hooks?.beforeStop?.()
      const attempt = { paused: false }
      this.reporting = attempt
      try {
        if (this.state === 'running' || this.state === 'starting' || this.state === 'stopping') {
          await this.stopAndWait()
        }
        // Recorded before the hook, which can refuse the load (ComfyUI rendering): restart() then retries
        // THIS model, not the one just stopped (startInternal records it too, for start()).
        this.opts = opts
        this.lastCommand = null
        if (hooks?.beforeStart) await hooks.beforeStart()
        await this.startInternal(opts, undefined, hooks?.beforeSpawn)
        await this.awaitNotStarting()
        // GitHub report (Qwen3.6-35B-A3B): the multimodal projector can fail to load even with
        // the model's own correct, official mmproj — see mmprojFallbackOpts's doc comment. Retry
        // ONCE, text-only, instead of leaving a model that could otherwise run fine unloaded.
        if (this.state === 'error' && this.errInfo) {
          const fallback = mmprojFallbackOpts(opts, this.errInfo)
          if (fallback) {
            // Computed from the pre-crash errInfo, before the await below can let a fresh
            // onTerminated() overwrite it.
            const note = mmprojFallbackNote(this.errInfo)
            // readiness()'s timeout path sets state='error' and fires child.kill() WITHOUT
            // awaiting the process's actual exit — awaitNotStarting() only waits for state to
            // leave 'starting', which happens the instant the kill is ISSUED, not once it's
            // landed. Racing the fallback spawn against that in-flight kill could leave two
            // engine processes alive at once (double VRAM allocation, violating the "at most
            // one load in flight" invariant above) and orphans the first child's pid file +
            // log stream, since onTerminated() no-ops once `this.child` no longer matches.
            // `this.exited` resolves exactly when the first child's onTerminated() finishes —
            // waiting on it here (already-resolved in the common immediate-crash case, so
            // effectively free) guarantees that cleanup has fully run before anything new spawns.
            await this.waitForExit(this.exited)
            // Set BEFORE the spawn (not after) so a throw out of startInternal() below is
            // still attributed to the config that actually threw, not the original one.
            effectiveOpts = fallback
            await this.startInternal(fallback, note, hooks?.beforeSpawn)
            await this.awaitNotStarting()
          }
        }
        // Both routes.ts call sites fire load() without awaiting, so the outcome
        // is not observable to the caller. Reporting it here — the single atomic
        // swap entry point — is what makes any future call site instrumented for
        // free. Manager stays telemetry-agnostic: it reports an outcome, and the
        // consumer (wired in cli.ts) decides what that means. Uses effectiveOpts (the
        // fallback's, when one ran and the retry is what actually ended up loaded/failed)
        // so a successful text-only fallback isn't misreported as a load "with mmproj". A load a ComfyUI render
        // stopped while it started did not fail either: that render's release reloads it, and reports the reload.
        if (!attempt.paused) this.reportLoad(this.state === 'running', this.errInfo, effectiveOpts)
      } catch (e) {
        // routes.ts fires load() without awaiting and only console.warns the rejection —
        // without this, a failed swap left `state` wherever it last was (often still
        // 'stopping'), which read to the user as "no model loaded" with no indication
        // anything went wrong or that a retry could help.
        this.state = 'error'
        this.errInfo = { code: 'load_failed', message: e instanceof Error ? e.message : String(e), exitCode: -1, logTail: [] }
        // A load a ComfyUI render paused did not fail: that render's release resumes it, and the resumed load reports.
        if (!attempt.paused && !(e instanceof LoadPausedError)) this.reportLoad(false, this.errInfo, effectiveOpts)
        throw e
      } finally {
        if (this.reporting === attempt) this.reporting = null
      }
    })
  }

  /** Start a model assuming nothing is loaded (throws BusyError otherwise). Held by
   *  the global load gate through readiness so concurrent loads can't spin up two
   *  engines at once. Most callers want load() (which stops first); this exists for
   *  paths that have already ensured the engine is free (bench, ComfyUI reload). `hooks` run inside the gate, as
   *  load()'s do: a throw from one starts nothing and rejects the start. `report`: report the outcome as load() does
   *  (the ComfyUI guard's reload of a load a render stopped while it started, which reported nothing); a start that
   *  is paused, refused by the guard (LoadPausedError) or finds another model loaded (BusyError: that load reports its
   *  own) reports nothing. */
  async start(opts: StartOpts, hooks?: LoadHooks, report = false): Promise<void> {
    await Manager.runExclusive(async () => {
      const attempt = report ? { paused: false } : null
      this.reporting = attempt
      try {
        if (hooks?.beforeStart) await hooks.beforeStart()
        await this.startInternal(opts, undefined, hooks?.beforeSpawn)
        await this.awaitNotStarting()
        if (attempt && !attempt.paused) this.reportLoad(this.state === 'running', this.errInfo, opts)
      } catch (e) {
        if (attempt && !attempt.paused && !(e instanceof LoadPausedError) && !(e instanceof BusyError)) {
          const message = e instanceof Error ? e.message : String(e)
          this.reportLoad(false, { code: 'load_failed', message, exitCode: -1, logTail: [] }, opts)
        }
        throw e
      } finally {
        if (this.reporting === attempt) this.reporting = null
      }
    })
  }

  /** Notify the load observer, swallowing anything it throws — an observer is
   *  by definition not allowed to affect whether a model loaded. `opts` is
   *  passed through from the call site's own local parameter, not read off
   *  `this.opts` — see {@link onLoadSettled}'s doc comment for why that
   *  distinction matters for an early preflight failure. */
  private reportLoad(ok: boolean, err: ErrInfo | null, opts: StartOpts): void {
    try {
      this.onLoadSettled?.(ok, err, opts)
    } catch {
      // observers are advisory only
    }
  }

  /** Wait until the engine leaves the 'starting' state (→ running or error/stopped),
   *  bounded by the readiness window plus a small grace. The internal readiness loop
   *  flips the state and surfaces errors; this just keeps the load gate held until
   *  that resolves. */
  private async awaitNotStarting(): Promise<void> {
    const deadline = loadTiming.now() + READINESS_TIMEOUT_MS + 5_000
    while (this.state === 'starting' && loadTiming.now() < deadline) await loadTiming.sleep(200)
  }

  private async startInternal(opts: StartOpts, retryNote?: string, beforeSpawn?: () => void): Promise<void> {
    if (this.state === 'starting' || this.state === 'running' || this.state === 'stopping') {
      throw new BusyError()
    }
    // From here on this attempt is the engine's model, even when it fails before the spawn (a preflight
    // return or a throw below): restart() retries it, and launchCommand() shows no argv rather than the
    // previous model's.
    this.opts = opts
    this.lastCommand = null
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

    let litertLmRequest = opts.litertLmRequest
    if (opts.engine.kind === 'litert-lm') {
      // Cached probe (litertLmServeBlockerCached): this runs on EVERY load and auto-resume,
      // and the probe spawns a fresh Python process that dlopens the native library —
      // noticeable on a phone. The result is stable for an unchanged venv, so it is cached
      // per interpreter + installed-package mtime and only re-run after a reinstall.
      // The Android app's native server has no interpreter to probe; its library is checked when the APK is built.
      const blocker = litertLmPathBlocker(opts.modelPath) ??
        (isNativeLitertLm(opts.engine.binPath) ? null : await litertLmServeBlockerCached(opts.engine.binPath))
      if (blocker) {
        this.state = 'error'
        this.errInfo = { code: 'engine_unsupported', message: blocker, exitCode: -1, logTail: [] }
        return
      }
      // A load that carries nothing of the bundle (a .litertlm loaded by path, also one restarted onto LiteRT-LM from
      // another engine, a devModel resumed): its requests get the bundle's own sampler, read from its header here as
      // the scanner reads a library entry's. Without it a thread's temperature alone went alone, which `serve`
      // completes with top_k 1 (greedy: the temperature did nothing), and nothing said so. Read before the port is
      // taken, after which nothing may yield (below).
      if (!litertLmRequest) {
        const { sampler } = await litertlmHeaderFromFile(opts.modelPath)
        litertLmRequest = { sampling: {}, ...(sampler ? { sampler } : {}) }
      }
    }

    const port = await allocPort(opts.preferredPort)
    // The last await before the spawn: from here to `state = 'starting'` nothing yields, so a check made here (the
    // ComfyUI guard's, against a render that began during the preflight above) still holds when the engine starts.
    beforeSpawn?.()
    // A pool slot often runs on the same engine as the primary, so it logs to a file named by its port (unique
    // among live engines): sharing the primary's file truncated it and interleaved both engines' output, and every
    // reader of logPath() (logs route, error banner, mmproj fallback, load-failure checks) saw the other's lines.
    const logName = this.poolSlot ? `engine-${opts.engine.id}-${port}.log` : `engine-${opts.engine.id}.log`
    const logPath = join(this.store.dir(), 'logs', logName)
    mkdirSync(dirname(logPath), { recursive: true })
    const logStream = new RotatingLogStream(logPath) // truncates; rotates to .1 past 50 MB
    // The log is best-effort: without a listener, a failed write (disk full) is an unhandled 'error' event,
    // which takes the whole daemon down.
    this.logStreamFailed = false
    logStream.on('error', (e) => {
      this.logStreamFailed = true
      console.warn(`[engine] log write failed: ${e.message}`)
    })
    // Header so the raw engine log is self-explanatory. `port` is the engine's OWN
    // loopback port (allocated 8081+), DISTINCT from the TurboLLM app/UI port the
    // user configures — surfacing it here stops the "it says 8081 even though I
    // changed the port" confusion, since this log is what the user reads.
    logStream.write(
      `[turbollm] starting engine "${opts.engine.name}" on internal port ${port} ` +
        `(127.0.0.1 only — the engine's own port, NOT the TurboLLM app/UI port).\n`,
    )
    if (retryNote) logStream.write(retryNote)

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

    // LiteRT-LM takes backend/context/threads from a JSON file (`serve --config`), one per port so two
    // engines never share (and overwrite) each other's settings.
    let litertConfigPath: string | undefined
    if (opts.engine.kind === 'litert-lm') {
      litertConfigPath = litertLmConfigPath(this.store.dir(), port)
      // No config (a load by path built before this one, a restart onto LiteRT-LM of a load by path): nothing is set,
      // so the server chooses from the model, as for a profile that sets nothing. It used to write the CPU, which a
      // GPU-only bundle cannot run on.
      writeLitertLmConfig(litertConfigPath, opts.litertLmConfig ?? { default: {} })
      // What its requests carry, by model path (litert-lm-request.ts); for a load that carried none, read above.
      rememberLitertLmModel(opts.modelPath, { ...(litertLmRequest ?? { sampling: {} }), native: isNativeLitertLm(opts.engine.binPath) })
    }

    const { cmd, args } = engineCommand(opts, port, slotSavePath, litertConfigPath)
    // The command as a human would type it in their own terminal — stored for "copy exact launch command" (GitHub
    // Discord ask). Not logged before now: the file only ever had a port-only header line, never the real argv.
    this.lastCommand = { cmd, args }
    // Tethered (util/tether.ts): the engine, and every worker it starts in its process group (vLLM's and SGLang's
    // Python workers, a pool slot's own), end the moment the daemon does, however it ends. A SIGKILLed, crashed or
    // out-of-memory-killed daemon used to leave llama-server running, parented to init, holding the model's VRAM and
    // its port until the next start's reaper found it, and one still loading (no port open yet) not even then. On
    // POSIX the wrapper is a `/bin/sh` that execs the engine, so a llamafile (an Actually Portable Executable that
    // execve refuses with ENOEXEC) runs through sh as the old shellWrapped did. Windows spawns it as before, in libuv's
    // kill-on-close job.
    const child = spawnTethered(cmd, args, { cwd: dirname(cmd), windowsHide: true, env: pyEngineEnv(opts.engine.kind, this.store.dir(), opts.engine.binPath) }, { kind: 'engine' })
    // end:false — otherwise whichever of stdout/stderr closes first would end the
    // shared log stream and drop the other's output. We close it in onTerminated.
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })
    // pipe() detaches on that error and leaves the engine's output paused: keep draining it, or the engine
    // blocks for good once its stdout pipe fills.
    logStream.once('error', () => {
      child.stdout?.resume()
      child.stderr?.resume()
    })

    this.state = 'starting'
    this.session = freshSession() // each running session starts with fresh stats (B4)
    this.audioInput = null
    this.port = port
    this.pid = child.pid ?? 0
    // Track the OS process on disk so a daemon that dies WITHOUT running its signal
    // handlers (terminal window closed, killed, crashed) can't leave llama-server
    // orphaned: the next startup reaps it (reapStaleEngines), and the exit handler
    // kills it synchronously (killTrackedEnginesSync). Cleared at the engine's exit, not only at its 'close' (in
    // onTerminated): a worker left holding its stdout holds 'close' back for as long as it lives, and in that window
    // the exit handler's kill (taskkill /T on Windows, the bare pid as the fallback on POSIX) named a pid Node had
    // already reaped, which may name another process by then.
    if (this.pid) {
      writeEnginePid(this.store.dir(), this.pid, port, isTetheredGroupLeader(child))
      const pid = this.pid
      const dir = this.store.dir()
      child.once('exit', () => clearEnginePid(dir, pid))
    }
    this.child = child
    this.startedAt = Date.now()
    this.errInfo = null
    this.lastActivity = Date.now()
    this.logPathStr = logPath
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.watchdogTick(), 60_000)
      this.watchdog.unref()
    }
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

  /** `onPausedLoad`: the ComfyUI guard's stop for a render. A load() still starting, or up and not yet reported, is
   *  paused, not failed: it reports nothing, and onPausedLoad is called (before the first await), so the guard reports
   *  the reload of it (start()'s `report`). That load was reported as a failed one, and its reload, a start(), reported
   *  nothing. */
  async stopAndWait(opts?: { force?: boolean; onPausedLoad?: () => void }): Promise<void> {
    const loading = this.reporting
    if (opts?.onPausedLoad && loading && !loading.paused && (this.state === 'starting' || this.state === 'running')) {
      loading.paused = true
      opts.onPausedLoad()
    }
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
    const result = await exitedWithin(exited, 10_000)
    if (result === 'timeout' && this.child) {
      forceKill(this.child)
      // Bounded too: forceKill's taskkill is fire-and-forget (failures swallowed), so an
      // unbounded await here on an unkillable/zombie process would wedge this forever —
      // and since stopAndWait() runs inside the exclusive load gate, that deadlocks every
      // future load(), which is worse than the 'stuck at stopping' bug this replaced.
      await exitedWithin(exited, 5_000)
    }
  }

  /** `hooks` as for load(): the ComfyUI guard's reload of a load a render paused refuses it in there when a new
   *  render has begun. */
  async restart(hooks?: LoadHooks): Promise<void> {
    const opts = this.opts
    if (!opts?.modelPath) throw new Error('no_such_model')
    // load() stops the current engine (if any) and starts the same opts again, all
    // under the global load gate — so a restart can't race a concurrent swap.
    await this.load(opts, hooks)
  }

  /** The exact command last spawned, formatted for copy-paste into a terminal
   *  (GitHub Discord ask — "copy exact launch command"). Meaningful while this engine is
   *  the one actually running, still starting, or just failed to start (its own error
   *  banner's "show launch command and diagnostics" control, QA_BUGS.md BUG-11); null
   *  once stopped/swapped for any other reason so a stale command from a PREVIOUS model
   *  can never be copied as if it were current.
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
    // 'error' is included deliberately (QA_BUGS.md BUG-11): `lastCommand` is set
    // immediately before every spawn attempt (below), so right after a failed one the
    // engine is in 'error' and `lastCommand` is exactly the argv that just failed — the
    // most useful diagnostic a "show launch command" control could show. Excluding it
    // left that button a documented no-op: the daemon had nothing to show, so toggling it
    // visibly did nothing. This is still never a STALE command: an attempt that fails before
    // a spawn (the vLLM/SGLang/LiteRT-LM preflight, a refused or throwing load) clears
    // `lastCommand` (startInternal, load), so its error shows no command rather than the
    // previous model's (a different model's command shown as if it were the current one).
    if (this.state !== 'running' && this.state !== 'starting' && this.state !== 'error') return null
    if (!this.lastCommand) return null
    const args = this.lastCommand.args.filter((a) => a !== '--no-webui')
    const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
    return [this.lastCommand.cmd, ...args].map(quote).join(' ')
  }

  /** How many generations the RUNNING engine can genuinely serve at once, or null when that can't
   *  be determined.
   *
   *  Read off the launch args rather than the saved profile on purpose: this must describe the
   *  process that is actually running, not what config says the next launch would use — the two
   *  diverge the moment a profile is edited while an engine is up.
   *
   *  null (not 1) when the engine advertises no `--parallel`: vLLM and mlx-lm do their own
   *  continuous batching, and capping them at one concurrent request because we couldn't read a
   *  flag would be a new restriction, not a safe default. Callers treat null as "unbounded".
   *
   *  Worth knowing when raising it: llama.cpp splits `-c` across the parallel sequences, so N
   *  slots means roughly ctx/N each, and `slot-cache.ts` only keeps its persistent KV cache at
   *  `--parallel 1` ("multi-stream splits the KV"). More concurrency genuinely costs context and
   *  prompt-cache reuse; it is not free. */
  parallelSlots(): number | null {
    if (this.state !== 'running' && this.state !== 'starting') return null
    const args = this.lastCommand?.args
    if (!args) return null
    const i = args.indexOf('--parallel')
    if (i === -1 || i + 1 >= args.length) return null
    const n = Number(args[i + 1])
    return Number.isInteger(n) && n > 0 ? n : null
  }

  status(): Status {
    const st: Status = { state: this.state, err: this.errInfo, port: this.port, pid: this.pid, model: null, loadElapsedMs: 0 }
    if ((this.state === 'running' || this.state === 'starting') && this.opts) {
      st.model = this.audioInput === null ? this.opts.model : { ...this.opts.model, audio: this.audioInput }
      if (this.state === 'starting') st.loadElapsedMs = Date.now() - this.startedAt
    }
    return st
  }

  /** Ask the engine that just became ready whether its model takes audio, once per load. The answer changes what
   *  /status says about the model, so the pages showing it are told. */
  private async learnAudioInput(child: ChildProcess, port: number): Promise<void> {
    const audio = await loadTiming.audioInput(port)
    if (audio === null || this.child !== child || this.state !== 'running') return
    this.audioInput = audio
    if (audio !== (this.opts?.model.audio === true)) announceEngineChange()
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

  /** The StartOpts restart() retries: the last load attempted, also one that failed or was refused (status() and
   *  currentOpts() name no model then). The ComfyUI guard reads it to tell which model its release() loads. */
  restartOpts(): StartOpts | null {
    return this.opts
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
  /** A turn's generation (a chat or Code turn, a gateway or extension request) starts or ends. Both restart the idle
   *  clock (lastActivity): only a load and a gateway request (touch) did, so the idle timeout counted from the load
   *  and unloaded a model in active chat use between two replies, once the timeout had passed since it was loaded. */
  generationStart(): void {
    this.generation++
    if (this.generation === 1) announceEngineChange()
    this.lastActivity = Date.now()
  }
  /** Marks the engine in use until the returned release is called, for work that sends requests with gaps between them
   *  (a one-shot CLI routine: one request per turn, its tools run in between). Every idle read honours it (isHeld: the
   *  idle watchdog, engineIsIdle, the router's eviction), but it is no generation: activeRequests and the live
   *  generation of the engine card stay at what is really in flight. The release is idempotent. */
  hold(): () => void {
    this.holds++
    this.lastActivity = Date.now()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds = Math.max(0, this.holds - 1)
      this.lastActivity = Date.now()
    }
  }
  /** Whether a hold() is in place, or the chat work holdsEngine reports. */
  isHeld(): boolean {
    return this.holds > 0 || !!this.holdsEngine?.()
  }
  /** Whether a hold() is in place: work running between its own requests (a one-shot CLI routine). Unlike isHeld()
   *  it leaves out holdsEngine's chat work, whose parked approval waits active work and host idleness exclude. */
  hasHolds(): boolean {
    return this.holds > 0
  }
  generationEnd(): void {
    const wasGenerating = this.generation > 0
    this.generation = Math.max(0, this.generation - 1)
    if (this.generation === 0) this.liveGen = null
    if (wasGenerating && this.generation === 0) announceEngineChange()
    this.lastActivity = Date.now()
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
    // A stop already under way (a Stop, an eject, the idle unload, a restart's teardown: SIGTERM sent) is waited out.
    // Returning at once let the daemon exit about 1.5 s into that stop's 8 s grace, and the exit handler SIGKILLed the
    // engine's group before it could exit by itself. gracefulStop's own force kill bounds the wait, waitForExit too.
    if (child && this.state === 'stopping') return this.waitForExit(this.exited)
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
    // readiness() already recorded the real diagnosis and SIGKILLed the process itself
    // before this 'close' event fires — don't let the generic "exited unexpectedly" message
    // from that kill's own aftermath clobber it. Two diagnoses are protected: the readiness
    // timeout (GitHub #85 saw a useless "exit -1" instead of "didn't become ready in
    // time"), and a model-load failure detected either in a Python engine's log tail or by
    // the LiteRT-LM warm-up (a bad bundle / unusable GPU must keep its actionable message —
    // litertLmLoadFailureMessage — rather than degrade to "exited unexpectedly").
    const preDiagnosed =
      this.state === 'error' &&
      (this.errInfo?.code === 'readiness_timeout' || this.errInfo?.code === 'model_load_failed')
    try {
      logStream.write(
        cleanStop
          ? `\n[turbollm] engine stopped — the model is no longer loaded.\n`
          : preDiagnosed
            ? `\n[turbollm] engine process killed after the failure diagnosed above. The model did NOT load.\n`
            : `\n[turbollm] engine process exited unexpectedly (exit ${code})` +
                `${errMsg ? ` — ${errMsg}` : ''}. The model did NOT load / is no longer loaded.\n`,
      )
    } catch {
      /* best-effort marker */
    }
    logStream.end()
    if (cleanStop) {
      this.state = 'stopped'
    } else if (!preDiagnosed) {
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
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.session = freshSession() // session ended — clear stats (B4)
    this.audioInput = null
    this.resolveExited?.()
  }

  private async readiness(child: ChildProcess, port: number): Promise<void> {
    const kind = this.opts?.engine.kind ?? 'llama-server'
    const deadline = loadTiming.now() + READINESS_TIMEOUT_MS
    // Stall watch (review 4.8): the global load lock is held through this loop, so a hung engine would block every
    // other load for the whole cap. Output and probe-answer changes count as progress; see LoadProgress.
    const stallMs = loadStallMs(kind, this.store.read().engineLoadStallSeconds)
    const progress = new LoadProgress(loadTiming.now(), logSize(this.logPathStr), loadTiming.processActivity(this.pid))
    let warmingUp = false
    for (;;) {
      await loadTiming.sleep(loadTiming.pollMs)
      if (this.child !== child || this.state !== 'starting') return
      // mlx/vllm load the model in a background thread AFTER the HTTP socket binds, so
      // /v1/models answers 200 even when the load crashed — which would otherwise flip
      // us to "running" and then hang every request forever on a dead generation
      // thread. mlx-vlm's own --model preload is actually synchronous (blocks the ASGI
      // lifespan startup, so the socket never even binds on a preload failure — see
      // mlxVlmServerCommand's docblock) and a plain process exit already surfaces via
      // the exit handler above with a generic message; we still check it here because
      // this path additionally recovers a real traceback line — when the crash trips one
      // of detectPyLoadFailure's gate patterns; a bare "Failed to load model: ..." line on
      // its own does not — for a much more useful error than "exited unexpectedly". Detect
      // a fatal load-failure traceback in the log and surface it as an engine error
      // instead. (Checked before probeReady so we win the race.)
      if (kind === 'mlx' || kind === 'rapid-mlx' || kind === 'mlx-vlm' || kind === 'vllm' || kind === 'sglang') {
        const loadErr = detectPyLoadFailure(kind, readTail(this.logPathStr, 200))
        if (loadErr) {
          if (this.child === child && this.state === 'starting') {
            this.state = 'error'
            this.errInfo = { code: 'model_load_failed', message: loadErr, exitCode: -1, logTail: readTail(this.logPathStr, 20) }
            child.kill('SIGKILL')
          }
          return
        }
      }
      const probe = await loadTiming.probe(port)
      if (probe.ready) {
        // LiteRT-LM binds its socket and answers /v1/models before any model is loaded (it loads on the first chat
        // request), so the socket is not readiness: load it with a one-token warm-up, which is also where a bad
        // bundle or an unusable GPU surfaces.
        if (kind === 'litert-lm' && this.opts) {
          // The user's Backend: the config names one only when the user chose it (litertLmProfileToConfig).
          const backend = this.opts.litertLmConfig?.default.backend ?? 'auto'
          const res = await warmUpLitertLm(
            port,
            // The `model` field the warm-up must send is exactly what every real request
            // sends: the model file's own path (engineModelAlias('litert-lm', path) resolves
            // to the same thing — there is deliberately no second wrapper for it).
            this.opts.modelPath,
            AbortSignal.timeout(Math.max(1000, deadline - loadTiming.now())),
          )
          if (!res.ok) {
            if (this.child === child && this.state === 'starting') {
              this.state = 'error'
              this.errInfo = {
                code: 'model_load_failed',
                message: litertLmLoadFailureMessage(res.message, backend),
                exitCode: -1,
                logTail: readTail(this.logPathStr, 20),
              }
              child.kill('SIGKILL')
            }
            return
          }
        }
        if (this.child === child && this.state === 'starting') {
          this.state = 'running'
          this.lastActivity = Date.now()
          void this.learnAudioInput(child, port)
        }
        return
      }
      const now = loadTiming.now()
      if (now > deadline) {
        if (this.child === child && this.state === 'starting') {
          this.state = 'error'
          this.errInfo = {
            code: 'readiness_timeout',
            message: `The model did not become ready within ${Math.round(READINESS_TIMEOUT_MS / 1000)} seconds.`,
            exitCode: -1,
            logTail: readTail(this.logPathStr, 20),
          }
          child.kill('SIGKILL')
        }
        return
      }
      progress.observe(now, logSize(this.logPathStr), probe.answer, loadTiming.processActivity(this.pid))
      // Latched: once the engine says it is warming up, the rest of the load is silent by design (see WARMUP_MARKER).
      warmingUp ||= readTail(this.logPathStr, 50).some((l) => WARMUP_MARKER.test(l))
      if (!warmingUp && !this.logStreamFailed && progress.silentFor(now) >= stallMs) {
        if (this.child === child && this.state === 'starting') {
          // Same code as the cap's: it is the same failure (the engine never became ready), so the telemetry class, the
          // exit handler's preDiagnosed guard and the UI's banner treat it alike; only the message says why.
          this.state = 'error'
          this.errInfo = {
            code: 'readiness_timeout',
            message: `The engine made no progress for ${Math.round(stallMs / MINUTE_MS)} minutes while loading (no output, no process activity, and its readiness check did not change), so the load was stopped.`,
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
    // In use: a generation, or work the count cannot see (holdsEngine: a compaction, an approval wait, a reply's title
    // call). The clock restarts, so the timeout counts from when that work let go, not from the load.
    if (this.generation > 0 || this.isHeld()) {
      this.lastActivity = Date.now()
      return
    }
    if (this.state === 'running' && Date.now() - this.lastActivity > ttl * 60_000) this.stop()
  }
}

// ---- helpers ---------------------------------------------------------------

/** Build the spawn command for an engine, branching on its kind (spec 03 §2b).
 *  `slotSavePath` (F-014) is appended only for llama.cpp; mlx/vllm don't support it. */
export function engineCommand(opts: StartOpts, port: number, slotSavePath?: string, configPath?: string): { cmd: string; args: string[] } {
  if (opts.engine.kind === 'litert-lm') {
    // LiteRT-LM: `serve` has no model argument (the model path rides in each request) — launch options come from
    // the --config file. opts.extraArgs are the user's own `serve` flags.
    return litertLmServerCommand(opts.engine.binPath, configPath!, port, '127.0.0.1', opts.extraArgs)
  }
  if (opts.engine.kind === 'laya') {
    // Laya: the launcher serves laya's own /v1/systemone app over the model folder's checkpoints. It has no
    // launch flags, so opts.extraArgs is never used.
    return layaServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1')
  }
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
  if (opts.engine.kind === 'mlx-vlm') {
    // MLX-VLM: run the mlx_vlm.server OpenAI server via the provisioned venv python.
    // No launch-time sampling flags exist (per-request only, like Rapid-MLX/vLLM) —
    // opts.extraArgs is never used here.
    return mlxVlmServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1')
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

/** Readiness deadline, uniform across engine kinds. Used to be 120s for llama.cpp-family
 *  engines vs. 600s for vLLM/SGLang (Python engines cold-start slower) — but 120s turned
 *  out too short for llama.cpp too whenever a model file is large relative to available
 *  RAM/VRAM and has to page in from disk (GitHub #85 / ADR-304/306/308: a 65GB file on a
 *  Strix Halo APU still hadn't finished loading at 120s). Flat-bumped to 600s for every
 *  kind rather than trying to model disk throughput. */
const READINESS_TIMEOUT_MS = 600_000

const MINUTE_MS = 60_000

/** A load that shows no progress for the configured window (Config.engineLoadStallSeconds, default 120 s, 0 = off) ends
 *  early and frees the global load lock (ADR-067 stays: one load at a time, held through readiness; review 4.8). Native
 *  engines only (llama.cpp, KoboldCpp, llamafile): they print as they load (llama.cpp a dot per ~1% of the weights
 *  read), so a silent window means hung, not busy. A longer window is what the 10-minute cap above already is.
 *
 *  Three things are NOT stalls and stand the watch down (the engine is busy without printing): the warm-up phase
 *  (WARMUP_MARKER), the engine process's own CPU or disk activity (processActivity), and a failed log stream. */
function loadStallMs(kind: string, seconds: number): number {
  const native = kind === 'llama-server' || kind === 'koboldcpp' || kind === 'llamafile'
  return native && seconds > 0 ? seconds * 1000 : Infinity
}
// The Python engines (vLLM, SGLang, the MLX family, LiteRT-LM, Laya) are exempt (Infinity: only the cap applies): they
// compile kernels (FlashInfer's ninja build, torch.compile, CUDA-graph capture) and run LiteRT-LM's first-request
// warm-up with no output or probe change for minutes at a time, and a false stall-fail there would discard minutes of
// valid work.

/** llama.cpp (and its forks: ik_llama, TurboQuant, Prism) logs "common_init_from_params: warming up the model with an
 *  empty run - please wait ... (--no-warmup to disable)" and then prints nothing until the run ends, with /health a
 *  constant 503. With mmap and CPU-offloaded experts that run is where tens of GB are paged in, minutes on a slow disk.
 *  Matches the phrase, not "--no-warmup": the logged launch command carries that flag for users who pass it. */
const WARMUP_MARKER = /warming up the model/i

/** What counts as a load making progress: the engine's log grew (or rotated: any change in size), the readiness probe's
 *  answer changed (the port started accepting connections, /health went from refused to 503), or the engine process's
 *  own activity counter moved (null = unreadable here, which never counts). The log size is read at each poll rather
 *  than hooked into the stdout pipe: it sees exactly what reached the log, and survives rotation. */
class LoadProgress {
  private at: number
  constructor(now: number, private logBytes: number, private activity: number | null, private answer = '') { this.at = now }
  observe(now: number, logBytes: number, answer: string, activity: number | null): void {
    if (logBytes !== this.logBytes || answer !== this.answer || (activity !== null && activity !== this.activity)) this.at = now
    this.logBytes = logBytes
    this.answer = answer
    if (activity !== null) this.activity = activity
  }
  silentFor(now: number): number { return now - this.at }
}

function logSize(path: string): number {
  try { return statSync(path).size } catch { return -1 }
}

export interface ProbeResult { ready: boolean; answer: string }

/** The load clock, sleep and readiness probe, as one mutable object so a test can drive the real readiness loop with a
 *  virtual clock and a fake probe instead of waiting minutes (manager.stall.test.ts). Production values are the real ones. */
export const loadTiming = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => sleep(ms),
  probe: (port: number): Promise<ProbeResult> => probeHealth(port),
  audioInput: (port: number): Promise<boolean | null> => probeAudioInput(port),
  processActivity: (pid: number): number | null => readProcessActivity(pid),
  pollMs: 500,
}

/** A counter that moves while the engine process is busy, or null when this platform has no cheap way to read one.
 *  Linux: /proc/<pid>/io read_bytes (disk bytes the process caused to be fetched: mmap page-in counts) plus the
 *  utime+stime clock ticks from /proc/<pid>/stat. Windows and macOS: null. Windows has no cheap, reliable per-process
 *  I/O counter without a native addon or a spawned PowerShell/wmic per poll, and macOS has none without `ps`/`proc_pid`
 *  bindings, so there the log and the warm-up marker are the only signals. */
function readProcessActivity(pid: number): number | null {
  if (process.platform !== 'linux' || pid <= 0) return null
  let total = 0
  let found = false
  try {
    const m = /^read_bytes:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/io`, 'utf8'))
    if (m) { total += Number(m[1]); found = true }
  } catch { /* another user's process, or gone */ }
  try {
    // comm (field 2) may contain spaces and parens: split after its closing paren; utime and stime are then fields 12 and 13.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(rest[11]) + Number(rest[12])
    if (Number.isFinite(ticks)) { total += ticks; found = true }
  } catch { /* gone */ }
  return found ? total : null
}

/** Environment for a spawned engine. For native engines (llama.cpp, koboldcpp, llamafile) on
 *  Linux and Android, points `LD_LIBRARY_PATH` at the binary's own directory: a source build
 *  compiled with CUDA bundles its runtime `.so` files there (build-runner.ts `copyCudaRuntimeLibs`),
 *  but unlike Windows the dynamic linker doesn't search the executable's directory by
 *  default — without this, a self-built engine fails to start with missing-library errors.
 *  macOS's dyld ignores LD_LIBRARY_PATH, so the same dir also goes on DYLD_LIBRARY_PATH there.
 *  Harmless when nothing is bundled there. Native engines on Windows still inherit the
 *  daemon env unchanged (undefined). For Python engines (MLX, vLLM, SGLang, LiteRT-LM) we:
 *   - prepend the venv's bin dir to PATH so venv-installed tools (notably `ninja`,
 *     used by FlashInfer's JIT kernel compiler) are found without a system install
 *     (BUG-005),
 *   - force HuggingFace OFFLINE so a model load / request can never block on a network
 *     call (TurboLLM downloads models itself; it is offline-first), and
 *   - point the HF cache at a real, created dir inside the TurboLLM data dir so mlx-lm's
 *     `/v1/models` (which calls huggingface_hub `scan_cache_dir()`) doesn't crash with
 *     CacheNotFound when `~/.cache/huggingface/hub` is absent, and
 *   - on WSL, run vLLM's V1 model runner, since V2 cannot start there (`vllmModelRunnerEnv`). */
export function pyEngineEnv(kind: string, dataDir: string, binPath: string): NodeJS.ProcessEnv | undefined {
  const python = kind === 'mlx' || kind === 'rapid-mlx' || kind === 'mlx-vlm' || kind === 'vllm' || kind === 'sglang' ||
    kind === 'laya' || (kind === 'litert-lm' && !isNativeLitertLm(binPath))
  if (!python) {
    if (process.platform === 'win32') return undefined
    const dir = dirname(binPath)
    // Append the existing value only if it's non-empty — glibc's dynamic linker treats an
    // empty LD_LIBRARY_PATH entry (a bare trailing ':') as "search the current working
    // directory", which a trailing `:${undefined ?? ''}` would otherwise produce whenever
    // LD_LIBRARY_PATH wasn't already set.
    const existing = process.env.LD_LIBRARY_PATH
    const env: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: existing ? `${dir}:${existing}` : dir }
    // macOS's dyld ignores LD_LIBRARY_PATH — the same dir must also go on DYLD_LIBRARY_PATH
    // or a build without a self-referential rpath can't find its bundled dylibs. probeEnv
    // (probe.ts) sets the same pair, so probing and launching stay mirrored.
    if (process.platform === 'darwin') {
      const dyld = process.env.DYLD_LIBRARY_PATH
      env.DYLD_LIBRARY_PATH = dyld ? `${dir}:${dyld}` : dir
    }
    // The native LiteRT-LM server keeps its compiled-model cache (XNNPACK weight packing, GPU programs) next to the
    // model, so a reload skips that work. A model in a folder it cannot write to would recompile on every load; this
    // directory is where it caches instead.
    if (kind === 'litert-lm') env.TURBOLLM_LITERT_CACHE_DIR = join(dataDir, 'cache', 'litert-lm')
    return env
  }
  const hfHome = join(dataDir, 'hf-cache')
  const hubCache = join(hfHome, 'hub')
  mkdirSync(hubCache, { recursive: true })
  const venvBin = dirname(binPath)
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const inherited = kind === 'laya' ? withoutLayaApiKey(process.env) : process.env
  return {
    ...inherited,
    PATH: `${venvBin}${pathSep}${process.env.PATH ?? ''}`,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HOME: hfHome,
    HF_HUB_CACHE: hubCache,
    ...(kind === 'vllm' ? vllmModelRunnerEnv(process.env, hostUname()) : {}),
  }
}

/** laya-serve requires a bearer token whenever LAYA_API_KEY is set, and the daemon never sends one, so a key the user set
 *  for their own use of laya would make the engine refuse every forwarded request. */
function withoutLayaApiKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Case-insensitively: Windows environment names are, and a spread of process.env keeps whatever casing was set.
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'LAYA_API_KEY'))
}

/** Scan a Python engine's log tail for a fatal model-load failure. mlx-lm loads the
 *  model in a background "_generate" thread; if `load_weights` throws (e.g. a model
 *  architecture or quantization the installed mlx-lm version doesn't support), that
 *  thread dies but the HTTP server keeps answering /v1/models, so chat requests queue
 *  to a dead thread and hang forever. We catch the crash and return a concise message;
 *  null when no such failure is present. The message names `kind`'s engine and package:
 *  readiness runs this for vLLM and SGLang too. */
export function detectPyLoadFailure(kind: string, lines: string[]): string | null {
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
  const [engine, pkg] = PY_ENGINE_NAMES[kind] ?? PY_ENGINE_NAMES.mlx
  return (
    `${engine} could not load this model — ${detail} ` +
    `This usually means the installed ${pkg} version does not support this model's architecture or quantization.`
  )
}

/** Display name and installed package of each engine kind detectPyLoadFailure runs for. */
const PY_ENGINE_NAMES: Record<string, [engine: string, pkg: string]> = {
  mlx: ['MLX', 'mlx-lm'],
  'rapid-mlx': ['Rapid-MLX', 'rapid-mlx'],
  'mlx-vlm': ['MLX-VLM', 'mlx-vlm'],
  vllm: ['vLLM', 'vllm'],
  sglang: ['SGLang', 'sglang'],
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
  return (await probeHealth(port)).ready
}

/** probeReady's verdict plus the probe's answer as a string ('down', '503', '404/200'...), which the load stall watch
 *  compares between polls: a change (the port opening, /health starting to answer) is progress. */
async function probeHealth(port: number): Promise<ProbeResult> {
  const base = `http://127.0.0.1:${port}`
  let health: number
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
    health = r.status
    if (health === 200) return { ready: true, answer: '200' }
    // 404/501 → this engine has no /health route; fall through to /v1/models below.
    // 503 (still loading) or any other status → not ready yet, keep polling.
    if (health !== 404 && health !== 501) return { ready: false, answer: String(health) }
  } catch {
    return { ready: false, answer: 'down' } // connection refused / not up yet → keep polling
  }
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) })
    return { ready: r.status === 200, answer: `${health}/${r.status}` }
  } catch {
    return { ready: false, answer: `${health}/down` }
  }
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
async function exitedWithin(exited: Promise<void>, ms: number): Promise<'exited' | 'timeout'> {
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
  /** When the engine was spawned (epoch ms). Absent in a pidfile written before it was recorded. */
  startedAt?: number
  /** The engine leads a process group of its own (util/tether.ts), so a kill takes its workers too. */
  group: boolean
  file: string
}

function enginePidDir(dataDir: string): string {
  return join(dataDir, 'run')
}

function writeEnginePid(dataDir: string, pid: number, port: number, group: boolean): void {
  try {
    const dir = enginePidDir(dataDir)
    mkdirSync(dir, { recursive: true })
    // owner = this daemon's pid, so another instance can tell "managed by a live daemon"
    // apart from "true orphan whose daemon is gone". `startedAt` lets the next start's reaper tell this engine apart
    // from an unrelated process that later got the same pid (util/process-start-time.ts); `group` that it can take
    // the engine's whole process group.
    writeFileSync(join(dir, `engine-${pid}.pid`), JSON.stringify({ pid, port, owner: process.pid, startedAt: Date.now(), group }))
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
      const { pid, port, owner, startedAt, group } = JSON.parse(readFileSync(file, 'utf8')) as {
        pid?: number; port?: number; owner?: number; startedAt?: number; group?: boolean
      }
      if (typeof pid === 'number' && pid > 0) {
        out.push({
          pid, port: typeof port === 'number' ? port : 0, owner: typeof owner === 'number' ? owner : 0,
          startedAt: typeof startedAt === 'number' ? startedAt : undefined, group: group === true, file,
        })
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
 *  An orphan is killed only when it is provably the engine that was recorded, so a recycled
 *  pid is never killed:
 *   - a pidfile with `startedAt`: when the pid's process started then, whether or not its port
 *     is open. The port rule alone left an engine killed by its daemon mid-load (no port open
 *     yet) running, holding its VRAM, until it finished loading and nothing ever reaped it;
 *     a start time that does not match is not killed;
 *   - a pidfile from before `startedAt` was recorded, or a live pid whose start time cannot be read (no `ps`, as
 *     in a slim container image; PowerShell failing on Windows): when the recorded engine port is alive, the rule
 *     every record had before.
 *  Either way the stale file is cleared. Returns orphans killed. */
export async function reapStaleEngines(dataDir: string): Promise<number> {
  let killed = 0
  const orphans = readEnginePidFiles(dataDir).filter(({ owner }) => !(owner && pidAlive(owner)))
  const started = processStartTimes(orphans.filter((o) => o.startedAt !== undefined && pidAlive(o.pid)).map((o) => o.pid))
  for (const { pid, port, startedAt, group, file } of orphans) {
    const actual = startedAt !== undefined ? started.get(pid) : undefined
    if (startedAt !== undefined && actual !== undefined) {
      if (Math.abs(actual - startedAt) <= START_TIME_TOLERANCE_MS) {
        killPidTree(pid, group)
        killed++
      }
    } else if ((startedAt === undefined || pidAlive(pid)) && await portAlive(port)) {
      killPidTree(pid, startedAt !== undefined && group)
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
  const ours = readEnginePidFiles(dataDir).filter((e) => e.owner === process.pid) // not ours — leave another daemon's engine + file alone
  let batchCompleted = true
  if (process.platform === 'win32') {
    // One taskkill for every engine, with a timeout: a synchronous call per engine, unbounded, let one hung taskkill
    // block the daemon's exit for good (the same batch as util/tether.ts's killTetheredSync).
    if (ours.length > 0) {
      try {
        const r = spawnSync('taskkill', ['/F', '/T', ...ours.flatMap((e) => ['/PID', String(e.pid)])], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
        batchCompleted = !r.error && !r.signal
      } catch {
        /* process already gone */
      }
    }
  } else {
    for (const { pid, group } of ours) {
      try {
        killPosix(pid, group)
      } catch {
        /* process already gone */
      }
    }
  }
  // A taskkill that timed out did not finish: the engines may still be alive, and their pidfiles are the only way the
  // next startup's reaper can find them, so they stay.
  if (!batchCompleted) return
  for (const { file } of ours) {
    try { rmSync(file, { force: true }) } catch { /* best-effort */ }
  }
}

/** SIGKILL an engine on POSIX: its whole process group when it leads one (its workers go with it), with the pid
 *  alone as the fallback. */
function killPosix(pid: number, group: boolean): void {
  if (group) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      /* no such group: the pid alone */
    }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

/** Kill a process tree by pid (async, fire-and-forget). taskkill /T on Windows takes
 *  the whole tree; on POSIX the engine's process group when the pidfile says it leads one. */
function killPidTree(pid: number, group: boolean): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/F', '/T'], () => {})
  } else {
    killPosix(pid, group)
  }
}

/** Strips `--mmproj <path>` and `--no-mmproj-offload` — the two flags profileToArgs adds
 *  when (and only when) `p.useMmproj` is true — without touching anything else. Used to
 *  retry a load as if useMmproj were false, without persisting that to the saved profile
 *  (useMmproj is intentionally self-healing to the model's own vision capability — see
 *  profile.ts's resolve() comment — so a permanent false would just get overwritten). */
export function stripMmprojArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mmproj') { i++; continue } // also skip its path value
    if (args[i] === '--no-mmproj-offload') continue
    out.push(args[i])
  }
  return out
}

/** GitHub report (2026-08): Qwen3.6-35B-A3B fails to load with its own correct, official
 *  mmproj — llama.cpp error `mismatch between text model (n_embd = 2048) and mmproj
 *  (n_embd = 5120)`, hinting "wrong mmproj". It isn't: this is a confirmed, still-open
 *  upstream bug (ggml-org/llama.cpp#20899, auto-closed stale rather than fixed) in the
 *  `qwen35moe`/`qwen3moe` + `qwen3vl_merger` compatibility check specifically — other
 *  reporters hit the identical crash with the identical model. TurboLLM can't validate
 *  mmproj/model compatibility itself without reimplementing (and inheriting the bugs of)
 *  llama.cpp's own internal check, so instead of leaving an otherwise-loadable model
 *  unloaded, retry the FIRST load attempt once without --mmproj when it dies with a
 *  multimodal-load failure. Self-limiting: `fallback`'s own extraArgs carry no --mmproj,
 *  so a second failure (of any kind) just surfaces normally — no further retry, no loop.
 *  `model.vision` is forced false too — the retry genuinely has no projector attached, and
 *  `status().model` / the reported load's `opts.model` both come straight from whatever
 *  StartOpts actually got spawned (see `startInternal`'s `this.opts = opts`), so leaving
 *  vision `true` here would misreport a text-only session as vision-capable everywhere
 *  downstream that reads it (the UI's engine card, `model_load` telemetry, etc) — including,
 *  usefully, `slot-cache.ts`'s `cacheEligible()`, which excludes vision models only because
 *  a multimodal slot-save 501s; a fallback session has no projector, so it's genuinely
 *  eligible now, not just falsely marked so. `profile.useMmproj` is cleared too so the SAME
 *  claim doesn't resurface if a future consumer starts reading `opts.profile` for reporting
 *  (nothing does yet — `buildModelLoadConfig` has no mmproj field — but `extraArgs`/`model`
 *  and `profile` disagreeing about what ran is exactly the class of bug this exists to fix). */
export function mmprojFallbackOpts(opts: StartOpts, err: ErrInfo): StartOpts | null {
  if (!opts.extraArgs.includes('--mmproj')) return null
  if (!/failed to load multimodal model/i.test(err.logTail.join('\n'))) return null
  return {
    ...opts,
    extraArgs: stripMmprojArgs(opts.extraArgs),
    model: { ...opts.model, vision: false },
    profile: opts.profile ? { ...opts.profile, useMmproj: false } : opts.profile,
  }
}

/** The log note written at the top of the fallback attempt's (freshly truncated) log —
 *  carries the original crash's key lines forward so the user isn't left staring at a
 *  clean-looking retry log with no explanation for why vision silently isn't available. */
export function mmprojFallbackNote(err: ErrInfo): string {
  const relevant = err.logTail.filter((l) => /mismatch between text model|failed to load multimodal model|mtmd_init_from_file/i.test(l))
  const summary = (relevant.length ? relevant : err.logTail.slice(-3)).join('\n')
  return (
    `[turbollm] the multimodal projector failed to load on the first attempt:\n${summary}\n` +
    `[turbollm] retrying once without --mmproj (text-only). This can happen even with the ` +
    `model's own correct, official mmproj file on some architectures due to open llama.cpp ` +
    `bugs (e.g. github.com/ggml-org/llama.cpp/issues/20899 for Qwen3.6-35B-A3B) — not ` +
    `necessarily a wrong or corrupt file on your end. Vision won't be available this session.\n\n`
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** The engine card (/status: state, the "Generating…" indicator) and the models list (loaded flags, last t/s) both
 *  change when an engine's state does or a generation starts or ends. */
function announceEngineChange(): void {
  emitInvalidation('status')
  emitInvalidation('models')
}
