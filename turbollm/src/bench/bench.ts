// Auto-benchmark + auto-tune runner (Differentiator #2, spec 09 §1). Owns the engine exclusively
// for the duration of a run. Two-phase per quality-preserving KV-cache type (f16 / q8_0 / turbo4):
// (1) pin the offload param (ngl for dense, nCpuMoe for MoE) with CHEAP VRAM probes — load, read
// absolute VRAM, stop, no generation — keeping the most on the GPU while leaving a user-configurable
// VRAM headroom (default 1 GB; Settings → Engine) so a later VRAM grab can't tip it into sysmem-spill;
// (2) run ONE real prefill + tok/s bench at
// that config. Picks the overall winner by best prefill AND generation t/s, saves it as the model's
// profile (tunedBy:'bench'), persists a benchResults row, and — when telemetry is on — queues an
// anonymized bench_result event. Single active run; additive; fail-safe (a bad candidate is
// recorded and the sweep continues).
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setModelProfile, getModelProfile, type BenchResult, type ConfigStore } from '../config/config'
import type { Manager, StartOpts } from '../engines/manager'
import type { Registry } from '../engines/registry'
import type { Engine } from '../config/config'
import type { Scanner, ModelEntry } from '../models/scanner'
import { deriveDefault, estimateVram, gpuBudgetMb, profileToArgs, resolveProfile, type GpuProfile, type LoadProfile } from '../models/profile'
import { getSysInfo, type SysInfo } from '../sysinfo/sysinfo'
import type { HfClient } from '../hf/hf'
import { inferRepoFromPath } from '../api/path-utils'
import {
  buildCardExtractionPrompt,
  hasAnySampling,
  parseCardSampling,
  parseGenerationParams,
  parseLlmSampling,
  type CardSampling,
} from '../models/card-sampling'

/** A single candidate the sweep evaluated. `outcome` is 'ok' on a measured run, or
 *  the failure mode (timeout/crash/oom) — the sweep keeps going on a failure. */
export interface BenchCandidate {
  label: string
  params: {
    ctx: number
    ngl: number
    /** True when this candidate used auto-fit (-ngl omitted) instead of the pinned `ngl` value —
     *  see `LoadProfile.nglFit`. `ngl` itself is meaningless/stale when this is true. */
    nglFit?: boolean
    nCpuMoe: number
    /** Same idea as `nglFit`, for `--n-cpu-moe` — see `LoadProfile.nCpuMoeFit`. */
    nCpuMoeFit?: boolean
    parallel: number
    kvTypeK: string
    flashAttn: string
  }
  outcome: 'ok' | 'timeout' | 'crash' | 'oom'
  tps: number | null
  /** Prefill (prompt-processing) speed, tok/s — from the engine's `prompt_per_second`. Part of
   *  the speed objective alongside `tps` (best prefill AND generation, not just generation). */
  prefillTps: number | null
  ttftMs: number | null
  /** VRAM use attributable to this candidate (after − before), MB — kept for display/telemetry. */
  vramMb: number | null
  /** ABSOLUTE GPU VRAM in use while this candidate ran, MB. Drives the ≤1 GB-headroom gate, which
   *  needs the true total (not the delta) to know how much free VRAM is actually left. */
  vramAbsMb: number | null
}

export interface BenchLogEntry {
  ts: string
  step: string
  candidate?: BenchCandidate
}

export interface BenchLogWinner {
  params: BenchCandidate['params']
  tps: number
  prefillTps?: number | null
  ttftMs: number
  vramMb: number | null
}

export interface BenchLog {
  modelKey: string
  startedAt: string
  hardware: { gpus: Array<{ name: string; vramMb: number }>; ramMb: number; os: string }
  entries: BenchLogEntry[]
  winner: BenchLogWinner | null
}

/** Live state surfaced on GET /status (spec 02 §7 / 09 §1). `running:false` resets
 *  step/best; `done`/`error` linger after a finished run until the next starts. */
export interface BenchState {
  running: boolean
  modelKey?: string
  step?: string
  bestTps?: number
  candidates?: BenchCandidate[]
  done?: boolean
  error?: string
  /** The winning candidate, surfaced when a run finishes so the UI can show a Save/Cancel
   *  results dialog. The profile is NOT persisted until the user clicks Save (POST /bench/save). */
  result?: {
    params: BenchCandidate['params']
    tps: number
    /** Prefill (prompt-processing) t/s for the winning config, when the engine reported it. */
    prefillTps?: number | null
    ttftMs: number
    vramMb: number | null
    /** The COMPLETE sampling the winning profile will be saved with (card values already
     *  merged in). Lets the results dialog show the full config as a table. */
    sampling?: CardSampling
    /** The subset of `sampling` that came from the HF card (ADR-099), when any was found —
     *  used to mark those rows "from model card". Absent when no card / nothing parsed. */
    recommendedSampling?: CardSampling
    /** ADR-219: a note shown (not acted on) when the winner is under 20 tok/s and the engine
     *  supports a smaller KV-cache type than the one tuned — surfaces that a faster, lower-
     *  quality option exists without auto-tune silently picking it. Absent otherwise. */
    kvAdvisory?: string
  }
}

// Hard limits (spec 09 §1).
// Readiness window: how long to wait for a candidate to come up before calling it a timeout.
// Generous enough for a large model (e.g. a 35B) to load; a candidate that over-allocates VRAM
// is caught faster than this by scanning the live log for an OOM signature (see awaitReady).
const READY_TIMEOUT_MS = 150_000
// Per-candidate cap: load + warmup + the measured request must all finish within this window,
// else the candidate is recorded 'timeout' and the sweep moves on — one hung config can't stall
// the run. Raised from 3 to 10 minutes (ADR-217 round 2): the bench prompt now targets depth near
// the CONFIGURED ctx (see benchPromptTokens) instead of an 8k cap, so a deep-ctx candidate does
// TWO full prefills at that depth (the warmup prefill-gate, then the measured request re-processes
// from scratch on purpose — see the `cache_prompt: false` comment in `chat`) — 10 min covers that
// at realistic prefill speeds with margin; the existing prefill-overrun projection in
// `prefillProbe` still fails a genuinely-too-slow config fast rather than waiting out the cap.
const PER_TEST_TIMEOUT_MS = 10 * 60_000
// Grace before judging prefill speed — give the first tokens time to flow before projecting.
const PREFILL_GRACE_MS = 8_000
// Overall budget — sized to fit a full binary search of per-test-capped trials (~log2(layers)).
// Raised from 20 to 45 minutes alongside PER_TEST_TIMEOUT_MS (ADR-217 round 2) — deep-ctx bench
// trials are slower by design now, and a run can measure 2+ KV types plus a headroom-backoff
// retry, each up to PER_TEST_TIMEOUT_MS.
const TOTAL_BUDGET_MS = 45 * 60_000
// Memory-pressure / GPU-exhaustion signatures. Beyond a clean "out of memory", a config that
// overflows VRAM often surfaces a secondary CUDA fault (failed allocation, or "device not ready"
// during graph capture once the allocation failed). Treat all of these as OOM so the search
// offloads more and the result reads as a fit problem rather than a mystery crash.
const OOM_RE = /out of memory|cudaMalloc|failed to allocate|unable to allocate|device not ready|CUDA error/i

// Auto-tune may also sweep the KV-cache quant — but only ever SELECTS a quality-preserving type:
// full-precision f16, near-lossless q8_0, and (on TurboQuant forks) turbo4 (≈ q8_0 quality). This
// lets it exploit a smaller KV cache for speed — fitting more of the model on the GPU — WITHOUT
// silently degrading output quality. Lower-bit types (q4_0/q5_*/turbo2/turbo3) are never auto-
// picked; the user's own KV choice is always kept as a candidate so the result can't do worse
// than what they'd load today.
const QUALITY_KV = ['f16', 'q8_0', 'turbo4']
// Leave at least this much VRAM free at the chosen config. Pushing offload to the very spill edge
// maximizes t/s in isolation, but then a later desktop / ComfyUI VRAM grab tips the model into
// "shared GPU memory" (sysmem over PCIe), which silently tanks generation. The search treats a
// candidate that uses more than (total − headroom) as "too much on GPU" and offloads further.
// User-configurable (Settings → Engine → VRAM headroom); see Config.vramHeadroomMb.
// Output-t/s tie band for the speed objective: when two configs are within this relative margin
// on generation speed, the one with faster prefill wins (best prefill AND t/s, not just t/s).
const OUTPUT_TIE = 0.05
// Bytes per cached element by KV-cache type — used only to order candidates by size (largest =
// most VRAM, smallest = least) so calibration probes the two extremes. Mirrors llama.cpp's types.
const KV_BYTES: Record<string, number> = {
  f32: 4, f16: 2, bf16: 2, q8_0: 1, q8_1: 1, q5_0: 0.625, q5_1: 0.625,
  q4_0: 0.5, q4_1: 0.5, iq4_nl: 0.5, turbo4: 0.5, turbo3: 0.375, turbo2: 0.25,
}

export class BenchError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BenchError'
  }
}

export class BenchRunner {
  private state: BenchState = { running: false }
  private cancelled = false
  private deadline = 0
  // Aborts the in-flight measurement request the instant cancel() is called, so a
  // stop/restart/load (kill switches) interrupts auto-tune immediately rather than
  // waiting out the current candidate's request.
  private abort: AbortController | null = null
  private runLog: BenchLogEntry[] = []
  private runLogMeta: { modelKey: string; startedAt: string; sys: SysInfo } | null = null
  private logWinner: BenchLogWinner | null = null
  // The finished run's winning candidate, held (not persisted) until the user clicks Save.
  private winning:
    | { modelKey: string; profile: LoadProfile; cand: BenchCandidate; entry: ModelEntry; sys: SysInfo; engineVersion: string; engineId: string }
    | null = null

