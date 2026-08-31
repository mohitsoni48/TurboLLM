// LoadProfile: per-model launch parameters, default derivation, VRAM-fit
// estimation, and the profile->llama-server arg mapping (spec 05). This
// productizes the hand-tuned models.json knowledge.
import type { Capabilities, ModelDefaults } from '../config/config'
import { backendIdFromBinPath } from '../engines/update'
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
   *  Absent / false on pre-feature profiles → unchanged existing behavior (always emit -ngl).
   *  Ignored for MoE models (see {@link profileToArgs}) — `nCpuMoeFit` is the real MoE offload
   *  control there. **Assumption, not yet capability-probed (pre-release review, Finding C):**
   *  this relies on the active engine's llama.cpp build actually implementing `-fit` when `-ngl`
   *  is omitted — a build old enough to predate it would default to CPU-only (`n_gpu_layers=0`)
   *  instead, silently tanking performance with no error. Opt-in and off by default, so the blast
   *  radius is small, but worth a capability probe (mirroring how `caps.kvTypes` gates KV-quant
   *  options) if this turns out to bite a user on an older engine build. */
  nglFit?: boolean
  nCpuMoe: number
  /** Same idea as {@link nglFit}, for `--n-cpu-moe` (MoE expert CPU-offload count). llama.cpp's
   *  `-fit` handles MoE offload with a more granular per-tensor fractional strategy than the
   *  simple N-experts-on-CPU count this app exposes (live-verified: it can fit MORE onto the GPU
   *  than a coarse fixed count would), so omitting the flag can genuinely do better than a manual
   *  number. Absent / false → unchanged existing behavior. Same engine-version assumption as
   *  {@link nglFit} applies here too.
   *
   *  **For MoE models this ALSO suppresses `-ngl`** (see {@link profileToArgs}) — found
   *  2026-08-03 from a user-reported OOM crash: llama.cpp's `common_params_fit_params` (fit.cpp)
   *  throws the instant `-ngl` is explicit, before it ever reaches the MoE tensor-placement step,
   *  so leaving `-ngl` in place while only omitting `--n-cpu-moe` doesn't get a partial fit — it
   *  gets NO fit. `-fit` aborts, and the engine falls through to loading `-ngl` layers (every
   *  expert included) with zero MoE offload, an instant OOM on a VRAM-constrained card. Since the
   *  UI already hides the ngl slider for MoE whenever this is on (see ModelDetailDialog.tsx), that
   *  doesn't reintroduce the "dead slider" problem ADR-190 was guarding against. */
  nCpuMoeFit?: boolean
  parallel: number
  /** Pin this model's engine instance to a specific loopback port instead of the
   *  default 8081+ first-free walk (allocPort in manager.ts). 0/undefined = auto.
   *  Distinct from the main daemon port (6996/6997) — this is only the per-model
   *  llama-server/mlx/vllm/etc. child process's own port. Falls back to auto if the
   *  requested port is already taken. */
  port?: number
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

// Fallback only, used when the GGUF/config doesn't declare a real per-head dimension
// (ModelEntry.headDim === 0) — a common architecture default, not a universal one; GQA/MQA
// models with a decoupled head size (see ModelEntry.headDim's doc) diverge from it.
const HEAD_DIM = 128

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

/** Is layer `i` a full-attention layer under a hybrid linear/SSM layout of stride N?
 *
 *  Convention: the LAST layer of each group of N, i.e. `(i + 1) % N === 0` — matching
 *  upstream's own `layer_types` derivation for these architectures (Qwen3-Next/Qwen3.5/
 *  Qwen3.6 build the list as "full_attention if (i+1) % full_attention_interval == 0
 *  else linear_attention"). For a block count that divides evenly by N — every real
 *  model observed so far — the offset only moves WHICH layers are full, not how many
 *  (64 blocks / interval 4 = 16 full layers either way), so the totals are robust to it;
 *  it matters only when a per-layer KV-head array has to be indexed alongside, and no
 *  observed model combines the two. */
function isFullAttentionLayer(i: number, interval: number): boolean {
  return (i + 1) % interval === 0
}

