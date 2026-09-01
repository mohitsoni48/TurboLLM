// Model discovery (A3, spec 04): scan model directories for GGUFs, parse their
// headers, group split/mmproj files, and expose a rich model list. Path-cached.
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { migrateModelKey, type ConfigStore } from '../config/config'
import { GgufError, type GgufMeta, parseGguf, quantFromName } from '../gguf/gguf'

export interface ModelEntry {
  key: string
  name: string
  path: string
  dir: string
  format: 'gguf' | 'mlx'
  sizeBytes: number
  sizeLabel: string
  arch: string
  quant: string
  nativeCtx: number
  blockCount: number
  headCountKv: number
  /** Real per-head dimension (GgufMeta.headDim) — 0 when the GGUF doesn't declare
   *  attention.key_length/value_length. See profile.ts's estimateVram for the fallback. */
  headDim: number
  /** Sliding-window size in tokens (`<arch>.attention.sliding_window`, Gemma 3/4).
   *  Sliding layers' KV cache stops growing at this many tokens instead of at `ctx`.
   *  Absent unless the GGUF declares it — see {@link kvCacheElems}. */
  slidingWindow?: number
  /** Per-layer sliding-window flags (`<arch>.attention.sliding_window_pattern`);
   *  `true` = that layer is a sliding (windowed) layer, `false` = a global/full one.
   *  Only honored when its length equals `blockCount`. Absent unless declared. */
  slidingWindowPattern?: boolean[]
  /** Per-head dimension used by the SLIDING layers specifically
   *  (`<arch>.attention.key_length_swa`). Gemma 4 halves it (256) versus its global
   *  layers (512), so the two layer kinds must be sized separately. Absent/0 → the
   *  sliding layers reuse `headDim`. */
  headDimSwa?: number
  /** Per-layer KV-head counts (`<arch>.attention.head_count_kv` when the GGUF declares
   *  it as an ARRAY rather than a scalar — e.g. Gemma-4-26B-A4B's 8-on-sliding /
   *  2-on-global layout). Wins over the scalar `headCountKv` when its length equals
   *  `blockCount`. Absent unless declared as an array. */
  headCountKvPerLayer?: number[]
  /** Hybrid linear/SSM layout stride (`<arch>.full_attention_interval`, Qwen3.5/3.6,
   *  Qwen3-Next): with interval N only every Nth layer keeps a growing KV cache; the
   *  rest hold a small constant recurrent state. Absent/0 → the layout is UNDECLARED
   *  and {@link kvCacheElems} keeps the conservative all-layer estimate, even for a
   *  model that clearly is hybrid (see its doc). */
  fullAttentionInterval?: number
  /** SSM/recurrent-state dimensions (`<arch>.ssm.inner_size` / `.state_size` /
   *  `.conv_kernel`). Used to size the small CONSTANT state a linear layer holds, so
   *  the estimate stays honest instead of dropping those layers to zero. Absent on
   *  every non-hybrid model. */
  ssmInnerSize?: number
  ssmStateSize?: number
  ssmConvKernel?: number
  moe: boolean
  expertCount: number
  nextnLayers: number
  vision: boolean
  /** True for MLX-format models whose config.json declares an audio_config (an audio
   *  tower/encoder, e.g. gemma4's Conformer audio module). GGUF detection isn't
   *  implemented (no observed need yet) — always false there. */
  audio: boolean
  mmprojPath: string | null
  /** On-disk size of the mmproj file, bytes (0 when `mmprojPath` is null). Used to size
   *  the vision projector's VRAM contribution instead of a flat guess. */
  mmprojSizeBytes: number
  hasChatTemplate: boolean
  /** True when the model's chat template itself supports a `reasoning_effort` control
   *  (low/medium/xhigh) — see GgufMeta.reasoningEffort. Detected per-file (never from
   *  `arch`), for both GGUF (embedded tokenizer.chat_template) and MLX (tokenizer_config.json
   *  / standalone chat_template.jinja). Callers that expose a reasoning-effort UI must gate
   *  it on this flag: sending the field to a model whose template doesn't check it is a
   *  silent no-op, but a model whose template raises on an unrecognized effort value is
   *  a separate, real risk this flag exists to prevent triggering. */
  reasoningEffort: boolean
  /** True for embedding models (BERT-family arch or known embed filename patterns).
   *  Passed to llama-server as --embeddings to activate /v1/embeddings. */
  embedding: boolean
  incomplete: boolean
  parseError: string | null
  loaded: boolean
  hasProfile: boolean
  benchTps: number | null
  mtime: string
}

