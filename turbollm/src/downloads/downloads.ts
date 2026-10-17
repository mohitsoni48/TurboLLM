// Download manager (spec 10 §5–6, §8). Streams model files from Hugging Face or an
// arbitrary HTTP(S) URL into the effective primaryModelDir, with single-connection
// resume (.part + Range), max 2 concurrent, disk-space pre-check, manifest
// persistence across daemon restarts, and a scan trigger on completion. Fail-safe:
// a failed job sets status='error' with a message and never crashes the daemon.
import { createHash } from 'node:crypto'
import {
  createReadStream,
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
import { homedir } from 'node:os'
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
  /** The server's strong validator (ETag, else Last-Modified) for the version of the file the
   *  .part holds — sent as If-Range on resume. */
  validator?: string
  createdAt: string
  /** When the record became 'done' (ISO), set in the same tick that requests the rescan. A
   *  models list whose lastScanAt is later has scanned this file: the web stops waiting for it
   *  to get a row then (a deleted model, an orphaned mmproj never will). */
  finishedAt?: string
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
  validator?: string
  createdAt: string
}

/** Download provenance: a record of which HF repo + file a local model came from,
 *  kept permanently (the manifest drops completed jobs). Lets the Discover UI mark a
 *  quant "Downloaded" only for the SPECIFIC repo it was pulled from — the identical
 *  model+quant from a different repo (a different requant, different sha256) is
 *  correctly shown as not-downloaded. Keyed primarily by sha256 (exact file
 *  identity), with (repo, filename) as the fallback when no hash is known.
 *  `filename` is the destination BASENAME — a repo listing that disambiguates
 *  same-named files by full path must basename its side before comparing. */
export interface ProvenanceEntry {
  repo: string
  filename: string
  sha256?: string
  dest: string
  at: string
}

const MAX_CONCURRENT = 2

/** Statuses whose record still owns its .part (writing it, or able to resume from it) — the
 *  same set {@link DownloadManager.hasLiveDest} treats as live. */
const LIVE: DownloadStatus[] = ['queued', 'downloading', 'paused']

/** The model file formats that make sense as a STANDALONE single-file download: a GGUF
 *  and a LiteRT-LM bundle each carry everything a load needs (weights, tokenizer, and
 *  for multimodal models the encoders) inside one file, so one URL/rfilename is a
 *  complete model. Safetensors weights are deliberately NOT here — they only work as a
 *  directory of component files (config.json + tokenizer + shards), which the HF repo
 *  path downloads file-by-file under a subdir; a lone .safetensors would land in the
 *  library as a file no engine can load. Shared by the raw-URL and repo-file guards so
 *  the two never drift apart; also imported by the Turbo Link façade's file guard
 *  (link/link-routes.ts) for the same reason, and mirrored client-side by the web's
 *  web/src/lib/single-file-model.ts (parity-tested there against this definition). */
export const SINGLE_FILE_MODEL_RE = /\.(gguf|litertlm)$/i

export interface EnqueueInput {
  repo?: string
  rfilename?: string
  url?: string
  size?: number
  sha256?: string
  /** Subdirectory under the primary model dir for the downloaded file. Used for
   *  MLX models whose component files must all land in the same directory. */
  subdir?: string
  /** With `subdir`: the whole folder download this file is one request of (a safetensors
   *  repo or checkpoint, which the web UI queues file by file): every file of it, each by
   *  where its own request puts it under the model dir (`<subdir>/<basename>`) and its size.
   *  The free-disk check is against the total of those no live row already holds, rather
   *  than this file's size, as a split GGUF drops its live shards and checks the rest as one
   *  total: a folder too big for the disk has none of its files queued. */
  folder?: { files: { path: string; size: number }[] }
  /** Drop any `mmproj`-flagged file the expansion would otherwise pull alongside the chosen
   *  GGUF (spec 25 §5.4 / ADR-338 Decision 6: "never pull mmproj-*.gguf — pure added download
   *  before first token"). Onboarding's blessed-catalog downloads are the only caller that
   *  sets this; Discover's own manual picks are unaffected — a user who explicitly browses
   *  and downloads a vision model there is choosing that, unlike onboarding's automatic pick. */
  excludeMmproj?: boolean
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
    const explicitSubdir = safeRelativeSubdir(input.subdir)
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
        if (!explicitSubdir && !SINGLE_FILE_MODEL_RE.test(path)) {
          throw new DownloadError('invalid_url', 'URL must point to a .gguf or .litertlm model file.')
        }
        const filename = basename(path)
        if (!explicitSubdir && !SINGLE_FILE_MODEL_RE.test(filename)) {
          throw new DownloadError('invalid_url', 'Could not derive a .gguf or .litertlm filename from that URL.')
        }
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
    // A `..` segment — raw in a request body, or `..%2F` decoded out of a resolve URL — would
    // climb out of the model folder, both in the fetched path and in the destination the
    // expander's fallback derives from it.
    if (rfilename.split(/[\\/]/).includes('..')) {
      throw new DownloadError('invalid_request', 'The file path must not contain ".." segments.')
    }
    if (!explicitSubdir && !SINGLE_FILE_MODEL_RE.test(rfilename)) {
      throw new DownloadError('invalid_url', 'The file must be a .gguf or .litertlm model file.')
    }