/** The hybrid stride to actually apply, or 0 for "no usable hybrid layout".
 *
 *  Rejects three ways the declaration can be unusable, all of which must fall back to the
 *  conservative all-layer estimate rather than to a partial one:
 *   - `<= 1`: interval 1 means every layer is full attention, i.e. the legacy formula.
 *   - `> blocks`: NO layer would satisfy `(i+1) % interval === 0`, so the loop in
 *     {@link kvCacheElems} would count zero layers and report a KV cache of ZERO bytes.
 *     That is the single worst failure mode this file can produce — it turns a real
 *     21 GB estimate into 12.8 GB and flips the verdict from `overflow` to `fits` on a
 *     16 GB card. Reachable without a malformed interval, too: `blocks` falls back to 1
 *     when `block_count` is missing or unparsed, and 1 < any real interval.
 *   - non-finite/non-integer: `%` against those yields NaN, which is never `=== 0`, so
 *     it degenerates to the same zero-layer count. */
function hybridInterval(m: ModelEntry, blocks: number): number {
  const interval = m.fullAttentionInterval ?? 0
  if (!Number.isInteger(interval) || interval <= 1 || interval > blocks) return 0
  return interval
}

/** Number of linear/SSM layers — layers that hold a small constant recurrent state
 *  instead of a growing KV cache. 0 whenever the layout isn't declared, which is the
 *  whole point: an undeclared layout must not be guessed at (see {@link kvCacheElems}). */
function linearLayerCount(m: ModelEntry): number {
  const blocks = m.blockCount || 1
  const interval = hybridInterval(m, blocks)
  if (interval === 0) return 0
  let n = 0
  for (let i = 0; i < blocks; i++) if (!isFullAttentionLayer(i, interval)) n++
  return n
}

/** Elements in the context-scaled KV cache for `ctx` tokens (ADR-216 addendum 2, ADR-223).
 *
 *  The old formula counted EVERY layer at FULL context. That is right for a plain dense
 *  transformer and badly wrong for the two families that no longer are:
 *
 *   - hybrid linear/SSM (Qwen3.5/3.6, Qwen3-Next): only every Nth layer keeps a growing
 *     KV cache; the rest hold a constant recurrent state — a ~4x over-count.
 *   - sliding-window (Gemma 3/4): most layers cap at a fixed window, and Gemma also uses
 *     a different head dim AND a different KV-head count on sliding vs global layers —
 *     measured up to an ~18x over-count.
 *
 *  Over-counting isn't cosmetic here: it pushes the fit verdict to "tight"/"overflow"
 *  and mis-drives auto-tune's headroom gate for a very popular model family.
 *
 *  DEGRADATION IS THE LOAD-BEARING PART. Every layout field is optional, and a model
 *  that declares none of them — the overwhelming majority: plain llama/mistral/qwen2
 *  dense architectures — takes the legacy branch below and gets bit-for-bit the number
 *  it got before. Crucially, a model with hybrid EVIDENCE but no declared layout (e.g.
 *  Qwen3-Coder-Next: ssm.* keys present, no full_attention_interval) also takes the
 *  legacy branch rather than a guessed interval. That deliberately over-counts by ~4x,
 *  because the failure modes are not symmetric: this estimate is user-facing (ADR-012)
 *  AND feeds auto-tune's headroom gate, so an under-estimate buys a failed load and a
 *  bad tune, while an over-estimate only costs a pessimistic verdict.
 *
 *  Pure and exported for unit testing against the measured ground truth in
 *  profile.kv.test.ts. */