interface CacheRow {
  size: number
  mtime: number
  meta: GgufMeta
}

// Bump when GgufMeta gains a field, OR when parseGguf's interpretation of an existing
// field changes, so on-disk caches re-parse (see loadCache) instead of replaying a stale
// value.
// 4: attention-layout fields (sliding window / hybrid-SSM layout, ADR-223) — rows cached
// by an older build predate the new keys, so re-parsing is what makes the improved KV
// estimate actually apply to already-scanned models instead of only to new ones.
// 5: general.name now rejects known storage-format placeholder values (issue #165) —
// without this bump, a model already in the cache with a bogus cached name (e.g. an APEX
// GGUF's literal "Safetensors") keeps replaying it forever, since entryFor() only calls
// parseGguf() again when size/mtime changed.
// 6: reasoningEffort (Qwen3.8's low/medium/xhigh chat-template reasoning-depth control) —
// a row cached by an older build predates the field and would otherwise replay `false`
// forever for a model that genuinely supports it.
const CACHE_VERSION = 6

/** Optional attention-layout metadata the GGUF parser surfaces (ADR-223).
 *
 *  Read as a structural view over {@link GgufMeta} rather than off it field-by-field:
 *  every key here is genuinely optional in the file format (only two model families
 *  declare any of it), so treating them as "maybe present" at the boundary keeps this
 *  file honest about that, and a GGUF declaring none of them produces an entry that is
 *  byte-for-byte what it was before — which is exactly the degradation guarantee the KV
 *  estimator relies on. */
interface AttentionLayoutMeta {
  slidingWindow?: number
  slidingWindowPattern?: boolean[]
  headDimSwa?: number
  headCountKvPerLayer?: number[]
  fullAttentionInterval?: number
  ssmInnerSize?: number
  ssmStateSize?: number
  ssmConvKernel?: number
}

/** Copy the declared attention-layout fields onto a ModelEntry, omitting anything the
 *  GGUF didn't declare. Omitting rather than storing 0/[] matters twice over: the model
 *  list is serialized to the API and to the on-disk cache for EVERY model, and — more
 *  importantly — it keeps "absent" unambiguous for {@link kvCacheElems}, which must not
 *  mistake a zeroed placeholder for a real declaration. */
function attentionLayoutOf(meta: GgufMeta | null): Partial<ModelEntry> {
  const a: AttentionLayoutMeta = meta ?? {}
  const out: Partial<ModelEntry> = {}
  if (a.slidingWindow) out.slidingWindow = a.slidingWindow
  if (a.slidingWindowPattern?.length) out.slidingWindowPattern = a.slidingWindowPattern
  if (a.headDimSwa) out.headDimSwa = a.headDimSwa
  if (a.headCountKvPerLayer?.length) out.headCountKvPerLayer = a.headCountKvPerLayer
  if (a.fullAttentionInterval) out.fullAttentionInterval = a.fullAttentionInterval
  if (a.ssmInnerSize) out.ssmInnerSize = a.ssmInnerSize
  if (a.ssmStateSize) out.ssmStateSize = a.ssmStateSize
  if (a.ssmConvKernel) out.ssmConvKernel = a.ssmConvKernel
  return out
}

const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