  constructor(
    private manager: Manager,
    private store: ConfigStore,
    private scanner: Scanner,
    private registry: Registry,
    private version: string,
    /** Used to fetch the model's HF card for card-derived sampling (ADR-099). */
    private hf: HfClient,
  ) {}

  /** Live state for GET /status. */
  status(): BenchState {
    return this.state
  }

  /** Whether a run is in flight (drives the 409 on a second start). */
  isRunning(): boolean {
    return this.state.running
  }

  /** Cancel the active run: aborts the in-flight measurement immediately, stops after the
   *  current step, leaves the engine stopped, and keeps the partial results gathered so far
   *  (AC#3). A no-op when nothing is running. */
  cancel(): void {
    this.winning = null // discard any unsaved result too
    this.state = { ...this.state, result: undefined } // don't re-show the results dialog
    if (!this.state.running) return
    this.cancelled = true
    this.abort?.abort()
  }

  /** Stop the engine — force-killed immediately when the run is cancelled (the user is actively
   *  waiting for it to stop, ADR-220), gracefully otherwise (lets llama-server release resources
   *  cleanly between candidates during a normal run). Every stop in this file goes through this
   *  one chokepoint instead of calling `manager.stopAndWait()` directly, so a cancel is fast
   *  regardless of which code path notices it first. Previously every stop used the graceful
   *  TERM→8s-then-kill path unconditionally, so cancelling could take up to 8s per in-flight
   *  stop — a real, reported "Cancel doesn't cancel immediately" bug. */
  private async stopEngine(): Promise<void> {
    await this.manager.stopAndWait({ force: this.cancelled }).catch(() => {})
  }

  /** Persist the finished run's winning profile (the user clicked Save). Returns false if there is
   *  nothing to save (no completed run, or it was already saved / discarded). */
  saveResult(): boolean {
    const w = this.winning
    if (!w) return false
    const record = this.persistBest(w.modelKey, w.profile, w.cand, w.engineId)
    this.queueTelemetry(record, w.entry, w.sys, this.version, w.engineVersion)
    this.winning = null
    this.state = { ...this.state, result: undefined } // consumed — don't re-show the dialog
    return true
  }

