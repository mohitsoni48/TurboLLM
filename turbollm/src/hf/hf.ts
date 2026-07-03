// Hugging Face discovery client (spec 10 §1–4). Client↔HF direct (ADR-011): the
// daemon calls HF with the user's token; nothing routes through our infra. All
// GET responses are cached in-memory for 5 minutes (key = full URL) for graceful
// degradation. Network/auth failures surface as a typed HfError so routes can map
// them to a stable error envelope.
import { quantFromName } from '../gguf/gguf'

const BASE = 'https://huggingface.co'
const CACHE_TTL_MS = 5 * 60 * 1000
/** Cap for the model card when read for sampling extraction (ADR-099). Much larger than the
 *  12k display cap because big model cards put their recommended-settings section deep in the
 *  card — e.g. Qwen3.5 cards run ~80–95k chars with the "recommended sampling parameters" block
 *  near char 64–80k. 120k keeps those in-window for the text scan while staying a bounded slice. */
const CARD_EXTRACT_MAX = 120000

/** Carries a machine-checkable `code` for the API error envelope. */
export class HfError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HfError'
  }
}

/** A search result row (spec 10 §2). `localCount` is overlaid by the route layer
 *  from the scan cache — the client itself has no view of the local library. */
export interface HfSearchItem {
  repo: string
  downloads: number
  likes: number
  updatedAt: string
  gated: boolean
  tags: string[]
}

/** Sort options for both search and browse (spec 10 §7 rewrite). 'best-match' is HF's
 *  own relevance ranking for a text query — it's a DISTINCT ordering from `sort=downloads`
 *  (verified against the live API), not just "no sort specified" as a synonym for one of
 *  the others. Browsing with no query has no notion of relevance, so it falls back to
 *  'trending' there (see {@link HfClient.browseModels}). */
export type HfSortOption = 'best-match' | 'trending' | 'downloads' | 'likes' | 'modified' | 'created'

const SORT_PARAM: Record<Exclude<HfSortOption, 'best-match'>, string> = {
  trending: 'trendingScore',
  downloads: 'downloads',
  likes: 'likes',
  modified: 'lastModified',
  created: 'createdAt',
}

/** The HF `library` facet to filter by, adapted to the active engine kind (spec 10 §2/§7)
 *  — NEVER hardcoded to GGUF, since the format that actually runs depends on the engine:
 *  - llama-server / koboldcpp / llamafile / TurboQuant (all llama.cpp-family) → gguf
 *  - mlx                                                                      → mlx (HF library tag)
 *  - vllm / anything else                                                     → no filter (all HF repos)
 *  Shared by `searchModels` and `browseModels` so the two never drift apart. */
function libraryFilterFor(engineKind?: string): string {
  if (engineKind === 'mlx') return 'filter=mlx&'
  if (engineKind === 'vllm') return ''
  return 'filter=gguf&'
}

function toSearchItem(m: RawSearchItem): HfSearchItem {
  return {
    repo: m.id ?? m.modelId ?? '',
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    updatedAt: m.lastModified ?? m.createdAt ?? '',
    gated: m.gated === true || m.gated === 'auto' || m.gated === 'manual',
    tags: Array.isArray(m.tags) ? m.tags : [],
  }
}

/** One logical file in a repo (spec 10 §3). For GGUF: split parts are grouped into
 *  a single entry with summed size and `parts` > 1. For safetensors repos (MLX /
 *  vLLM): each component file (safetensors + JSON) is its own entry with
 *  `safetensors: true`. */
export interface HfRepoFile {
  name: string
  quant: string
  sizeBytes: number
  parts: number
  mmproj: boolean
  /** True for safetensors component files (MLX and vLLM repos). */
  safetensors?: boolean
  /** HF LFS sha256 when published in the tree metadata; used for integrity. */
  sha256?: string
  /** Download URL for the first/only part (resolve/main). */
  url: string
}

export interface HfRepoDetail {
  repo: string
  gated: boolean
  license: string
  downloads: number
  likes: number
  card: string
  files: HfRepoFile[]
  /** True when the repo is a safetensors model (no GGUFs — covers MLX and vLLM). */
  safetensors?: boolean
}

/** One concrete file to fetch for a working GGUF model (spec 10 §3): a shard of a
 *  split group, or a shared mmproj projector. Repo-relative `rfilename` (the download
 *  manager builds the resolve URL). */