    // Safetensors/MLX pass an explicit subdir and enqueue each component file themselves
    // — no expansion. Place it (single file) directly under that subdir.
    if (explicitSubdir || !this.expand) {
      const filename = basename(rfilename)
      const destDir = join(dir, explicitSubdir || repoSubdir(repo))
      mkdirSync(destDir, { recursive: true })
      const dest = join(destDir, filename)
      if (this.hasLiveDest(dest)) return []
      // A whole-folder download's files each check what is left of the folder, not their own
      // size: checked one by one, three 18 GB shards on a disk with 30 GB free all passed
      // (19.8 GB each) and the folder could never finish. Never less than this file's own size.
      const need = Math.max(input.size ?? 0, this.folderToFetch(dir, input.folder))
      if (need > 0) this.assertDisk(dir, need)
      return this.commit([
        { name: filename, repo, url: hfResolveUrl(repo, rev, rfilename), dest, total: input.size ?? 0, sha256: input.sha256 },
      ])
    }

    // Expand a single-file model into every concrete file to fetch. GGUF: all split
    // shards + the shared mmproj projector, each model in its own
    // <owner>/<repo>/<repo-subdir> folder (mirrors HF's layout and the primary library's
    // structure), so a model's shards + mmproj sit together for the scanner to group and
    // two quants that share a shard basename never collide. A .litertlm bundle is one
    // self-contained file with no siblings to group (handled inside the expander).
    const { dir: modelDir, files } = await this.expand(repo, rfilename, rev)
    // The expander's dir is HF-derived (or, on its fallbacks, the caller's own rfilename) —
    // sanitised like the repo id so it can never leave the model folder.
    const destDir = join(dir, repoSubdir(repo), repoSubdir(modelDir))
    mkdirSync(destDir, { recursive: true })

    const targets = files
      .map((f) => ({ f, dest: join(destDir, basename(f.rfilename)) }))
      .filter(({ f }) => !(input.excludeMmproj && f.mmproj))
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

  /** True when a queued/downloading/paused record already targets this dest (as the file
   *  system compares names, {@link sameDest}) — the guard against two concurrent writers
   *  corrupting one file. Terminal records (done/cancelled/error) don't block a fresh attempt. */
  private hasLiveDest(dest: string): boolean {
    for (const r of this.records.values()) {
      if (sameDest(r.dest, dest) && (r.status === 'queued' || r.status === 'downloading' || r.status === 'paused')) return true
    }
    return false
  }

