// Client-side mirror of the daemon's VRAM estimate (spec 05 §6) so the load
// form can show a live fit as the user drags sliders. Deterministic math — the
// only number we show pre-run, always labeled an estimate (ADR-012).
import type { FitVerdict, HfSearchItem, LoadProfile, ModelEntry, SysGpu } from './types'

// Fallback only, for a model that declares no per-head dimension (headDim 0/absent) — as in the daemon.
const HEAD_DIM = 128

/** Mirror of the daemon's `gpuBudgetMb` (ADR-054): a layer/row split (and the default)
 *  spans all GPUs; 'none' restricts to one. Single-GPU is unaffected (sum = that GPU). */
export function gpuBudgetMb(gpus: SysGpu[], gpu?: LoadProfile['gpu']): number {
  if (!gpus.length) return 0
  if (gpu?.splitMode === 'none') {
    const idx = gpu.mainGpu >= 0 ? gpu.mainGpu : 0
    return gpus[idx]?.vramMb ?? gpus[0]?.vramMb ?? 0
  }
  return gpus.reduce((sum, g) => sum + (g.vramMb || 0), 0)
}

const VENDOR_RANK: Record<string, number> = { nvidia: 4, amd: 3, apple: 3, intel: 2, unknown: 1 }

type VendorGpu = { name: string; vramMb: number; vendor: string }

/** Mirror of the daemon's `detectHardware` primary-vendor VRAM sum (`turbollm/src/engines/
 *  hardware.ts`) for use as the raw-sysinfo fallback on the Engines screen: before the
 *  `/recommendation` query resolves (or if it errors, since that query never retries), the
 *  hero must not regress to a single un-summed card's VRAM on a multi-GPU box. */
export function primaryVendorSummary(gpus: VendorGpu[]): { gpuName: string | null; vramMb: number; count: number } {
  if (!gpus.length) return { gpuName: null, vramMb: 0, count: 0 }
  let vendor = 'unknown'
  for (const g of gpus) if ((VENDOR_RANK[g.vendor] ?? 1) > (VENDOR_RANK[vendor] ?? 1)) vendor = g.vendor
  const ofVendor = gpus.filter((g) => g.vendor === vendor)
  const pool = ofVendor.length ? ofVendor : gpus
  const headline = pool.reduce<VendorGpu | undefined>((best, g) => (!best || g.vramMb > best.vramMb ? g : best), undefined)
  const vramMb = ofVendor.reduce((sum, g) => sum + g.vramMb, 0)
  return { gpuName: headline?.name ?? null, vramMb, count: pool.length }
}

// ── "Will this repo run on THIS machine?" (Discover's fits-my-hardware filter) ──
// Anticipated by ADR-338 Decision 6b, which sends the Pro onboarding branch into
// DiscoverTab "seeded with a fits-your-hardware filter".
//
// This is a much coarser question than `estimateVram` above, and deliberately so: a
// Discover row is an HF *repo*, and `HfSearchItem` carries no file sizes at all (only
// repo/tags/downloads — see src/hf/hf.ts's search mapping). Pulling `getRepo` for every
// row to get real sizes would be one HF round-trip per result on every keystroke's
// worth of results. So the size comes from the parameter count that GGUF repo names
// almost always spell out, and every constant below errs toward "too big" — a filter
// that wrongly hides a runnable model is worse than one that lets a marginal one through.

/** Bytes per parameter at ~Q4_K_M, measured across the usual suspects (Llama-3.1-8B
 *  4.92 GB, Qwen2.5-3B 1.93 GB, Llama-3.2-1B 0.81 GB → 0.61–0.65). */
const Q4_MB_PER_B_PARAMS = 620
/** Engine + a modest KV window on top of the weights. Deliberately below `estimateVram`'s
 *  flat 800 MB: that number budgets a full desktop context the user has actually chosen,
 *  whereas this only asks whether the repo could ever load here — charging 800 MB against
 *  a phone's ~1.3 GB budget would hide every model that genuinely runs on it. */
const FIT_OVERHEAD_MB = 400

export type FitHardware = { os: string; ramMB: number; gpus: SysGpu[] }

