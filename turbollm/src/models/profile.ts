// LoadProfile: per-model launch parameters, default derivation, VRAM-fit
// estimation, and the profile->llama-server arg mapping (spec 05). This
// productizes the hand-tuned models.json knowledge.
import type { Capabilities, ModelDefaults } from '../config/config'
import type { SysInfo } from '../sysinfo/sysinfo'
import type { ModelEntry } from './scanner'

export interface Sampling {
  temp: number
  topP: number
  topK: number
  minP: number
  repeatPenalty: number
  presencePenalty: number
  frequencyPenalty: number
  /** Stop sequences: generation halts when any of these strings is produced. */
  stop: string[]
}

/** Per-engine multi-GPU split settings (ADR-054). Stored on the per-model profile;
 *  the knobs are engine-kind-specific, so each field maps to a different launch flag:
 *
 *  - llama.cpp / TurboQuant (mapped in {@link profileToArgs}):
 *      splitMode    → --split-mode {layer,row,none}
 *      tensorSplit  → --tensor-split a,b,…   (per-GPU proportions; empty = even)
 *      mainGpu      → --main-gpu N           (-1 = engine default)
 *  - vLLM (mapped in vllm.ts `vllmServerCommand`):
 *      tensorParallelSize → --tensor-parallel-size N  (1 = single GPU, vLLM default)
 *  - MLX: not applicable (Apple unified memory) — fields ignored.
 *
 *  The defaults are deliberately no-ops: 'layer' split with an empty tensorSplit and
 *  mainGpu -1 emit NO new flags, so llama.cpp keeps its built-in even layer-split
 *  across all visible GPUs, and tensorParallelSize 1 keeps vLLM single-GPU. The config
 *  only changes behavior when the user deviates. */
export interface GpuProfile {
  splitMode: 'layer' | 'row' | 'none'
  tensorSplit: number[]
  mainGpu: number
  tensorParallelSize: number
}

export function defaultGpu(): GpuProfile {
  return { splitMode: 'layer', tensorSplit: [], mainGpu: -1, tensorParallelSize: 1 }
}

/** vLLM-specific load controls (F-027). vLLM is a full server with richer load-time config
 *  than llama.cpp — these map to its CLI flags in {@link vllmProfileToArgs}. Defaults are
 *  deliberate no-ops (match vLLM's own defaults) so a fresh profile emits no extra flags:
 *
 *    maxModelLen          → --max-model-len N            (0 = derive from the model config)
 *    gpuMemoryUtilization → --gpu-memory-utilization F   (0.90 = vLLM default; lower to share VRAM)
 *    maxNumSeqs           → --max-num-seqs N             (0 = vLLM default; concurrent sequences)
 *    dtype                → --dtype {auto,bfloat16,float16,float32}
 *    kvCacheDtype         → --kv-cache-dtype {auto,fp8}  (fp8 ~halves KV memory)
 *    enforceEager         → --enforce-eager              (skip CUDA graphs: less VRAM, slower)
 *    trustRemoteCode      → --trust-remote-code          (models that ship custom modelling code)
 *
 *  Tensor-parallel (multi-GPU shard count) stays on {@link GpuProfile.tensorParallelSize}. */
export interface VllmProfile {
  maxModelLen: number
  gpuMemoryUtilization: number
  maxNumSeqs: number
  dtype: 'auto' | 'bfloat16' | 'float16' | 'float32'
  kvCacheDtype: 'auto' | 'fp8'
  enforceEager: boolean
  trustRemoteCode: boolean
}

export function defaultVllm(): VllmProfile {
  return {
    maxModelLen: 0,
    gpuMemoryUtilization: 0.9,
    maxNumSeqs: 0,
    dtype: 'auto',
    kvCacheDtype: 'auto',
    enforceEager: false,
    trustRemoteCode: false,
  }
}

