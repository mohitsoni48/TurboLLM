// Download manager (spec 10 §5–6, §8). Streams GGUF files from Hugging Face or an
// arbitrary HTTP(S) URL into the effective primaryModelDir, with single-connection
// resume (.part + Range), max 2 concurrent, disk-space pre-check, manifest
// persistence across daemon restarts, and a scan trigger on completion. Fail-safe:
// a failed job sets status='error' with a message and never crashes the daemon.
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ConfigStore } from '../config/config'
import type { HfModelFiles } from '../hf/hf'

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

export interface DownloadRecord {
  id: string
  /** Display name = the destination filename. */
  name: string
  /** Source HF repo ("owner/name"), or '' for a raw-URL import. */
  repo: string
  url: string
  dest: string
  total: number
  received: number
  status: DownloadStatus
  error: string | null
  /** Best-effort instantaneous bytes/sec, updated while downloading. */
  bytesPerSec: number
  /** HF LFS sha256 to verify against when known (spec 10 §5). */
  sha256?: string
  createdAt: string
}

/** Persisted manifest shape (spec 10 §5). Live runtime fields (controller, timers)
 *  are not persisted — restored jobs come back as 'paused'. */
interface ManifestEntry {
  id: string
  name: string
  repo: string
  url: string
  dest: string
  total: number
  sha256?: string
  createdAt: string
}

/** Download provenance: a record of which HF repo + file a local model came from,
 *  kept permanently (the manifest drops completed jobs). Lets the Discover UI mark a
 *  quant "Downloaded" only for the SPECIFIC repo it was pulled from — the identical
 *  model+quant from a different repo (a different requant, different sha256) is
 *  correctly shown as not-downloaded. Keyed primarily by sha256 (exact file
 *  identity), with (repo, filename) as the fallback when no hash is known. */
export interface ProvenanceEntry {
  repo: string
  filename: string
  sha256?: string
  dest: string
  at: string
}

const MAX_CONCURRENT = 2

export interface EnqueueInput {
  repo?: string
  rfilename?: string
  url?: string
  size?: number
  sha256?: string
  /** Subdirectory under the primary model dir for the downloaded file. Used for
   *  MLX models whose component files must all land in the same directory. */
  subdir?: string
}

export class DownloadError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

export class DownloadManager {
  private records = new Map<string, DownloadRecord>()
  private controllers = new Map<string, AbortController>()
  private manifestPath: string
  private provenancePath: string
  private provenanceList: ProvenanceEntry[] = []
  private nextSeq = 0

  /** Optional observer for a download's terminal outcome, wired in cli.ts to
   *  the `model_downloaded` event (spec 23 §4 — promoted out of
   *  `onboarding_step: model_download`). Separate from `onComplete`, which
   *  fires only on success and exists to trigger a rescan — reusing it would
   *  have made a failed download indistinguishable from one that never
   *  started. The error string is deliberately not passed: the only consumer
   *  may never send text. */
  onSettled?: (outcome: 'ok' | 'fail' | 'cancelled') => void

  private settle(outcome: 'ok' | 'fail' | 'cancelled'): void {
    try {
      this.onSettled?.(outcome)
    } catch {
      // Observers are advisory — they must not affect a download.
    }
  }

  constructor(
    private store: ConfigStore,
    /** Called after a download completes so the model list picks up the new file. */
    private onComplete: () => void,
    private authHeaders: () => Record<string, string>,
    /** Expand a chosen HF GGUF into every concrete file to fetch — all split shards +
     *  the shared mmproj projector, plus the model's repo-relative directory (spec 10 §3).
     *  Injected from the HfClient so the download layer stays decoupled from HF discovery.
     *  Absent under tests that don't exercise repo downloads → those take the single-file
     *  path instead. */
    private expand?: (repo: string, rfilename: string, rev?: string) => Promise<HfModelFiles>,
  ) {
    const dir = join(store.dir(), 'downloads')
    mkdirSync(dir, { recursive: true })
    this.manifestPath = join(dir, 'manifest.json')
    this.provenancePath = join(dir, 'provenance.json')
    this.restore()
    this.loadProvenance()
  }