export function kvCacheElems(m: ModelEntry, ctx: number): number {
  const blocks = m.blockCount || 1
  const kvHeads = m.headCountKv || 8
  const headDim = m.headDim || HEAD_DIM

  // A per-layer array is honored only when it covers every layer. A short or mismatched
  // one is treated as absent rather than index-clamped: reading past its end would
  // silently substitute a smaller head count, i.e. under-count.
  const perLayerHeads =
    m.headCountKvPerLayer?.length === blocks ? m.headCountKvPerLayer : undefined

  // Sliding-window layout needs BOTH the per-layer pattern and the window size — a
  // pattern with no window has no cap to apply, so it isn't actionable on its own.
  const window = m.slidingWindow ?? 0
  const swaPattern =
    window > 0 && m.slidingWindowPattern?.length === blocks ? m.slidingWindowPattern : undefined
  const swaHeadDim = (m.headDimSwa ?? 0) > 0 ? (m.headDimSwa as number) : headDim

  // Hybrid layout, only when the stride is declared AND usable against this block count
  // — see hybridInterval for the strides that are rejected and why zeroing matters.
  const interval = hybridInterval(m, blocks)
  const hybrid = interval > 0 && swaPattern === undefined

  // Legacy path: nothing declared (or nothing actionable). Unchanged from before —
  // this is the branch essentially every model in the wild takes.
  if (swaPattern === undefined && !hybrid) return 2 * blocks * ctx * kvHeads * headDim

  let elems = 0
  for (let i = 0; i < blocks; i++) {
    // Linear/SSM layers keep no ctx-scaled cache at all; their constant state is
    // accounted for separately by ssmStateElems so it can't be scaled by ctx.
    if (hybrid && !isFullAttentionLayer(i, interval)) continue
    const sliding = swaPattern?.[i] === true
    const tokens = sliding ? Math.min(ctx, window) : ctx
    const heads = perLayerHeads?.[i] || kvHeads
    const dim = sliding ? swaHeadDim : headDim
    elems += 2 * tokens * heads * dim // ×2 for the K and V caches
  }
  return elems
}

/** Elements in the CONSTANT recurrent state held by linear/SSM layers — roughly
 *  `inner_size * (state_size + conv_kernel - 1)` per layer (the SSM state plus the
 *  causal-conv window). Derived from the model's own ssm.* metadata rather than a magic
 *  number, and deliberately NOT scaled by ctx: that's the entire point of a recurrent
 *  layer. Small but not zero — ~38.6M elements (~77 MB at f16) for Qwen3.6-27B's 48
 *  linear layers, which matches an independent analysis of that model.
 *
 *  0 unless the layout AND the dimensions are both declared, so it can never turn the
 *  conservative legacy estimate into a smaller one. */
export function ssmStateElems(m: ModelEntry): number {
  const layers = linearLayerCount(m)
  const inner = m.ssmInnerSize ?? 0
  const state = m.ssmStateSize ?? 0
  if (layers === 0 || inner <= 0 || state <= 0) return 0
  const conv = Math.max(1, m.ssmConvKernel ?? 1)
  return layers * inner * (state + conv - 1)
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

  // Attention-layout-aware KV sizing (ADR-223): counts each layer for what it actually
  // caches instead of assuming every layer holds full context. Falls back to exactly the
  // old all-layer formula for any model that doesn't declare its layout — see kvCacheElems.
  const kvElems = kvCacheElems(m, p.ctx)
  // The linear/SSM layers' constant recurrent state. Sized at f32 (4 bytes) and NOT scaled by
  // --cache-type-k: llama.cpp keeps recurrent state unquantized, so applying the user's KV quant
  // here would under-count it. f32 rather than f16 is the deliberate, safer reading — this
  // estimate also drives auto-tune's headroom gate, where under-counting costs a failed load
  // while over-counting only costs a pessimistic verdict. Worth ~155 MB on a 27B, 0 on every
  // non-hybrid model.
  const ssmMb = (ssmStateElems(m) * 4) / 1e6
  // KV cache only counts against VRAM when it's offloaded to the GPU. With --no-kv-offload
  // (kvOffload === false) it lives in system RAM, so it adds nothing to the GPU estimate.
  // Absent on pre-feature profiles → treated as the GPU default.
  // kvCacheElems returns the COMBINED K+V element count (always ×2, identical shape for
  // both — see its own comment); halving it gives the K-only / V-only count so an
  // asymmetric quant (e.g. K=q8_0, V=q4_0) is weighted correctly instead of assuming V
  // matches K's byte width.
  const kvBytesMb = ((kvElems / 2) * kvBytesPerElem(p.kvTypeK) + (kvElems / 2) * kvBytesPerElem(p.kvTypeV)) / 1e6
  const kvMb = p.kvOffload === false
    ? 0
    : (kvBytesMb + ssmMb) * (p.kvUnified ? 1 : Math.max(1, p.parallel))

  // The mmproj file's on-disk size is a much closer proxy for its real VRAM footprint than
  // a flat guess (already-quantized weights load close to 1:1) — a measured ~15% overhead
  // for the vision encoder's activation/compute buffers on top of raw weight size roughly
  // matches llama.cpp's own reported worst-case mmproj estimate for a real 27B-VL model.
  const mmprojMb = p.useMmproj && p.mmprojGpu && m.mmprojPath ? (m.mmprojSizeBytes / 1e6) * 1.15 : 0
  const estMb = Math.round(weightsMb + kvMb + 800 + mmprojMb)
  const pct = estMb / totalVramMb
  const verdict: FitVerdict = pct <= 0.8 ? 'fits' : pct <= 0.95 ? 'tight' : 'overflow'
  return { estMb, totalVramMb, pct, verdict }
}