export interface HfDownloadFile {
  rfilename: string
  size: number
  sha256?: string
  /** True for the vision projector companion (mmproj-*.gguf). */
  mmproj: boolean
}

/** The result of expanding a chosen GGUF: the repo-relative directory the model lives
 *  in (`''` = repo root) and every file to fetch. All files are placed together under
 *  `<modelDir>/<owner>/<repo>/<dir>/` so the scanner groups a model's shards + mmproj. */
export interface HfModelFiles {
  dir: string
  files: HfDownloadFile[]
}

interface CacheRow {
  at: number
  value: unknown
}

const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

export class HfClient {
  private cache = new Map<string, CacheRow>()

  constructor(
    private tokenFn: () => string,
    private version: string,
  ) {}

  /** Search repos by text (spec 10 §2). Returns up to 30 rows. `sort` defaults to HF's own
   *  relevance ranking ('best-match' — omits `sort=` entirely, a genuinely different order
   *  from `sort=downloads`, not just an alias for it). Format filter adapts to the active
   *  engine kind (never hardcoded to GGUF) — see {@link libraryFilterFor}. */
  async searchModels(query: string, engineKind?: string, sort: HfSortOption = 'best-match'): Promise<HfSearchItem[]> {
    const q = query.trim()
    const sortParam = sort === 'best-match' ? '' : `sort=${SORT_PARAM[sort]}&direction=-1&`
    const url =
      `${BASE}/api/models?search=${encodeURIComponent(q)}&` +
      `${libraryFilterFor(engineKind)}${sortParam}limit=30&full=false`
    const raw = await this.getJson<RawSearchItem[]>(url)
    return raw.map(toSearchItem)
  }

  /** Browse repos with no search term (spec 10 §7 rewrite) — the live equivalent of
   *  https://huggingface.co/models?library=gguf&sort=trending, replacing what used to be a
   *  hardcoded "Featured" list. 'best-match' has no meaning without a query, so it falls
   *  back to 'trending'. Format filter adapts to the active engine kind, same as search. */
  async browseModels(sort: HfSortOption, engineKind?: string, limit = 30): Promise<HfSearchItem[]> {
    const effective = sort === 'best-match' ? 'trending' : sort
    const url =
      `${BASE}/api/models?${libraryFilterFor(engineKind)}` +
      `sort=${SORT_PARAM[effective]}&direction=-1&limit=${limit}&full=false`
    const raw = await this.getJson<RawSearchItem[]>(url)
    return raw.map(toSearchItem)
  }