export interface LoadProfile {
  ctx: number
  ngl: number
  /** When true, omit `-ngl` entirely and let llama.cpp's own `-fit` memory-fitting logic (always
   *  active unless overridden) decide how many layers land on GPU vs CPU at load time, instead of
   *  the fixed `ngl` value. `ngl` is kept as the last manual value so switching back restores it.
   *  Absent / false on pre-feature profiles → unchanged existing behavior (always emit -ngl). */
  nglFit?: boolean
  nCpuMoe: number
  /** Same idea as {@link nglFit}, for `--n-cpu-moe` (MoE expert CPU-offload count). llama.cpp's
   *  `-fit` handles MoE offload with a more granular per-tensor fractional strategy than the
   *  simple N-experts-on-CPU count this app exposes (live-verified: it can fit MORE onto the GPU
   *  than a coarse fixed count would), so omitting the flag can genuinely do better than a manual
   *  number. Absent / false → unchanged existing behavior. */
  nCpuMoeFit?: boolean
  parallel: number
  kvUnified: boolean
  kvTypeK: string
  kvTypeV: string
  flashAttn: 'auto' | 'on' | 'off'
  /** KV cache location (llama.cpp --no-kv-offload). true (default) keeps the KV cache on the
   *  GPU next to the weights — fastest, and llama.cpp's own default. false emits
   *  --no-kv-offload, holding the KV cache in system RAM instead: frees VRAM for a larger model
   *  or longer context at the cost of speed. llama.cpp-only; ignored by mlx/vllm. May be absent
   *  on pre-feature saved profiles → treated as the GPU default (see {@link profileToArgs}). */
  kvOffload: boolean
  threads: number
  threadsBatch: number
  useMmproj: boolean
  mmprojGpu: boolean
  imageMaxTokens: number
  cacheReuse: number
  useJinja: boolean
  chatTemplateFile: string
  speculative: 'off' | 'mtp' | 'nextn' | 'draft'
  mtpHeadPath: string
  draftModelPath: string
  sampling: Sampling
  /** Context overflow policy. 'shift' (default) is llama-server's built-in sliding
   *  window — oldest tokens are evicted while keeping `nKeep` tokens from the start.
   *  'keep' makes nKeep explicit (e.g. preserve the full system prompt).
   *  Mapped in {@link profileToArgs} via --n-keep. */
  contextOverflow: 'shift' | 'keep'
  /** Tokens to keep from the start of the context when shifting (--n-keep).
   *  Only applied when contextOverflow === 'keep' and nKeep > 0. */
  nKeep: number
  /** RoPE scaling type (--rope-scaling). 'none' = model-native; 'linear'/'yarn'
   *  extend context beyond the trained limit. Only emitted when not 'none'. */
  ropeScalingType: 'none' | 'linear' | 'yarn'
  /** RoPE base frequency override (--rope-freq-base). 0 = model native. */
  ropeFreqBase: number
  /** RoPE frequency scale override (--rope-freq-scale). 0 = model native. */
  ropeFreqScale: number
  /** Multi-GPU split settings (ADR-054). See {@link GpuProfile}. */
  gpu: GpuProfile
  /** vLLM-specific load controls (F-027). See {@link VllmProfile}. Ignored by llama.cpp/MLX. */
  vllm: VllmProfile
  /** GBNF grammar enforced at startup (--grammar). Empty string = no constraint.
   *  Power-user override for models that should always respond in a fixed format. */
  grammar: string
  extraArgs: string[]
  /** llama.cpp --batch-size (-b). Logical batch size for prompt processing. 0 / absent = engine
   *  default (2048). Larger values use more memory but can improve prompt-ingestion speed. */
  batchSize?: number
  /** llama.cpp --ubatch-size (-ub). Physical micro-batch size for prompt processing. 0 / absent =
   *  engine default (512). Must be ≤ batchSize. Tune alongside batchSize for throughput. */
  uBatchSize?: number
  /** Speculative-decoding draft window (GitHub #35) — applies to every active speculative
   *  mode (mtp/nextn/draft), not just `draft`. Max tokens the draft head proposes per step
   *  (--draft-max). Absent → 16 (the previous hardcoded default). */
  draftMax?: number
  /** Speculative-decoding draft window (GitHub #35) — applies to every active speculative
   *  mode (mtp/nextn/draft), not just `draft`. Min tokens drafted per step before
   *  verification (--draft-min). Absent → 1 (the previous hardcoded default). */
  draftMin?: number
  /** Provenance of a saved profile (spec 05 §3, 09 §1): 'bench' = written by the
   *  auto-tune runner, 'user' = hand-saved. Absent on heuristic/global defaults. */
  tunedBy?: 'bench' | 'user'
}