// GGUF architectures that are always embedding models.
const EMBED_ARCHS = new Set([
  'bert', 'nomic-bert', 'jina-bert-v3-base', 'jina-bert',
  'distilbert', 'roberta', 'xlm-roberta', 'electra',
])
// Filename patterns common for embedding / reranker models. The curated prefixes catch
// classic sentence-transformer-style names that don't spell out "embed" (bge, e5, gte); the
// trailing `embed(ding)?` is the generic catch-all for the newer wave of decoder-architecture
// embedding models (Qwen3-Embedding, gte-Qwen2, granite-embedding, arctic-embed, …) whose repo
// names just say so outright — missed live: `Qwen3-Embedding-0.6B-Q8_0.gguf` matched none of
// the curated prefixes and its arch (`qwen3`) is shared with ordinary chat models, so it loaded
// as an ordinary (non-embedding) model and evicted a running chat model instead of getting its
// own pool slot (ADR-389's fix routes correctly once `embedding` is actually true).
const EMBED_FILE_RE = /\b(bge[-_]|nomic[-_]embed|all[-_]minilm|e5[-_]|gte[-_]|stella[-_]embed|jina[-_]embed|mxbai[-_]embed|embed(ding)?)\b/i

function isEmbeddingModel(arch: string, name: string): boolean {
  return EMBED_ARCHS.has(arch.toLowerCase()) || EMBED_FILE_RE.test(name)
}

/** How many identical characters two (already-lowercased) strings share from the start —
 *  a cheap, realistic correlation signal for GGUF filenames: a repo's model and mmproj
 *  files typically share a "<repo-name>-…" prefix before diverging into their own
 *  quant/format suffix (e.g. "gemma-4-12b-it-qat" vs "gemma-4-12b-mmproj-F16"). */
function commonPrefixLen(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

const MIN_MMPROJ_CORRELATION_PREFIX = 6

/** Picks the mmproj that actually belongs to `modelFile` out of every mmproj candidate
 *  in the same directory. Fixes a real bug (Discord thread, 2026-07-20): a modelDir the
 *  user points at manually with more than one vision model's files sitting flat in one
 *  folder used to pick "the single largest mmproj in the directory" and attach it to
 *  EVERY model there, regardless of which model it actually belongs to — wiring the wrong
 *  projector onto a model, which then fails to start with an incompatible vision tower.
 *
 *  1. One candidate → unambiguous, use it (the common case — and ADR-145's per-repo
 *     download folders mean TurboLLM's own downloader never produces more than one).
 *  2. Filename correlation (shared prefix before quant/format suffixes diverge) narrows
 *     to exactly one candidate → use it.
 *  3. Still ambiguous (no correlation, or several candidates all correlate) → the mmproj
 *     with the closest mtime to the model file wins: files pulled down in the same HF
 *     download land within moments of each other, so this reliably tells two repos' files
 *     apart even when the mmproj is generically named — e.g. "mmproj-F16.gguf", the ACTUAL
 *     repro case (gemma-4-12B-it-qat-GGUF), which carries no model identity to correlate
 *     by name at all. */
function resolveMmproj(modelFile: FileInfo, candidates: FileInfo[]): FileInfo | undefined {
  if (candidates.length <= 1) return candidates[0]
  const modelName = basename(modelFile.path).toLowerCase()
  const correlated = candidates.filter(
    (c) => commonPrefixLen(modelName, basename(c.path).toLowerCase()) >= MIN_MMPROJ_CORRELATION_PREFIX,
  )
  if (correlated.length === 1) return correlated[0]
  const pool = correlated.length > 1 ? correlated : candidates
  return pool.reduce((best, c) =>
    Math.abs(c.mtime - modelFile.mtime) < Math.abs(best.mtime - modelFile.mtime) ? c : best,
  )
}

/** Thrown by Scanner operations that fail in a caller-actionable way (e.g. delete
 *  of an unknown key). Carries a machine-checkable `code` for the API envelope. */
export class ScannerError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ScannerError'
  }
}

export class Scanner {
  private entries: ModelEntry[] = []
  private scanning = false
  private lastScanAt = ''
  private cache = new Map<string, CacheRow>()
  private cachePath: string
  // [legacyKey, key] pairs discovered during the CURRENT rescan — see the comment in `entryFor`
  // for why these are batched into one config write instead of applied as they're found.
  private pendingKeyMigrations: Array<[string, string]> = []