  /** What is left to fetch of the whole-folder download `folder` names: the total of its files
   *  that no live row already holds. Their own requests add nothing (hasLiveDest), as the GGUF
   *  path drops its live shards before totalling them. Counted whole, a folder clicked again
   *  while some of its files are still downloading would be checked as if every byte were
   *  still to come: of three 10 GB shards with 1 and 3 still writing and 20 GB free, shard 2
   *  (errored) refused as needing ~33 GB. Matched file by file, never by the folder's path: a
   *  root checkpoint's folder is the repo's own, with every nested checkpoint inside it, yet
   *  its files are only the root's, so a nested one still downloading holds none of them.
   *  0 without one. */
  private folderToFetch(dir: string, folder: EnqueueInput['folder']): number {
    const files = folder?.files
    if (!Array.isArray(files)) return 0
    let need = 0
    for (const f of files) {
      if (typeof f?.path !== 'string' || typeof f.size !== 'number' || !Number.isFinite(f.size) || f.size <= 0) continue
      if (!this.hasLiveDest(join(dir, safeRelativeSubdir(f.path)))) need += f.size
    }
    return need
  }

  /** True when ANOTHER record with one of `statuses` targets this record's dest. hasLiveDest
   *  lets a fresh enqueue through while an errored row for the same file remains, so two rows
   *  can share one .part: the stale row must neither delete it under the live one (cancel /
   *  remove) nor start a second writer on it (resume). */
  private sharesDest(rec: DownloadRecord, statuses: DownloadStatus[]): boolean {
    for (const r of this.records.values()) {
      if (r.id !== rec.id && sameDest(r.dest, rec.dest) && statuses.includes(r.status)) return true
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
      if (!this.sharesDest(rec, LIVE)) rmSync(`${rec.dest}.part`, { force: true })
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
   *  until this is called. False when there is no paused or errored row with that id; throws
   *  DownloadError('download_in_progress') when the row exists but cannot start. */
  resume(id: string): boolean {
    const rec = this.records.get(id)
    if (!rec || (rec.status !== 'paused' && rec.status !== 'error')) return false
    // Another row is already (about to be) writing this .part — a second writer would interleave.
    if (this.sharesDest(rec, ['queued', 'downloading'])) {
      throw new DownloadError('download_in_progress', 'Another download is already writing this file.')
    }
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
    if (rec.status !== 'done' && !this.sharesDest(rec, LIVE)) rmSync(`${rec.dest}.part`, { force: true })
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

      // sha256 covers the whole file, so a resume first hashes the prefix already in the .part
      // (streamed, never buffered whole): a stale or corrupt prefix then fails the checksum
      // instead of being spliced onto the new bytes and accepted as done. Done BEFORE the
      // request so a large prefix never holds an open response idle.
      let hash = rec.sha256 ? createHash('sha256') : null
      if (hash && startAt > 0) {
        for await (const chunk of createReadStream(part, { end: startAt - 1 })) {
          if (ac.signal.aborted) break // cancelled mid-hash: the fetch below rejects with AbortError
          hash.update(chunk as Buffer)
        }
      }

      const headers: Record<string, string> = { ...this.authHeaders() }
      // The HF token is for Hugging Face alone: a raw-URL import can name any host, even over
      // plain http://, so only a request to the HF origin may carry it.
      if (!isHfOrigin(rec.url)) delete headers.Authorization
      if (startAt > 0) {
        headers.Range = `bytes=${startAt}-`
        // Only the rest of the SAME file: a server whose file changed since the .part was
        // written answers 200 with the whole new file, which the "ignored Range" path below
        // restarts from, instead of a 206 tail spliced onto the old prefix. A raw URL usually
        // has no sha256 to catch that splice.
        if (rec.validator) headers['If-Range'] = rec.validator
      }

      let res = await fetch(rec.url, { headers, redirect: 'follow', signal: ac.signal })
      // A 416 to a resume: the .part is as long as the server's file or longer, so no byte of
      // `bytes=<.part size>-` exists (the file shrank on the server while paused, or the daemon
      // died after the last write but before the rename below). Thrown as a plain HTTP error with
      // the .part kept, every later Resume asked for the same range and got the same 416. A .part
      // that passes the same size and sha256 checks as a finished stream IS the file: finish it.
      // Anything else is dropped and fetched again from byte 0, once, without Range or If-Range;
      // a 416 to that request fails below like any other HTTP error, with no .part left behind.
      if (res.status === 416 && startAt > 0) {
        await res.body?.cancel().catch(() => {})
        if (hash && (rec.total <= 0 || startAt === rec.total) && hash.digest('hex') === rec.sha256) {
          this.finish(rec, part)
          return
        }
        rmSync(part, { force: true })
        startAt = 0
        rec.received = 0
        // The row's total is the length of the file the .part was written against, which this 416
        // says the server may no longer hold. Kept, a restart whose 200 has no Content-Length was
        // size-checked against it and failed "size did not match", removing the .part, and every
        // later Resume did the same. A 416 names the current length as `bytes */N` (RFC 9110
        // §15.5.17); without one it is unknown until the reply says it. Persisted at once: the
        // persist below runs only when the reply brings a validator or length other than the row's,
        // so a daemon killed during a restart that brings neither came back with the old length.
        rec.total = unsatisfiedRangeLength(res.headers.get('content-range'))
        this.persist()
        if (hash) hash = createHash('sha256')
        delete headers.Range
        delete headers['If-Range']
        res = await fetch(rec.url, { headers, redirect: 'follow', signal: ac.signal })
      }
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
        if (hash) hash = createHash('sha256') // the hashed prefix is gone with the .part
      }
      // A server that ignores If-Range (Hugging Face's own CDN does), or a row with no validator
      // to send, can still return another file's tail as a 206. It shows when the 206 names
      // another strong validator than the one the .part was written under, or when its
      // Content-Range starts elsewhere, stops before the end of the file or names another full
      // length. Checked before rec.total is overwritten with this reply's length, which would
      // make the size check below pass for any splice or truncation.
      const got = strongValidator(res.headers)
      if (
        resuming &&
        ((rec.validator !== undefined && validatorChanged(rec.validator, res.headers)) ||
          !rangeContinues(res.headers.get('content-range'), startAt, rec.total))
      ) {
        await res.body.cancel().catch(() => {})
        rmSync(part, { force: true })
        rec.received = 0
        throw new DownloadError(
          'download_failed',
          "The server's reply does not continue the partial file (the file may have changed on the server since this download started). Removed the partial file: resume to download it again.",
        )
      }

      const clen = Number(res.headers.get('content-length') ?? 0)
      // A 206 names the full length itself; offset + content-length would take a body shorter
      // than its own Content-Range for the whole file.
      const rangeFull = resuming ? contentRangeFull(res.headers.get('content-range')) : 0
      const total = rangeFull > 0 ? rangeFull : clen > 0 ? (resuming ? startAt + clen : clen) : rec.total
      // Remember which version of the file the .part now holds (for If-Range and the check
      // above) and its full length (for the Content-Range check), persisted at once: a daemon
      // restart mid-download is exactly when they are needed, and nothing else writes the
      // manifest until this run ends. A raw URL is enqueued with total 0.
      const validator = got ?? (resuming ? rec.validator : undefined)
      if (validator !== rec.validator || total !== rec.total) {
        rec.validator = validator
        rec.total = total
        this.persist()
      }

      // Disk guard at download time (spec 10 §6): content-length is often the FIRST real
      // size we see — a raw URL, or an HF expansion where the tree metadata was
      // unavailable (sizes 0), both skip the enqueue-time check. Verifying the remaining
      // bytes here fails a too-large download cleanly (status=error) before writing any,
      // instead of silently filling the disk.
      if (clen > 0) this.assertDisk(dirname(part), clen)

      const verifyHash = hash !== null

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

      this.finish(rec, part)
    } catch (e) {
      this.controllers.delete(rec.id)
      rec.bytesPerSec = 0
      // A user cancel/remove already set a terminal status (and may have dropped the
      // record) — never clobber it back to 'error'. Aborts land here too.
      const terminal: DownloadStatus[] = ['cancelled', 'done']
      if (terminal.includes(rec.status) || (e as Error)?.name === 'AbortError') {
        // Widened: finish(), cancel() and remove() set the status where the narrowing from
        // run()'s own 'downloading' cannot see it.
        if ((rec.status as DownloadStatus) !== 'done') rec.status = 'cancelled'
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

  /** Move a verified .part into place and mark its row done: the end of a streamed download,
   *  and of a resume whose .part already held the whole file (run()'s 416 path). */
  private finish(rec: DownloadRecord, part: string): void {
    renameSync(part, rec.dest) // atomic within the same dir
    rec.status = 'done'
    rec.finishedAt = new Date().toISOString()
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
        validator: r.validator,
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
        validator: e.validator,
        createdAt: e.createdAt,
      })
    }
  }
}

