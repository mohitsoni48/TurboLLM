// Auto-benchmark + auto-tune runner (Differentiator #2, spec 09 §1). Owns the engine exclusively
// for the duration of a run. Two-phase per quality-preserving KV-cache type (f16 / q8_0 / turbo4):
// (1) pin the offload param (ngl for dense, nCpuMoe for MoE) with CHEAP VRAM probes — load, read
// absolute VRAM, stop, no generation — keeping the most on the GPU while leaving a ≤1 GB headroom
// (so a later VRAM grab can't tip it into sysmem-spill); (2) run ONE real prefill + tok/s bench at
// that config. Picks the overall winner by best prefill AND generation t/s, saves it as the model's
// profile (tunedBy:'bench'), persists a benchResults row, and — when telemetry is on — queues an
// anonymized bench_result event. Single active run; additive; fail-safe (a bad candidate is
// recorded and the sweep continues).
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BenchResult, ConfigStore } from '../config/config'
import type { Manager, StartOpts } from '../engines/manager'
import type { Registry } from '../engines/registry'
import type { Engine } from '../config/config'
import type { Scanner, ModelEntry } from '../models/scanner'
import { deriveDefault, profileToArgs, resolveProfile, type LoadProfile } from '../models/profile'
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
  params: { ctx: number; ngl: number; nCpuMoe: number; parallel: number; kvTypeK: string; flashAttn: string }
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
  }
}

// Hard limits (spec 09 §1).
// Readiness window: how long to wait for a candidate to come up before calling it a timeout.
// Generous enough for a large model (e.g. a 35B) to load; a candidate that over-allocates VRAM
// is caught faster than this by scanning the live log for an OOM signature (see awaitReady).
const READY_TIMEOUT_MS = 150_000
// Per-candidate cap: load + warmup + the measured request must all finish within this window,
// else the candidate is recorded 'timeout' and the sweep moves on — one hung config can't stall
// the run.
const PER_TEST_TIMEOUT_MS = 3 * 60_000
// Grace before judging prefill speed — give the first tokens time to flow before projecting.
const PREFILL_GRACE_MS = 8_000
// Overall budget — sized to fit a full binary search of per-test-capped trials (~log2(layers)).
const TOTAL_BUDGET_MS = 20 * 60_000
// Memory-pressure / GPU-exhaustion signatures. Beyond a clean "out of memory", a config that
// overflows VRAM often surfaces a secondary CUDA fault (failed allocation, or "device not ready"
// during graph capture once the allocation failed). Treat all of these as OOM so the search
// offloads more and the result reads as a fit problem rather than a mystery crash.
const OOM_RE = /out of memory|cudaMalloc|failed to allocate|unable to allocate|device not ready|CUDA error/i