/** What each GPU is projected to hold, index-aligned with `sys.gpus`. */
export interface GpuSplitPlan {
  /** Layer count assigned to each GPU. */
  layers: number[]
  /** Projected VRAM use per GPU, in MB. */
  estMb: number[]
  /** Each GPU's projected use as a fraction of ITS OWN VRAM. */
  pct: number[]
  /** The worst card's verdict — a split is only as good as its fullest GPU. */
  verdict: FitVerdict
}

/** Share of an MoE layer's bytes that live in its expert tensors. Calibrated against measured
 *  dual-T4 loads of Qwen3.6-35B-A3B: at --n-cpu-moe 24 of 40 blocks the two cards came out at
 *  1707 / 14693 MiB, which solves to ~90% expert / ~10% attention per layer. `estimateVram`'s
 *  pooled math uses 0.85 for the same quantity; kept separate so tightening one doesn't silently
 *  move the other. */
const MOE_EXPERT_SHARE = 0.9

/** Fraction of a GGUF's on-disk bytes that actually becomes per-layer GPU weight. The rest is
 *  container overhead plus non-layer tensors (embeddings / output head) that don't ride the layer
 *  split. Calibrated the same way: 22.9 GB of Qwen3.6-35B-A3B at zero offload measured 10905 MiB
 *  on GPU0 over 20 of 40 layers, which back-solves to ~0.95. */
const GPU_WEIGHT_FRACTION = 0.95

/** Per-card fixed cost (CUDA context + compute buffers). Charged to every participating card,
 *  unlike estimateVram's single pooled 800 MB. */
const PER_GPU_OVERHEAD_MB = 300

/** Per-GPU VRAM projection for a multi-GPU split — the thing {@link estimateVram} cannot express.
 *
 *  estimateVram compares ONE scalar against the SUMMED pool, so a config that pins GPU1 at its
 *  ceiling while GPU0 sits nearly empty still reads as comfortably fitting: measured on 2x16 GB,
 *  --n-cpu-moe 24 put 1707 MB on GPU0 and 14693 MB on GPU1 — 16.4 GB against a 30.7 GB pool, or
 *  "53%, fits", while GPU1 was one step from OOM. The offload search then can't tell that the
 *  ceiling it keeps hitting is one card's, not the pool's, and backs off far further than needed
 *  (nCpuMoe 24 where 16 was reachable once the layers were placed by BYTES).
 *
 *  Why layer counts don't track bytes: `--n-cpu-moe N` strips the experts out of the FIRST N
 *  layers, leaving them ~10x lighter than the rest, while llama.cpp's default split divides by
 *  layer COUNT. Dense models have uniform layers and so are already balanced — this only bites
 *  MoE, which is most of what people run now. */
