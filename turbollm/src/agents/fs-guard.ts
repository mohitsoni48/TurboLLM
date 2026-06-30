// Filesystem guard — default-deny containment check for agent tool calls (spec 13 §4.2)
import { realpathSync, readlinkSync, lstatSync } from 'node:fs'
import { dirname, resolve, sep, posix, isAbsolute } from 'node:path'
import type { AgentType } from '../config/config'

const PI_BUILTINS_DENIED = new Set(['bash', 'write', 'edit', 'read', 'ls', 'find', 'grep'])
const FS_READ = new Set(['read_file', 'list_dir', 'glob'])
const FS_WRITE = new Set(['write_file', 'create_skill'])

export type ToolCallGuardResult = { allow: true } | { block: true; reason: string }
export type ToolCallGuard = (toolName: string, input: Record<string, unknown>) => ToolCallGuardResult

export function makeToolCallGuard(agent: AgentType, dataDir: string, bridgedNames: Set<string>): ToolCallGuard {
  const readRoots = resolveRoots(agent.readRoots, dataDir)
  const writeRoots = resolveRoots(agent.writeRoots, dataDir)
  return (toolName, input) => {
    // 1. Hard-deny pi built-ins
    if (PI_BUILTINS_DENIED.has(toolName))
      return { block: true, reason: `built-in '${toolName}' is not permitted` }
    // 2. Our FS tools: containment-check
    if (FS_READ.has(toolName) || FS_WRITE.has(toolName)) {
      const p = safeRealpath(typeof input.path === 'string' ? input.path : null)
      const roots = FS_WRITE.has(toolName) ? writeRoots : readRoots
      if (!p || !isInsideAny(p, roots))
        return { block: true, reason: `path outside allowed ${FS_WRITE.has(toolName) ? 'write' : 'read'} roots` }
      return { allow: true }
    }
    // 3. Bridged registry tools — no FS surface
    if (bridgedNames.has(toolName)) return { allow: true }
    // 4. Known action tools
    if (toolName === 'call_agent' || toolName === 'complete_task' || toolName === 'update_doc')
      return { allow: true }
    // 5. Default-deny: anything unknown is blocked
    return { block: true, reason: `unrecognized tool '${toolName}' denied` }
  }
}

function resolveRoots(roots: string[], dataDir: string): string[] {
  return roots.map(r => {
    if (r === '<dataDir>') return dataDir
    // On Windows, resolve() treats POSIX absolute paths as relative.
    // If a root starts with '/', treat it as absolute (our roots are always posix).
    if (r.startsWith('/')) return r
    return resolve(r)
  })
}

function safeRealpath(path: string | null): string | null {
  if (!path) return null
  try {
    // Check if path is a symlink first — readlinkSync gives us the target
    const lstat = lstatSync(path)
    if (lstat.isSymbolicLink()) {
      // Read the symlink target and resolve it relative to the symlink's parent
      const target = readlinkSync(path)
      const resolvedTarget = isAbsolute(target) ? target : posix.join(dirname(path), target)
      const targetReal = safeRealpath(resolvedTarget)
      if (!targetReal) return null
      return targetReal
    }
    // Not a symlink — canonicalize the path
    const real = realpathSync(path)
    return posix.normalize(real.split(sep).join('/'))
  } catch {
    // Path doesn't exist — canonicalize the parent directory (which exists)
    // and append the filename. This handles:
    // 1. New files being written (parent dir exists, file doesn't)
    // 2. Symlinks that point outside the root (realpathSync fails here)
    const parent = dirname(path)
    if (parent === path) return null // can't go higher
    try {
      const realParent = realpathSync(parent)
      const filename = path.split(sep).pop() || ''
      const canonical = posix.join(posix.normalize(realParent.split(sep).join('/')), filename)
      return canonical
    } catch {
      // Parent doesn't exist either — use resolve for containment check
      const resolved = resolve(path)
      return posix.normalize(resolved.split(sep).join('/'))
    }
  }
}

export function isInsideAny(path: string, roots: string[]): boolean {
  // Resolve path to canonical form (handles .., ., redundant separators)
  const normalized = posix.normalize(path.split(sep).join('/'))
  for (const root of roots) {
    const rootNorm = posix.normalize(root.split(sep).join('/'))
    if (normalized === rootNorm || normalized.startsWith(rootNorm + '/') || normalized === rootNorm + '/..') return true
  }
  return false
}