  /** Resolve once no run is in flight (the runner has finished its teardown), or after
   *  `timeoutMs`. Lets a restart wait for auto-tune to release the engine before reloading,
   *  so the two don't race over the engine. */
  async waitIdle(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.state.running && Date.now() < deadline) await sleep(150)
  }

  getLog(): BenchLog | null {
    if (!this.runLogMeta) return null
    const { modelKey, startedAt, sys } = this.runLogMeta
    return {
      modelKey,
      startedAt,
      hardware: {
        gpus: sys.gpus.map((g) => ({ name: g.name, vramMb: g.vramMb })),
        ramMb: sys.ramMB,
        os: sys.os,
      },
      entries: [...this.runLog],
      winner: this.logWinner,
    }
  }

  private emit(step: string, candidate?: BenchCandidate): void {
    this.runLog.push({ ts: new Date().toISOString(), step, ...(candidate ? { candidate } : {}) })
  }

  /** Start a run for `modelKey`. Rejects (throws BenchError) when a run is already
   *  active, the engine is busy, or the model isn't a benchmarkable GGUF. The run
   *  itself proceeds in the background; callers get 202 + poll /status. */
  start(modelKey: string, base?: Partial<LoadProfile>): void {
    if (this.state.running) throw new BenchError('bench_running', 'A benchmark is already running.')
    const engineState = this.manager.status().state
    if (engineState === 'running' || engineState === 'starting' || engineState === 'stopping') {
      throw new BenchError('engine_in_use', 'Stop the running model before benchmarking.')
    }
    const active = this.registry.active()
    if (!active) throw new BenchError('no_active_engine', 'Register and select an engine first.')
    // Auto-tune sweeps llama.cpp LoadProfile flags (profileToArgs). MLX has no such
    // flags; KoboldCpp uses a DIFFERENT flag dialect (koboldcppProfileToArgs), so the
    // swept llama.cpp flags wouldn't apply. Both are unsupported. llamafile runs
    // llama.cpp's server with the same flags, so it auto-tunes like llama-server.
    if (active.kind === 'mlx' || active.kind === 'rapid-mlx' || active.kind === 'koboldcpp') {
      throw new BenchError('unsupported_model', 'Auto-tune supports llama.cpp / llamafile (GGUF) engines only.')
    }
    const entry = this.scanner.get(modelKey)
    if (!entry) throw new BenchError('no_such_model', 'No model with that key.')
    if (entry.format !== 'gguf') throw new BenchError('unsupported_model', 'Auto-tune supports GGUF models only.')
    if (entry.incomplete || entry.parseError) throw new BenchError('model_not_loadable', 'This model is incomplete or unreadable.')

    this.cancelled = false
    this.abort = new AbortController()
    this.winning = null
    this.runLog = []
    this.runLogMeta = null
    this.logWinner = null
    this.deadline = Date.now() + TOTAL_BUDGET_MS
    this.state = { running: true, modelKey, step: 'Preparing…', candidates: [] }
    void this.run(modelKey, entry, base).catch((e) => {
      // The run is fully guarded internally; this is a last-resort net so a thrown
      // error never leaves `running` stuck true.
      this.state = { running: false, modelKey, done: true, error: e instanceof Error ? e.message : String(e), candidates: this.state.candidates }
      void this.stopEngine()
    })
  }

  // ---- the run ------------------------------------------------------------

  private async run(modelKey: string, entry: ModelEntry, base?: Partial<LoadProfile>): Promise<void> {
    const sys = getSysInfo()
    this.runLogMeta = { modelKey, startedAt: new Date().toISOString(), sys }
    const active = this.registry.active()
    const caps = active?.capabilities ?? { flags: [], kvTypes: [] }
    // Per-engine profile (issue #35): tune from the profile saved for the active engine
    // (falling back to the '*' migrated profile), so a re-tune builds on this engine's own basis.
    const saved = getModelProfile(this.store.snapshot(), modelKey, active?.id ?? '*') as Partial<LoadProfile> | undefined
    const defaults = this.store.snapshot().modelDefaults
    // Honor the user's CURRENT config (the dialog draft, passed as `base`) as the basis for every
    // candidate — ctx, flash-attn, sampling, etc. `base` overrides the saved profile + global
    // defaults. Auto-tune then CHOOSES the KV-cache type (by reasoning about VRAM, below) and tunes
    // the offload (ngl / nCpuMoe) under it, so the result reflects settings they'll load with.
    // Tune WITH the user's speculative-decoding setting (NextN / MTP / draft) active — do NOT force
    // it off. Auto-tune's job is to fit the config the user will ACTUALLY load, and native MTP/NextN
    // adds real VRAM (draft KV cache + head compute, ~460 MB measured on a 35B MoE at 200K ctx) that
    // the offload search must reserve room for; searching with spec excluded would pick an offload
    // that fits WITHOUT it, then load spec on top and eat the vramHeadroomMb margin (or spill to RAM,
    // exactly what the projector note below guards against). Keeping spec on also means the winning
    // profile PRESERVES the user's setting instead of silently resetting it to 'off' on Save.
    // (This used to force spec off on the theory that it "runs the model ~twice, cratering t/s ~2 vs
    // ~24" — but that number was measured with the --model-draft double-load bug since fixed; native
    // MTP is now FASTER, so the premise no longer holds. Modes that genuinely load extra weights
    // (the fork's `nextn`, Gemma `mtp`) tune slower but that reflects their true footprint, which is
    // the honest thing to fit against.)
    // Tune WITH the vision projector (mmproj) exactly as the user has it configured (useMmproj /
    // mmprojGpu come from `resolved`, untouched here). A vision model always loads with mmproj
    // resident (see resolveProfile), so the offload search must account for its real VRAM
    // footprint (~1-2 GB) — searching with it excluded would pick an offload that fits WITHOUT
    // the projector, then load the projector on top of that afterward, eating into the
    // vramHeadroomMb safety margin the search thought it had (or spilling outright).
    const resolved = resolveProfile(entry, sys, saved, base, defaults)
    const baseProfile: LoadProfile = resolved
    // User-configurable VRAM safety margin for the offload search (Settings → Engine).
    const headroomMb = this.store.snapshot().vramHeadroomMb

    const results: BenchCandidate[] = []
    let best: { cand: BenchCandidate; profile: LoadProfile } | null = null

    // --- Choose the multi-GPU SPLIT strategy (ADR-054) — the KV-cache TYPE is no longer swept
    // here (ADR-219): auto-tune tunes offload (ngl/nCpuMoe) on whatever KV type the user already
    // has selected, instead of silently choosing between f16/q8_0/turbo4 itself. Founder call
    // after live-testing showed a lower-precision type (q4_0) measurably outperforming turbo4 on
    // deep-context real chat — that's a genuine quality/speed tradeoff the user should make
    // explicitly, not one auto-tune should pick for them. See the KV-cache speed advisory below
    // instead, which surfaces the option without silently taking it.
    // llama.cpp's default is an even LAYER-split across every visible GPU. But a model that fits on
    // ONE card is almost always faster there: a layer-split runs the GPUs as a sequential pipeline
    // (one busy at a time) and copies activations across PCIe every token, so on a fits-on-one model
    // it's strictly slower than single-GPU — the reported "dual-GPU is slower than my single GPU".
    // So on a >1-GPU box we tune single-GPU (when the model plausibly fits one card, even only with
    // the smallest quality KV) FIRST, then the layer-split, and let measured t/s pick. A single-GPU
    // box or a split-incapable engine yields exactly one strategy → unchanged behavior. (Row-split
    // is a deliberate follow-up: its per-layer all-reduce rarely pays off on PCIe-only multi-GPU.)
    const splitStrategies = pickSplitStrategies(entry, sys, baseProfile, caps)
    for (const gpu of splitStrategies) {
      if (this.cancelled || Date.now() > this.deadline) break
      const splitBase: LoadProfile = { ...baseProfile, gpu }
      if (splitStrategies.length > 1) {
        const label = splitLabel(gpu, sys.gpus.length)
        this.state = { ...this.state, step: `Trying ${label}…`, candidates: results }
        this.emit(`split strategy → ${label}`)
      }

      const found = entry.moe
        ? await this.moeSearch(entry, sys, splitBase, caps, results, headroomMb)
        : await this.denseSearch(entry, sys, splitBase, caps, results, headroomMb)
      if (found && (!best || betterBySpeed(found.cand, best.cand))) best = found
      if (best) this.state = { ...this.state, bestTps: best.cand.tps ?? undefined }
    }

    // Engine is always left stopped at the end of a run (AC#3 for cancel; also tidy
    // for a normal finish — the user explicitly loads afterward).
    await this.stopEngine()

    if (best) {
      // Card-derived recommended sampling (ADR-099): read the model author's recommended
      // temp/top_k/top_p/min_p from the HF card and merge into the winning profile so Save
      // persists it. Fully fail-safe — no card / nothing parsed leaves sampling untouched
      // (done-when: "no card → defaults unchanged"). The engine is stopped here; the LLM
      // fallback (only when the heuristic finds nothing) reloads the winner briefly itself.
      // Gate on the global deadline too (not just cancel): a run that already spent the full
      // TOTAL_BUDGET_MS must not spawn a multi-minute LLM-fallback reload past budget.
      let recommended: CardSampling | undefined
      if (!this.cancelled && Date.now() <= this.deadline) {
        recommended = await this.extractCardSampling(entry, best.profile, caps, sys).catch(() => undefined)
        await this.stopEngine() // in case the LLM fallback loaded a model
      }
      // A cancel DURING extraction (the LLM fallback can run for minutes) must not resurrect the
      // results dialog or re-hold a profile the user just discarded: cancel() cleared winning +
      // result, but couldn't stop this still-running run. Re-check before committing the winner.
      if (this.cancelled) {
        this.state = { running: false, modelKey, done: true, candidates: results }
        return
      }
      const profile =
        recommended && hasAnySampling(recommended)
          ? { ...best.profile, sampling: { ...best.profile.sampling, ...recommended } }
          : best.profile
      // ADR-219: note (don't auto-switch) when a smaller, faster KV-cache type is available —
      // auto-tune no longer picks the KV type itself, so a slow result deserves a pointer to the
      // tradeoff rather than silence.
      const kvAdvisory = kvSpeedAdvisory(best.cand.tps, profile.kvTypeK, caps.kvTypes)
      // Hold the winner instead of auto-saving — the UI shows a Save/Cancel results dialog and
      // persists via POST /bench/save only when the user clicks Save.
      this.winning = { modelKey, profile, cand: best.cand, entry, sys, engineVersion: active?.version ?? '', engineId: active?.id ?? '' }
      this.logWinner = { params: best.cand.params, tps: best.cand.tps ?? 0, prefillTps: best.cand.prefillTps, ttftMs: best.cand.ttftMs ?? 0, vramMb: best.cand.vramMb }
      this.state = {
        running: false,
        modelKey,
        done: true,
        bestTps: best.cand.tps ?? undefined,
        result: {
          params: best.cand.params,
          tps: best.cand.tps ?? 0,
          prefillTps: best.cand.prefillTps,
          ttftMs: best.cand.ttftMs ?? 0,
          vramMb: best.cand.vramMb,
          // The full sampling that Save will persist (winning profile, card values merged in) so
          // the results dialog can show the COMPLETE config — not just the card-derived delta.
          sampling: {
            temp: profile.sampling.temp,
            topK: profile.sampling.topK,
            topP: profile.sampling.topP,
            minP: profile.sampling.minP,
          },
          ...(recommended && hasAnySampling(recommended) ? { recommendedSampling: recommended } : {}),
          ...(kvAdvisory ? { kvAdvisory } : {}),
        },
        candidates: results,
      }
    } else {
      // No candidate measured successfully — keep the partial results, surface a soft error
      // (every candidate's outcome is visible in `candidates`). When every trial ran out of VRAM,
      // say so with the context size so the fix (lower ctx) is obvious — rather than a vague crash.
      const memoryBound = results.length > 0 && results.every((r) => r.outcome === 'oom')
      const err = this.cancelled
        ? undefined
        : memoryBound
          ? `This model doesn't fit on your GPU at ${baseProfile.ctx.toLocaleString()} context — even with maximum CPU offload it ran out of VRAM. Lower the context length and try again.`
          : 'No candidate completed successfully.'
      this.state = { running: false, modelKey, done: true, error: err, candidates: results }
    }
  }

  /** Dense models: pin `ngl` by VRAM probing (Phase 1), then run the full bench once (Phase 2).
   *  More GPU layers = faster, monotonically, up to the no-spill edge — so the best ngl is the
   *  HIGHEST whose absolute VRAM still leaves the configured headroom. Whether a config fits/spills is a
   *  LOAD-time property, so we find that ngl with cheap load-and-read-VRAM probes (no generation),
   *  and only measure t/s at the winner. CPU-only machines skip straight to ngl=0. */
  private async denseSearch(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
    headroomMb: number,
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile } | null> {
    // User chose auto-fit (LoadProfile.nglFit) — trust llama.cpp's own -fit logic for the
    // GPU/CPU split instead of empirically binary-searching it ourselves; just measure speed
    // once at whatever it picks. Skips the whole probe phase, and the winning profile keeps
    // nglFit:true so future loads stay adaptive rather than pinning today's specific number.
    if (base.nglFit) return this.benchAt(entry, sys, base, caps, results, 'auto-fit')

    let bestNgl: number | null = 0 // CPU-only box → everything on CPU, no probing needed.
    // The VRAM this split is allowed to use: all cards for a layer/row split, ONE card for a
    // single-GPU 'none' split (ADR-054). The headroom gate must judge against THIS, not the summed
    // pool — else a 14 GB single-GPU load looks safe against a 30 GB total when it's at one card's
    // edge. Computed unconditionally (0 on a CPU-only box) so the Phase-2 re-check below can reuse
    // it too (ADR-217) — `overHeadroom` treats a ≤0 budget as "never over".
    const budgetMb = gpuBudgetMb(sys, base)

    if (sys.gpus.length > 0) {
      // Binary search ngl ∈ [0, blockCount] for the HIGHEST that loads with enough headroom VRAM.
      const hi0 = entry.blockCount > 0 ? entry.blockCount : 99
      let lo = 0, hi = hi0
      bestNgl = null
      while (lo <= hi && !this.cancelled && Date.now() <= this.deadline) {
        const mid = Math.floor((lo + hi) / 2)
        this.state = { ...this.state, step: `KV ${base.kvTypeK}: probing ngl=${mid} (range ${lo}–${hi})…`, candidates: results }
        const probe = await this.probeVram(entry, sys, { ...base, ngl: mid }, caps)
        this.pushProbe(results, base, 'ngl', mid, probe)
        await this.settleGpu(sys)
        if (probe.outcome === 'ok' && !overHeadroom(probe.vramAbsMb, budgetMb, headroomMb)) {
          bestNgl = mid // fits with headroom → record, try MORE GPU layers
          lo = mid + 1
        } else {
          hi = mid - 1 // oom / over-headroom / crash → fewer GPU layers
        }
      }
    }

    if (bestNgl === null) return null
    let found = await this.benchAt(entry, sys, { ...base, ngl: bestNgl }, caps, results, `ngl=${bestNgl}`)
    // Phase 2 (the actual timed run) can allocate more VRAM than Phase 1's load-only probe did
    // (lazy cuBLAS/graph-capture scratch buffers) — re-validate against the REAL post-generation
    // VRAM and back off one layer if it silently blew through the user's headroom (ADR-217).
    if (found && overHeadroom(found.cand.vramAbsMb, budgetMb, headroomMb) && bestNgl > 0) {
      this.emit(`ngl=${bestNgl} exceeded headroom after generation (${found.cand.vramAbsMb} MB) — retrying at ngl=${bestNgl - 1}`)
      const safer = await this.benchAt(entry, sys, { ...base, ngl: bestNgl - 1 }, caps, results, `ngl=${bestNgl - 1} (headroom backoff)`)
      if (safer) found = safer
    }
    return found
  }

  /** MoE models: pin `nCpuMoe` by VRAM probing (Phase 1), then run the full bench once (Phase 2).
   *  Fewer CPU experts = more on GPU = faster, so the best is the LOWEST nCpuMoe whose absolute VRAM
   *  still leaves the configured headroom. Found with cheap load-and-read-VRAM probes (no generation);
   *  t/s is measured only at the winner. */
  private async moeSearch(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
    headroomMb: number,
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile } | null> {
    // Same idea as denseSearch's nglFit check, for MoE CPU-offload auto-fit.
    if (base.nCpuMoeFit) return this.benchAt(entry, sys, base, caps, results, 'auto-fit')

    const derived = deriveDefault(entry, sys)
    const maxN = entry.blockCount > 0 ? entry.blockCount : (derived.nCpuMoe || 0)
    // VRAM budget for THIS split (one card for single-GPU 'none', summed pool otherwise) — see denseSearch.
    const budgetMb = gpuBudgetMb(sys, base)
    let lo = 0, hi = maxN
    let bestN: number | null = null

    while (lo <= hi && !this.cancelled && Date.now() <= this.deadline) {
      const mid = Math.floor((lo + hi) / 2)
      this.state = { ...this.state, step: `KV ${base.kvTypeK}: probing nCpuMoe=${mid} (range ${lo}–${hi})…`, candidates: results }
      const probe = await this.probeVram(entry, sys, { ...base, nCpuMoe: mid }, caps)
      this.pushProbe(results, base, 'nCpuMoe', mid, probe)
      await this.settleGpu(sys)
      if (probe.outcome === 'oom' || overHeadroom(probe.vramAbsMb, budgetMb, headroomMb)) {
        lo = mid + 1 // too much on GPU → more CPU experts to free VRAM / restore the headroom
      } else if (probe.outcome === 'ok') {
        bestN = mid // fits with headroom → record, try FEWER CPU experts (more on GPU)
        hi = mid - 1
      } else {
        lo = mid + 1 // crash / timeout → treat as memory pressure
      }
    }

    if (bestN === null) return null
    let found = await this.benchAt(entry, sys, { ...base, nCpuMoe: bestN }, caps, results, `nCpuMoe=${bestN}`)
    // Same Phase-1-vs-Phase-2 VRAM gap as denseSearch — back off (more CPU experts, less VRAM) one
    // step if the real measured run blew through headroom (ADR-217).
    if (found && overHeadroom(found.cand.vramAbsMb, budgetMb, headroomMb) && bestN < maxN) {
      this.emit(`nCpuMoe=${bestN} exceeded headroom after generation (${found.cand.vramAbsMb} MB) — retrying at nCpuMoe=${bestN + 1}`)
      const safer = await this.benchAt(entry, sys, { ...base, nCpuMoe: bestN + 1 }, caps, results, `nCpuMoe=${bestN + 1} (headroom backoff)`)
      if (safer) found = safer
    }
    return found
  }

  /** A cheap VRAM probe (Phase 1 of a search): load the candidate, wait for readiness — by which
   *  point the weights, the full KV cache, AND the compute buffers are all allocated — read the
   *  absolute GPU VRAM in use, then stop. NO prefill, NO generation. The offload param is decided
   *  from this alone: whether a config fits-with-headroom or spills is a load-time property, so
   *  measuring t/s at every search step would be wasted — we bench ONCE, at the chosen config. */
  private async probeVram(
    entry: ModelEntry,
    sys: SysInfo,
    profile: LoadProfile,
    caps: Engine['capabilities'],
  ): Promise<{ outcome: 'ok' | 'timeout' | 'crash' | 'oom'; vramAbsMb: number | null }> {
    const active = this.registry.active()
    if (!active) return { outcome: 'crash', vramAbsMb: null }
    const testDeadline = Math.min(Date.now() + READY_TIMEOUT_MS + 5_000, this.deadline)
    const opts: StartOpts = {
      engine: active,
      model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
      modelPath: entry.path,
      extraArgs: profileToArgs(profile, entry, caps, sys.cores),
    }
    try {
      await this.manager.start(opts)
    } catch {
      return { outcome: 'crash', vramAbsMb: null }
    }
    const outcome = await this.awaitReady(testDeadline)
    let vramAbsMb: number | null = null
    if (outcome === 'ok') {
      await sleep(800) // let the allocator settle so the VRAM reading is final
      vramAbsMb = await readGpuVramMb(sys)
    }
    await this.stopEngine()
    return { outcome, vramAbsMb }
  }

  /** Record a VRAM-probe trial in the candidate list (tps/prefill are null — nothing was generated;
   *  only the load outcome and absolute VRAM are known). */
  private pushProbe(
    results: BenchCandidate[],
    base: LoadProfile,
    knob: 'ngl' | 'nCpuMoe',
    value: number,
    probe: { outcome: BenchCandidate['outcome']; vramAbsMb: number | null },
  ): void {
    const probeCand: BenchCandidate = {
      label: `probe ${knob}=${value}`,
      params: {
        ctx: base.ctx,
        ngl: knob === 'ngl' ? value : base.ngl,
        nCpuMoe: knob === 'nCpuMoe' ? value : base.nCpuMoe,
        parallel: base.parallel,
        kvTypeK: base.kvTypeK,
        flashAttn: base.flashAttn,
      },
      outcome: probe.outcome,
      tps: null,
      prefillTps: null,
      ttftMs: null,
      vramMb: null,
      vramAbsMb: probe.vramAbsMb,
    }
    results.push(probeCand)
    this.emit(`${probeCand.label} → ${probe.outcome}${probe.vramAbsMb != null ? ` (${probe.vramAbsMb} MB)` : ''}`, probeCand)
    this.state = { ...this.state, candidates: results }
  }

  /** Phase 2: the single full prefill + t/s benchmark, at the offload the VRAM probe chose. Pushes
   *  the candidate and returns it as this KV quant's winner (null if the final measurement faulted). */
  private async benchAt(
    entry: ModelEntry,
    sys: SysInfo,
    profile: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
    label: string,
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile } | null> {
    this.state = { ...this.state, step: `KV ${profile.kvTypeK}: measuring best (${label})…`, candidates: results }
    const cand = await this.measure(entry, sys, profile, caps, label, `Measuring ${label}`)
    results.push(cand)
    this.emit(`bench ${label} → ${cand.outcome}${cand.tps != null ? ` (${cand.tps.toFixed(1)} tok/s)` : ''}`, cand)
    this.state = { ...this.state, candidates: results, bestTps: cand.tps ?? this.state.bestTps }
    await this.settleGpu(sys)
    return cand.outcome === 'ok' && cand.tps !== null ? { cand, profile } : null
  }

  /** The measurement primitive (spec 09 §1): launch the candidate, detect
   *  ready/timeout/crash/oom, then warm up + one measured request. Never throws —
   *  any failure maps to an outcome so the sweep can continue (AC#2). */
  private async measure(
    entry: ModelEntry,
    sys: SysInfo,
    profile: LoadProfile,
    caps: Engine['capabilities'],
    label: string,
    stepPrefix: string,
  ): Promise<BenchCandidate> {
    const params = {
      ctx: profile.ctx,
      ngl: profile.ngl,
      nglFit: profile.nglFit,
      nCpuMoe: profile.nCpuMoe,
      nCpuMoeFit: profile.nCpuMoeFit,
      parallel: profile.parallel,
      kvTypeK: profile.kvTypeK,
      flashAttn: profile.flashAttn,
    }
    const fail = (outcome: BenchCandidate['outcome']): BenchCandidate => ({ label, params, outcome, tps: null, prefillTps: null, ttftMs: null, vramMb: null, vramAbsMb: null })
    // Live sub-phase progress so each (possibly multi-minute) trial isn't a silent wait.
    const phase = (p: string) => { this.state = { ...this.state, step: `${stepPrefix} — ${p}` } }

    const active = this.registry.active()
    if (!active) return fail('crash')

    // Per-test cap (3 min): the whole trial — load + warmup + measured request — must finish
    // within this, else it's recorded 'timeout' and the sweep continues. Also bounded by the
    // global deadline so a near-budget start can't overrun.
    const testDeadline = Math.min(Date.now() + PER_TEST_TIMEOUT_MS, this.deadline)
    const remaining = () => Math.max(1_000, testDeadline - Date.now())

    // Run at the user's REAL ctx (no clamp): VRAM use + OOM behavior then reflect the
    // actual config they'll load with, so the winning offload is one that genuinely
    // fits. The measured request itself is small and tok/s is ~ctx-independent.
    const opts: StartOpts = {
      engine: active,
      model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
      modelPath: entry.path,
      extraArgs: profileToArgs(profile, entry, caps, sys.cores),
    }

    const vramBefore = await readGpuVramMb(sys)
    phase('loading model…')
    try {
      await this.manager.start(opts)
    } catch {
      return fail('crash')
    }

    // Wait for ready / detect crash / OOM within the readiness window (and per-test cap).
    const outcome = await this.awaitReady(testDeadline)
    if (outcome !== 'ok') {
      await this.stopEngine()
      return fail(outcome)
    }

    const target = this.manager.target()
    if (!target) {
      await this.stopEngine()
      return fail('crash')
    }
    const logPath = this.manager.logPath()

    // Bench request sized to this profile's configured ctx (ADR-217 round 2) — see
    // buildBenchMessages for why depth matters here.
    const benchMessages = buildBenchMessages(profile.ctx)

    // Prefill gate (doubles as warmup): stream the prompt and fail fast if it's spilling/crawling
    // or the engine faults — so a config that doesn't fit at this ctx is rejected in seconds and the
    // search offloads more, instead of hanging out the whole per-test budget.
    phase('warming up…')
    const warm = await this.prefillProbe(target, benchMessages, remaining(), logPath, stepPrefix)
    if (warm !== 'ok') {
      await this.stopEngine()
      return fail(warm.fault)
    }
    phase('measuring t/s…')
    const measured = await this.runChatWatched(target, benchMessages, 128, remaining(), logPath)
    const vramAfter = await readGpuVramMb(sys)
    await this.stopEngine()

    if ('fault' in measured) return fail(measured.fault)
    const vramMb = vramBefore !== null && vramAfter !== null ? Math.max(0, vramAfter - vramBefore) : vramAfter
    return { label, params, outcome: 'ok', tps: measured.tps, prefillTps: measured.prefillTps, ttftMs: measured.ttftMs, vramMb, vramAbsMb: vramAfter }
  }

  /** Poll the manager state until the engine is running, the readiness window
   *  elapses (timeout), the process exits (crash), or an OOM line appears in the
   *  log (oom). Honors cancel + the global deadline. */
  private async awaitReady(testDeadline: number): Promise<'ok' | 'timeout' | 'crash' | 'oom'> {
    const deadline = Math.min(Date.now() + READY_TIMEOUT_MS, testDeadline, this.deadline)
    const logPath = this.manager.logPath()
    for (;;) {
      await sleep(400)
      if (this.cancelled) return 'crash' // treated as a non-ok outcome; engine stopped by caller
      const st = this.manager.status()
      if (st.state === 'running') return 'ok'
      if (st.state === 'error' || st.state === 'stopped') {
        // Distinguish OOM from a generic crash via the captured log tail.
        const tail = st.err?.logTail ?? []
        if (tail.some((l) => OOM_RE.test(l))) return 'oom'
        return 'crash'
      }
      // Still 'starting' — but a candidate that over-allocates VRAM can hang here without the
      // process cleanly exiting (it allocates/thrashes instead of crashing). Scan the LIVE engine
      // log so we catch the OOM / "device not ready" right away rather than waiting out the window.
      if (logPath && OOM_RE.test(readLiveTail(logPath))) return 'oom'
      if (Date.now() > deadline) return 'timeout'
    }
  }

  /** After a candidate's engine is stopped, wait for the GPU to actually release its VRAM (and the
   *  driver to settle) before the next candidate loads. A trial that exhausts VRAM can leave the GPU
   *  in a "device not ready" state that otherwise cascades into every following trial failing — the
   *  cause of spurious "no candidate found" on large models. Returns fast when VRAM is already low
   *  (the normal success case). Best-effort; never throws. */
  private async settleGpu(sys: SysInfo): Promise<void> {
    await sleep(1500) // base: let the killed engine process release + the driver settle
    let prev = await readGpuVramMb(sys)
    if (prev === null) return // no live VRAM reader for this vendor: the fixed wait is all we can do
    for (let i = 0; i < 12 && !this.cancelled; i++) {
      await sleep(1000)
      const cur = await readGpuVramMb(sys)
      if (cur === null || cur >= prev - 64) return // released / stabilized (no further drop)
      prev = cur
    }
  }

  /** A measured chat that aborts the instant the engine faults, so a config that doesn't fit fails
   *  in seconds instead of hanging out the per-test budget. A watchdog polls the engine state + the
   *  live engine log; on an OOM / "device not ready" / process death it aborts the request and the
   *  result is classified accordingly. Returns the timing, or a `fault` outcome. */
  private async runChatWatched(
    target: string,
    messages: BenchMessage[],
    maxTokens: number,
    budgetMs: number,
    logPath: string,
  ): Promise<{ tps: number; prefillTps: number | null; ttftMs: number } | { fault: 'oom' | 'crash' | 'timeout' }> {
    const probe = new AbortController()
    let fault: 'oom' | 'crash' | null = null
    const watch = (async () => {
      while (!probe.signal.aborted) {
        await sleep(1200)
        if (this.cancelled) { fault = 'crash'; probe.abort(); return }
        const st = this.manager.status()
        if (st.state === 'error' || st.state === 'stopped') {
          fault = (st.err?.logTail ?? []).some((l) => OOM_RE.test(l)) ? 'oom' : 'crash'
          probe.abort(); return
        }
        // Engine still "running" but stuck mid-inference (graph-capture OOM, etc.) writes the fault
        // to its log without exiting — catch it from the live log so we don't wait out the budget.
        if (logPath && OOM_RE.test(readLiveTail(logPath))) { fault = 'oom'; probe.abort(); return }
      }
    })()

    let timed: { tps: number; prefillTps: number | null; ttftMs: number } | null = null
    try {
      timed = await this.chat(target, messages, maxTokens, budgetMs, probe.signal)
    } catch {
      timed = null
    } finally {
      probe.abort()
      await watch.catch(() => {})
    }
    if (timed) return timed
    if (fault) return { fault }
    return { fault: this.cancelled ? 'crash' : 'timeout' }
  }

  /** Prefill gate: stream the bench prompt and watch how fast the prompt is processed. If the
   *  projected time to finish prefilling exceeds the per-test budget, the config is spilling to
   *  system memory / crawling — abort and mark it NG so the search offloads more, instead of waiting
   *  out the whole budget. Also aborts on an engine fault (OOM / "device not ready" / process death).
   *  Returns 'ok' once prefill completes (generation starts) — a config that gets here is viable and
   *  the warm prompt cache makes the following measured request fast and accurate. */
  private async prefillProbe(
    target: string,
    messages: BenchMessage[],
    budgetMs: number,
    logPath: string,
    stepPrefix: string,
  ): Promise<'ok' | { fault: 'oom' | 'crash' | 'timeout' }> {
    const probe = new AbortController()
    let fault: 'oom' | 'crash' | null = null
    const watch = (async () => {
      while (!probe.signal.aborted) {
        await sleep(1200)
        if (this.cancelled) { fault = 'crash'; probe.abort(); return }
        const st = this.manager.status()
        if (st.state === 'error' || st.state === 'stopped') {
          fault = (st.err?.logTail ?? []).some((l) => OOM_RE.test(l)) ? 'oom' : 'crash'
          probe.abort(); return
        }
        if (logPath && OOM_RE.test(readLiveTail(logPath))) { fault = 'oom'; probe.abort(); return }
      }
    })()

    const signals: AbortSignal[] = [AbortSignal.timeout(budgetMs), probe.signal]
    if (this.abort) signals.push(this.abort.signal)
    const start = Date.now()
    let reachedGen = false
    try {
      const res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'bench', messages, max_tokens: 8, temperature: 0, seed: 42, stream: true, return_progress: true }),
        signal: AbortSignal.any(signals),
      })
      if (!res.ok || !res.body) throw new Error('no stream')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { reachedGen = true; break outer }
          let chunk: Record<string, unknown>
          try { chunk = JSON.parse(raw) } catch { continue }
          const pp = chunk.prompt_progress as { processed?: number; total?: number } | undefined
          if (pp?.total) {
            const processed = pp.processed ?? 0
            const pct = Math.round((processed / pp.total) * 100)
            this.state = { ...this.state, step: `${stepPrefix} — prefill ${pct}%` }
            const elapsed = Date.now() - start
            if (processed > 0 && elapsed > PREFILL_GRACE_MS && elapsed * (pp.total / processed) > budgetMs) {
              // Projected to overrun the budget → spilling/too slow for this ctx. NG.
              fault = 'oom'
              await reader.cancel().catch(() => {})
              break outer
            }
          }
          const delta = (chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string } }> | undefined)?.[0]?.delta
          if (delta && (delta.content || delta.reasoning_content)) { reachedGen = true; await reader.cancel().catch(() => {}); break outer }
        }
      }
    } catch {
      // aborted by fault watchdog / cancel / budget, or a transport error
    } finally {
      probe.abort()
      await watch.catch(() => {})
    }
    if (reachedGen) return 'ok'
    if (fault) return { fault }
    return { fault: this.cancelled ? 'crash' : 'timeout' }
  }

  /** One non-streaming /v1/chat/completions request. Returns engine-reported tps + ttftMs, or null.
   *  Aborts on the per-test timeout, the cancel kill-switch, or `extraSignal` (the fault watchdog). */
  private async chat(target: string, messages: BenchMessage[], maxTokens: number, timeoutMs: number, extraSignal?: AbortSignal): Promise<{ tps: number; prefillTps: number | null; ttftMs: number } | null> {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (this.abort) signals.push(this.abort.signal)
    if (extraSignal) signals.push(extraSignal)
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'bench',
        messages,
        max_tokens: maxTokens,
        temperature: 0,
        seed: 42,
        stream: false,
        // Re-process the prompt instead of reusing the warmup's cached prefill — otherwise the
        // engine only evaluates the few new template tokens and `prompt_per_second` reflects ~4
        // tokens, not the real prefill throughput over the whole bench prompt.
        cache_prompt: false,
      }),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    })
    if (!res.ok) return null
    const data = (await res.json()) as { timings?: { predicted_per_second?: number; prompt_per_second?: number; prompt_ms?: number } }
    const t = data.timings
    if (!t || typeof t.predicted_per_second !== 'number') return null
    return {
      tps: t.predicted_per_second,
      prefillTps: typeof t.prompt_per_second === 'number' ? t.prompt_per_second : null,
      ttftMs: typeof t.prompt_ms === 'number' ? t.prompt_ms : 0,
    }
  }

  // ---- card-derived recommended sampling (ADR-099) ------------------------

  /** Resolve the model's HF card and extract recommended sampling (temp/top_k/top_p/min_p).
   *  Order (ADR-099): (1) heuristic on the LOCAL repo card; (2) heuristic on the BASE model's card
   *  — most local GGUFs are third-party requants (lmstudio-community/unsloth/noctrex/…) whose card
   *  omits the author's recommended sampling, but they declare the original model, whose card has
   *  it (e.g. Gemma QAT → `google/gemma-…`); (3) LLM fallback (one reload) on the richer card for
   *  prose-only recommendations. Returns undefined when the repo can't be resolved (hand-placed
   *  file), no card is reachable, or nothing parseable is found — the caller then leaves sampling
   *  at the resolved defaults. Never throws.
   *
   *  NOTE: a gated base model (e.g. Gemma's `google/…`) needs a configured HF token to fetch — without
   *  one its card 401s and we fall through (sampling unchanged). */
  private async extractCardSampling(
    entry: ModelEntry,
    winningProfile: LoadProfile,
    caps: Engine['capabilities'],
    sys: SysInfo,
  ): Promise<CardSampling | undefined> {
    const repo = inferRepoFromPath(entry.path, this.store.snapshot().modelDirs)
    if (!repo) return undefined // hand-placed file outside a model dir → no upstream card
    this.state = { ...this.state, step: 'Reading model-card recommendations…' }

    // 1. Structured params sidecar (some quantizers, e.g. unsloth, publish a root-level
    //    `params`/`generation_config.json` with the exact recommended values) — exact, no
    //    parsing/inference needed, so it outranks the heuristic and LLM fallback below.
    const genParams = await this.hf.fetchGenerationParams(repo).catch(() => '')
    const paramsH = parseGenerationParams(genParams)
    if (hasAnySampling(paramsH)) return paramsH

    // 2. Local GGUF repo card — heuristic.
    const localCard = await this.hf.fetchModelCard(repo).catch(() => '')
    const localH = parseCardSampling(localCard)
    if (hasAnySampling(localH)) return localH

    // 3. Base-model fallback — the original model's card (where the author states the recommendation).
    let baseCard = ''
    if (!this.cancelled) {
      const baseRepo = await this.hf.baseModelOf(repo).catch(() => null)
      if (baseRepo && baseRepo !== repo) {
        baseCard = await this.hf.fetchModelCard(baseRepo).catch(() => '')
        const baseH = parseCardSampling(baseCard)
        if (hasAnySampling(baseH)) return baseH
      }
    }

    // 4. LLM fallback (one reload) on the richer card — prose-only / unusual phrasing the scan misses.
    if (this.cancelled) return undefined
    const card = baseCard.length > localCard.length ? baseCard : localCard
    if (!card) return undefined
    const llm = await this.llmExtractSampling(entry, winningProfile, caps, sys, card).catch(() => undefined)
    return llm && hasAnySampling(llm) ? llm : undefined
  }

  /** LLM fallback for {@link extractCardSampling}: briefly reload the winning profile, ask the
   *  model to extract recommended sampling as JSON, then stop. The recommendation is
   *  model-specific (independent of the swept offload), so reusing the winning profile is exact.
   *  Bounded by the readiness window + a short generation timeout; any failure → undefined, and
   *  the engine is always left stopped. */
  private async llmExtractSampling(
    entry: ModelEntry,
    profile: LoadProfile,
    caps: Engine['capabilities'],
    sys: SysInfo,
    card: string,
  ): Promise<CardSampling | undefined> {
    const active = this.registry.active()
    if (!active) return undefined
    const opts: StartOpts = {
      engine: active,
      model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
      modelPath: entry.path,
      extraArgs: profileToArgs(profile, entry, caps, sys.cores),
    }
    try {
      await this.manager.start(opts)
    } catch {
      return undefined
    }
    const ready = await this.awaitReady(Date.now() + READY_TIMEOUT_MS)
    const target = ready === 'ok' ? this.manager.target() : null
    if (!target) {
      await this.stopEngine()
      return undefined
    }
    const text = await this.chatText(target, buildCardExtractionPrompt(card), 200, 60_000).catch(() => null)
    await this.stopEngine()
    return text ? parseLlmSampling(text) : undefined
  }

  /** One non-streaming completion that returns the generated TEXT (vs {@link chat}, which
   *  returns timings). Used by the card-sampling LLM fallback. Honors the per-call timeout and
   *  the cancel kill-switch; null on a non-OK response.
   *
   *  `enable_thinking: false` is REQUIRED here (live-verified): a reasoning model (Gemma 4,
   *  Qwen3, …) otherwise spends the whole token budget on hidden reasoning and either emits no
   *  JSON or truncates it (`finish_reason: length`) — the extraction returns nothing on exactly
   *  the models people run. Card extraction is a structured task that needs no reasoning; with
   *  thinking off, even a 4B model emits clean JSON in well under 200 tokens. Templates that
   *  don't know the kwarg ignore it. */
  private async chatText(target: string, content: string, maxTokens: number, timeoutMs: number): Promise<string | null> {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (this.abort) signals.push(this.abort.signal)
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'bench',
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content ?? null
  }

  /** Save the winning profile as the model's saved profile (tunedBy:'bench') and
   *  persist a benchResults row. Both via the same ConfigStore the route uses. */
  private persistBest(modelKey: string, profile: LoadProfile, cand: BenchCandidate, engineId: string): BenchResult {
    const record: BenchResult = {
      modelKey,
      tps: cand.tps ?? 0,
      ttftMs: cand.ttftMs ?? 0,
      vramMb: cand.vramMb,
      params: cand.params,
      ts: new Date().toISOString(),
    }
    const tuned: LoadProfile = { ...profile, tunedBy: 'bench' }
    this.store.update((cfg) => {
      // Per-engine profile (issue #35): a tune is only valid for the engine it ran on, so
      // persist into that engine's slot only. No active engine (engineId '') → '*' fallback.
      setModelProfile(cfg, modelKey, engineId || '*', tuned)
      cfg.benchResults[modelKey] = record
    })
    return record
  }

  /** Queue an anonymized bench_result telemetry event (spec 09 §3) — ONLY when
   *  telemetry is on. Built from whitelisted fields only (never prompts, paths,
   *  tokens). No uploader (post-launch); just a queue file. Fully fail-safe. */
  private queueTelemetry(record: BenchResult, entry: ModelEntry, sys: SysInfo, appVersion: string, engineVersion: string): void {
    try {
      const cfg = this.store.snapshot()
      const level = cfg.telemetry.level
      if (level !== 'anon' && level !== 'full') return // 'off' / 'unset' → write nothing (AC#4)

      // Lazily mint a stable per-install machineId (never generated while off).
      let machineId = cfg.telemetry.machineId
      if (!machineId) {
        machineId = randomUUID()
        this.store.update((c) => {
          if (!c.telemetry.machineId) c.telemetry.machineId = machineId
        })
      }

      const event = {
        schema: 1,
        event: 'bench_result',
        ts: record.ts,
        machineId,
        app: { version: appVersion, os: sys.os },
        hw: {
          cpu: sys.cpu,
          ramMb: sys.ramMB,
          gpus: sys.gpus.map((g) => ({ name: g.name, vramMb: g.vramMb })),
        },
        payload: {
          model: { name: entry.name, quant: entry.quant, sizeBytes: entry.sizeBytes, arch: entry.arch, moe: entry.moe },
          engine: { version: engineVersion },
          params: record.params,
          result: { tps: record.tps, ttftMs: record.ttftMs, vramMb: record.vramMb, outcome: 'ok' },
        },
      }

      const queueDir = join(this.store.dir(), 'telemetry', 'queue')
      mkdirSync(queueDir, { recursive: true })
      writeFileSync(join(queueDir, `${randomUUID()}.json`), JSON.stringify(event))
    } catch {
      // Telemetry is best-effort and offline-first: a failure to queue must never
      // surface to the user or abort the run (spec 09 §4).
    }
  }
}