export function estimateVramPerGpu(p: LoadProfile, m: ModelEntry, sys: SysInfo): GpuSplitPlan {
  const n = sys.gpus.length
  if (n === 0) return { layers: [], estMb: [], pct: [], verdict: 'cpu' }

  const blocks = m.blockCount > 0 ? m.blockCount : 1
  const sizeMb = m.sizeBytes / 1e6
  const perLayerMb = (sizeMb * GPU_WEIGHT_FRACTION) / blocks
  // Dense drops whole layers, so only `ngl` of them occupy VRAM.
  // MoE also honours `ngl` for the attention layers — lowering `ngl` frees GPU VRAM even
  // for MoE, so the estimate must not always report `blocks` as resident (otherwise `ngl=0`
  // reads "fits fully" while nothing is on the GPU). Expert layers move to CPU via
  // `--n-cpu-moe` and don't need VRAM.
  const residentLayers = Math.max(0, Math.min(p.ngl, blocks))
  const nCpuMoe = m.moe ? Math.max(0, Math.min(p.nCpuMoe, blocks)) : 0

  // Layers per GPU. splitMode 'none' pins everything to one card; otherwise honour tensorSplit's
  // proportions, falling back to llama.cpp's own even division.
  const layers = new Array<number>(n).fill(0)
  if (p.gpu?.splitMode === 'none' || n === 1) {
    layers[p.gpu && p.gpu.mainGpu >= 0 ? Math.min(p.gpu.mainGpu, n - 1) : 0] = residentLayers
  } else {
    const w = p.gpu?.tensorSplit?.length === n && p.gpu.tensorSplit.some((x) => x > 0)
      ? p.gpu.tensorSplit
      : new Array<number>(n).fill(1)
    const sum = w.reduce((a, b) => a + b, 0) || 1
    let placed = 0
    for (let i = 0; i < n; i++) {
      const take = i === n - 1 ? residentLayers - placed : Math.round((residentLayers * w[i]) / sum)
      layers[i] = Math.max(0, take)
      placed += layers[i]
    }
  }

  // KV rides along with the layer that owns it (llama.cpp allocates it per-layer on that device),
  // so it follows the same distribution as the weights and needs no placement of its own.
  const kvElems = kvCacheElems(m, p.ctx)
  const kvTotalMb = p.kvOffload === false
    ? 0
    : ((((kvElems / 2) * kvBytesPerElem(p.kvTypeK) + (kvElems / 2) * kvBytesPerElem(p.kvTypeV)) / 1e6)
        + (ssmStateElems(m) * 4) / 1e6) * (p.kvUnified ? 1 : Math.max(1, p.parallel))
  const kvPerLayerMb = kvTotalMb / Math.max(1, residentLayers)

  const mmprojMb = p.useMmproj && p.mmprojGpu && m.mmprojPath ? (m.mmprojSizeBytes / 1e6) * 1.15 : 0
  // Walk the layers in order so an MoE's light (expert-stripped) head lands on whichever cards
  // the split actually gives it — that asymmetry is the entire point of this function.
  const estMb = new Array<number>(n).fill(0)
  let idx = 0
  for (let g = 0; g < n; g++) {
    let mb = 0
    for (let k = 0; k < layers[g]; k++, idx++) {
      mb += m.moe && idx < nCpuMoe ? perLayerMb * (1 - MOE_EXPERT_SHARE) : perLayerMb
      mb += kvPerLayerMb
    }
    // Context + compute buffers land on every participating card, not once for the whole load.
    estMb[g] = Math.round(mb + (layers[g] > 0 ? PER_GPU_OVERHEAD_MB : 0) + (g === 0 ? mmprojMb : 0))
  }

  const pct = estMb.map((mb, g) => mb / Math.max(1, sys.gpus[g]?.vramMb ?? 0))
  const worst = Math.max(...pct)
  const verdict: FitVerdict = worst <= 0.8 ? 'fits' : worst <= 0.95 ? 'tight' : 'overflow'
  return { layers, estMb, pct, verdict }
}

/** Layer proportions that even out BYTES across the cards, for {@link GpuProfile.tensorSplit}.
 *
 *  Only meaningful when the layers themselves are uneven — i.e. MoE with `--n-cpu-moe` — and only
 *  worth emitting when a card would otherwise saturate while another idles. Measured: with both
 *  cards well short of their ceiling, rebalancing moved bytes around (7717/11303 -> 11369/7653)
 *  and changed throughput by 0.5%, i.e. nothing. The win is not the balance itself, it is that a
 *  balanced placement lets the offload search stop sooner (nCpuMoe 24 -> 16 on the same hardware,
 *  4.96 -> 5.82 tok/s), so callers should only reach for this when the split is the binding
 *  constraint. Returns [] when an even split is already right. */
