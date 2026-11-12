// The engine log file: a size-capped write stream and a bounded tail reader. An engine served for weeks (a
// gateway-held model) wrote an unbounded log, and every reader slurped the whole file, which past V8's string
// limit threw and came back as an empty crash diagnosis (scalability review 3.3).
import { closeSync, createWriteStream, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, type WriteStream } from 'node:fs'
import { Writable } from 'node:stream'

/** A log past this many bytes rotates to `<path>.1` (one previous file kept). */
export const ENGINE_LOG_MAX_BYTES = 50 * 1024 * 1024

/** The window readTail reads from the end of a log: enough for 2000 long lines, never the whole file. */
const TAIL_MIN_BYTES = 64 * 1024
const TAIL_MAX_BYTES = 2 * 1024 * 1024

/** A write stream onto `path` (truncated, like the engine start always did) that rotates when it passes `maxBytes`:
 *  the live file is closed, renamed to `<path>.1` (replacing the last rotation), and reopened empty at the SAME
 *  path, so a tailing reader (the engine-log SSE route) sees the file shrink and restarts from 0. Used as an engine
 *  stdout/stderr pipe destination, so the swap happens inside _write and the pipe never notices. */
export class RotatingLogStream extends Writable {
  private inner: WriteStream
  private bytes = 0
  /** The size past which the next rotation is attempted; pushed out after a refused one so it is not retried per chunk. */
  private rotateAtBytes: number

  /** `rename` is a seam for tests: a held file (Windows without share-delete) refuses the rotation. */
  constructor(private readonly path: string, private readonly maxBytes = ENGINE_LOG_MAX_BYTES, private readonly rename: typeof renameSync = renameSync) {
    super()
    this.rotateAtBytes = maxBytes
    rmSync(`${path}.1`, { force: true }) // a previous run's rotation: the new run starts clean
    this.inner = this.open('w')
  }

  private open(flags: 'w' | 'a'): WriteStream {
    const s = createWriteStream(this.path, { flags }) // 'w' truncates
    s.on('error', (e) => this.destroy(e))
    return s
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.bytes > 0 && this.bytes + chunk.length > this.rotateAtBytes) {
      // end() flushes what is queued before the file is renamed (Windows will not rename an open-for-write file
      // under every sharing mode, so close first), then the next file takes this chunk.
      this.inner.end(() => {
        // Renaming over `.1` replaces it in one step, so a refused rotation loses neither generation.
        try {
          this.rename(this.path, `${this.path}.1`)
          this.bytes = 0
          this.rotateAtBytes = this.maxBytes
          this.inner = this.open('w')
        } catch {
          // Refused (the file is held): keep appending to the live file and try again after another cap's worth.
          this.rotateAtBytes = this.bytes + this.maxBytes
          this.inner = this.open('a')
        }
        this.bytes += chunk.length
        this.inner.write(chunk, cb)
      })
      return
    }
    this.bytes += chunk.length
    this.inner.write(chunk, cb)
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.inner.end(() => cb())
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.inner.destroy()
    cb(err)
  }
}

/** The last `n` lines of the log at `path` (CRLF stripped), reading only a bounded window from the end of the file
 *  rather than all of it. A window that starts mid-file drops its first (cut) line. Right after a rotation the live
 *  file is nearly empty and the crash traceback is in `<path>.1`, so a live file holding fewer than `n` lines (all
 *  of it, not a cut window) is continued from there. Empty when unreadable. */
export function readTail(path: string, n: number): string[] {
  const live = readWindow(path, n)
  if (live.cut || live.lines.length >= n) return live.lines.slice(-n)
  return [...readWindow(`${path}.1`, n - live.lines.length).lines, ...live.lines]
}

function readWindow(path: string, n: number): { lines: string[]; cut: boolean } {
  if (!path || n <= 0 || !existsSync(path)) return { lines: [], cut: false }
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const window = Math.min(size, Math.min(Math.max(TAIL_MIN_BYTES, n * 512), TAIL_MAX_BYTES))
      const buf = Buffer.alloc(window)
      const read = readSync(fd, buf, 0, window, size - window)
      let text = buf.toString('utf8', 0, read)
      const cut = size > window
      if (cut) text = text.slice(text.indexOf('\n') + 1) // the window cut the first line
      const body = text.replace(/[\r\n]+$/, '')
      if (!body) return { lines: [], cut }
      const lines = body.split('\n').map((l) => l.replace(/\r$/, ''))
      return { lines: lines.length > n ? lines.slice(-n) : lines, cut }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { lines: [], cut: false }
  }
}