export type FitVerdict = 'fits' | 'tight' | 'overflow' | 'cpu' | 'unknown'

export interface VramFit {
  estMb: number
  totalVramMb: number
  pct: number
  verdict: FitVerdict
}

const HEAD_DIM = 128 // embedLen/headCount approximation (spec 05 §6)

function kvBytesPerElem(t: string): number {
  switch (t) {
    case 'f16': return 2
    case 'q8_0': case 'q8_1': return 1
    case 'q5_0': case 'q5_1': return 0.625
    case 'q4_0': case 'q4_1': case 'turbo4': return 0.5
    case 'turbo3': return 0.375
    case 'turbo2': return 0.25
    default: return 2
  }
}

export function defaultSampling(): Sampling {
  return { temp: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.0, presencePenalty: 0.0, frequencyPenalty: 0.0, stop: [] }
}

/** The VRAM budget a profile can use (ADR-054). A layer/row split — and the default —
 *  spreads the model across ALL detected GPUs, so the honest budget is their summed
 *  VRAM. 'none' restricts to a single GPU (mainGpu, else GPU 0). Single-GPU boxes are
 *  unaffected (the sum equals GPU 0). Profiles without a `gpu` field (old saved/bench
 *  profiles) fall back to the all-GPU sum — matching llama.cpp's default behavior. */
export function gpuBudgetMb(sys: SysInfo, p?: Pick<LoadProfile, 'gpu'>): number {
  if (sys.gpus.length === 0) return 0
  if (p?.gpu?.splitMode === 'none') {
    const idx = p.gpu.mainGpu >= 0 ? p.gpu.mainGpu : 0
    return sys.gpus[idx]?.vramMb ?? sys.gpus[0]?.vramMb ?? 0
  }
  return sys.gpus.reduce((sum, g) => sum + (g.vramMb || 0), 0)
}

/** Estimate GPU memory use for a profile (spec 05 §6). Deterministic math — the
 *  only "numbers" we show pre-run; always labeled an estimate (ADR-012). */
export function estimateVram(p: LoadProfile, m: ModelEntry, sys: SysInfo): VramFit {
  const totalVramMb = gpuBudgetMb(sys, p)
  if (totalVramMb === 0) return { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'cpu' }

  const sizeMb = m.sizeBytes / 1e6
  const blocks = m.blockCount || 1
  const gpuFrac = m.moe
    ? 1 - 0.85 * (p.nCpuMoe / blocks)
    : Math.min(p.ngl, blocks) / blocks
  const weightsMb = sizeMb * Math.max(0, Math.min(1, gpuFrac))

  const kvHeads = m.headCountKv || 8
  const kvElems = 2 * blocks * p.ctx * kvHeads * HEAD_DIM
  // KV cache only counts against VRAM when it's offloaded to the GPU. With --no-kv-offload
  // (kvOffload === false) it lives in system RAM, so it adds nothing to the GPU estimate.
  // Absent on pre-feature profiles → treated as the GPU default.
  const kvMb = p.kvOffload === false
    ? 0
    : ((kvElems * kvBytesPerElem(p.kvTypeK)) / 1e6) * (p.kvUnified ? 1 : Math.max(1, p.parallel))

  const mmprojMb = p.useMmproj && p.mmprojGpu && m.mmprojPath ? 600 : 0
  const estMb = Math.round(weightsMb + kvMb + 800 + mmprojMb)
  const pct = estMb / totalVramMb
  const verdict: FitVerdict = pct <= 0.8 ? 'fits' : pct <= 0.95 ? 'tight' : 'overflow'
  return { estMb, totalVramMb, pct, verdict }
}