  constructor(private store: ConfigStore) {
    this.cachePath = join(store.dir(), 'models-cache.json')
    this.loadCache()
  }

  list(): { models: ModelEntry[]; scanning: boolean; lastScanAt: string } {
    return { models: this.entries, scanning: this.scanning, lastScanAt: this.lastScanAt }
  }

  get(key: string): ModelEntry | undefined {
    return this.entries.find((e) => e.key === key)
  }

  /** All on-disk file paths that make up a model (spec 04 §2): every shard of a
   *  split GGUF, or the single file for an unsplit one. The shared mmproj projector
   *  is intentionally NOT included — it pairs to other models in the same dir. For
   *  MLX models (a whole directory) the directory path is returned. */
  filesFor(key: string): string[] {
    const e = this.get(key)
    if (!e) return []
    if (e.format === 'mlx') return [e.path]
    const m = basename(e.path).match(SPLIT_RE)
    if (!m) return [e.path]
    // Resolve every present shard of this split group from its sibling files.
    const prefix = m[1]
    const total = m[3]
    let names: string[]
    try {
      names = readdirSync(e.dir)
    } catch {
      return [e.path]
    }
    const shards: string[] = []
    for (const name of names) {
      const sm = name.match(SPLIT_RE)
      if (sm && sm[1] === prefix && sm[3] === total) shards.push(join(e.dir, name))
    }
    return shards.length > 0 ? shards.sort() : [e.path]
  }

  /** Delete a model's file(s) from disk (spec 05) and re-scan. Returns the paths
   *  that were removed; throws if the model key is unknown. MLX models delete the
   *  whole model directory recursively. */
  async delete(key: string): Promise<string[]> {
    const e = this.get(key)
    if (!e) throw new ScannerError('no_such_model', 'No model with that key.')
    const paths = this.filesFor(key)
    if (e.format === 'mlx') {
      rmSync(e.path, { recursive: true, force: true })
    } else {
      for (const p of paths) rmSync(p, { force: true })
      this.cache.delete(e.path)
    }
    await this.rescan()
    return paths
  }

