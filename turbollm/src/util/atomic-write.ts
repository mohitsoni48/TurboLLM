// Replace a small state file without ever exposing a half-written one: write a temp file of this
// process's own, then rename it over the target. A crash mid-write leaves the previous file whole
// (and at worst a stray temp file) instead of truncated JSON that a reader's catch treats as empty.
import { renameSync, rmSync, writeFileSync } from 'node:fs'

const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 20
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

export function writeFileAtomicSync(path: string, data: string, options: { mode?: number } = {}): void {
  // Per-pid name: two processes saving the same file never share (and clobber) one temp file.
  const tmp = `${path}.${process.pid}.tmp`
  // A mode applies only to a file the write creates, so one left under this pid is removed first.
  rmSync(tmp, { force: true })
  try {
    writeFileSync(tmp, data, options)
    renameWithRetry(tmp, path)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
    throw e
  }
}

/** On Windows a rename over a file another process (a virus scanner, a reader) briefly holds open
 *  fails with EPERM/EBUSY; it clears within milliseconds. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= RENAME_ATTEMPTS || !code || !TRANSIENT_RENAME_CODES.has(code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS)
    }
  }
}