  /** Repo detail (spec 10 §3): card data + the GGUF file tree, with split parts
   *  grouped and quant/mmproj detected per file. */
  async getRepo(repo: string): Promise<HfRepoDetail> {
    const info = await this.getJson<RawRepoInfo>(`${BASE}/api/models/${repo}`)
    const tree = await this.getJson<RawTreeEntry[]>(`${BASE}/api/models/${repo}/tree/main?recursive=true`)

    const ggufEntries = tree.filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path))
    const safetensorsEntries = tree.filter((e) => e.type === 'file' && /\.safetensors$/i.test(e.path))

    // Safetensors repo (MLX or vLLM): has safetensors weights but no GGUFs.
    const isSafetensors = ggufEntries.length === 0 && safetensorsEntries.length > 0

    let files: HfRepoFile[]
    let safetensors: boolean | undefined
    if (isSafetensors) {
      safetensors = true
      // Collect all component files: safetensors weights + JSON config/tokenizer files.
      const components = tree.filter(
        (e) =>
          e.type === 'file' &&
          (/\.safetensors$/i.test(e.path) || /\.json$/i.test(e.path)) &&
          !e.path.includes('/'), // root-level only — no nested model card assets
      )
      files = components.map((e) => ({
        name: e.path,
        quant: 'mlx',
        sizeBytes: e.lfs?.size ?? e.size ?? 0,
        parts: 1,
        mmproj: false,
        safetensors: true,
        sha256: e.lfs?.oid,
        url: this.fileUrl(repo, e.path),
      }))
    } else {
      files = groupFiles(repo, ggufEntries)
    }

    const gated = info.gated === true || info.gated === 'auto' || info.gated === 'manual'
    const license =
      info.cardData?.license ??
      (info.tags?.find((t) => t.startsWith('license:'))?.slice('license:'.length) || '')

    return {
      repo,
      gated,
      license: typeof license === 'string' ? license : '',
      downloads: info.downloads ?? 0,
      likes: info.likes ?? 0,
      card: await this.getCard(repo),
      files,
      ...(safetensors ? { safetensors } : {}),
    }
  }

  /** Expand a chosen GGUF into every concrete file needed for a working model
   *  (spec 10 §3): all shards of its split group (NNNNN-of-NNNNN) plus its mmproj vision
   *  projector. Matching is scoped to the chosen file's OWN repo directory so a repo
   *  that organises quants in per-quant subfolders (e.g. `Q4_K_M/…`, `Q8_0/…`) never
   *  cross-matches another quant's identically-named shards. The mmproj is preferred
   *  from the same directory (mirrors the scanner's per-directory pairing), falling back
   *  to the largest anywhere in the repo. `rev` is the git revision (branch/tag/commit)
   *  the download targets. Best-effort: on any HF failure it returns just the one
   *  requested file. When the requested file is itself an mmproj, none is paired. */
  async expandModelFiles(repo: string, rfilename: string, rev = 'main'): Promise<HfModelFiles> {
    const wantBase = base(rfilename).toLowerCase()
    let tree: RawTreeEntry[]
    try {
      tree = await this.getJson<RawTreeEntry[]>(`${BASE}/api/models/${repo}/tree/${encodeURIComponent(rev)}?recursive=true`)
    } catch {
      return { dir: dirOf(rfilename), files: [{ rfilename, size: 0, mmproj: wantBase.includes('mmproj') }] }
    }
    const ggufs = tree.filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path))

    // Locate the chosen file by basename (the UI carries a split group's first-shard
    // basename; the tree recovers its full repo path + siblings).
    const chosen = ggufs.find((e) => base(e.path).toLowerCase() === wantBase)
    if (!chosen) {
      // Requested file not in the tree — fall back to the name as given.
      return { dir: dirOf(rfilename), files: [{ rfilename, size: 0, mmproj: wantBase.includes('mmproj') }] }
    }

    const modelDir = dirOf(chosen.path)
    const inModelDir = (e: RawTreeEntry) => dirOf(e.path) === modelDir
    const files: HfDownloadFile[] = []

    const split = base(chosen.path).match(SPLIT_RE)
    if (split) {
      const prefix = split[1].toLowerCase()
      const total = split[3]
      for (const e of ggufs) {
        if (!inModelDir(e)) continue
        const sm = base(e.path).match(SPLIT_RE)
        if (sm && sm[1].toLowerCase() === prefix && sm[3] === total) {
          files.push({ rfilename: e.path, size: sizeOf(e), sha256: e.lfs?.oid, mmproj: false })
        }
      }
      files.sort((a, b) => a.rfilename.localeCompare(b.rfilename))
    } else {
      files.push({ rfilename: chosen.path, size: sizeOf(chosen), sha256: chosen.lfs?.oid, mmproj: false })
    }

    // Pair an mmproj projector with an actual model download (not with another mmproj):
    // prefer one in the model's own directory, else the largest anywhere in the repo.
    if (!wantBase.includes('mmproj')) {
      const projectors = ggufs.filter((e) => base(e.path).toLowerCase().includes('mmproj'))
      const sameDir = projectors.filter(inModelDir)
      const best = (sameDir.length ? sameDir : projectors).sort((a, b) => sizeOf(b) - sizeOf(a))[0]
      if (best) files.push({ rfilename: best.path, size: sizeOf(best), sha256: best.lfs?.oid, mmproj: true })
    }
    return { dir: modelDir, files }
  }

  /** Public model-card fetch (ADR-099): the cleaned README for `owner/repo`, or '' when
   *  missing/unreachable. Used by auto-tune to read recommended sampling from the card.
   *  Uses a LARGER cap than the display path: popular requanters (e.g. unsloth) put their
   *  recommended-settings section in the BACK HALF of a long card, past the 12k display cap —
   *  the extra window is what lets the heuristic actually find them (live-verified). */
  fetchModelCard(repo: string): Promise<string> {
    return this.getCard(repo, CARD_EXTRACT_MAX)
  }

  /** Fetch a repo's structured generation-params sidecar, if it has one — some quantizers
   *  (e.g. unsloth) publish a root-level `params` JSON file with the exact recommended
   *  sampling values (`{"temperature":1.0,"top_k":0,"top_p":1.0,"min_p":0.0,"stop":[…]}`)
   *  alongside the GGUF shards. When present this is a strictly better signal than the
   *  README heuristic/LLM extraction (exact values, no parsing/inference needed) — auto-tune
   *  tries it first. Tries `params` then the more standard `generation_config.json` name.
   *  Best-effort: '' when neither exists or the repo is unreachable, never throws. */
  async fetchGenerationParams(repo: string): Promise<string> {
    for (const name of ['params', 'generation_config.json']) {
      const url = `${BASE}/${repo}/raw/main/${name}`
      const now = Date.now()
      const hit = this.cache.get(url)
      if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as string
      try {
        const res = await fetch(url, { headers: this.authHeaders(), redirect: 'follow' })
        if (!res.ok) continue
        const raw = await res.text()
        this.cache.set(url, { at: now, value: raw })
        return raw
      } catch {
        continue
      }
    }
    return ''
  }

  /** Resolve the upstream base model for a repo (ADR-099 base-model fallback): the `base_model`
   *  declared in the repo's HF card metadata. Most local GGUFs are third-party requants
   *  (lmstudio-community / unsloth / noctrex / …) whose card omits the author's recommended
   *  sampling — but they name the ORIGINAL model, whose card has it. Returns `owner/name`, or null
   *  when none is declared / unreachable. Handles the array form and the `base_model:[relation:]repo`
   *  tag form. Cached via {@link getJson}. */
  async baseModelOf(repo: string): Promise<string | null> {
    try {
      const info = await this.getJson<RawRepoInfo>(`${BASE}/api/models/${repo}`)
      const bm = info.cardData?.base_model
      const first = Array.isArray(bm) ? bm[0] : bm
      if (typeof first === 'string' && first.includes('/')) return first
      const tag = (info.tags ?? []).find((t) => t.startsWith('base_model:'))
      // Tag forms: `base_model:owner/repo` or newer `base_model:<relation>:owner/repo`.
      const fromTag = tag ? tag.split(':').pop() ?? '' : ''
      return fromTag.includes('/') ? fromTag : null
    } catch {
      return null
    }
  }

  /** Fetch the repo README (the model card), strip its YAML frontmatter, and cap the
   *  length. Best-effort — a missing/unreachable README yields '' rather than failing the
   *  whole repo-detail request. The full (up to {@link CARD_EXTRACT_MAX}) card is cached and
   *  each caller slices to its own `maxLen` (display 12k; extraction larger), so the two
   *  paths share one fetch without the cache returning a too-short slice. */
  private async getCard(repo: string, maxLen = 12000): Promise<string> {
    const url = `${BASE}/${repo}/raw/main/README.md`
    const now = Date.now()
    const hit = this.cache.get(url)
    if (hit && now - hit.at < CACHE_TTL_MS) return (hit.value as string).slice(0, maxLen)
    try {
      const res = await fetch(url, { headers: this.authHeaders(), redirect: 'follow' })
      if (!res.ok) return ''
      const raw = await res.text()
      // Strip a leading `---\n…\n---` YAML frontmatter block, then cap (cache the full window).
      const full = raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim().slice(0, CARD_EXTRACT_MAX)
      this.cache.set(url, { at: now, value: full })
      return full.slice(0, maxLen)
    } catch {
      return ''
    }
  }

  /** Validate a token against HF whoami (spec 10 §4). Never throws on a bad token —
   *  returns { ok:false } so the Settings "Test" button can show a clean failure. */
  async testToken(token: string): Promise<{ ok: boolean; name?: string }> {
    const t = token.trim()
    if (!t) return { ok: false }
    let res: Response
    try {
      res = await fetch(`${BASE}/api/whoami-v2`, {
        headers: { Authorization: `Bearer ${t}`, 'User-Agent': `TurboLLM/${this.version}` },
      })
    } catch {
      throw new HfError('hf_unreachable', 'Hugging Face is unreachable — check your connection.')
    }
    if (!res.ok) return { ok: false }
    const who = (await res.json().catch(() => ({}))) as { name?: string; fullname?: string }
    return { ok: true, name: who.name ?? who.fullname }
  }

  /** Build the resolve URL for a repo file (spec 10 §1). */
  fileUrl(repo: string, rfilename: string): string {
    return `${BASE}/${repo}/resolve/main/${rfilename}`
  }

  /** Authorization header when a token is configured (for gated repos). */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': `TurboLLM/${this.version}` }
    const t = this.tokenFn().trim()
    if (t) headers.Authorization = `Bearer ${t}`
    return headers
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async getJson<T>(url: string): Promise<T> {
    const now = Date.now()
    const hit = this.cache.get(url)
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as T

    let res: Response
    try {
      res = await fetch(url, { headers: this.authHeaders(), redirect: 'follow' })
    } catch {
      // Graceful degradation: serve a stale cache entry if we have one.
      if (hit) return hit.value as T
      throw new HfError('hf_unreachable', 'Hugging Face is unreachable — check your connection.')
    }
    if (res.status === 403) {
      throw new HfError('hf_gated', 'This repository is gated — accept its license on huggingface.co and add your token.')
    }
    if (res.status === 401) {
      // HF returns 401 for a private OR non-existent repo when no token is sent.
      // Only a configured-but-rejected token is a real auth failure; otherwise this
      // is effectively "not found" (commonly a model folder name that doesn't match
      // its actual HF repo id).
      if (this.tokenFn().trim()) throw new HfError('hf_unauthorized', 'Your Hugging Face token was rejected.')
      throw new HfError('hf_not_found', 'Not found on Hugging Face — it may be private, or the name may not match its repo.')
    }
    if (res.status === 404) {
      throw new HfError('hf_not_found', 'This model was not found on Hugging Face.')
    }
    if (!res.ok) {
      // 5xx / 429 / anything else: a transient server-side problem, not "your repo".
      if (hit) return hit.value as T
      throw new HfError('hf_unreachable', `Hugging Face request failed (HTTP ${res.status}).`)
    }
    const value = (await res.json()) as T
    this.cache.set(url, { at: now, value })
    return value
  }
}