  /** Re-scan all configured model directories. Coalesces concurrent calls. */
  async rescan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const dirs = this.store.snapshot().modelDirs
      const scan: ScanResult = { ggufs: [], mlxDirs: [] }
      for (const d of dirs) {
        if (existsSync(d)) walk(d, scan)
        await tick()
      }
      this.pendingKeyMigrations = []
      const gguf = await this.build(scan.ggufs)
      const mlx = scan.mlxDirs.map((dir) => mlxEntryFor(dir))
      this.entries = [...gguf, ...mlx].sort((a, b) => a.name.localeCompare(b.name))
      this.lastScanAt = new Date().toISOString()
      this.saveCache()
      // One config write for the whole scan (see `entryFor`), not one per affected model.
      if (this.pendingKeyMigrations.length > 0) {
        const pairs = this.pendingKeyMigrations
        this.store.update((cfg) => { for (const [oldKey, newKey] of pairs) migrateModelKey(cfg, oldKey, newKey) })
      }
    } finally {
      this.scanning = false
    }
  }

  private async build(files: FileInfo[]): Promise<ModelEntry[]> {
    // Group by directory for split + mmproj resolution (spec 04 §2).
    const byDir = new Map<string, FileInfo[]>()
    for (const f of files) {
      const d = dirname(f.path)
      ;(byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f)
    }

    const entries: ModelEntry[] = []
    for (const [dir, group] of byDir) {
      const mmprojFiles = group.filter((f) => basename(f.path).toLowerCase().includes('mmproj'))
      const modelFiles = group.filter((f) => !basename(f.path).toLowerCase().includes('mmproj'))

      // Resolve split groups: prefix+total -> shards, keyed by shard INDEX so a split is
      // judged complete by the distinct part numbers present (1..total), not by the raw
      // file count. A duplicate copy of one shard (e.g. a leftover from a re-download)
      // must not make an otherwise-complete split look "over-full", and — more importantly
      // — a missing part must be detected by its absent index, so the presence check is
      // index-based (spec 04 §2).
      const splits = new Map<string, { shards: Map<number, FileInfo>; total: number }>()
      const singles: FileInfo[] = []
      for (const f of modelFiles) {
        const m = basename(f.path).match(SPLIT_RE)
        if (m) {
          const gkey = `${m[1]}|${m[3]}`
          const g = splits.get(gkey) ?? { shards: new Map<number, FileInfo>(), total: Number(m[3]) }
          const idx = Number(m[2])
          // First writer for an index wins; a duplicate same-index file is ignored so it
          // can't inflate the count. Deterministic: keep the lexicographically-first path.
          const prev = g.shards.get(idx)
          if (!prev || f.path.localeCompare(prev.path) < 0) g.shards.set(idx, f)
          splits.set(gkey, g)
        } else {
          singles.push(f)
        }
      }

      for (const f of singles) {
        const mmproj = resolveMmproj(f, mmprojFiles)
        entries.push(await this.entryFor(f.path, f.size, f.mtime, dir, mmproj?.path ?? null, mmproj?.size ?? 0, false))
        await tick()
      }
      for (const { shards, total } of splits.values()) {
        const present = [...shards.values()].sort((a, b) => a.path.localeCompare(b.path))
        const first = present[0]
        const totalSize = present.reduce((s, x) => s + x.size, 0)
        // Complete only when every index 1..total is present on disk (not merely when the
        // count matches — a duplicate + a hole would otherwise pass the old length check).
        let incomplete = shards.size !== total
        if (!incomplete) {
          for (let i = 1; i <= total; i++)
            if (!shards.has(i)) {
              incomplete = true
              break
            }
        }
        const mmproj = resolveMmproj(first, mmprojFiles)
        entries.push(await this.entryFor(first.path, totalSize, first.mtime, dir, mmproj?.path ?? null, mmproj?.size ?? 0, incomplete))
        await tick()
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return entries
  }

  private async entryFor(
    path: string,
    sizeBytes: number,
    mtimeMs: number,
    dir: string,
    mmprojPath: string | null,
    mmprojSizeBytes: number,
    incomplete: boolean,
  ): Promise<ModelEntry> {
    let meta: GgufMeta | null = null
    let parseError: string | null = null

    const cached = this.cache.get(path)
    if (cached && cached.size === sizeBytes && cached.mtime === mtimeMs) {
      meta = cached.meta
    } else {
      try {
        meta = parseGguf(path)
        this.cache.set(path, { size: sizeBytes, mtime: mtimeMs, meta })
      } catch (e) {
        parseError = e instanceof GgufError ? e.message : (e as Error).message
      }
    }

    const fileName = basename(path)
    // Filename wins over the GGUF's own `general.file_type` when it parses (issue: Q2/IQ2 dynamic
    // quants reporting as Q4). That metadata field is llama.cpp's own single-enum summary of a
    // model's tensor quant types, and for mixed/dynamic quantizations (unsloth's "UD" line, which
    // deliberately varies bit-width per tensor to hit a size target) it is computed by MOST-COMMON
    // TENSOR, not by byte size — so a file whose few, huge, size-dominant tensors were pushed down
    // to 2-bit to shrink it can still report Q4_K_S/Q4_K_M, because the many small attention/norm
    // tensors kept at 4-bit outnumber them. Verified live 2026-08-16: `Qwen3.8-27B-UD-IQ2_M.gguf`
    // (10.3 GB — a 2-bit-class file) read `general.file_type` = 14 (Q4_K_S); same for
    // `Muse-Glimmer-30B-UD-Q2_K_XL.gguf` reading 15 (Q4_K_M) — both silently misrepresenting a
    // 2-bit model as 4-bit, the one number users actually rely on to judge output quality.
    // Filename is trustworthy here for the same reason `BOGUS_GENERAL_NAMES` already distrusts a
    // different metadata field below: every quantizer in the ecosystem (llama.cpp's own `quantize`,
    // bartowski, mradermacher, unsloth, …) names its output after the real quant, because that
    // filename IS the tool's own record of what it produced — nobody hand-renames a GGUF to a
    // different quant label. Checked against the full local catalog (26 GGUFs, 7 disagreements):
    // 5 were the filename carrying MORE information than metadata at the same bit-width (e.g.
    // "Q4_K_XL" vs "Q4_K_M" — unsloth's own recipe label, not a lie), and the other 2 were exactly
    // this bug. Zero cases favored metadata.
    const quant = quantFromName(fileName) !== '?' ? quantFromName(fileName) : meta?.quant || '?'
    const name = meta?.name || cleanName(fileName)
    const vision = mmprojPath !== null
    const arch = meta?.arch ?? 'unknown'
    const key = `${name.toLowerCase()}|${quant}|${sizeBytes}`

    // The key this same file would have gotten under the PRE-fix precedence (metadata trusted
    // over filename) — if that differs, any profile/preset/bench-result a user saved before the
    // fix landed is sitting under the old key and needs to move. See `migrateModelKey`.
    const legacyQuant = meta?.quant || quantFromName(fileName)
    const legacyKey = `${name.toLowerCase()}|${legacyQuant}|${sizeBytes}`
    // Queued, not applied here: this runs once per file on EVERY scan (a rescan can fire on every
    // file-watch tick), and `ConfigStore.update` clones + validates + writes the whole config to
    // disk. Batching every candidate from this scan into one `update()` call in `rescan()` keeps
    // that cost to once per scan instead of once per affected model — `migrateModelKey` itself is
    // a cheap no-op once there is nothing left under `legacyKey` to move.
    if (legacyKey !== key) this.pendingKeyMigrations.push([legacyKey, key])

    return {
      key,
      name,
      path,
      dir,
      format: 'gguf',
      sizeBytes,
      sizeLabel: meta?.sizeLabel ?? '',
      arch,
      quant,
      nativeCtx: meta?.nativeCtx ?? 0,
      blockCount: meta?.blockCount ?? 0,
      headCountKv: meta?.headCountKv ?? 0,
      headDim: meta?.headDim ?? 0,
      // Only present on the handful of models that declare a non-uniform attention
      // layout; everything else keeps the shape (and the KV estimate) it had before.
      ...attentionLayoutOf(meta),
      moe: (meta?.expertCount ?? 0) > 0,
      expertCount: meta?.expertCount ?? 0,
      nextnLayers: meta?.nextnLayers ?? 0,
      vision,
      audio: false,
      mmprojPath: vision ? mmprojPath : null,
      mmprojSizeBytes: vision ? mmprojSizeBytes : 0,
      hasChatTemplate: meta?.hasChatTemplate ?? false,
      reasoningEffort: meta?.reasoningEffort ?? false,
      embedding: isEmbeddingModel(arch, fileName),
      incomplete,
      parseError,
      loaded: false, // overlaid live by the API layer
      hasProfile: false, // overlaid live by the API layer
      benchTps: null,
      mtime: new Date(mtimeMs).toISOString(),
    }
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        version?: number
        entries?: Record<string, CacheRow>
      }
      // Bump CACHE_VERSION whenever GgufMeta gains a field, so stale rows (missing
      // the new field) are discarded and re-parsed instead of read back as defaults.
      if (raw.version !== CACHE_VERSION) return
      for (const [k, v] of Object.entries(raw.entries ?? {})) this.cache.set(k, v)
    } catch {
      /* no cache yet */
    }
  }

  private saveCache(): void {
    const entries: Record<string, CacheRow> = {}
    for (const [k, v] of this.cache) entries[k] = v
    try {
      writeFileSync(this.cachePath, JSON.stringify({ version: CACHE_VERSION, entries }))
    } catch {
      /* cache is a pure accelerator */
    }
  }
}

