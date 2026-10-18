// Path containment for Code sessions — the SINGLE default-deny boundary enforced in the
// pi `tool_call` extension hook (plan §3b). This is the ONE narrow piece recovered from the
// old, deleted agents/fs-guard.ts: only the pure containment ALGORITHM (canonicalize via the
// nearest existing ancestor so a symlink ANYWHERE in the path can't escape, Windows case-fold,
// NUL / non-absolute / drive-relative rejection, exact-or-descendant match) — NOT the old file's
// per-tool wiring, which is replaced by the pi SDK's real tool_call hook.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, basename, join, sep, posix, win32, type PlatformPath } from 'node:path'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'

// The kernel gives up (ELOOP) after following 40 links in one path (Linux MAXSYMLINKS; macOS stops
// at 32), so a write that needs more fails anyway. Refusing past that also keeps a link cycle or a
// long link chain in a hostile repo from stalling the daemon, which checks repo files every turn.
const MAX_LINKS = 40
// Each lstat in walk() re-walks its whole path, so link texts that dive deep into a tree and climb
// back out cost the square of that depth (about 1 s for 40 such links). A real path looks up a few
// KB in all; refusing past this keeps a hostile layout to a few tens of ms.
const MAX_LOOKED = 1 << 20

/** Canonicalize an input path: resolve all symlinks in the nearest EXISTING ancestor,
 *  then re-append the non-existent tail (which therefore cannot contain a symlink — a
 *  DANGLING symlink is followed to its target rather than treated as part of that tail).
 *  Returns a comparison-normalized absolute path, or null if the input is unusable. */
export function canonicalize(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || input.length === 0) return null
  if (input.includes('\0')) return null
  let abs: string
  try { abs = resolve(input) } catch { return null }
  // POSIX walks the path itself, the way the kernel does (see walk). Windows keeps Node's
  // realpathSync, which knows its junctions, drive letters and UNC paths.
  if (!isWin) {
    const walked = walk(abs)
    return walked === null ? null : normForCompare(walked)
  }
  const tail: string[] = []
  let cur = abs
  let links = 0
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync(cur)
      const full = tail.length ? join(real, ...[...tail].reverse()) : real
      return normForCompare(full)
    } catch {
      // A dangling symlink (its target doesn't exist yet) also fails realpath, but it is NOT a
      // missing entry: fs.writeFile follows it and creates the target, wherever that is. Keep
      // canonicalizing from the link's target instead of treating the link as an in-root name —
      // a relative target taken against the link's REAL directory, since `cur` may still be
      // spelled through another link (`d/up/x` with `d/up -> ..`) where a lexical `..` differs.
      const link = readLinkOrNull(cur)
      if (link !== null) {
        if (++links > MAX_LINKS) return null
        try { cur = resolve(realpathSync(dirname(cur)), link) } catch { return null }
        continue
      }
      const parent = dirname(cur)
      // Reached the root; nothing exists. Rebuilt from `cur`, not `abs`: after following a link
      // `cur` is the link's target (e.g. on a drive that doesn't exist), not the input path.
      if (parent === cur) return normForCompare(join(cur, ...[...tail].reverse()))
      tail.push(basename(cur))
      cur = parent
    }
  }
  return null // only reachable through a path thousands of components deep — fail closed
}

/** POSIX: walk `abs` one component at a time the way the kernel does. A link's target text takes
 *  its place in the walk, so a `..` after a link applies to where that link really leads, whereas
 *  resolve() and Node's JS realpathSync collapse `sub/..` first: with `a/b/sub -> ../..`, a link
 *  to `a/b/sub/../x` reads as <repo>/a/b/x but a write through it lands at <repo>/../x. From the
 *  first missing component on, the path is kept as spelled (a write creates it as named, so it
 *  holds no link). Returns null where the kernel can't walk the path either, or this can't. */
function walk(abs: string): string | null {
  const todo = abs.split('/').reverse() // a stack: the next component is last
  let cur = '/' // the real path walked so far: it exists and holds no link, so `..` is dirname()
  let links = 0
  let looked = 0
  while (todo.length > 0) {
    const part = todo.pop()!
    if (part === '' || part === '.') continue
    if (part === '..') { cur = dirname(cur); continue }
    const next = join(cur, part)
    if ((looked += next.length) > MAX_LOOKED) return null
    let isLink: boolean
    try { isLink = lstatSync(next).isSymbolicLink() } catch (e) {
      // Missing (or under a file): the kernel can't walk a `..` past it either. A path too long to
      // look up from here may still be walked by the kernel through shorter link texts.
      if ((e as NodeJS.ErrnoException).code === 'ENAMETOOLONG' || todo.includes('..')) return null
      return join(next, ...todo.reverse())
    }
    if (!isLink) { cur = next; continue }
    if (++links > MAX_LINKS) return null
    let target: string
    try { target = readlinkSync(next) } catch { return null }
    // Bytes that aren't UTF-8 decode to U+FFFD: a different name than the one the kernel follows.
    if (target.includes('\uFFFD')) return null
    if (target.startsWith('/')) cur = '/'
    todo.push(...target.split('/').reverse())
  }
  return cur
}

