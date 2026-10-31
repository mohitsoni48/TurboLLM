// Lazy content-hash store (spec 10 §3). For models the user already had on disk
// (imported or downloaded outside TurboLLM) there is no download provenance, so the
// only repo-accurate "downloaded" signal is the file's actual sha256 vs the HF repo
// file's published lfs sha256. Hashing a multi-GB GGUF is expensive, so this is:
//   - on-demand: only the repo-detail route asks, and only for a local file whose
//     byte size exactly matches a repo file (a near-certain same-file pre-filter),
//   - cached: keyed by (path, size, mtime), persisted across restarts,
//   - deduped + background: ensure() never blocks the caller; the badge appears on a
//     later refetch once the hash lands.
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../util/atomic-write'
import { join } from 'node:path'

interface HashRow {
  size: number
  mtime: number
  sha256: string
}

export class HashStore {
  private cache = new Map<string, HashRow>()
  private pending = new Set<string>()
  private path: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.path = join(dataDir, 'model-hashes.json')
    this.load()
  }

  /** Cached sha256 for a file, only when the cached row still matches size+mtime
   *  (a changed file invalidates its hash). Undefined when not yet computed. */
  get(path: string, size: number, mtime: number): string | undefined {
    const e = this.cache.get(path)
    return e && e.size === size && e.mtime === mtime ? e.sha256 : undefined
  }

  /** Kick off a background sha256 if not already cached/in-flight. Deduped; the
   *  result is read later via get(). Never throws, never blocks. */
  ensure(path: string, size: number, mtime: number): void {
    if (this.get(path, size, mtime) || this.pending.has(path)) return
    this.pending.add(path)
    void this.compute(path, size, mtime).finally(() => this.pending.delete(path))
  }

  private compute(path: string, size: number, mtime: number): Promise<void> {
    return new Promise((resolve) => {
      const hash = createHash('sha256')
      const rs = createReadStream(path)
      rs.on('error', () => resolve())
      rs.on('data', (c) => hash.update(c))
      rs.on('end', () => {
        try {
          this.cache.set(path, { size, mtime, sha256: hash.digest('hex') })
          this.save()
        } catch {
          /* cache is a pure accelerator */
        }
        resolve()
      })
    })
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { entries?: Record<string, HashRow> }
      for (const [k, v] of Object.entries(raw.entries ?? {})) this.cache.set(k, v)
    } catch {
      /* no cache yet */
    }
  }

  private save(): void {
    const entries: Record<string, HashRow> = {}
    for (const [k, v] of this.cache) entries[k] = v
    try {
      writeFileAtomicSync(this.path, JSON.stringify({ version: 1, entries }))
    } catch {
      /* never fatal */
    }
  }
}