// ---- helpers ----------------------------------------------------------------

/** A chat message for the bench request — mirrors the wire shape `/v1/chat/completions` expects. */
export interface BenchMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Bench system prompt: the "Default" agent's REAL injected prompt (ADR-217) — mirrors
 *  `web/src/lib/personas.ts`'s `TURBOLLM_BASE_CAPABILITY` + `TURBOLLM_ARTIFACTS_CAPABILITY` +
 *  date line verbatim (Default carries no persona text of its own, and a bench run has no
 *  personalization/memory facts to inject). No shared module exists between `web/` and `src/`
 *  (separate build targets), so this is kept in sync with personas.ts BY HAND — if one changes,
 *  update the other. Using the real system prompt (instead of synthetic filler) means the bench
 *  request's prefill shape matches what a real first chat message actually sends. */
const BENCH_SYSTEM_PROMPT = `You are running inside TurboLLM, a local-first AI chat app. You can render text-based charts and graphics using Unicode characters. Use them when a visual would genuinely make the response clearer — not by default.

A chart is appropriate when:
- Comparing 3+ items by a numeric metric (rankings, benchmarks, budgets)
- Showing a trend, distribution, or progression over time or stages
- Presenting a hierarchy or dependency tree
- The user asks about data that has a clear pattern hard to read in prose

A chart is NOT appropriate for:
- Conversational replies, opinions, or explanations
- Data with only 1–2 values (just state the numbers inline)
- Lists that are purely qualitative (no meaningful numeric comparison)

When a chart is warranted:
- Bar / column charts: use block fill characters █ ▓ ▒ ░ with a numeric scale and axis labels
- Tables: use box-drawing characters ┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼ for clean borders; align columns
- Line / trend: sketch with · ╌ ╍ ╱ ╲ characters; mark key points with ●
- Tree / hierarchy: use └─ ├─ │ connectors
- Progress / gauge: [████████░░] style with a percentage

Always include a title, axis/column labels, and the underlying numbers. Keep charts compact — no wider than ~60 characters. Wrap chart output in a plain code block (\`\`\`) so spacing is preserved.

TurboLLM also live-previews three kinds of fenced code block, so you can return RENDERED visuals, not just text. When the user wants something visual or interactive, reply with ONE self-contained fenced block in the right language:

- \`\`\`mermaid — diagrams: flowcharts, sequence/class/ER/state diagrams, gantt, mind maps, pie charts. Reach for this on "diagram", "flowchart", "flow", "architecture", "sequence", "how X works" (visually), "org chart", "timeline".
- \`\`\`svg — static vector graphics: icons, logos, illustrations, simple scenes, or charts you draw by hand (bar/line/scatter). Reach for this on "draw", "icon", "logo", "illustration", "graphic".
- \`\`\`html — interactive or animated results: a web page, UI mockup, form, canvas animation, game, calculator — anything needing live CSS/JS. Must be fully self-contained: inline CSS/JS only, NO external URLs, scripts, fonts, images, or network calls (they are blocked).

When to use them:
- ONLY when a rendered visual or runnable result is genuinely what the user asked for. Pick the simplest type that satisfies it — a flowchart is mermaid, not html; an icon is svg, not html.
- Put any explanation BEFORE or AFTER the block, never inside it. At most one artifact per response.

Keep the syntax valid (a diagram that fails to parse is worse than a simpler one that renders):
- mermaid: prefer simple flowcharts/graphs. Wrap any node or message label that contains spaces, parentheses, slashes, or punctuation in double quotes. In sequence diagrams, do NOT use activate/deactivate unless every activate has a matching deactivate — when in doubt, leave them out.
- svg/html: self-contained only — no external URLs, CDNs, fonts, or images.

When NOT to use them (important — do not over-render):
- Plain questions, opinions, explanations, or conversation → normal prose.
- Code meant to be read, copied, or used in a project (a function, a script, a config) → a normal code block in its real language, NOT an artifact. Wrapping ordinary code in html/svg/mermaid is wrong.
- A 1–2 number comparison → just say the numbers. Small text tables/sparklines → the Unicode style above.

Today's date is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`