/** True when two destinations name one file on this platform's file system. Windows and
 *  (by default) macOS ignore letter case, and Hugging Face serves a repo id in any casing
 *  (`GGML-ORG/MODELS/resolve/...` redirects to `ggml-org/models`), so a pasted URL can build a
 *  dest that differs from a live row's only in case yet opens the same .part. Compared exactly,
 *  both rows wrote it at once: one ended 'done' with a corrupt file in the library (its size and
 *  sha256 checks cover the bytes it streamed, not the file on disk), the other failed on the
 *  rename. On Android only shared storage ignores case ({@link onAndroidSharedStorage}).
 *  Elsewhere case is significant and names compare exactly. The platform is read per call, not
 *  at load, so a test can stand in for another one. */
function sameDest(a: string, b: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return a.toLowerCase() === b.toLowerCase()
  if (process.platform === 'android' && onAndroidSharedStorage(a)) return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/** Android's shared storage ignores letter case (its FUSE layer, like the FAT/exFAT of an SD
 *  card), while app-private storage under /data, Termux's home included, does not. The rule is
 *  by path, with no file system probe: shared storage is /sdcard and /storage (the internal
 *  /storage/emulated/0 and SD cards under /storage), and Termux reaches it through the links
 *  `termux-setup-storage` makes in ~/storage (shared, downloads, external-1, ...). A model
 *  folder reached through any other link compares exactly, as before. */
function onAndroidSharedStorage(path: string): boolean {
  if (path.startsWith('/sdcard/') || path.startsWith('/storage/')) return true
  let home: string
  try {
    home = homedir()
  } catch {
    return false // os.homedir() throws when neither HOME nor the user database names one
  }
  return !!home && path.startsWith(`${join(home, 'storage')}/`)
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1)
}