interface FileInfo {
  path: string
  size: number
  mtime: number
}

interface ScanResult {
  ggufs: FileInfo[]
  mlxDirs: string[]
}

/** A directory holds an MLX/HF model when it has config.json + safetensors weights
 *  + a tokenizer. mlx-lm loads such a directory directly (spec 03 §2b, 04). */
function isMlxModelDir(names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase())
  const hasConfig = lower.includes('config.json')
  const hasWeights = lower.some((n) => n.endsWith('.safetensors'))
  const hasTokenizer =
    lower.includes('tokenizer.json') ||
    lower.includes('tokenizer.model') ||
    lower.includes('tokenizer_config.json')
  return hasConfig && hasWeights && hasTokenizer
}

function walk(dir: string, out: ScanResult): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // permission / gone
  }
  // An MLX model is a whole directory — record it and don't descend (the shards
  // and tokenizer live inside).
  if (isMlxModelDir(names)) {
    out.mlxDirs.push(dir)
    return
  }
  for (const name of names) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(dir, name)
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue // avoid cycles
    if (st.isDirectory()) walk(full, out)
    else if (st.isFile() && name.toLowerCase().endsWith('.gguf') && st.size >= 1 << 20) {
      out.ggufs.push({ path: full, size: st.size, mtime: st.mtimeMs })
    }
  }
}