/** Computed defaults for a model (spec 05 §3). NOT saved until the user saves. */
export function deriveDefault(m: ModelEntry, sys: SysInfo): LoadProfile {
  const hasGpu = sys.gpus.length > 0
  const base: LoadProfile = {
    ctx: Math.min(m.nativeCtx || 8192, 8192),
    ngl: hasGpu ? 99 : 0,
    nCpuMoe: 0,
    parallel: 1,
    kvUnified: true,
    kvTypeK: 'f16',
    kvTypeV: 'f16',
    // Flash attention on by default — faster and lower KV memory on every modern
    // backend; gated by engine capability in profileToArgs so it's a safe default.
    flashAttn: 'on',
    // KV cache on the GPU by default (llama.cpp's own default — fastest). The user can
    // flip it to RAM to free VRAM; mapped to --no-kv-offload in profileToArgs.
    kvOffload: true,
    // CPU threads: 0 = auto, resolved to half the logical cores at launch
    // (profileToArgs) — leaves headroom for the OS; user-overridable via slider.
    threads: 0,
    threadsBatch: 0,
    useMmproj: m.vision,
    mmprojGpu: true,
    imageMaxTokens: 0,
    cacheReuse: 256,
    useJinja: m.hasChatTemplate,
    chatTemplateFile: '',
    // Enable NextN self-speculative decoding by default whenever the GGUF carries
    // a built-in head (`nextn_predict_layers` > 0) — free speed-up. Only actually
    // applied when the engine supports it (profileToArgs gates on --spec-type).
    speculative: m.nextnLayers > 0 ? 'nextn' : 'off',
    mtpHeadPath: '',
    draftModelPath: '',
    sampling: defaultSampling(),
    contextOverflow: 'shift',
    nKeep: 0,
    ropeScalingType: 'none',
    ropeFreqBase: 0,
    ropeFreqScale: 0,
    gpu: defaultGpu(),
    vllm: defaultVllm(),
    grammar: '',
    extraArgs: [],
  }

  // MoE: pick the smallest CPU-offload that fits ~85% of VRAM (spec 05 §3). The
  // budget spans all GPUs the default layer-split uses (ADR-054), so a multi-GPU
  // box keeps more experts on the GPU(s).
  if (m.moe && hasGpu && m.blockCount > 0) {
    const budget = gpuBudgetMb(sys, base) * 0.85
    base.nCpuMoe = m.blockCount
    for (let n = 0; n <= m.blockCount; n += 2) {
      if (estimateVram({ ...base, nCpuMoe: n }, m, sys).estMb <= budget) {
        base.nCpuMoe = n
        break
      }
    }
  }
  return base
}

/** Apply the global model defaults (spec 05 §3) on top of the built-in heuristics.
 *  Only the fields the user can set globally are overlaid; everything else keeps
 *  the per-model heuristic value. `ngl` is clamped to 0 when no GPU is present so a
 *  default tuned for a GPU box can't force layer offload on a CPU-only machine. */
function applyGlobalDefaults(base: LoadProfile, m: ModelEntry, sys: SysInfo, defaults?: ModelDefaults): LoadProfile {
  if (!defaults) return base
  const hasGpu = sys.gpus.length > 0
  // Honor the global ctx but never exceed the model's native context window.
  const nativeCap = m.nativeCtx
  return {
    ...base,
    ctx: defaults.ctx > 0 ? (nativeCap > 0 ? Math.min(defaults.ctx, nativeCap) : defaults.ctx) : base.ctx,
    ngl: hasGpu ? defaults.ngl : 0,
    imageMaxTokens: defaults.imageMaxTokens ?? base.imageMaxTokens,
  }
}

/** Merge heuristics <- global defaults <- saved <- overrides (field-level; sampling
 *  deep-merged). Precedence highest→lowest: per-request overrides > saved per-model
 *  profile > global model defaults > built-in heuristics (spec 05 §3). */
export function resolveProfile(
  m: ModelEntry,
  sys: SysInfo,
  saved?: Partial<LoadProfile>,
  overrides?: Partial<LoadProfile>,
  defaults?: ModelDefaults,
): LoadProfile {
  const base = applyGlobalDefaults(deriveDefault(m, sys), m, sys, defaults)
  return {
    ...base,
    ...(saved ?? {}),
    ...(overrides ?? {}),
    sampling: { ...base.sampling, ...(saved?.sampling ?? {}), ...(overrides?.sampling ?? {}) },
    // gpu is deep-merged like sampling so a partial override (or an old saved profile
    // missing some fields) keeps the rest of the defaults instead of going undefined.
    gpu: { ...base.gpu, ...(saved?.gpu ?? {}), ...(overrides?.gpu ?? {}) },
    // vllm deep-merged for the same reason — old/partial profiles keep the defaults.
    vllm: { ...base.vllm, ...(saved?.vllm ?? {}), ...(overrides?.vllm ?? {}) },
    // useMmproj has no UI control (only mmprojGpu — GPU-vs-CPU placement — is user-facing;
    // see ModelDetailDialog's "Vision encoder on GPU" toggle), so there is no legitimate way
    // for a saved profile or draft override to carry a meaningful `false` here. Forcing it to
    // track the model's own vision capability makes it self-healing: any profile saved with a
    // stale/incorrect useMmproj (e.g. auto-tune runs prior to the bench.ts fix that persisted
    // false) is corrected on the very next resolve, for every user, with no reset/migration
    // needed and no other tuned setting touched.
    useMmproj: m.vision,
  }
}