/** The response's strong validator, usable in If-Range (RFC 9110 §13.1.5): a strong ETag, or
 *  Last-Modified when there is no ETag at all. A weak ETag may not be sent there, and with one
 *  present a date may not stand in for it, so that case yields none. */
function strongValidator(h: Headers): string | undefined {
  const etag = h.get('etag')?.trim()
  if (etag) return etag.startsWith('W/') ? undefined : etag
  return h.get('last-modified')?.trim() || undefined
}

/** True when a 206 names another version of the file than `stored` (the strongValidator the
 *  .part was written under). Only like is compared with like: a stored date with the 206's
 *  Last-Modified, a stored ETag with its strong ETag. A 206 that carries only the other kind (an
 *  ETag on the 200 and only a date on the 206, or the reverse) says nothing either way and is
 *  left to the Content-Range check. */
function validatorChanged(stored: string, h: Headers): boolean {
  let theirs: string | undefined
  // An HTTP-date (any of RFC 9110's three forms) starts with a day name and has a time; an
  // ETag, quoted or not, has no space.
  if (/^[A-Za-z]{3,9},? .*\d{2}:\d{2}:\d{2}/.test(stored)) theirs = h.get('last-modified')?.trim()
  else {
    const etag = h.get('etag')?.trim()
    theirs = etag?.startsWith('W/') ? undefined : etag
  }
  return !!theirs && theirs !== stored
}

/** True when a 206's Content-Range continues the .part to the end of the file: it starts at
 *  `startAt`, names the full length the row expects when both sides know it, and ends at the
 *  last byte when the full length is known (a server capping open-ended ranges sends less,
 *  which startAt + content-length would then take for the whole file). A 206 without the header
 *  (which the spec requires), or with one this cannot read, cannot be checked and is let
 *  through, as before: refusing it would throw away the .part on a merely sloppy server. */
function rangeContinues(contentRange: string | null, startAt: number, total: number): boolean {
  const m = contentRange === null ? null : /^bytes[\s=]+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim())
  if (!m) return true
  if (Number(m[1]) !== startAt) return false
  const full = m[3] === '*' ? total : Number(m[3])
  if (total > 0 && full !== total) return false
  return full <= 0 || Number(m[2]) === full - 1
}