interface MlxConfig {
  model_type?: string
  architectures?: string[]
  max_position_embeddings?: number
  num_hidden_layers?: number
  num_key_value_heads?: number
  /** Real per-head dimension, when the config declares it explicitly (GQA/MQA models
   *  with a decoupled head size). Absent → callers fall back to a conservative constant. */
  head_dim?: number
  num_local_experts?: number
  num_experts?: number
  /** MLX-style on-disk quantization (mlx-lm convert). */
  quantization?: { bits?: number; group_size?: number }
  /** HF/vLLM post-training quantization (compressed-tensors, awq, gptq, fp8…). */
  quantization_config?: {
    quant_method?: string
    bits?: number
    config_groups?: Record<string, { weights?: { num_bits?: number }; input_activations?: { num_bits?: number } | null }>
  }
  /** Multimodal models (gemma4_unified, llava, qwen-vl…) nest the language-model
   *  fields under `text_config`; read ctx/layers/heads from there when absent up top. */
  text_config?: Omit<MlxConfig, 'text_config'>
  /** Presence (not contents) is the only thing read — an image/vision tower exists. */
  vision_config?: unknown
  /** Presence (not contents) is the only thing read — an audio tower/encoder exists
   *  (e.g. gemma4's Conformer audio module). */
  audio_config?: unknown
}

/** Human quant label for a safetensors model dir. Recognizes HF/vLLM post-training
 *  quant (compressed-tensors → e.g. "w4a16", awq/gptq → "awq-4bit") and MLX-style
 *  quant ("4bit"); falls back to "fp16" for an unquantized checkpoint. Keeps the label
 *  engine-neutral — a safetensors dir loads on either MLX or vLLM (compat.ts). */
function detectSafetensorsQuant(cfg: MlxConfig): string {
  const qc = cfg.quantization_config
  if (qc?.quant_method) {
    const method = qc.quant_method.toLowerCase()
    const group0 = qc.config_groups ? Object.values(qc.config_groups)[0] : undefined
    const wBits = group0?.weights?.num_bits ?? qc.bits
    if (method === 'compressed-tensors') {
      if (wBits) {
        const aBits = group0?.input_activations?.num_bits ?? 16
        return `w${wBits}a${aBits}`
      }
      return 'compressed-tensors'
    }
    return wBits ? `${method}-${wBits}bit` : method
  }
  const mlxBits = cfg.quantization?.bits
  return mlxBits ? `${mlxBits}bit` : 'fp16'
}

