// Filesystem guard — default-deny containment for agent tool calls (spec 13 §4.2).
//
// Hardened per adversarial review: canonicalizes symlinks via the nearest existing
// ancestor (so a symlink ANYWHERE in the path can't escape), case-folds on Windows,
// rejects embedded NUL / non-absolute / drive-relative roots, validates the correct
// path field PER TOOL (glob uses `root`, not `path`), and has NO parent-escape clause.
import { realpathSync } from 'node:fs'
import { resolve, dirname, basename, join, sep } from 'node:path'
import type { AgentType } from '../config/config'

const PI_BUILTINS_DENIED = new Set(['bash', 'write', 'edit', 'read', 'ls', 'find', 'grep'])
// Custom FS tools and the field each one actually reads — glob's search root is `root`,
// not `path`, so the guard MUST check `root` for glob or it validates a field glob ignores.
const FS_READ_PATH = new Set(['read_file', 'list_dir'])
const FS_READ_ROOT = new Set(['glob'])
const FS_WRITE_PATH = new Set(['write_file', 'create_skill'])
const ALLOWED_ACTION = new Set(['call_agent', 'complete_task', 'update_doc'])

export type ToolCallGuardResult = { allow: true } | { block: true; reason: string }
export type ToolCallGuard = (toolName: string, input: Record<string, unknown>) => ToolCallGuardResult

const isWin = process.platform === 'win32'

export function makeToolCallGuard(agent: AgentType, dataDir: string, bridgedNames: Set<string>): ToolCallGuard {
  const readRoots = resolveRoots(agent.readRoots, dataDir)
  const writeRoots = resolveRoots(agent.writeRoots, dataDir)
  return (toolName, input) => {
    // 1. Hard-deny pi built-ins (they bypass our path checks entirely).
    if (PI_BUILTINS_DENIED.has(toolName)) return { block: true, reason: `built-in '${toolName}' is not permitted` }

    // 2. Our path-taking FS tools: canonicalize + containment-check the RIGHT field.
    const isReadPath = FS_READ_PATH.has(toolName)
    const isReadRoot = FS_READ_ROOT.has(toolName)
    const isWrite = FS_WRITE_PATH.has(toolName)
    if (isReadPath || isReadRoot || isWrite) {
      const field = isReadRoot ? input.root : input.path
      const p = canonicalize(typeof field === 'string' ? field : null)
      if (!p) return { block: true, reason: `${toolName}: a valid ${isReadRoot ? 'root' : 'path'} is required` }
      const roots = isWrite ? writeRoots : readRoots
      if (!isInsideAny(p, roots)) return { block: true, reason: `path outside allowed ${isWrite ? 'write' : 'read'} roots` }
      return { allow: true }
    }

    // 3. Bridged ToolRegistry tools the agent was granted (web_search/fetch_url/mcp__*):
    //    no direct filesystem surface → allow. (run_code is NOT bridged — see pi-adapter.)
    if (bridgedNames.has(toolName)) return { allow: true }

    // 4. Known action tools (composition + task-tracking).
    if (ALLOWED_ACTION.has(toolName)) return { allow: true }

    // 5. Default-deny: anything unrecognized is blocked.
    return { block: true, reason: `unrecognized tool '${toolName}' denied` }
  }
}

/** Resolve config roots to canonical absolute paths. `<dataDir>` → the data dir.
 *  Non-absolute / drive-relative roots are dropped (config.validate also rejects them);
 *  every root is canonicalized so a symlinked root matches a canonicalized input path. */
function resolveRoots(roots: string[], dataDir: string): string[] {
  const out: string[] = []
  for (const r of roots) {
    const raw = r === '<dataDir>' ? dataDir : r
    if (!isOsAbsolute(raw)) continue
    const c = canonicalize(raw)
    if (c) out.push(c)
  }
  return out
}

/** Canonicalize an input path: resolve all symlinks in the nearest EXISTING ancestor,
 *  then re-append the non-existent tail (which therefore cannot contain a symlink).
 *  Returns a comparison-normalized absolute path, or null if the input is unusable.
 *  Mirrors the proven routes.ts containment (isWithinHome + realpathSync). */
function canonicalize(input: string | null): string | null {
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
function normForCompare(p: string): string {
  const unified = p.split(/[\\/]+/).join(sep)
  return isWin ? unified.toLowerCase() : unified
}

function isOsAbsolute(p: string): boolean {
  if (typeof p !== 'string') return false
  if (isWin) return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) // drive-absolute or UNC
  return p.startsWith('/')
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
