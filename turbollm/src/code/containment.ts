// Path containment for Code sessions — the SINGLE default-deny boundary enforced in the
// pi `tool_call` extension hook (plan §3b). This is the ONE narrow piece recovered from the
// old, deleted agents/fs-guard.ts: only the pure containment ALGORITHM (canonicalize via the
// nearest existing ancestor so a symlink ANYWHERE in the path can't escape, Windows case-fold,
// NUL / non-absolute / drive-relative rejection, exact-or-descendant match) — NOT the old file's
// per-tool wiring, which is replaced by the pi SDK's real tool_call hook.
import { realpathSync } from 'node:fs'
import { resolve, dirname, basename, join, sep } from 'node:path'

const isWin = process.platform === 'win32'

/** Canonicalize an input path: resolve all symlinks in the nearest EXISTING ancestor,
 *  then re-append the non-existent tail (which therefore cannot contain a symlink).
 *  Returns a comparison-normalized absolute path, or null if the input is unusable. */
export function canonicalize(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || input.length === 0) return null
  if (input.includes('\0')) return null
  let abs: string
  try { abs = resolve(input) } catch { return null }
  const tail: string[] = []
  let cur = abs
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync(cur)
      const full = tail.length ? join(real, ...[...tail].reverse()) : real
      return normForCompare(full)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return normForCompare(abs) // reached the root; nothing exists
      tail.push(basename(cur))
      cur = parent
    }
  }
  return normForCompare(abs)
}

/** Normalize for containment comparison: unify separators to the OS sep and case-fold
 *  on Windows (NTFS is case-insensitive; 8.3 short names are already expanded by realpath). */
export function normForCompare(p: string): string {
  const unified = p.split(/[\\/]+/).join(sep)
  return isWin ? unified.toLowerCase() : unified
}

/** True iff `path` is one of the roots or a descendant. Both sides are normalized.
 *  No parent-escape clause — containment is exact-match OR startsWith(root + sep). */
export function isInsideAny(path: string, roots: string[]): boolean {
  const p = normForCompare(path)
  for (const root of roots) {
    const r = normForCompare(root)
    if (p === r || p.startsWith(r + sep)) return true
  }
  return false
}

/** True iff `input` canonicalizes to a path contained by `root`. `root` is expected to
 *  already exist (the session cwd), so it is canonicalized too. A non-string / NUL /
 *  drive-relative input fails closed (returns false).
 *
 *  NOTE: `input` is resolved with `resolve(input)`, i.e. a RELATIVE `input` is resolved
 *  against `process.cwd()`. For tool-call path arguments (which are relative to the session
 *  repo root, NOT the daemon's cwd) use `isContainedFromRoot` instead. */
export function isContained(input: string | null | undefined, root: string): boolean {
  const p = canonicalize(input)
  if (!p) return false
  const r = canonicalize(root)
  if (!r) return false
  return isInsideAny(p, [r])
}

/** Containment check for a tool-call PATH ARGUMENT, resolving RELATIVE inputs against `root`
 *  (the Code session's repoRoot) rather than `process.cwd()`.
 *
 *  pi's read/edit/write/ls tools normally emit paths relative to the session cwd
 *  (`math-utils.js`, `./index.js`, `.`). Passing those straight to `isContained` resolved them
 *  against the DAEMON's own cwd (e.g. `.../turbollm`), so a perfectly in-bounds relative call
 *  canonicalized to a path OUTSIDE `root` and was falsely rejected. Resolving against `root`
 *  first fixes that. Absolute inputs are unaffected — `resolve(root, abs)` returns `abs`, so
 *  `..`-escape attempts and out-of-root absolute paths are still rejected (fails closed).
 *  Non-string / empty / NUL input fails closed (returns false). */
export function isContainedFromRoot(input: string | null | undefined, root: string): boolean {
  if (typeof input !== 'string' || input.length === 0) return false
  if (input.includes('\0')) return false
  let resolved: string
  try { resolved = resolve(root, input) } catch { return false }
  return isContained(resolved, root)
}