/** Build a ModelEntry for an MLX model directory by reading its config.json. */
export function mlxEntryFor(dir: string): ModelEntry {
  let cfg: MlxConfig = {}
  let parseError: string | null = null
  try {
    // Strip a leading UTF-8 BOM if present — JSON.parse rejects it.
    const raw = readFileSync(join(dir, 'config.json'), 'utf8').replace(/^﻿/, '')
    cfg = JSON.parse(raw) as MlxConfig
  } catch (e) {
    parseError = `Could not read config.json: ${(e as Error).message}`
  }

  let sizeBytes = 0
  let mtimeMs = 0
  let hasChatTemplate = false
  let reasoningEffort = false
  try {
    for (const n of readdirSync(dir)) {
      const lower = n.toLowerCase()
      if (lower.endsWith('.safetensors')) {
        const st = lstatSync(join(dir, n))
        sizeBytes += st.size
        mtimeMs = Math.max(mtimeMs, st.mtimeMs)
      }
    }
    const tc = join(dir, 'tokenizer_config.json')
    const tcText = existsSync(tc) ? readFileSync(tc, 'utf8') : ''
    // Modern HF repos ship the chat template as a standalone `chat_template.jinja` file
    // (mlx-lm/transformers both read it) rather than embedded in tokenizer_config.json —
    // either location counts.
    const jinjaPath = join(dir, 'chat_template.jinja')
    const jinjaText = existsSync(jinjaPath) ? readFileSync(jinjaPath, 'utf8') : ''
    hasChatTemplate = tcText.includes('chat_template') || jinjaText !== ''
    // Same per-file substring check as the GGUF path (GgufMeta.reasoningEffort) — never
    // inferred from arch/model_type, since sibling models of the same family routinely
    // don't carry this template branch.
    reasoningEffort = tcText.includes('reasoning_effort') || jinjaText.includes('reasoning_effort')
  } catch {
    /* best effort */
  }

  let incomplete = false
  try {
    const indexPath = join(dir, 'model.safetensors.index.json')
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { weight_map?: Record<string, string> }
      const shards = new Set(Object.values(index.weight_map ?? {}))
      for (const shard of shards) {
        if (!existsSync(join(dir, shard))) {
          incomplete = true
          break
        }
      }
    }
  } catch { /* best effort */ }

  // Multimodal configs nest the LM fields under text_config; fall back to it so
  // ctx/layers/heads aren't reported as 0 (which would, e.g., lock the vLLM
  // --max-model-len control to a [0,0] range in the UI).
  const lm = cfg.text_config ?? {}
  const expertCount = cfg.num_local_experts ?? cfg.num_experts ?? lm.num_local_experts ?? lm.num_experts ?? 0
  const quant = detectSafetensorsQuant(cfg)
  const arch = cfg.model_type || cfg.architectures?.[0] || lm.model_type || 'unknown'
  const name = basename(dir).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()

  return {
    key: `${name.toLowerCase()}|mlx-${quant}|${sizeBytes}`,
    name,
    path: dir,
    dir,
    format: 'mlx',
    sizeBytes,
    sizeLabel: '',
    arch,
    quant,
    nativeCtx: cfg.max_position_embeddings ?? lm.max_position_embeddings ?? 0,
    blockCount: cfg.num_hidden_layers ?? lm.num_hidden_layers ?? 0,
    headCountKv: cfg.num_key_value_heads ?? lm.num_key_value_heads ?? 0,
    headDim: cfg.head_dim ?? lm.head_dim ?? 0,
    moe: expertCount > 0,
    expertCount,
    nextnLayers: 0,
    vision: cfg.vision_config != null,
    audio: cfg.audio_config != null,
    mmprojPath: null,
    mmprojSizeBytes: 0,
    hasChatTemplate,
    reasoningEffort,
    embedding: isEmbeddingModel(arch, basename(dir)),
    incomplete,
    parseError,
    loaded: false,
    hasProfile: false,
    benchTps: null,
    mtime: new Date(mtimeMs || Date.now()).toISOString(),
  }
}

function cleanName(fileName: string): string {
  return fileName
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}