/** How much model this machine can actually hold, in MB. 0 when it can't be known
 *  (no sysinfo yet) — callers must hide the filter rather than filter against 0.
 *
 *  GPU boxes get **VRAM + usable system RAM**, not VRAM alone, because partial/MoE
 *  offload is a headline feature here, not an edge case: ADR-338 Decision 6 ships a
 *  35B-A3B coder pick to ≤16 GB cards precisely because experts spill to system RAM via
 *  `nCpuMoe` ("the larger model goes to the smaller card"). A VRAM-only budget would hide
 *  the model TurboLLM itself recommends — the same trap ADR-084 called out when it
 *  rejected VRAM-gating the engine catalog for "risks wrongly hiding runnable" entries. */
export function fitBudgetMb(sys: FitHardware): number {
  if (!sys.ramMB) return 0
  // Android has no discrete VRAM pool — it's one unified CPU memory space, and the OS,
  // the WebView and the app itself stay resident in it. The low-memory killer also reaps
  // the app well before RAM is literally exhausted, so the reserve is both proportional
  // (40%) and absolute (1 GB): on the ~3.8 GB test device that leaves ~1.3 GB, which is
  // about what a phone will really give a llama.cpp mmap.
  if (sys.os.startsWith('android')) return Math.max(0, Math.round(sys.ramMB * 0.6) - 1024)
  // Desktop: a flat 2 GB for the OS plus 30% slack, since spilling into swap is a hang,
  // not a slowdown.
  return gpuBudgetMb(sys.gpus) + Math.max(0, Math.round(sys.ramMB * 0.7) - 2048)
}

/** Parameter count in billions, read off an HF repo id ("Qwen3-30B-A3B-GGUF" → 30),
 *  or null when the name doesn't say. Rules, all learned from real repo names:
 *  - Takes the **max** of every size token, not the first: `Qwen3-30B-A3B` puts total
 *    first while `OLMoE-1B-7B` puts active first, and total is what has to fit in memory.
 *  - Skips `A`-prefixed tokens outright (`A3B` = active params, never resident-only).
 *  - `8x7B` multiplies (→ 56, vs Mixtral's real ~47B: over, which is the safe side).
 *  - `M` counts as millions, so `gemma-3-270m-it` is 0.27 and doesn't read as 270. */
export function repoParamsB(repo: string): number | null {
  const tokens: number[] = []
  // The leading `[^a-z0-9]` is what rejects `a3b` and `q8_0`: a size token must start at a
  // separator, never mid-word.
  const re = /(?:^|[^a-z0-9])(?:(\d+(?:\.\d+)?)x)?(\d+(?:\.\d+)?)([bm])(?![a-z0-9])/gi
  for (const m of repo.toLowerCase().matchAll(re)) {
    const n = parseFloat(m[2]) * (m[1] ? parseFloat(m[1]) : 1)
    tokens.push(m[3] === 'm' ? n / 1000 : n)
  }
  return tokens.length ? Math.max(...tokens) : null
}

/** Repo-level fit verdict against `fitBudgetMb`.
 *
 *  "Fits" means **at least one variant we'd actually recommend fits** — sized at Q4_K_M,
 *  the bottom of the quality ladder rather than the bottom of the size ladder. A GGUF repo
 *  is a ladder of quants, so judging it by its default/largest file would hide repos whose
 *  smaller rungs run fine; judging it by its literal smallest (IQ1/Q2) would promise a
 *  model that technically loads and answers gibberish. Q4 is the honest middle.
 *
 *  'unknown' when the name carries no parameter count — which is common, not rare: most of
 *  today's frontier releases are codename-branded ("Flash", "Next", "Pro", a bare version
 *  number like "GLM-5.3" or "DeepSeek-V4") with no "<N>B" anywhere in the repo name.
 *  DiscoverTab hides 'unknown' the same as 'too-big' when its filter is on — verified live:
 *  with 'unknown' left visible, a 7.7 GB Android phone's filtered Discover list was DOMINATED
 *  by exactly those oversized codename models, because none of them carried a size token this
 *  function could read. Treating "can't tell" as "assume it's fine" defeated the filter for
 *  most of what it exists to catch. The trade-off runs the other way now — a repo that would
 *  genuinely have fit can be hidden — but on the platform this defaults on for, a model that
 *  silently OOMs is worse than one that never appears. See DiscoverTab for the hidden-count
 *  UI that keeps this honest instead of silent. */