// English text is roughly 4 characters per token — used to size the bench prompt.
const CHARS_PER_TOKEN = 4

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
const VRAM_HEADROOM_MB = 1024
// Output-t/s tie band for the speed objective: when two configs are within this relative margin
// on generation speed, the one with faster prefill wins (best prefill AND t/s, not just t/s).
const OUTPUT_TIE = 0.05
// If swapping the KV-cache quant from largest (f16) to smallest changes VRAM by less than this, the
// cache is small enough that the quant barely affects how much of the model fits on the GPU — so
// the highest-precision, fastest-kernel type (f16) is the right pick and no quant sweep is needed.
const KV_SPREAD_MIN = 1024
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
    | { modelKey: string; profile: LoadProfile; cand: BenchCandidate; entry: ModelEntry; sys: SysInfo; engineVersion: string }
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

  /** Persist the finished run's winning profile (the user clicked Save). Returns false if there is
   *  nothing to save (no completed run, or it was already saved / discarded). */
  saveResult(): boolean {
    const w = this.winning
    if (!w) return false
    const record = this.persistBest(w.modelKey, w.profile, w.cand)
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
    if (active.kind === 'mlx' || active.kind === 'koboldcpp') {
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
      void this.manager.stopAndWait().catch(() => {})
    })
  }

  // ---- the run ------------------------------------------------------------

  private async run(modelKey: string, entry: ModelEntry, base?: Partial<LoadProfile>): Promise<void> {
    const sys = getSysInfo()
    this.runLogMeta = { modelKey, startedAt: new Date().toISOString(), sys }
    const active = this.registry.active()
    const caps = active?.capabilities ?? { flags: [], kvTypes: [] }
    const saved = this.store.snapshot().modelProfiles[modelKey] as Partial<LoadProfile> | undefined
    const defaults = this.store.snapshot().modelDefaults
    // Honor the user's CURRENT config (the dialog draft, passed as `base`) as the basis for every
    // candidate — ctx, flash-attn, sampling, etc. `base` overrides the saved profile + global
    // defaults. Auto-tune then CHOOSES the KV-cache type (by reasoning about VRAM, below) and tunes
    // the offload (ngl / nCpuMoe) under it, so the result reflects settings they'll load with.
    // Tune with speculative decoding OFF. Spec (NextN / MTP / draft) runs the model ~twice per
    // step, so on a partially-offloaded model the extra CPU work craters t/s (measured ~2 t/s vs
    // ~24 with it off) and a load-time VRAM probe can't see that runtime cost. The offload + KV
    // choice here is for the base model; spec stays a separate load-time toggle, best left to the
    // user for when a model fits fully on the GPU.
    // Tune WITH the vision projector (mmproj) exactly as the user has it configured (useMmproj /
    // mmprojGpu come from `resolved`, untouched here). A vision model always loads with mmproj
    // resident (see resolveProfile), so the offload search must account for its real VRAM
    // footprint (~1-2 GB) — searching with it excluded would pick an offload that fits WITHOUT
    // the projector, then load the projector on top of that afterward, eating into the
    // VRAM_HEADROOM_MB safety margin the search thought it had (or spilling outright).
    const resolved = resolveProfile(entry, sys, saved, base, defaults)
    const baseProfile: LoadProfile = { ...resolved, speculative: 'off', mtpHeadPath: '', draftModelPath: '' }

    const results: BenchCandidate[] = []
    let best: { cand: BenchCandidate; profile: LoadProfile } | null = null

    // --- Choose which KV-cache type(s) to tune, by reasoning about VRAM (not by sweeping all) ---
    // The quant only matters in proportion to how big the KV cache actually is. Measure that cheaply:
    // the VRAM SPREAD between the largest and smallest candidate at one shared offload is exactly
    // their KV-size difference (weights/overhead cancel) — true for any architecture, hybrid or not.
    //   • tiny KV (spread ≤ KV_SPREAD_MIN) → the quant barely changes the fit, so the highest-
    //     precision/fastest-kernel type (f16) wins outright → tune just that.
    //   • big KV → a smaller quant frees real VRAM for more of the model on the GPU, but its kernel
    //     can be slower (turbo4), so tune BOTH the smallest (max-fit) and q8_0 (stock fallback) and
    //     let the measured prefill + t/s decide.
    const kvCandidates = pickKvQuants(baseProfile.kvTypeK, caps.kvTypes)
    // Default to the user's own KV type (covers CPU-only — no VRAM pressure, the quant barely
    // matters — and unprobed/single-candidate engines). Only with a GPU and a real choice do we
    // size the cache and decide.
    let kvToTune = kvCandidates.slice(0, 1)
    if (sys.gpus.length > 0 && kvCandidates.length > 1) {
      const spread = await this.calibrateKvSpread(entry, sys, baseProfile, caps, kvCandidates, results)
      kvToTune = decideKvToBench(spread, kvCandidates)
      const swing = spread < 0 ? 'unknown' : spread >= Number.MAX_SAFE_INTEGER ? 'huge' : `${Math.round(spread)} MB`
      this.state = { ...this.state, step: `KV cache swing ${swing} → tuning ${kvToTune.join(' + ')}`, candidates: results }
      this.emit(`KV spread ${swing} → tuning ${kvToTune.join(' + ')}`)
    }

    for (let i = 0; i < kvToTune.length && !this.cancelled && Date.now() <= this.deadline; i++) {
      const kv = kvToTune[i]
      const kvBase: LoadProfile = { ...baseProfile, kvTypeK: kv, kvTypeV: kv }
      const found = entry.moe
        ? await this.moeSearch(entry, sys, kvBase, caps, results)
        : await this.denseSearch(entry, sys, kvBase, caps, results)
      if (found && (!best || betterBySpeed(found.cand, best.cand))) best = found
      if (best) this.state = { ...this.state, bestTps: best.cand.tps ?? undefined }
    }

    // Engine is always left stopped at the end of a run (AC#3 for cancel; also tidy
    // for a normal finish — the user explicitly loads afterward).
    await this.manager.stopAndWait().catch(() => {})

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
        await this.manager.stopAndWait().catch(() => {}) // in case the LLM fallback loaded a model
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
      // Hold the winner instead of auto-saving — the UI shows a Save/Cancel results dialog and
      // persists via POST /bench/save only when the user clicks Save.
      this.winning = { modelKey, profile, cand: best.cand, entry, sys, engineVersion: active?.version ?? '' }
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
   *  HIGHEST whose absolute VRAM still leaves the ≤1 GB headroom. Whether a config fits/spills is a
   *  LOAD-time property, so we find that ngl with cheap load-and-read-VRAM probes (no generation),
   *  and only measure t/s at the winner. CPU-only machines skip straight to ngl=0. */
  private async denseSearch(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile } | null> {
    let bestNgl: number | null = 0 // CPU-only box → everything on CPU, no probing needed.

    if (sys.gpus.length > 0) {
      // Binary search ngl ∈ [0, blockCount] for the HIGHEST that loads with ≤1 GB-headroom VRAM.
      const hi0 = entry.blockCount > 0 ? entry.blockCount : 99
      let lo = 0, hi = hi0
      bestNgl = null
      while (lo <= hi && !this.cancelled && Date.now() <= this.deadline) {
        const mid = Math.floor((lo + hi) / 2)
        this.state = { ...this.state, step: `KV ${base.kvTypeK}: probing ngl=${mid} (range ${lo}–${hi})…`, candidates: results }
        const probe = await this.probeVram(entry, sys, { ...base, ngl: mid }, caps)
        this.pushProbe(results, base, 'ngl', mid, probe)
        await this.settleGpu()
        if (probe.outcome === 'ok' && !overHeadroom(probe.vramAbsMb, sys)) {
          bestNgl = mid // fits with headroom → record, try MORE GPU layers
          lo = mid + 1
        } else {
          hi = mid - 1 // oom / over-headroom / crash → fewer GPU layers
        }
      }
    }

    if (bestNgl === null) return null
    return this.benchAt(entry, sys, { ...base, ngl: bestNgl }, caps, results, `ngl=${bestNgl}`)
  }

  /** MoE models: pin `nCpuMoe` by VRAM probing (Phase 1), then run the full bench once (Phase 2).
   *  Fewer CPU experts = more on GPU = faster, so the best is the LOWEST nCpuMoe whose absolute VRAM
   *  still leaves the ≤1 GB headroom. Found with cheap load-and-read-VRAM probes (no generation);
   *  t/s is measured only at the winner. */
  private async moeSearch(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile } | null> {
    const derived = deriveDefault(entry, sys)
    const maxN = entry.blockCount > 0 ? entry.blockCount : (derived.nCpuMoe || 0)
    let lo = 0, hi = maxN
    let bestN: number | null = null

    while (lo <= hi && !this.cancelled && Date.now() <= this.deadline) {
      const mid = Math.floor((lo + hi) / 2)
      this.state = { ...this.state, step: `KV ${base.kvTypeK}: probing nCpuMoe=${mid} (range ${lo}–${hi})…`, candidates: results }
      const probe = await this.probeVram(entry, sys, { ...base, nCpuMoe: mid }, caps)
      this.pushProbe(results, base, 'nCpuMoe', mid, probe)
      await this.settleGpu()
      if (probe.outcome === 'oom' || overHeadroom(probe.vramAbsMb, sys)) {
        lo = mid + 1 // too much on GPU → more CPU experts to free VRAM / restore the headroom
      } else if (probe.outcome === 'ok') {
        bestN = mid // fits with headroom → record, try FEWER CPU experts (more on GPU)
        hi = mid - 1
      } else {
        lo = mid + 1 // crash / timeout → treat as memory pressure
      }
    }

    if (bestN === null) return null
    return this.benchAt(entry, sys, { ...base, nCpuMoe: bestN }, caps, results, `nCpuMoe=${bestN}`)
  }

  /** Measure how much the KV-cache QUANT swings VRAM at this context — so we tune only the quant(s)
   *  that matter instead of sweeping all. Two cheap probes (largest vs smallest candidate) at ONE
   *  shared offload: their VRAM difference is exactly the KV-size difference (weights + overhead are
   *  identical at the same offload), valid for any architecture. Returns that swing in MB scaled to
   *  the full model, `Number.MAX_SAFE_INTEGER` if even the largest quant won't load (cache enormous
   *  → definitely the big-KV regime), or -1 if it couldn't be sized at all. */
  private async calibrateKvSpread(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    candidates: string[],
    results: BenchCandidate[],
  ): Promise<number> {
    const big = kvLargest(candidates)
    const small = kvSmallest(candidates)
    if (big === small) return 0

    // A shared offload where the KV is resident on the GPU (so the swing is measurable) yet the
    // model loads even with the LARGEST cache: MoE → all experts on CPU (attention + KV stay on
    // GPU); dense → a small fraction of layers on GPU.
    const blocks = entry.blockCount > 0 ? entry.blockCount : 32
    const moeMax = entry.blockCount > 0 ? entry.blockCount : deriveDefault(entry, sys).nCpuMoe || 0
    const refNgl = Math.max(1, Math.floor(blocks / 4))
    const refOffload: Partial<LoadProfile> = entry.moe ? { nCpuMoe: moeMax, ngl: 99 } : { ngl: refNgl }
    const knob: 'ngl' | 'nCpuMoe' = entry.moe ? 'nCpuMoe' : 'ngl'
    const knobVal = entry.moe ? moeMax : refNgl

    this.state = { ...this.state, step: `Sizing the KV cache (${big} vs ${small})…`, candidates: results }
    const pBig = await this.probeVram(entry, sys, { ...base, kvTypeK: big, kvTypeV: big, ...refOffload }, caps)
    this.pushProbe(results, { ...base, kvTypeK: big, ...refOffload }, knob, knobVal, pBig)
    await this.settleGpu()
    const pSmall = await this.probeVram(entry, sys, { ...base, kvTypeK: small, kvTypeV: small, ...refOffload }, caps)
    this.pushProbe(results, { ...base, kvTypeK: small, ...refOffload }, knob, knobVal, pSmall)
    await this.settleGpu()

    if (pBig.outcome !== 'ok' || pBig.vramAbsMb === null) return Number.MAX_SAFE_INTEGER // huge cache
    if (pSmall.outcome !== 'ok' || pSmall.vramAbsMb === null) return -1 // couldn't size it
    let spread = pBig.vramAbsMb - pSmall.vramAbsMb
    // Dense: only the GPU layers' KV is resident at refNgl, so scale the partial swing up to the
    // whole model. (MoE keeps every attention layer's KV on GPU already → no scaling.)
    if (!entry.moe) spread = spread * (blocks / refNgl)
    return Math.max(0, spread)
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
      vramAbsMb = await readNvidiaVramMb()
    }
    await this.manager.stopAndWait().catch(() => {})
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
    await this.settleGpu()
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
      nCpuMoe: profile.nCpuMoe,
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

    const vramBefore = await readNvidiaVramMb()
    phase('loading model…')
    try {
      await this.manager.start(opts)
    } catch {
      return fail('crash')
    }

    // Wait for ready / detect crash / OOM within the readiness window (and per-test cap).
    const outcome = await this.awaitReady(testDeadline)
    if (outcome !== 'ok') {
      await this.manager.stopAndWait().catch(() => {})
      return fail(outcome)
    }

    const target = this.manager.target()
    if (!target) {
      await this.manager.stopAndWait().catch(() => {})
      return fail('crash')
    }
    const logPath = this.manager.logPath()

    // Bench prompt = 75% of the configured ctx, capped at 8k (see benchPromptTokens).
    const promptContent = makeBenchContent(benchPromptTokens(profile.ctx))

    // Prefill gate (doubles as warmup): stream the prompt and fail fast if it's spilling/crawling
    // or the engine faults — so a config that doesn't fit at this ctx is rejected in seconds and the
    // search offloads more, instead of hanging out the whole per-test budget.
    phase('warming up…')
    const warm = await this.prefillProbe(target, promptContent, remaining(), logPath, stepPrefix)
    if (warm !== 'ok') {
      await this.manager.stopAndWait().catch(() => {})
      return fail(warm.fault)
    }
    phase('measuring t/s…')
    const measured = await this.runChatWatched(target, promptContent, 128, remaining(), logPath)
    const vramAfter = await readNvidiaVramMb()
    await this.manager.stopAndWait().catch(() => {})

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
  private async settleGpu(): Promise<void> {
    await sleep(1500) // base: let the killed engine process release + the driver settle
    let prev = await readNvidiaVramMb()
    if (prev === null) return // non-NVIDIA / no nvidia-smi: the fixed wait is all we can do
    for (let i = 0; i < 12 && !this.cancelled; i++) {
      await sleep(1000)
      const cur = await readNvidiaVramMb()
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
    content: string,
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
      timed = await this.chat(target, content, maxTokens, budgetMs, probe.signal)
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
    content: string,
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
        body: JSON.stringify({ model: 'bench', messages: [{ role: 'user', content }], max_tokens: 8, temperature: 0, seed: 42, stream: true, return_progress: true }),
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
  private async chat(target: string, content: string, maxTokens: number, timeoutMs: number, extraSignal?: AbortSignal): Promise<{ tps: number; prefillTps: number | null; ttftMs: number } | null> {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (this.abort) signals.push(this.abort.signal)
    if (extraSignal) signals.push(extraSignal)
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'bench',
        messages: [{ role: 'user', content }],
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
      await this.manager.stopAndWait().catch(() => {})
      return undefined
    }
    const text = await this.chatText(target, buildCardExtractionPrompt(card), 200, 60_000).catch(() => null)
    await this.manager.stopAndWait().catch(() => {})
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
  private persistBest(modelKey: string, profile: LoadProfile, cand: BenchCandidate): BenchResult {
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
      cfg.modelProfiles[modelKey] = tuned as unknown as Record<string, unknown>
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

/** Filler text for the bench prompt — varied enough to avoid tokenizer-dedup tricks. */
const BENCH_BASE =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure ' +
  'dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt ' +
  'mollit anim id est laborum. '

/** Build a bench prompt of approximately `targetTokens` tokens by repeating BENCH_BASE.
 *  Uses a 4-chars-per-token estimate — close enough for English lorem text. */
function makeBenchContent(targetTokens: number): string {
  const targetChars = Math.max(BENCH_BASE.length, targetTokens * CHARS_PER_TOKEN)
  const reps = Math.ceil(targetChars / BENCH_BASE.length)
  return BENCH_BASE.repeat(reps).slice(0, targetChars) + '\n\nSummarize the passage above in one sentence.'
}

/** How many prompt tokens to use for a bench trial: 75% of the configured context, capped at 8k.
 *  The cap matters for BOTH speed and accuracy. Speed: a huge model at 200K would otherwise spend
 *  the whole trial prefilling tens of thousands of tokens. Accuracy: generation t/s falls with how
 *  deep the context is, and a very deep measurement reflects a worst case, not typical use — an 8k
 *  context is representative of normal prompts and makes the per-token attention cost (which is
 *  where a low-bit KV's slower kernel shows up) realistic rather than exaggerated. KV/VRAM is
 *  allocated for the full ctx at load regardless, so this only sizes the speed measurement. */
function benchPromptTokens(ctx: number): number {
  return Math.max(256, Math.min(8_192, Math.floor(ctx * 0.75)))
}

/** Total dedicated VRAM across all GPUs, MB (0 when none / non-NVIDIA). */
function totalVramMb(sys: SysInfo): number {
  return sys.gpus.reduce((s, g) => s + (g.vramMb || 0), 0)
}

/** True when a candidate's ABSOLUTE VRAM use leaves less than VRAM_HEADROOM_MB free — i.e. it's
 *  too close to the spill edge. The search then offloads more so the chosen config keeps a safety
 *  margin against a later desktop / ComfyUI VRAM grab. Unknown VRAM (non-NVIDIA) → never blocks. */
function overHeadroom(vramAbsMb: number | null, sys: SysInfo): boolean {
  const total = totalVramMb(sys)
  if (!vramAbsMb || total <= 0) return false
  return vramAbsMb > total - VRAM_HEADROOM_MB
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

/** Bytes per cached element for a KV-cache type (defaults to f16's 2 for unknown types). */
function kvBytes(t: string): number {
  return KV_BYTES[t] ?? 2
}
/** The largest / smallest KV-cache type in a candidate set (by bytes per element). */
function kvLargest(c: string[]): string {
  return c.reduce((a, b) => (kvBytes(b) > kvBytes(a) ? b : a), c[0])
}
function kvSmallest(c: string[]): string {
  return c.reduce((a, b) => (kvBytes(b) < kvBytes(a) ? b : a), c[0])
}

/** Decide which quality-preserving KV-cache type(s) to actually tune, from the measured VRAM swing
 *  (see {@link calibrateKvSpread}). Tiny swing → the cache is small, so the quant barely changes
 *  the fit and the highest-precision/fastest-kernel type (f16) wins → tune only it. Big (or
 *  un-sizable, spread < 0) swing → the smallest type frees real VRAM for more of the model on the
 *  GPU, but its kernel can be slower (turbo4), so tune BOTH the smallest and the q8_0 stock fallback
 *  and let the measured prefill + t/s pick the winner. */
export function decideKvToBench(spreadMb: number, candidates: string[]): string[] {
  const has = (t: string) => candidates.includes(t)
  const largest = kvLargest(candidates)
  if (spreadMb >= 0 && spreadMb <= KV_SPREAD_MIN) return [largest]
  const smallest = has('turbo4') ? 'turbo4' : kvSmallest(candidates)
  const stock = has('q8_0') ? 'q8_0' : largest
  return [...new Set([smallest, stock])]
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
