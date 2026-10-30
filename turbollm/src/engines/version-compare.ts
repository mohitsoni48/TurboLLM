// Version/tag comparison (pure), split out of update.ts and re-exported there. Leaf module: it imports
// nothing relative, so release-assets.ts can order release tags without an import cycle (update.ts
// imports release-assets.ts).

/** The outcome of comparing INSTALLED vs LATEST, stated from the latest's perspective:
 *  `newer` = upstream/latest is ahead of installed (i.e. an update is available),
 *  `older` = installed is ahead of latest, `equal` = same version. `unknown` when the
 *  two can't be meaningfully compared (different/unparseable formats) — the honest
 *  "I can't tell" (we never guess across formats). */
export type CompareResult = 'older' | 'equal' | 'newer' | 'unknown'

/** Parse a llama.cpp-style build tag (`b9608`, `B9761`) into its integer build
 *  number, or null when it isn't that shape. Tolerates surrounding whitespace and a
 *  leading `v` (some forks tag `vb1234`-style); anything else → null (→ unknown). */
export function parseBuildTag(tag: string): number | null {
  const m = /^v?b(\d+)$/i.exec(tag.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) ? n : null
}

/** Compare two GitHub release tags. Prefers llama.cpp build-tag (`b<number>`) ordering;
 *  when EITHER side isn't that shape it falls back to semver/PEP440-ish ordering
 *  ({@link comparePipVersions}) so forks that tag releases `v1.115.2` (KoboldCpp) or
 *  `0.10.3` (llamafile) still compare correctly. `unknown` only when neither scheme can
 *  parse both sides — the honest "I can't tell" (we never guess across formats). */
export function compareBuildTags(installed: string, latest: string): CompareResult {
  const a = parseBuildTag(installed)
  const b = parseBuildTag(latest)
  if (a !== null && b !== null) return a === b ? 'equal' : a < b ? 'newer' : 'older'
  // Not both b<number> tags → try semver-style ordering (KoboldCpp/llamafile/etc.).
  return comparePipVersions(installed, latest)
}

/** Parse a PEP440-ish / semver-ish version into numeric release segments. We keep
 *  this deliberately simple (documented limit): we read the leading dotted-integer
 *  release (e.g. `1.2.3` from `1.2.3rc1+cu124`) and ignore pre-release/build/local
 *  suffixes. That's enough to answer "is a newer stable out?" for vLLM/MLX, which is
 *  all the update check needs; it is NOT a full PEP440 ordering (rc/post/dev are not
 *  ranked). Strips a leading `v`. Returns null when no leading number is present. */
export function parsePipVersion(version: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(version.trim())
  if (!m) return null
  const parts = m[1].split('.').map((s) => Number(s))
  if (parts.some((n) => !Number.isInteger(n))) return null
  return parts
}

/** Compare two pip-style versions by their numeric release segments (missing trailing
 *  segments count as 0, so `0.11` == `0.11.0`). `unknown` when either side can't be
 *  parsed. Pre-release/build suffixes are ignored (see {@link parsePipVersion}). */
export function comparePipVersions(installed: string, latest: string): CompareResult {
  const a = parsePipVersion(installed)
  const b = parsePipVersion(latest)
  if (a === null || b === null) return 'unknown'
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x < y) return 'newer'
    if (x > y) return 'older'
  }
  return 'equal'
}