// ── tree → logical files ───────────────────────────────────────────────────

interface RawSearchItem {
  id?: string
  modelId?: string
  downloads?: number
  likes?: number
  lastModified?: string
  createdAt?: string
  gated?: boolean | string
  tags?: string[]
}

interface RawRepoInfo {
  downloads?: number
  likes?: number
  gated?: boolean | string
  tags?: string[]
  cardData?: { license?: string; base_model?: string | string[] }
}

interface RawTreeEntry {
  type?: string
  path: string
  size?: number
  lfs?: { oid?: string; size?: number }
}

/** Group raw GGUF tree entries into logical files: split parts (NNNNN-of-NNNNN)
 *  collapse into one entry with summed size and parts>1; everything else is a
 *  single-part file. mmproj projectors are flagged separately (spec 10 §3). */
function groupFiles(repo: string, entries: RawTreeEntry[]): HfRepoFile[] {
  const splits = new Map<string, { parts: RawTreeEntry[]; total: number }>()
  const singles: RawTreeEntry[] = []
  for (const e of entries) {
    const m = base(e.path).match(SPLIT_RE)
    if (m) {
      const gkey = `${m[1]}|${m[3]}`
      const g = splits.get(gkey) ?? { parts: [], total: Number(m[3]) }
      g.parts.push(e)
      splits.set(gkey, g)
    } else {
      singles.push(e)
    }
  }

  const out: HfRepoFile[] = []
  for (const e of singles) out.push(fileFor(repo, e, base(e.path), 1))
  for (const { parts, total } of splits.values()) {
    parts.sort((a, b) => a.path.localeCompare(b.path))
    const first = parts[0]
    const size = parts.reduce((s, p) => s + sizeOf(p), 0)
    out.push(fileFor(repo, first, base(first.path), total, size))
  }
  // Recommended-first ordering is the UI's job; keep a stable name sort here.
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function fileFor(
  repo: string,
  e: RawTreeEntry,
  name: string,
  parts: number,
  sizeOverride?: number,
): HfRepoFile {
  const mmproj = name.toLowerCase().includes('mmproj')
  return {
    name,
    quant: mmproj ? 'mmproj' : quantFromName(name),
    sizeBytes: sizeOverride ?? sizeOf(e),
    parts,
    mmproj,
    sha256: e.lfs?.oid,
    url: `${BASE}/${repo}/resolve/main/${e.path}`,
  }
}

function sizeOf(e: RawTreeEntry): number {
  return e.lfs?.size ?? e.size ?? 0
}

function base(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

/** Repo-relative directory of a path (POSIX '/' — HF tree paths are always '/'-joined);
 *  '' for a root-level file. */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}