/** Fixed bench question (ADR-217) — one realistic, medium-length technical question, held
 *  constant across every bench run so results stay comparable run-to-run. Deterministic sampling
 *  (`temperature: 0`, `seed: 42` in {@link BenchRunner.chat}) means the same question always
 *  measures the same thing. Always the LAST message — see {@link buildBenchMessages}. */
const BENCH_QUESTION = 'Explain the main differences between TCP and UDP, and give a couple of real-world scenarios where each one is the better choice.'

// English text is roughly 4 characters per token — used only to size how much filler content
// {@link buildBenchMessages} needs to add to reach the target depth; the real prefill then reports
// the real token count.
const CHARS_PER_TOKEN = 4

// Fraction of the configured ctx the bench prompt targets, before the depth cap below — see
// {@link benchPromptTokens}.
const BENCH_CTX_FRACTION = 0.75
// Depth cap (ADR-217 round 3): a founder live test at the UNCAPPED 150k depth (0.75 × their
// 200k ctx) measured 3.2 tok/s (127s just for first token) — MORE pessimistic than their real
// ~11 tok/s chat experience, not just slower to bench. A mid-depth test at 22k tokens measured
// 10.4 tok/s, matching real chat almost exactly. So depth beyond ~20-30k tokens isn't just
// expensive to bench, it's actively LESS representative of typical real usage — real
// conversations rarely sustain tens of thousands of tokens of *dense* back-and-forth before a
// user would have started a fresh chat or the context reset. 32k is the founder-directed cap:
// deep enough to capture the real depth-dependent slowdown (validated: 22k already tracked real
// chat within ~5%), capped low enough that bench time stays close to the original ~8k-depth
// runtime instead of scaling unboundedly with ctx.
const BENCH_MAX_PROMPT_TOKENS = 32_000

