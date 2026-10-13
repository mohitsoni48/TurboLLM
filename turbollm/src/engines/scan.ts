// Guided "Add your own engine" scan (engine overhaul, Phase 3). Given a folder OR
// a binary file, locate the server binary and report what we found. Read-only —
// registration still goes through the registry. Factored out of the route so the
// resolution logic is unit-testable without HTTP.
import { dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { findFile, serverBinNameFor } from './download'

/** The server binary name for the daemon's OS — same convention as download.ts. */
export const serverBinName = serverBinNameFor()

/** Dirs we never descend into during a scan: VCS/dep/dotdirs would make a big tree
 *  hang and never hold an engine binary anyway. */
function skipScanDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name.startsWith('.')
}

/** Locate the server binary for a chosen path. If `path` is a file, it's taken as
 *  the binary directly; if a directory, we walk it (pruned) for `serverBinName`.
 *  Returns null when nothing usable is found. */
export function resolveServerBinary(path: string, binName = serverBinName): string | null {
  if (!existsSync(path)) return null
  let isDir: boolean
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    return null
  }
  if (!isDir) return path
  return findFile(path, binName, skipScanDir)
}

/** Generic build-output dir names that say nothing about WHICH engine this is —
 *  we skip past them when naming so `.../atomic/build/bin/llama-server` suggests
 *  "atomic", not "bin". */
const GENERIC_DIRS = new Set([
  'bin', 'build', 'release', 'debug', 'relwithdebinfo', 'minsizerel',
  'dist', 'out', 'x64', 'x86', 'arm64', 'win', 'windows', 'linux', 'macos', 'osx',
])

/** Walk up from the binary to the nearest meaningful folder name, skipping generic
 *  build-output dirs. Falls back to the immediate parent when every ancestor is generic. */
export function meaningfulFolder(binPath: string): string {
  const parts = dirname(binPath).split(/[\\/]+/).filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!GENERIC_DIRS.has(parts[i].toLowerCase())) return parts[i]
  }
  return parts[parts.length - 1] ?? 'engine'
}

/** Pull a single clean identifier out of a probed version string for use in a name:
 *  prefer a llama.cpp build tag (b1234), else a git short hash, else the first token.
 *  Returns '' for empty/unknown so the name is just the folder. Avoids the messy
 *  "1 (0a635dc)"-style raw version leaking into the suggested name. */
export function cleanVersionLabel(version: string): string {
  const v = version.trim()
  if (!v || v.toLowerCase() === 'unknown') return ''
  const btag = /\bb\d+\b/i.exec(v)
  if (btag) return btag[0]
  const hash = /\b[0-9a-f]{7,40}\b/i.exec(v)
  if (hash) return hash[0].slice(0, 7)
  const first = v.split(/\s+/)[0]
  return first.length <= 24 ? first : first.slice(0, 24)
}

/** A suggested engine name from the binary's location: the nearest meaningful folder
 *  (skipping bin/build/release/…), plus a clean version token when known
 *  (e.g. "atomic (b1234)" / "atomic (0a635dc)"). Folder-only when no clean version. */
export function suggestEngineName(binPath: string, version: string): string {
  const folder = meaningfulFolder(binPath)
  const v = cleanVersionLabel(version)
  return v ? `${folder} (${v})` : folder
}