/** The full length a Content-Range names (`bytes a-b/N`), or 0 for `/*` or an unreadable header. */
function contentRangeFull(contentRange: string | null): number {
  const m = contentRange === null ? null : /^bytes[\s=]+\d+-\d+\/(\d+)$/i.exec(contentRange.trim())
  return m ? Number(m[1]) : 0
}

/** The current length a 416 names (`bytes *\/N`, RFC 9110 §14.4), or 0 when it names none. Apart
 *  from contentRangeFull: a 206 must not carry that form, and one that does stays unreadable
 *  there, as rangeContinues already treats it. */
function unsatisfiedRangeLength(contentRange: string | null): number {
  const m = contentRange === null ? null : /^bytes[\s=]+\*\/(\d+)$/i.exec(contentRange.trim())
  return m ? Number(m[1]) : 0
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

/** Where real HF resolve URLs are built/parsed against. Overridable ONLY via
 *  `TURBOLLM_HF_BASE` (set exclusively by docker-compose.test.yaml's E2E harness, never in
 *  production) so the Docker E2E suite's fixture HF server (test/fixtures/hf-server.mjs) is
 *  what "the real download and provision code paths run end to end against" — its own
 *  words. Found live: the env var was declared in the compose file and documented as doing
 *  this, but nothing in this file ever actually read it — every ModelStep "Download this"
 *  in that supposedly-isolated container was silently pulling real multi-GB files from
 *  real huggingface.co the entire time, which is both a real-network dependency the
 *  harness's own header comment explicitly disclaims and, at the tiny tmpfs sizes involved,
 *  functionally guaranteed to time out. */
function hfBaseUrl(): string {
  const override = process.env.TURBOLLM_HF_BASE?.trim()
  return override ? override.replace(/\/+$/, '') : 'https://huggingface.co'
}

/** True when `u` is on the HF origin (scheme, host and port of {@link hfBaseUrl}) — the only
 *  place the user's HF token may be sent. */
function isHfOrigin(u: string): boolean {
  try {
    return new URL(u).origin === new URL(hfBaseUrl()).origin
  } catch {
    return false
  }
}

/** Recognise an HF resolve URL and pull out the repo + revision + repo-relative file
 *  path: `<hfBaseUrl()>/<owner>/<repo>/resolve/<rev>/<path…>.gguf|.litertlm`. Segments are
 *  URL-decoded (so a `%20` in the path becomes a real space). Returns null for any host that
 *  isn't the configured HF base or a URL that isn't a single-file model resolve link, so
 *  those stay raw imports. */
function parseHfResolveUrl(u: string): { repo: string; rev: string; rfilename: string } | null {
  let parsed: URL
  let base: URL
  try {
    parsed = new URL(u)
    base = new URL(hfBaseUrl())
  } catch {
    return null
  }
  if (parsed.hostname !== base.hostname) return null
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
  if (!repo.includes('/') || !rev || !rfilename || !SINGLE_FILE_MODEL_RE.test(rfilename)) return null
  return { repo, rev, rfilename }
}

/** Build an HF resolve URL for a repo-relative file, encoding each path segment (so a
 *  space or `#` in a filename survives) while leaving the `/` separators intact. */
function hfResolveUrl(repo: string, rev: string, rfilename: string): string {
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
  return `${hfBaseUrl()}/${enc(repo)}/resolve/${encodeURIComponent(rev)}/${enc(rfilename)}`
}

/** Sanitise an HF repo id (`owner/name`) into a safe relative subdirectory: forward
 *  slashes only, no absolute/`..`/`.` segments that could escape the model dir. */
/** The subdir a caller asked for, reduced to a relative path that cannot leave the model
 *  folder: the same segment filter {@link repoSubdir} applies to a repo id. The checkpoint
 *  picker builds this from Hugging-Face-provided directory names (ADR-434 (h)), and the value
 *  is joined straight onto the library path — so `..` must never survive it. */
function safeRelativeSubdir(subdir: string | undefined): string {
  return repoSubdir((subdir ?? '').trim())
}

function repoSubdir(repo: string): string {
  return repo
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}
