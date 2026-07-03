// Model discovery (A3, spec 04): scan model directories for GGUFs, parse their
// headers, group split/mmproj files, and expose a rich model list. Path-cached.
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConfigStore } from '../config/config'
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
  moe: boolean
  expertCount: number
  nextnLayers: number
  vision: boolean
  mmprojPath: string | null
  hasChatTemplate: boolean
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

// Bump when GgufMeta gains a field so on-disk caches re-parse (see loadCache).
const CACHE_VERSION = 2

const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

// GGUF architectures that are always embedding models.
const EMBED_ARCHS = new Set([
  'bert', 'nomic-bert', 'jina-bert-v3-base', 'jina-bert',
  'distilbert', 'roberta', 'xlm-roberta', 'electra',
])
// Filename patterns common for embedding / reranker models.
const EMBED_FILE_RE = /\b(bge[-_]|nomic[-_]embed|all[-_]minilm|e5[-_]|gte[-_]|stella[-_]embed|jina[-_]embed|mxbai[-_]embed)\b/i

function isEmbeddingModel(arch: string, name: string): boolean {
  return EMBED_ARCHS.has(arch.toLowerCase()) || EMBED_FILE_RE.test(name)
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
      const gguf = await this.build(scan.ggufs)
      const mlx = scan.mlxDirs.map((dir) => mlxEntryFor(dir))
      this.entries = [...gguf, ...mlx].sort((a, b) => a.name.localeCompare(b.name))
      this.lastScanAt = new Date().toISOString()
      this.saveCache()
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
      const mmprojPath = mmprojFiles.sort((a, b) => b.size - a.size)[0]?.path ?? null

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
        entries.push(await this.entryFor(f.path, f.size, f.mtime, dir, mmprojPath, false))
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
        entries.push(await this.entryFor(first.path, totalSize, first.mtime, dir, mmprojPath, incomplete))
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
    const quant = meta?.quant || quantFromName(fileName)
    const name = meta?.name || cleanName(fileName)
    const vision = mmprojPath !== null
    const arch = meta?.arch ?? 'unknown'

    return {
      key: `${name.toLowerCase()}|${quant}|${sizeBytes}`,
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
      moe: (meta?.expertCount ?? 0) > 0,
      expertCount: meta?.expertCount ?? 0,
      nextnLayers: meta?.nextnLayers ?? 0,
      vision,
      mmprojPath: vision ? mmprojPath : null,
      hasChatTemplate: meta?.hasChatTemplate ?? false,
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
    if (existsSync(tc)) hasChatTemplate = readFileSync(tc, 'utf8').includes('chat_template')
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
    moe: expertCount > 0,
    expertCount,
    nextnLayers: 0,
    vision: false,
    mmprojPath: null,
    hasChatTemplate,
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