/** How many prompt tokens the bench trial should target: {@link BENCH_CTX_FRACTION} of the
 *  configured context, capped at {@link BENCH_MAX_PROMPT_TOKENS} (ADR-217 round 3 — see that
 *  constant's comment for why the cap is correctness, not just speed). Floored at 256 so a tiny
 *  ctx still gets a minimally-realistic bench. */
export function benchPromptTokens(ctx: number): number {
  return Math.max(256, Math.min(BENCH_MAX_PROMPT_TOKENS, Math.floor(ctx * BENCH_CTX_FRACTION)))
}

/** Deterministic filler topics used to pad the bench prompt out toward the target depth (ADR-217
 *  round 2) — realistic technical prose, not Lorem-ipsum repetition, so the attention pattern isn't
 *  degenerate. Cycled in a fixed order (never random / never Date/Math.random-seeded) so a bench
 *  run stays exactly reproducible. */
const FILLER_TOPICS = [
  'the history and evolution of relational databases, from IBM System R through modern distributed SQL engines',
  'how modern CPUs use branch prediction and speculative execution to hide pipeline stalls',
  'the tradeoffs between microservices and monolithic architectures for a mid-sized SaaS company',
  'how TCP congestion control algorithms like Reno, Cubic, and BBR differ in their approach to bandwidth estimation',
  "the design philosophy behind Rust's ownership and borrowing system compared to garbage collection",
  'how content delivery networks use anycast routing and edge caching to reduce latency',
  'the tradeoffs between REST, GraphQL, and gRPC for building internal service APIs',
  'how modern GPUs pipeline shader execution across thousands of parallel cores',
]