/** Map a profile to llama-server args (spec 05 §8). The manager injects
 *  -m/--host/--port/--metrics/--no-webui; this returns everything else.
 *  Flags absent from the engine's capabilities are skipped (graceful degrade). */
export function profileToArgs(p: LoadProfile, m: ModelEntry, caps: Capabilities, cores = 0): string[] {
  const has = (flag: string) => caps.flags.length === 0 || caps.flags.includes(flag)
  const a: string[] = ['-c', String(p.ctx)]
  // nglFit: omit -ngl entirely so llama.cpp's own -fit logic picks the offload (see LoadProfile).
  if (!p.nglFit && p.ngl > 0) a.push('-ngl', String(p.ngl))
  // Multi-GPU split (ADR-054). Defaults are no-ops: 'layer' + empty tensorSplit +
  // mainGpu -1 emit nothing, preserving llama.cpp's built-in even split across GPUs.
  const g = p.gpu
  if (g) {
    if (g.splitMode !== 'layer' && has('--split-mode')) a.push('--split-mode', g.splitMode)
    // tensor-split sets per-GPU proportions; meaningless for single-GPU 'none'.
    if (g.splitMode !== 'none' && g.tensorSplit.length > 0 && has('--tensor-split')) {
      a.push('--tensor-split', g.tensorSplit.join(','))
    }
    if (g.mainGpu >= 0 && has('--main-gpu')) a.push('--main-gpu', String(g.mainGpu))
  }
  // Always pin --parallel: omitting it makes llama-server auto-pick 4 slots,
  // quadrupling KV memory (seen in logs).
  if (has('--parallel')) a.push('--parallel', String(p.parallel))
  if (p.parallel > 1 && p.kvUnified && has('--kv-unified')) a.push('--kv-unified')
  // nCpuMoeFit: omit --n-cpu-moe so -fit's finer-grained MoE offload strategy decides instead.
  if (m.moe && !p.nCpuMoeFit && p.nCpuMoe > 0 && has('--n-cpu-moe')) a.push('--n-cpu-moe', String(p.nCpuMoe))
  // Emit a non-default KV cache type only when the engine supports the VALUE, not just
  // the --cache-type-k FLAG: e.g. TurboQuant's turbo2/3/4 must NOT leak into a standard
  // llama.cpp / llamafile engine (which has the flag but rejects the value → launch fails).
  // The probe captures the supported set in caps.kvTypes; empty/unknown → only f16 is safe.
  const kvOk = (t: string) => caps.kvTypes.includes(t)
  if (p.kvTypeK !== 'f16' && has('--cache-type-k') && kvOk(p.kvTypeK)) a.push('--cache-type-k', p.kvTypeK)
  if (p.kvTypeV !== 'f16' && has('--cache-type-v') && kvOk(p.kvTypeV)) a.push('--cache-type-v', p.kvTypeV)
  if (p.flashAttn !== 'auto' && has('--flash-attn')) a.push('--flash-attn', p.flashAttn)
  // KV cache location: on the GPU by default (llama.cpp's default — no flag). When the user
  // pins it to RAM, emit --no-kv-offload so the KV cache lives in system memory, freeing VRAM
  // for a bigger model / longer context at the cost of speed. `kvOffload` is absent on
  // pre-feature saved profiles → `=== false` treats that as the GPU default (no flag).
  if (p.kvOffload === false && has('--no-kv-offload')) a.push('--no-kv-offload')
  // threads 0 = auto → half the logical cores (matches the UI's "Auto" label).
  const threads = p.threads > 0 ? p.threads : cores > 0 ? Math.max(1, Math.floor(cores / 2)) : 0
  if (threads > 0) a.push('--threads', String(threads))
  if (p.threadsBatch > 0) a.push('--threads-batch', String(p.threadsBatch))
  if (p.batchSize && p.batchSize > 0 && has('--batch-size')) a.push('--batch-size', String(p.batchSize))
  if (p.uBatchSize && p.uBatchSize > 0 && has('--ubatch-size')) a.push('--ubatch-size', String(p.uBatchSize))
  if (m.vision && p.useMmproj && m.mmprojPath) a.push('--mmproj', m.mmprojPath)
  if (m.vision && p.useMmproj && !p.mmprojGpu && has('--no-mmproj-offload')) a.push('--no-mmproj-offload')
  if (p.imageMaxTokens > 0 && has('--image-max-tokens')) a.push('--image-max-tokens', String(p.imageMaxTokens))
  if (p.cacheReuse > 0 && has('--cache-reuse')) a.push('--cache-reuse', String(p.cacheReuse))
  if (p.useJinja && has('--jinja')) a.push('--jinja')
  if (p.chatTemplateFile && has('--chat-template-file')) a.push('--chat-template-file', p.chatTemplateFile)
  // Speculative decoding (spec 05 §8). TurboQuant forks expose `--spec-type`:
  //   mtp   → Gemma-4 MTP: a separate gemma4_assistant GGUF via --mtp-head
  //   nextn → Qwen3 NextN: the model's OWN built-in head as the draft
  //   draft → mainline: a separate small draft GGUF
  const specType = has('--spec-type')
  // Whether the engine accepts a given `--spec-type` value (captured by the probe
  // as `spec-type:<value>`). Empty flags = unprobed → allow (graceful degrade).
  const specAccepts = (v: string) => caps.flags.length === 0 || caps.flags.includes(`spec-type:${v}`)
  let specActive = false
  if (p.speculative === 'mtp' && p.mtpHeadPath && has('--mtp-head')) {
    if (specType) a.push('--spec-type', 'mtp')
    a.push('--mtp-head', p.mtpHeadPath)
    specActive = true
  } else if (p.speculative === 'nextn' && specType) {
    // Qwen3 NextN speculative decoding uses the model's own built-in NextN/MTP
    // head as the draft. Mainline llama.cpp names this spec-type `draft-mtp` and
    // takes ONLY --spec-type — no --model-draft. Passing --model-draft pointing
    // at the SAME GGUF (as this used to do unconditionally) makes llama.cpp load
    // a full second copy of the model into RAM: measured +35GB RAM on a 35B MoE
    // model (24GB → 59GB) for a 54% SLOWER generation, with no error printed —
    // a silent, severe regression (GitHub VRAM report). The TurboQuant fork's own
    // `nextn` spec-type value is a different codebase that DOES want --model-draft
    // pointing at the same file (verified when this branch was first written) —
    // only mainline's draft-mtp is exempted here.
    const nextnVal = ['nextn', 'draft-mtp'].find((v) => specAccepts(v))
    if (nextnVal === 'draft-mtp') {
      a.push('--spec-type', nextnVal)
      specActive = true
    } else if (nextnVal === 'nextn' && has('--model-draft')) {
      a.push('--spec-type', nextnVal, '--model-draft', m.path)
      specActive = true
    }
  } else if (p.speculative === 'draft' && p.draftModelPath && has('--model-draft')) {
    if (specType) a.push('--spec-type', 'draft')
    a.push('--model-draft', p.draftModelPath)
    specActive = true
  }
  // Draft window (GitHub #35): how many tokens the draft head proposes per step before
  // the main model verifies them, and the minimum before verification kicks in. This is
  // a property of the speculation mechanism itself (llama.cpp's shared verify loop), not
  // specific to how the draft is produced — applies to all three modes above, matching
  // e.g. LM Studio's MTP "max/min draft tokens" controls. Absent -> the previous
  // hardcoded 16/1 defaults (unchanged behavior for existing profiles).
  // llama.cpp removed --draft-max/--draft-min (GitHub #43); the successors are
  // --spec-draft-n-max/--spec-draft-n-min. Prefer the old names when the probe
  // confirms them (keeps unprobed/graceful-degrade and older-engine behavior
  // unchanged) and fall back to the new names when it confirms only those.
  if (specActive) {
    if (has('--draft-max')) a.push('--draft-max', String(p.draftMax ?? 16))
    else if (has('--spec-draft-n-max')) a.push('--spec-draft-n-max', String(p.draftMax ?? 16))
    if (has('--draft-min')) a.push('--draft-min', String(p.draftMin ?? 1))
    else if (has('--spec-draft-n-min')) a.push('--spec-draft-n-min', String(p.draftMin ?? 1))
  }
  // Sampling startup defaults — become the engine's per-request defaults; can still
  // be overridden in the chat request body. Only emitted when non-default to avoid
  // cluttering the startup command. llama-server built-in defaults match these values.
  if (p.sampling.temp !== 0.8 && has('--temp')) a.push('--temp', String(p.sampling.temp))
  if (p.sampling.topP !== 0.95 && has('--top-p')) a.push('--top-p', String(p.sampling.topP))
  if (p.sampling.topK !== 40 && has('--top-k')) a.push('--top-k', String(p.sampling.topK))
  if (p.sampling.minP !== 0.05 && has('--min-p')) a.push('--min-p', String(p.sampling.minP))
  if (p.sampling.repeatPenalty !== 1.0 && has('--repeat-penalty')) a.push('--repeat-penalty', String(p.sampling.repeatPenalty))
  if (p.sampling.presencePenalty !== 0.0 && has('--presence-penalty')) a.push('--presence-penalty', String(p.sampling.presencePenalty))
  if (p.sampling.frequencyPenalty !== 0.0 && has('--frequency-penalty')) a.push('--frequency-penalty', String(p.sampling.frequencyPenalty))
  // Context overflow: 'keep' pins the first nKeep tokens during context-shift so the
  // system prompt / initial context is never evicted (--n-keep). 'shift' is the engine
  // default (no flag needed).
  if (p.contextOverflow === 'keep' && p.nKeep > 0 && has('--n-keep')) a.push('--n-keep', String(p.nKeep))
  // Rope scaling: only emitted when the user explicitly requests a non-native scaling
  // type. ropeFreqBase / ropeFreqScale of 0 mean "use the model's native value".
  if (p.ropeScalingType !== 'none' && has('--rope-scaling')) {
    a.push('--rope-scaling', p.ropeScalingType)
    if (p.ropeFreqBase > 0 && has('--rope-freq-base')) a.push('--rope-freq-base', String(p.ropeFreqBase))
    if (p.ropeFreqScale > 0 && has('--rope-freq-scale')) a.push('--rope-freq-scale', String(p.ropeFreqScale))
  }
  // Embedding models activate the /v1/embeddings endpoint via --embeddings.
  if (m.embedding && has('--embeddings')) a.push('--embeddings')
  // Startup GBNF grammar constraint — only emitted when the user has set one.
  if (p.grammar && has('--grammar')) a.push('--grammar', p.grammar)
  a.push(...p.extraArgs)
  return a
}