  /** Permanent record of which repo+file each downloaded model came from (spec 10 §3).
   *  Consumed by the repo-detail route to mark a quant "Downloaded" for the exact repo
   *  it was pulled from. */
  provenance(): ProvenanceEntry[] {
    return [...this.provenanceList]
  }

  /** Active (downloading) job count — surfaced on GET /status. */
  activeCount(): number {
    let n = 0
    for (const r of this.records.values()) if (r.status === 'downloading') n++
    return n
  }

  list(): DownloadRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Enqueue a download. Validates the target + disk space, persists, then kicks the
   *  queue. Returns every record created — a single file for a raw non-HF URL, or the
   *  whole model (all split shards + the shared mmproj) for an HF repo file. Throws
   *  DownloadError for caller-actionable failures (no dir set, bad URL, insufficient
   *  disk). */
  async enqueue(input: EnqueueInput): Promise<DownloadRecord[]> {
    const dir = this.primaryDir()
    if (!dir) throw new DownloadError('no_model_dir', 'Add a model folder in Settings before downloading.')

    let repo = (input.repo ?? '').trim()
    const explicitSubdir = (input.subdir ?? '').trim()
    let rfilename = (input.rfilename ?? '').trim()
    let rev = 'main'

    if (input.url) {
      const u = normalizeHfBlobUrl(input.url.trim())
      if (!/^https?:\/\//i.test(u)) throw new DownloadError('invalid_url', 'URL must start with http:// or https://.')
      // An HF resolve URL carries a repo + revision + file path — recover them so the
      // import gets the same subfolder + split-shard + mmproj handling as a Discover
      // download, and targets the exact revision the user linked (not always `main`).
      const hf = parseHfResolveUrl(u)
      if (hf) {
        repo = hf.repo
        rfilename = hf.rfilename
        rev = hf.rev
      } else {
        // A non-HF host: a single flat file — its repo structure is unknowable.
        const path = safePathname(u)
        if (!explicitSubdir && !/\.gguf$/i.test(path)) throw new DownloadError('invalid_url', 'URL must point to a .gguf file.')
        const filename = basename(path)
        if (!explicitSubdir && !/\.gguf$/i.test(filename)) throw new DownloadError('invalid_url', 'Could not derive a .gguf filename from that URL.')
        const destDir = explicitSubdir ? join(dir, explicitSubdir) : dir
        mkdirSync(destDir, { recursive: true })
        if ((input.size ?? 0) > 0) this.assertDisk(dir, input.size!)
        const dest = join(destDir, filename)
        if (this.hasLiveDest(dest)) return []
        return this.commit([{ name: filename, repo: '', url: u, dest, total: input.size ?? 0, sha256: input.sha256 }])
      }
    }

    // HF repos are always `owner/name` — reject anything that can't be one (also stops a
    // degenerate `repo` from sanitising to an empty subfolder that lands in the root).
    if (!repo.includes('/') || !rfilename) throw new DownloadError('invalid_request', 'repo and rfilename are required.')
    if (!explicitSubdir && !/\.gguf$/i.test(rfilename)) throw new DownloadError('invalid_url', 'The file must be a .gguf.')

    // Safetensors/MLX pass an explicit subdir and enqueue each component file themselves
    // — no expansion. Place it (single file) directly under that subdir.
    if (explicitSubdir || !this.expand) {
      const filename = basename(rfilename)
      const destDir = join(dir, explicitSubdir || repoSubdir(repo))
      mkdirSync(destDir, { recursive: true })
      const dest = join(destDir, filename)
      if (this.hasLiveDest(dest)) return []
      if ((input.size ?? 0) > 0) this.assertDisk(dir, input.size!)
      return this.commit([
        { name: filename, repo, url: hfResolveUrl(repo, rev, rfilename), dest, total: input.size ?? 0, sha256: input.sha256 },
      ])
    }

    // Expand a GGUF into every concrete file: all split shards + the shared mmproj. Each
    // model gets its own <owner>/<repo>/<repo-subdir> folder (mirrors HF's layout and the
    // primary library's structure), so a model's shards + mmproj sit together for the
    // scanner to group and two quants that share a shard basename never collide.
    const { dir: modelDir, files } = await this.expand(repo, rfilename, rev)
    const destDir = join(dir, repoSubdir(repo), modelDir)
    mkdirSync(destDir, { recursive: true })

    const targets = files
      .map((f) => ({ f, dest: join(destDir, basename(f.rfilename)) }))
      .filter(({ f, dest }) => {
        // An in-flight/queued job already owns this exact file — never enqueue a second
        // writer for the same .part (double-click, or two quants sharing one mmproj).
        if (this.hasLiveDest(dest)) return false
        // A shared mmproj already on disk: keep it only if it looks incomplete (size
        // known and mismatched) — otherwise adding a second quant shouldn't re-pull it.
        if (f.mmproj && existsSync(dest)) {
          if (f.size <= 0) return false
          try {
            return statSync(dest).size !== f.size
          } catch {
            return true
          }
        }
        return true
      })
    if (targets.length === 0) return []

    const totalBytes = targets.reduce((s, { f }) => s + (f.size || 0), 0)
    if (totalBytes > 0) this.assertDisk(dir, totalBytes)

    return this.commit(
      targets.map(({ f, dest }) => ({
        name: basename(f.rfilename),
        repo,
        url: hfResolveUrl(repo, rev, f.rfilename),
        dest,
        total: f.size || 0,
        sha256: f.sha256,
      })),
    )
  }

  /** True when a queued/downloading/paused record already targets this exact dest — the
   *  guard against two concurrent writers corrupting one file. Terminal records
   *  (done/cancelled/error) don't block a fresh attempt. */
  private hasLiveDest(dest: string): boolean {
    for (const r of this.records.values()) {
      if (r.dest === dest && (r.status === 'queued' || r.status === 'downloading' || r.status === 'paused')) return true
    }
    return false
  }

  /** Materialise queued records from resolved targets, persist once, and kick the queue. */
  private commit(
    targets: Array<{ name: string; repo: string; url: string; dest: string; total: number; sha256?: string }>,
  ): DownloadRecord[] {
    const created: DownloadRecord[] = []
    for (const t of targets) {
      const id = `dl-${Date.now().toString(36)}-${(this.nextSeq++).toString(36)}`
      const rec: DownloadRecord = {
        id,
        name: t.name,
        repo: t.repo,
        url: t.url,
        dest: t.dest,
        total: t.total,
        received: 0,
        status: 'queued',
        error: null,
        bytesPerSec: 0,
        sha256: t.sha256,
        createdAt: new Date().toISOString(),
      }
      this.records.set(id, rec)
      created.push(rec)
    }
    this.persist()
    this.pump()
    return created
  }

  /** Cancel an in-flight or queued job: abort the stream, delete the .part, mark
   *  cancelled. Keeps the record so the UI can show + clear it. */
  cancel(id: string): boolean {
    const rec = this.records.get(id)
    if (!rec) return false
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    if (rec.status !== 'done') {
      rmSync(`${rec.dest}.part`, { force: true })
      rec.status = 'cancelled'
      rec.bytesPerSec = 0
    }
    this.persist()
    this.pump()
    return true
  }

  /** Resume a paused or errored job (spec 10 §5): re-queue it so pump() picks it back
   *  up. run() already resumes from the .part file's byte offset via a Range request —
   *  this just flips the status so the queue actually starts it again. A restart-
   *  restored job comes back as 'paused' with no automatic way back to 'downloading'
   *  until this is called. */
  resume(id: string): boolean {
    const rec = this.records.get(id)
    if (!rec || (rec.status !== 'paused' && rec.status !== 'error')) return false
    rec.status = 'queued'
    rec.error = null
    this.persist()
    this.pump()
    return true
  }

  /** Remove a record entirely (and any lingering .part). */
  remove(id: string): boolean {
    const rec = this.records.get(id)
    if (!rec) return false
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    if (rec.status !== 'done') rmSync(`${rec.dest}.part`, { force: true })
    this.records.delete(id)
    this.persist()
    this.pump()
    return true
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Effective primary download dir (spec 01 §3, ADR-035): the configured primary
   *  when still valid, else the first modelDir; '' when none configured. Mirrors
   *  the /modeldirs endpoint's resolution. */
  private primaryDir(): string {
    const cfg = this.store.snapshot()
    return cfg.primaryModelDir && cfg.modelDirs.includes(cfg.primaryModelDir)
      ? cfg.primaryModelDir
      : (cfg.modelDirs[0] ?? '')
  }

  /** Disk-space guard (spec 10 §6): require free ≥ size × 1.1. Best-effort — skips
   *  the check (does not block) when free space can't be determined. */
  private assertDisk(dir: string, size: number): void {
    let free: number
    try {
      const st = statfsSync(dir)
      free = st.bavail * st.bsize
    } catch {
      return // can't measure → don't block
    }
    const need = size * 1.1
    if (free < need) {
      throw new DownloadError(
        'insufficient_disk',
        `Not enough free disk space: need ~${gb(need)} GB, only ${gb(free)} GB free.`,
      )
    }
  }

  /** Start queued jobs up to the concurrency cap. */
  private pump(): void {
    if (this.activeCount() >= MAX_CONCURRENT) return
    for (const rec of this.list()) {
      if (this.activeCount() >= MAX_CONCURRENT) break
      if (rec.status === 'queued') void this.run(rec)
    }
  }

  private async run(rec: DownloadRecord): Promise<void> {
    rec.status = 'downloading'
    rec.error = null
    const ac = new AbortController()
    this.controllers.set(rec.id, ac)
    const part = `${rec.dest}.part`

    try {
      // Resume from an existing .part via a Range request (spec 10 §5).
      let startAt = 0
      if (existsSync(part)) {
        try {
          startAt = statSync(part).size
        } catch {
          startAt = 0
        }
      }
      rec.received = startAt

      const headers: Record<string, string> = { ...this.authHeaders() }
      if (startAt > 0) headers.Range = `bytes=${startAt}-`

      const res = await fetch(rec.url, { headers, redirect: 'follow', signal: ac.signal })
      if (res.status === 401) throw new DownloadError('hf_unauthorized', 'Your Hugging Face token was rejected.')
      if (res.status === 403) throw new DownloadError('hf_gated', 'This repository is gated — accept its license and add your token.')
      if (!res.ok && res.status !== 206) throw new DownloadError('download_failed', `Download failed (HTTP ${res.status}).`)
      if (!res.body) throw new DownloadError('download_failed', 'Empty response body.')

      // A 200 (not 206) means the server ignored Range → restart from scratch.
      const resuming = res.status === 206
      if (!resuming && startAt > 0) {
        rmSync(part, { force: true })
        startAt = 0
        rec.received = 0
      }

      const clen = Number(res.headers.get('content-length') ?? 0)
      if (clen > 0) rec.total = resuming ? startAt + clen : clen

      // Disk guard at download time (spec 10 §6): content-length is often the FIRST real
      // size we see — a raw URL, or an HF expansion where the tree metadata was
      // unavailable (sizes 0), both skip the enqueue-time check. Verifying the remaining
      // bytes here fails a too-large download cleanly (status=error) before writing any,
      // instead of silently filling the disk.
      if (clen > 0) this.assertDisk(dirname(part), clen)

      const hash = rec.sha256 ? createHash('sha256') : null
      // sha256 can only be verified over the full file; skip it on a partial resume.
      const verifyHash = hash !== null && startAt === 0

      let lastTick = Date.now()
      let lastBytes = startAt
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      body.on('data', (chunk: Buffer) => {
        rec.received += chunk.length
        if (verifyHash) hash!.update(chunk)
        const now = Date.now()
        const dt = now - lastTick
        if (dt >= 500) {
          rec.bytesPerSec = ((rec.received - lastBytes) / dt) * 1000
          lastTick = now
          lastBytes = rec.received
        }
      })

      const out = createWriteStream(part, startAt > 0 ? { flags: 'a' } : { flags: 'w' })
      await pipeline(body, out, { signal: ac.signal })

      // Integrity: size (spec 10 §5/§8) + sha256 when fully streamed.
      if (rec.total > 0 && rec.received !== rec.total) {
        rmSync(part, { force: true })
        throw new DownloadError('size_mismatch', 'Download corrupt — size did not match. Removed the partial file.')
      }
      if (verifyHash && rec.sha256) {
        const got = hash!.digest('hex')
        if (got !== rec.sha256) {
          rmSync(part, { force: true })
          throw new DownloadError('checksum_failed', 'Checksum failed — the downloaded file was corrupt.')
        }
      }

      renameSync(part, rec.dest) // atomic within the same dir
      rec.status = 'done'
      rec.bytesPerSec = 0
      this.controllers.delete(rec.id)
      this.recordProvenance(rec)
      this.persist()
      try {
        this.onComplete()
      } catch {
        /* scan trigger is best-effort */
      }
      this.settle('ok')
    } catch (e) {
      this.controllers.delete(rec.id)
      rec.bytesPerSec = 0
      // A user cancel/remove already set a terminal status (and may have dropped the
      // record) — never clobber it back to 'error'. Aborts land here too.
      const terminal: DownloadStatus[] = ['cancelled', 'done']
      if (terminal.includes(rec.status) || (e as Error)?.name === 'AbortError') {
        if (rec.status !== 'done') rec.status = 'cancelled'
      } else {
        rec.status = 'error'
        rec.error = e instanceof Error ? e.message : String(e)
      }
      this.persist()
      // A user who abandons a download is a different signal from one whose
      // download broke — 'cancelled' and 'fail' must not be conflated, or the
      // onboarding funnel reads a deliberate choice as a product defect.
      this.settle(rec.status === 'cancelled' ? 'cancelled' : 'fail')
    } finally {
      this.pump()
    }
  }

  /** Append a completed download to the permanent provenance list, keyed by dest
   *  (re-downloading the same target replaces the old entry). Raw-URL imports carry
   *  an empty repo and so only ever match by sha256. */
  private recordProvenance(rec: DownloadRecord): void {
    const entry: ProvenanceEntry = {
      repo: rec.repo,
      filename: rec.name,
      sha256: rec.sha256,
      dest: rec.dest,
      at: new Date().toISOString(),
    }
    this.provenanceList = this.provenanceList.filter((p) => p.dest !== rec.dest)
    this.provenanceList.push(entry)
    this.saveProvenance()
  }

  private loadProvenance(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.provenancePath, 'utf8')) as { entries?: ProvenanceEntry[] }
      this.provenanceList = parsed.entries ?? []
    } catch {
      /* no provenance yet */
    }
  }

  private saveProvenance(): void {
    try {
      writeFileSync(this.provenancePath, JSON.stringify({ version: 1, entries: this.provenanceList }, null, 2))
    } catch {
      /* provenance is a convenience — never fatal */
    }
  }

  /** Write the in-flight/queued manifest so jobs survive a daemon restart. Done
   *  rows are dropped from the manifest (the file is on disk and scanned). */
  private persist(): void {
    const entries: ManifestEntry[] = []
    for (const r of this.records.values()) {
      if (r.status === 'done' || r.status === 'cancelled') continue
      entries.push({
        id: r.id,
        name: r.name,
        repo: r.repo,
        url: r.url,
        dest: r.dest,
        total: r.total,
        sha256: r.sha256,
        createdAt: r.createdAt,
      })
    }
    try {
      writeFileSync(this.manifestPath, JSON.stringify({ version: 1, entries }, null, 2))
    } catch {
      /* manifest is a convenience — never fatal */
    }
  }

  /** Restore queued/in-flight jobs from a prior run as 'paused' (spec 10 §5): the
   *  user resumes manually. The .part offset (if any) lets a resume continue. */
  private restore(): void {
    let parsed: { entries?: ManifestEntry[] }
    try {
      parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as { entries?: ManifestEntry[] }
    } catch {
      return
    }
    for (const e of parsed.entries ?? []) {
      let received = 0
      try {
        const p = `${e.dest}.part`
        if (existsSync(p)) received = statSync(p).size
      } catch {
        /* ignore */
      }
      this.records.set(e.id, {
        id: e.id,
        name: e.name,
        repo: e.repo,
        url: e.url,
        dest: e.dest,
        total: e.total,
        received,
        status: 'paused',
        error: null,
        bytesPerSec: 0,
        sha256: e.sha256,
        createdAt: e.createdAt,
      })
    }
  }
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1)
}