/** One filler assistant answer for {@link FILLER_TOPICS}. `round` distinguishes repeated cycles
 *  through the topic list (needed once the target depth exceeds one pass) so the prompt isn't
 *  made of byte-identical repeated blocks. */
function fillerAnswer(topic: string, round: number): string {
  const sentences: string[] = []
  for (let i = 0; i < 40; i++) {
    sentences.push(
      `Regarding ${topic} (pass ${round}, point ${i + 1}), the underlying tradeoffs depend heavily on the specific ` +
        'workload, the scale of the system, and the operational constraints the team is working under, which is ' +
        'why experienced engineers tend to reach for established patterns before inventing something bespoke.',
    )
  }
  return sentences.join(' ')
}

/** Build the bench request for `ctx`: the real Default-agent system prompt, deterministic
 *  realistic filler exchanges padded out to ~{@link benchPromptTokens}(ctx) tokens (ADR-217 round
 *  2 — matches the depth a real, substantially-filled conversation reaches at this ctx), then the
 *  fixed {@link BENCH_QUESTION} as the final turn so every run asks the identical last question. */
export function buildBenchMessages(ctx: number): BenchMessage[] {
  const targetChars = benchPromptTokens(ctx) * CHARS_PER_TOKEN
  const messages: BenchMessage[] = [{ role: 'system', content: BENCH_SYSTEM_PROMPT }]
  let chars = BENCH_SYSTEM_PROMPT.length
  for (let round = 0; chars < targetChars; round++) {
    const topic = FILLER_TOPICS[round % FILLER_TOPICS.length]
    const q = `Can you explain ${topic}?`
    const a = fillerAnswer(topic, Math.floor(round / FILLER_TOPICS.length) + 1)
    messages.push({ role: 'user', content: q }, { role: 'assistant', content: a })
    chars += q.length + a.length
  }
  messages.push({ role: 'user', content: BENCH_QUESTION })
  return messages
}

/** True when a candidate's ABSOLUTE VRAM use leaves less than `headroomMb` free within `budgetMb`
 *  — the VRAM this profile is allowed to use: the summed pool for a layer/row split, or a SINGLE
 *  card for a single-GPU 'none' split (ADR-054; `gpuBudgetMb`). The search then offloads more so
 *  the chosen config keeps a safety margin against a later desktop / ComfyUI VRAM grab. Unknown
 *  VRAM (non-NVIDIA) or no budget → never blocks. */
export function overHeadroom(vramAbsMb: number | null, budgetMb: number, headroomMb: number): boolean {
  if (!vramAbsMb || budgetMb <= 0) return false
  return vramAbsMb > budgetMb - headroomMb
}

/** Which multi-GPU split strategies auto-tune should try, in search order (ADR-054). A single-GPU
 *  box — or an engine whose probe didn't confirm the split flags — yields just the profile's own gpu
 *  setting (one strategy → unchanged behavior). A >1-GPU box returns single-GPU FIRST (the whole
 *  model on one card, offered when it plausibly fits even with the smallest quality-preserving KV
 *  quant, which the inner sweep can then pick) and the profile's split (default: layer across all)
 *  second. Single-GPU is tried first because, when the model fits one card, it beats any split (a
 *  layer-split is a sequential cross-GPU pipeline + per-token PCIe activation copies), so a
 *  budget-truncated run still measured the likely winner. */