export function deriveTensorSplit(p: LoadProfile, m: ModelEntry, sys: SysInfo): number[] {
  const n = sys.gpus.length
  if (n < 2 || !m.moe || p.gpu?.splitMode === 'none') return []
  const blocks = m.blockCount > 0 ? m.blockCount : 1
  const nCpuMoe = Math.max(0, Math.min(p.nCpuMoe, blocks))
  if (nCpuMoe === 0) return [] // uniform layers — llama.cpp's even split is already byte-balanced

  const light = 1 - MOE_EXPERT_SHARE
  const totalW = nCpuMoe * light + (blocks - nCpuMoe) * 1
  const vram = sys.gpus.map((g) => g.vramMb || 0)
  const vramSum = vram.reduce((a, b) => a + b, 0) || 1

  // Walk the layers in order, handing each card layers until it has its VRAM-proportional share
  // of the total weight. The light (expert-stripped) head is cheap, so the first card absorbs
  // many more layers than an even split would give it.
  const layers = new Array<number>(n).fill(0)
  let idx = 0
  let acc = 0
  for (let g = 0; g < n; g++) {
    const target = g === n - 1 ? Infinity : (totalW * vram[g]) / vramSum
    while (idx < blocks && (g === n - 1 || acc < target)) {
      acc += idx < nCpuMoe ? light : 1
      layers[g]++
      idx++
      if (g < n - 1 && acc >= target) break
    }
    acc = 0
  }
  if (layers.some((l) => l === 0)) return [] // degenerate — leave llama.cpp's default alone
  return layers
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

/** GitHub #85 / ADR-324: llama.cpp on ROCm hangs loading large models on AMD unified-memory
 *  APUs (Strix Halo / gfx1151 confirmed; an open upstream llama.cpp/ROCm bug, not ours — see
 *  decision-log ADR-310). --no-mmap is a workaround the reporter confirmed fixes it alone.
 *  Upstream reports put the confirmed-safe ceiling at ~33GB and the confirmed-hang floor at
 *  ~60GB; 30GB was chosen (deliberately, not derived) to start the workaround a bit before the
 *  known-safe boundary rather than right at the edge of the unconfirmed 33-60GB gap. */
const ROCM_APU_NOMMAP_MIN_BYTES = 30 * 1024 ** 3

/** True when this load matches the GitHub #85 hang profile: a ROCm llama.cpp build (identified
 *  from the managed install dir naming, {@link backendIdFromBinPath}) on an AMD unified-memory
 *  GPU ({@link SysInfo.gpus}, ADR-310), loading a model at or above the threshold. `sys`/`binPath`
 *  are optional so every existing caller (tests, bench.ts fixtures) keeps working unchanged when
 *  it doesn't have them in scope — absence just means the gate never fires. */
function isRocmUnifiedApuLoad(m: ModelEntry, sys: SysInfo | undefined, binPath: string | undefined): boolean {
  if (!sys || !binPath) return false
  if (m.sizeBytes < ROCM_APU_NOMMAP_MIN_BYTES) return false
  if (backendIdFromBinPath(binPath) !== 'rocm') return false
  return sys.gpus.some((g) => g.vendor === 'amd' && g.unified)
}

/** Map a profile to llama-server args (spec 05 §8). The manager injects
 *  -m/--host/--port/--metrics/--no-webui; this returns everything else.
 *  Flags absent from the engine's capabilities are skipped (graceful degrade).
 *  `sys`/`binPath` are optional — only needed for the GitHub #85 ROCm+APU gate above. */
export function profileToArgs(
  p: LoadProfile,
  m: ModelEntry,
  caps: Capabilities,
  cores = 0,
  sys?: SysInfo,
  binPath?: string,
): string[] {
  const has = (flag: string) => caps.flags.length === 0 || caps.flags.includes(flag)
  const a: string[] = ['-c', String(p.ctx)]
  // nglFit: omit -ngl entirely so llama.cpp's own -fit logic picks the offload (see LoadProfile).
  // Ignored for MoE models (pre-release review, Finding D) — the UI hides the "Auto-fit GPU
  // layers" toggle and force-shows the plain slider for MoE (nCpuMoeFit is the real MoE
  // offload control), so honoring a stray nglFit:true here would silently make that slider a
  // no-op with no UI path to notice or undo it.
  //
  // For MoE, nCpuMoeFit ALSO suppresses -ngl (found from a user-reported OOM crash, see
  // LoadProfile.nCpuMoeFit): llama.cpp's own -fit (fit.cpp `common_params_fit_params`) throws
  // the instant -ngl is explicit, before it ever reaches the MoE tensor-placement step — it
  // doesn't partially fit just --n-cpu-moe, it aborts the WHOLE pass. Leaving -ngl in place
  // while only omitting --n-cpu-moe silently defeats the "Auto-fit MoE CPU offload" toggle:
  // -fit aborts, and the engine falls through to loading -ngl layers — every expert included —
  // with zero MoE offload, an instant CUDA OOM on a VRAM-constrained card.
  const moeAutoFit = m.moe && p.nCpuMoeFit
  if (!moeAutoFit && (!p.nglFit || m.moe) && p.ngl > 0) a.push('-ngl', String(p.ngl))
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
  // Outside auto-fit, pass it explicitly whenever -ngl is ALSO explicit (p.ngl > 0 — the same
  // gate as the -ngl push above) — including 0 — found 2026-08-06 from a live BeeLlama.cpp repro:
  // omitting --n-cpu-moe (on the old assumption that "0" and "absent" are equivalent) while -ngl
  // is explicit leaves it ambiguous whether the engine should auto-fit its own placement or use
  // exactly 0 CPU offload. BeeLlama's fork runs an implicit fit pass whenever --n-cpu-moe is
  // absent, which then aborts on seeing -ngl already pinned ("n_gpu_layers already set by user to
  // N, abort") and falls through to loading every expert on GPU with no real offload — silently
  // spilling to system RAM instead of erroring, so auto-tune's own nCpuMoe=0 search candidate can
  // look like it fits when it doesn't. Gating on p.ngl > 0 (not unconditional) matters: when ngl
  // is 0 (a CPU-only box, or a user dragging the still-visible MoE ngl slider to 0) there's no
  // -ngl on the command line to collide with, so forcing --n-cpu-moe 0 there would needlessly
  // suppress a fit pass that runs cleanly on its own.
  if (m.moe && !p.nCpuMoeFit && p.ngl > 0 && has('--n-cpu-moe')) a.push('--n-cpu-moe', String(p.nCpuMoe))
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
  // GitHub #85 / ADR-324: skip if the user already added it themselves (e.g. copying the
  // manual workaround from the issue) so it's never passed twice.
  if (
    isRocmUnifiedApuLoad(m, sys, binPath) &&
    has('--no-mmap') &&
    !p.extraArgs.includes('--no-mmap') &&
    !p.extraArgs.includes('-dio')
  ) {
    a.push('--no-mmap')
  }
  a.push(...p.extraArgs)
  return a
}

/** Map a profile's vLLM block to vLLM OpenAI-server CLI flags (F-027). The manager injects
 *  -m/--model/--served-model-name/--host/--port and the tensor-parallel flag; this returns the
 *  rest. Each flag is emitted only when it deviates from vLLM's own default, so a fresh profile
 *  produces no extra args (launch is unchanged from before this feature). User `extraArgs` pass
 *  through last so they can override anything.
 *
 *  `nativeCtx` is the model's own uncapped `max_position_embeddings` (`ModelEntry.nativeCtx`) —
 *  deliberately NOT `p.ctx`, which `deriveDefault()` caps at 8192 for llama.cpp/MLX's KV-memory
 *  sizing and has no bearing on vLLM once `--max-model-len` is left unset (see below). */
export function vllmProfileToArgs(p: LoadProfile, nativeCtx: number): string[] {
  const v = p.vllm ?? defaultVllm()
  const a: string[] = []
  if (v.maxModelLen > 0) a.push('--max-model-len', String(v.maxModelLen))
  // vLLM's own --max-num-batched-tokens defaults to 2048, and its scheduler config
  // validator hard-rejects (refuses to start) any effective max-model-len larger than
  // that — not a soft truncation. When --max-model-len is left unset, vLLM derives its
  // own from the model's real max_position_embeddings, so --max-num-batched-tokens must
  // be raised to match THAT (nativeCtx), not the 8192-capped p.ctx used elsewhere.
  const effectiveMaxLen = v.maxModelLen > 0 ? v.maxModelLen : nativeCtx || 8192
  if (effectiveMaxLen > 2048) a.push('--max-num-batched-tokens', String(effectiveMaxLen))
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