/** Rewrite HF blob viewer URLs to the direct-download resolve URL so raw HTTP
 *  clients receive the binary rather than the HTML file-viewer page. */
function normalizeHfBlobUrl(u: string): string {
  try {
    const parsed = new URL(u)
    if (parsed.hostname === 'huggingface.co') {
      parsed.pathname = parsed.pathname.replace(/\/blob\//, '/resolve/')
    }
    return parsed.toString()
  } catch {
    return u
  }
}

/** Extract the URL pathname without throwing on a malformed URL. */
function safePathname(u: string): string {
  try {
    return new URL(u).pathname
  } catch {
    return ''
  }
}

/** Recognise an HF resolve URL and pull out the repo + revision + repo-relative file
 *  path: `https://huggingface.co/<owner>/<repo>/resolve/<rev>/<path…>.gguf`. Segments are
 *  URL-decoded (so a `%20` in the path becomes a real space). Returns null for any non-HF
 *  host or a URL that isn't a .gguf resolve link, so those stay raw imports. */
function parseHfResolveUrl(u: string): { repo: string; rev: string; rfilename: string } | null {
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return null
  }
  if (parsed.hostname !== 'huggingface.co') return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  const ri = parts.indexOf('resolve')
  // Need owner/repo before `resolve`, then a revision, then at least one path segment.
  if (ri < 2 || parts.length < ri + 3) return null
  const repo = parts.slice(0, ri).join('/')
  const rev = decodeURIComponent(parts[ri + 1])
  const rfilename = parts
    .slice(ri + 2)
    .map((s) => decodeURIComponent(s))
    .join('/')
  if (!repo.includes('/') || !rev || !rfilename || !/\.gguf$/i.test(rfilename)) return null
  return { repo, rev, rfilename }
}

/** Build an HF resolve URL for a repo-relative file, encoding each path segment (so a
 *  space or `#` in a filename survives) while leaving the `/` separators intact. */
function hfResolveUrl(repo: string, rev: string, rfilename: string): string {
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
  return `https://huggingface.co/${enc(repo)}/resolve/${encodeURIComponent(rev)}/${enc(rfilename)}`
}

/** Sanitise an HF repo id (`owner/name`) into a safe relative subdirectory: forward
 *  slashes only, no absolute/`..`/`.` segments that could escape the model dir. */
function repoSubdir(repo: string): string {
  return repo
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}