export function pickSplitStrategies(
  entry: ModelEntry,
  sys: SysInfo,
  base: LoadProfile,
  caps: Engine['capabilities'],
): GpuProfile[] {
  const has = (flag: string) => caps.flags.length === 0 || caps.flags.includes(flag)
  if (sys.gpus.length <= 1 || !has('--split-mode') || !has('--main-gpu')) return [base.gpu]

  const strategies: GpuProfile[] = []
  // Single-GPU: whole model on one card. Judge feasibility with the SMALLEST quality-preserving KV
  // the engine offers (the inner KV sweep can pick it to fit), so a model that only fits one card
  // with turbo4 still gets the single-GPU branch it would win on.
  const kvOpts = pickKvQuants(base.kvTypeK, caps.kvTypes)
  const bestFitKv = kvOpts.reduce((a, b) => (kvBytes(b) < kvBytes(a) ? b : a), kvOpts[0] ?? base.kvTypeK)
  const mainGpu = base.gpu.mainGpu >= 0 ? base.gpu.mainGpu : 0
  const single: GpuProfile = { ...base.gpu, splitMode: 'none', mainGpu, tensorSplit: [] }
  const singleFits =
    estimateVram({ ...base, gpu: single, kvTypeK: bestFitKv, kvTypeV: bestFitKv }, entry, sys).verdict !== 'overflow'
  if (singleFits) strategies.push(single)

  // The profile's current split (default: layer across all GPUs) — always kept, as the fallback for
  // models too big for one card and so a tuned result can never be worse than today's default.
  strategies.push(base.gpu)

  // De-dup by the fields that actually reach the launch args (e.g. the user already pinned 'none').
  const seen = new Set<string>()
  return strategies.filter((g) => {
    const key = `${g.splitMode}|${g.mainGpu >= 0 ? g.mainGpu : 0}|${g.tensorSplit.join(',')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Human-readable label for a split strategy, for the live step / bench log. */
function splitLabel(g: GpuProfile, gpuCount: number): string {
  if (g.splitMode === 'none') return `single-GPU (GPU ${g.mainGpu >= 0 ? g.mainGpu : 0})`
  if (g.splitMode === 'row') return `row-split across ${gpuCount} GPUs`
  return `layer-split across ${gpuCount} GPUs`
}

/** The quality-preserving KV-cache types to try, in search order. The model's current/base type
 *  comes first (so a budget-truncated run is never worse than today), then the other near-lossless
 *  options the engine actually supports. An unprobed engine (empty kvTypes) is treated as f16-only,
 *  so only the base type is offered. See {@link QUALITY_KV}. */
export function pickKvQuants(baseKv: string, kvTypes: string[]): string[] {
  const supported = (t: string) => (kvTypes.length === 0 ? t === baseKv : kvTypes.includes(t))
  const out: string[] = []
  for (const t of [baseKv, ...QUALITY_KV]) if (supported(t) && !out.includes(t)) out.push(t)
  return out
}

/** Speed objective ("best prefill AND t/s"): generation t/s is primary; when two configs are within
 *  OUTPUT_TIE of each other on generation t/s, the one with faster prefill wins. Returns true when
 *  `a` beats `b`. */
export function betterBySpeed(
  a: { tps: number | null; prefillTps: number | null },
  b: { tps: number | null; prefillTps: number | null },
): boolean {
  const at = a.tps ?? 0
  const bt = b.tps ?? 0
  if (bt <= 0) return at > 0
  const rel = (at - bt) / bt
  if (rel > OUTPUT_TIE) return true
  if (rel < -OUTPUT_TIE) return false
  return (a.prefillTps ?? 0) > (b.prefillTps ?? 0)
}

/** Bytes per cached element for a KV-cache type (defaults to f16's 2 for unknown types). Note:
 *  this is a nominal/declared size, not a measured one — ADR-219 found turbo4's REAL VRAM and
 *  compute cost is higher than its 0.5-bytes-per-element entry here implies (it runs a Walsh-
 *  Hadamard rotation + InnerQ calibration per cached token, plus extra rotation-tensor VRAM, none
 *  of which this table accounts for) — treat comparisons using this table as directional only. */
function kvBytes(t: string): number {
  return KV_BYTES[t] ?? 2
}
/** The smallest KV-cache type in a candidate set (by nominal bytes per element). */
function kvSmallest(c: string[]): string {
  return c.reduce((a, b) => (kvBytes(b) < kvBytes(a) ? b : a), c[0])
}

/** TurboQuant's rotation-based KV types (ADR-219). Confirmed from the fork's own source
 *  (turbo-wht.cu/.cuh, InnerQ calibration state, "+3 rotation tensor overhead" in its merge
 *  notes): these run a Walsh-Hadamard rotation + variance-equalizing calibration on every cached
 *  token, plus real extra rotation-tensor VRAM — none of which `KV_BYTES`'s nominal bytes-per-
 *  element accounts for. That's WHY turbo4 and q4_0 show the identical "0.5" in `KV_BYTES` (both
 *  nominally 4-bit) yet turbo4 measured meaningfully slower and higher-VRAM in real testing: the
 *  table only captures the raw quantized size, not this extra cost. It's a deliberate trade for
 *  better quality at low bit-widths (the fork's own notes: "turbo4/turbo3 match f16 quality"),
 *  not a bug — see {@link kvSpeedAdvisory}. */
const TURBO_KV_TYPES = new Set(['turbo2', 'turbo3', 'turbo4'])

/** ADR-219: auto-tune no longer sweeps KV-cache type — it tunes offload on whatever type the user
 *  already selected, since the quality/speed tradeoff (confirmed real via ADR-217/219's live
 *  testing: turbo4 vs. q4_0 on the same offload, then root-caused in TurboQuant's own source — see
 *  {@link TURBO_KV_TYPES}) belongs to the user, not a silent auto-pick. This surfaces that tradeoff
 *  instead of hiding it: when the winner is slow (<20 tok/s), find the smallest available type that
 *  is NOT a turbo type (whose real cost `KV_BYTES` understates) and no bigger, nominally, than the
 *  one tuned — note it without switching anything. A same-size non-turbo alternative still counts
 *  (that's exactly the turbo4-vs-q4_0 case that motivated this), which a plain "strictly smaller
 *  bytes" comparison would miss. Null when already fast enough, no such alternative exists, or the
 *  engine wasn't probed. `20` is a blunt heuristic, not a guarantee. */
export function kvSpeedAdvisory(tps: number | null, currentKv: string, supportedKvTypes: string[]): string | null {
  if ((tps ?? 0) >= 20 || supportedKvTypes.length === 0) return null
  const isTurbo = TURBO_KV_TYPES.has(currentKv)
  const candidates = supportedKvTypes.filter(
    (t) => t !== currentKv && kvBytes(t) <= kvBytes(currentKv) && (!isTurbo || !TURBO_KV_TYPES.has(t)),
  )
  if (candidates.length === 0) return null
  const smallest = kvSmallest(candidates)
  return `This result used the "${currentKv}" KV cache type. A different type (e.g. "${smallest}") may run faster, at some output-quality cost — try it manually if you want the extra speed.`
}

/** Best-effort current NVIDIA VRAM use in MB (sum across GPUs). Null on non-NVIDIA
 *  or when nvidia-smi is absent — never throws (spec 09 §1). */
function readNvidiaVramMb(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'nvidia-smi',
        ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve(null)
          const total = stdout
            .trim()
            .split('\n')
            .map((l) => parseInt(l.trim(), 10))
            .filter((n) => Number.isFinite(n))
            .reduce((a, b) => a + b, 0)
          resolve(total > 0 ? total : null)
        },
      )
    } catch {
      resolve(null)
    }
  })
}

/** Pure parser for `rocm-smi --showmeminfo vram --json` output, split out for direct testing
 *  (mirrors `sysinfo.ts`'s `parseRocmSmi`). Sums "VRAM Total Used Memory (B)" across every card.
 *  Null on unparseable JSON or when no card reports a positive used-memory figure. */
export function parseRocmVramUsed(memJson: string): number | null {
  try {
    const mem = JSON.parse(memJson) as Record<string, Record<string, string>>
    let total = 0
    for (const fields of Object.values(mem)) {
      const usedKey = Object.keys(fields).find((k) => /VRAM Total Used Memory/i.test(k))
      const bytes = usedKey ? parseInt(String(fields[usedKey]).trim(), 10) || 0 : 0
      total += bytes
    }
    const mb = Math.round(total / 1e6)
    return mb > 0 ? mb : null
  } catch {
    return null
  }
}

/** Best-effort current AMD VRAM use in MB (sum across cards) via ROCm's rocm-smi. Null when
 *  rocm-smi is absent (ROCm not installed) or its output can't be parsed — never throws.
 *  Mirrors `sysinfo.ts`'s `parseRocmSmi` (same `--showmeminfo vram --json` call), reading
 *  "VRAM Total Used Memory (B)" instead of "VRAM Total Memory (B)" (ADR-217: before this, the
 *  headroom gate had zero VRAM protection on AMD — {@link readNvidiaVramMb} silently returned
 *  null on every AMD box and {@link overHeadroom} treats unknown VRAM as "never over"). */
function readRocmVramMb(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      execFile('rocm-smi', ['--showmeminfo', 'vram', '--json'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        resolve(err || !stdout ? null : parseRocmVramUsed(stdout))
      })
    } catch {
      resolve(null)
    }
  })
}

/** Best-effort current GPU VRAM use in MB (sum across GPUs), vendor-aware (ADR-217). Tries
 *  nvidia-smi first (unconditionally — cheap to attempt, and correct even without `sys`), then
 *  falls back to rocm-smi only when the box has a known AMD GPU. Null when neither applies
 *  (Intel/Apple/CPU-only, or no live VRAM reader for that vendor) — matches
 *  {@link overHeadroom}'s "unknown VRAM never blocks" contract. Never throws. */
async function readGpuVramMb(sys: SysInfo): Promise<number | null> {
  const nv = await readNvidiaVramMb()
  if (nv !== null) return nv
  if (sys.gpus.some((g) => g.vendor === 'amd')) return readRocmVramMb()
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Last ~8KB of a (possibly growing) log file as a string, or '' on error. Cheap enough to poll
 *  during readiness to catch an OOM the engine prints but hasn't crashed on yet. */
function readLiveTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-8000)
  } catch {
    return ''
  }
}