export function repoFitVerdict(repo: string, budgetMb: number): 'fits' | 'too-big' | 'unknown' {
  const paramsB = repoParamsB(repo)
  if (paramsB === null || !budgetMb) return 'unknown'
  return paramsB * Q4_MB_PER_B_PARAMS + FIT_OVERHEAD_MB <= budgetMb ? 'fits' : 'too-big'
}

/** The actual policy DiscoverTab's "Fits my hardware" checkbox applies: show a repo only when
 *  we can positively confirm it fits, i.e. only on a 'fits' verdict — 'unknown' is treated the
 *  same as 'too-big', not as "innocent until proven big". Pulled out of the component and
 *  tested directly because getting this backwards is exactly how the filter shipped broken:
 *  with 'unknown' left visible, a real Android device's filtered list was DOMINATED by
 *  codename-branded frontier models (Qwen3.8-Flash-Next, GLM-5.3-Flash,
 *  DeepSeek-V4-Flash-Vision-Exp) that carry no "<N>B" token for `repoParamsB` to find — which
 *  is most of what a trending page returns today, not an edge case. */
export function repoFitsHardware(repo: string, budgetMb: number): boolean {
  return repoFitVerdict(repo, budgetMb) === 'fits'
}

/** `repoFitsHardware` for a Discover row, except that a Text classification row (ADR-444) is
 *  never hidden. The name rule sizes a Q4 GGUF quant ladder, and a classifier repo is not one:
 *  its name carries no "<N>B" token, so the rule would hide the whole category, and the daemon
 *  already lists only classifiers TurboLLM can run. */
export function searchRowFitsHardware(row: HfSearchItem, budgetMb: number): boolean {
  return !!row.textClassification || repoFitsHardware(row.repo, budgetMb)
}

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

// ── Attention-layout-aware KV sizing: a port of src/models/profile.ts's kvCacheElems /
// ssmStateElems (ADR-223). The old all-layer, headDim-128 formula here over-counted sliding-window
// (Gemma) and hybrid linear/SSM (Qwen3.5/3.6, Qwen3-Next) models by up to ~10x, so the load
// dialog's live bar said "overflow" where the daemon's own verdict said "tight". Kept identical to
// the daemon's (see profile.ts for why every undeclared or unusable layout degrades to the
// conservative legacy formula); vram-parity.test.ts pins the two to the same numbers.

function isFullAttentionLayer(i: number, interval: number): boolean {
  return (i + 1) % interval === 0
}

function hybridInterval(m: ModelEntry, blocks: number): number {
  const interval = m.fullAttentionInterval ?? 0
  if (!Number.isInteger(interval) || interval <= 1 || interval > blocks) return 0
  return interval
}

function linearLayerCount(m: ModelEntry): number {
  const blocks = m.blockCount || 1
  const interval = hybridInterval(m, blocks)
  if (interval === 0) return 0
  let n = 0
  for (let i = 0; i < blocks; i++) if (!isFullAttentionLayer(i, interval)) n++
  return n
}

/** Combined K+V cache elements for `ctx` tokens (mirror of the daemon's `kvCacheElems`). A
 *  sliding layer holds llama.cpp's `pad256(min(ctx, window × swaSeqs + ubatch))` cells. */
function kvCacheElems(m: ModelEntry, ctx: number, swaSeqs: number, ubatch: number): number {
  const blocks = m.blockCount || 1
  const kvHeads = m.headCountKv || 8
  const headDim = m.headDim || HEAD_DIM
  const perLayerHeads =
    m.headCountKvPerLayer?.length === blocks ? m.headCountKvPerLayer : undefined
  const window = m.slidingWindow ?? 0
  const swaPattern =
    window > 0 && m.slidingWindowPattern?.length === blocks ? m.slidingWindowPattern : undefined
  const swaHeadDim = (m.headDimSwa ?? 0) > 0 ? (m.headDimSwa as number) : headDim
  const interval = hybridInterval(m, blocks)
  const hybrid = interval > 0 && swaPattern === undefined

  if (swaPattern === undefined && !hybrid) return 2 * blocks * ctx * kvHeads * headDim

  const swaTokens = Math.ceil(Math.min(ctx, window * swaSeqs + ubatch) / 256) * 256
  let elems = 0
  for (let i = 0; i < blocks; i++) {
    if (hybrid && !isFullAttentionLayer(i, interval)) continue
    const sliding = swaPattern?.[i] === true
    const tokens = sliding ? swaTokens : ctx
    const heads = perLayerHeads?.[i] || kvHeads
    const dim = sliding ? swaHeadDim : headDim
    elems += 2 * tokens * heads * dim
  }
  return elems
}