/** Map a profile's vLLM block to vLLM OpenAI-server CLI flags (F-027). The manager injects
 *  -m/--model/--served-model-name/--host/--port and the tensor-parallel flag; this returns the
 *  rest. Each flag is emitted only when it deviates from vLLM's own default, so a fresh profile
 *  produces no extra args (launch is unchanged from before this feature). User `extraArgs` pass
 *  through last so they can override anything. */
export function vllmProfileToArgs(p: LoadProfile): string[] {
  const v = p.vllm ?? defaultVllm()
  const a: string[] = []
  if (v.maxModelLen > 0) a.push('--max-model-len', String(v.maxModelLen))
  if (v.gpuMemoryUtilization > 0 && v.gpuMemoryUtilization !== 0.9) {
    a.push('--gpu-memory-utilization', String(v.gpuMemoryUtilization))
  }
  if (v.maxNumSeqs > 0) a.push('--max-num-seqs', String(v.maxNumSeqs))
  if (v.dtype !== 'auto') a.push('--dtype', v.dtype)
  if (v.kvCacheDtype !== 'auto') a.push('--kv-cache-dtype', v.kvCacheDtype)
  if (v.enforceEager) a.push('--enforce-eager')
  if (v.trustRemoteCode) a.push('--trust-remote-code')
  a.push(...p.extraArgs)
  return a
}