function readLinkOrNull(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null
  } catch {
    return null
  }
}

/** Normalize for containment comparison: unify separators to the OS sep and case-fold
 *  on Windows (NTFS is case-insensitive; 8.3 short names are already expanded by realpath).
 *  On POSIX `\` is an ordinary filename character: the sibling `<parent>/repo\x` is not inside
 *  `<parent>/repo`. */
export function normForCompare(p: string): string {
  const unified = p.split(isWin ? /[\\/]+/ : /\/+/).join(sep)
  return isWin ? unified.toLowerCase() : unified
}

/** True iff `path` is one of the roots or a descendant. Both sides are normalized.
 *  No parent-escape clause — containment is exact-match OR startsWith(root + sep). */
export function isInsideAny(path: string, roots: string[]): boolean {
  const p = normForCompare(path)
  for (const root of roots) {
    const r = normForCompare(root)
    // A filesystem/drive root (`/`, `d:\`) already ends in the separator — appending another
    // would match nothing, rejecting every path under a project opened at a drive root.
    const prefix = r.endsWith(sep) ? r : r + sep
    if (p === r || p.startsWith(prefix)) return true
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
  // Both readings of the string must stay inside: the one pi's write/edit tools act on
  // (normalizePiToolPath) and the raw one, which persona resolves itself with a plain join.
  const normalized = normalizePiToolPath(input)
  if (normalized === null) return false
  for (const candidate of normalized === input ? [input] : [input, normalized]) {
    let resolved: string | null
    try { resolved = resolveToolPath(root, candidate) } catch { return false }
    if (resolved === null || !isContained(resolved, root)) return false
  }
  return true
}

/** `candidate` resolved against `root` for the containment check, or null for a path that pi's
 *  write/edit tools would not write there. On Windows `\x` and `/x` (rooted, with no drive or
 *  share) are absolute to pi (path.isAbsolute), so it writes them on the CURRENT drive, the
 *  daemon's own (process.cwd()'s), while resolve(root, candidate) put them on the root's drive:
 *  with a project on D: and the daemon on C:, `\Users\me\...\Startup\x.bat` was checked as
 *  D:\Users\... (inside a project opened at D:\) and written as C:\Users\.... Such a path is
 *  refused rather than resolved either way, so the check never judges a file other than the one
 *  written. `p` is the platform's path module (win32 in the tests, which run on any OS). */
export function resolveToolPath(root: string, candidate: string, p: PlatformPath = isWin ? win32 : posix): string | null {
  if (p.sep === '\\') {
    const rootOf = p.parse(candidate).root
    if (rootOf === '\\' || rootOf === '/') return null
  }
  return p.resolve(root, candidate)
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** The path pi's write/edit tools ACTUALLY touch is not the raw argument: their resolveToCwd
 *  (pi utils/paths.js `normalizePath` with normalizeUnicodeSpaces + stripAtPrefix) maps Unicode
 *  spaces to ' ', strips one leading `@`, expands `~` / `~/` (and `~\` on win32) to the home
 *  directory, and turns a `file://` URL into a path. Checking the raw string let `~/.bashrc`,
 *  `@/etc/passwd` and `file:///etc/passwd` pass as in-repo names while pi wrote outside the repo.
 *  pi doesn't export this from its package entry point, so it is mirrored here (pi 0.80.6; the
 *  parity test in containment.test.ts drives pi's real write tool to catch drift). Returns null
 *  when pi's own conversion would throw (an unconvertible file:// URL) — the write fails anyway.
 *  Exported for revert.ts, which must undo an edit on the file pi actually edited. */
export function normalizePiToolPath(input: string): string | null {
  let normalized = input.replace(UNICODE_SPACES, ' ')
  if (normalized.startsWith('@')) normalized = normalized.slice(1)
  if (normalized === '~') return homedir()
  if (normalized.startsWith('~/') || (isWin && normalized.startsWith('~\\'))) return join(homedir(), normalized.slice(2))
  if (/^file:\/\//.test(normalized)) {
    try { return fileURLToPath(normalized) } catch { return null }
  }
  return normalized
}