/** K+V elements across all sequences (mirror of the daemon's `profileKvElems`): a non-unified
 *  cache is `parallel` streams of pad256(ctx / parallel) cells, not `parallel` full contexts. */
function profileKvElems(m: ModelEntry, p: LoadProfile): number {
  const seqs = Math.max(1, p.parallel)
  const ubatch = p.uBatchSize || 512
  if (p.kvUnified || seqs === 1) return kvCacheElems(m, p.ctx, seqs, ubatch)
  return kvCacheElems(m, Math.ceil(Math.floor(p.ctx / seqs) / 256) * 256, 1, ubatch) * seqs
}

/** Elements in the linear/SSM layers' constant recurrent state (mirror of `ssmStateElems`). */
function ssmStateElems(m: ModelEntry): number {
  const layers = linearLayerCount(m)
  const inner = m.ssmInnerSize ?? 0
  const state = m.ssmStateSize ?? 0
  if (layers === 0 || inner <= 0 || state <= 0) return 0
  const conv = Math.max(1, m.ssmConvKernel ?? 1)
  return layers * inner * (state + conv - 1)
}

export function estimateVram(
  p: LoadProfile,
  m: ModelEntry,
  totalVramMb: number,
): { estMb: number; totalVramMb: number; pct: number; verdict: FitVerdict } {
  if (!totalVramMb) return { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'cpu' }
  const sizeMb = m.sizeBytes / 1e6
  const blocks = m.blockCount || 1
  const gpuFrac = m.moe ? 1 - 0.85 * (p.nCpuMoe / blocks) : Math.min(p.ngl, blocks) / blocks
  const weightsMb = sizeMb * Math.max(0, Math.min(1, gpuFrac))
  // Every sequence's cells, unified or not — see profileKvElems.
  const kvElems = profileKvElems(m, p)
  // Recurrent state at f32, not scaled by the KV quant or ctx (llama.cpp keeps it unquantized).
  const ssmMb = (ssmStateElems(m) * 4) / 1e6
  // KV cache only weighs on VRAM when offloaded to the GPU; in RAM mode (--no-kv-offload) it
  // costs no VRAM. Absent on pre-feature profiles → treated as the GPU default.
  // kvElems is the COMBINED K+V count (×2, identical shape for both) — halved so an
  // asymmetric quant (K=q8_0, V=q4_0) is weighted correctly instead of assuming V
  // matches K's byte width. Same expression as src/models/profile.ts, so the two round alike.
  const kvBytesMb = ((kvElems / 2) * kvBytesPerElem(p.kvTypeK) + (kvElems / 2) * kvBytesPerElem(p.kvTypeV)) / 1e6
  // The recurrent state is one cell per sequence whether or not the KV cache is unified.
  const kvMb = p.kvOffload === false
    ? 0
    : kvBytesMb + ssmMb * Math.max(1, p.parallel)
  // The mmproj's real on-disk size plus ~15% for the vision encoder's buffers, as the daemon does.
  const mmprojMb = p.useMmproj && p.mmprojGpu && m.mmprojPath ? ((m.mmprojSizeBytes ?? 0) / 1e6) * 1.15 : 0
  const estMb = Math.round(weightsMb + kvMb + 800 + mmprojMb)
  const pct = estMb / totalVramMb
  const verdict: FitVerdict = pct <= 0.8 ? 'fits' : pct <= 0.95 ? 'tight' : 'overflow'
  return { estMb, totalVramMb, pct, verdict }
}
