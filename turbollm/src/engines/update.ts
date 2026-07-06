// Honest engine update detection (ADR-085, Phase 6). Three concerns, with the
// DECISION logic kept pure + unit-tested and the I/O (network, registry) thin
// around it:
//   1. Version/tag comparison — is `latest` newer than `installed`?
//        - llama.cpp / forks ship build tags like `b9608` / `b9761`.
//        - pip engines (vLLM, MLX) ship PEP440-ish versions like `0.11.2`.
//   2. checkUpdate(engine) — resolve the REAL upstream latest (GitHub releases/latest
//      for llama.cpp + forks; PyPI JSON for vLLM/MLX), compare, and NEVER fabricate a
//      "latest" on a network failure (returns an `error` state instead). Cached in-memory.
//   3. decideAutoUpdate({policy, hasUpdate, idle}) — pure: should an `auto` engine
//      apply an available update right now? (only when auto && hasUpdate && idle).
//
// Why pure-first: the network/download/scheduler paths are hard to verify offline,
// so the comparison + auto-update decision live as side-effect-free functions that
// the tests exercise directly; checkUpdate/the scheduler are thin shells over them.

import type { Engine } from '../config/config'
import { latestCommitSha, latestReleaseTag } from './download'

// ─── Layer 1a: version/tag comparison (pure) ─────────────────────────────────

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

/** Which comparison applies to an engine source. llama.cpp + forks compare build
 *  tags; pip engines compare PEP440-ish versions; source-built engines (ADR-088)
 *  compare the built commit hash against a GitHub repo's latest commit. */
export type UpdateSource = 'github-release' | 'pip' | 'source'

/** Compare installed vs latest for a given source. The single decision used both by
 *  checkUpdate and the tests. */
export function compareVersions(source: UpdateSource, installed: string, latest: string): CompareResult {
  return source === 'pip' ? comparePipVersions(installed, latest) : compareBuildTags(installed, latest)
}

// ─── Layer 3a: auto-update decision (pure) ───────────────────────────────────

/** Per-engine auto-update policy (ADR-085). Default 'notify' (badge the UI; never
 *  auto-apply). 'off' = ignore entirely; 'auto' = apply when idle. */
export type UpdatePolicy = 'off' | 'notify' | 'auto'

/** Coerce an arbitrary stored value to a known policy, defaulting to 'notify'
 *  (the safe default — missing/garbage means "notify", never silently auto-update). */
export function normalizeUpdatePolicy(v: unknown): UpdatePolicy {
  return v === 'off' || v === 'auto' ? v : 'notify'
}

/** Pure decision: should this engine auto-apply an update RIGHT NOW? Only when the
 *  policy is 'auto', an update actually exists, AND the engine is idle (not generating
 *  — applying mid-generation would kill the in-flight request). 'off'/'notify' never
 *  auto-apply; a busy engine waits for the next scheduler tick. */
export function decideAutoUpdate(opts: { policy: UpdatePolicy; hasUpdate: boolean; idle: boolean }): boolean {
  return opts.policy === 'auto' && opts.hasUpdate && opts.idle
}

// ─── Layer 1b: checkUpdate (thin I/O over the pure compare) ───────────────────

/** Result of an update check for one engine. On success, `installed`/`latest` carry
 *  the compared strings and `hasUpdate` says whether latest is ahead. On a network
 *  failure `error` is set and `latest`/`hasUpdate` stay null/false — we NEVER claim a
 *  fabricated "latest" we couldn't actually fetch. `checkedAt` is always set. */
export interface UpdateStatus {
  /** The installed version/tag we compared (best-effort; '' when unknown). */
  installed: string
  /** The real upstream latest, or null when the check failed. */
  latest: string | null
  hasUpdate: boolean
  /** ISO timestamp of when this status was produced. */
  checkedAt: string
  /** Set when the check could not complete: 'offline' (network) or 'no_source'
   *  (engine has no known update source). Mutually exclusive with a non-null latest. */
  error?: 'offline' | 'no_source'
  /** When latest couldn't be parsed/compared against installed → result was `unknown`.
   *  The UI shows "couldn't compare" rather than a false up-to-date. */
  comparable: boolean
  /** Set for source-built engines (ADR-088): the update is a source change that can't
   *  be auto-applied (we can't recompile). The UI shows "newer source available →
   *  rebuild" + a link to the repo instead of a one-click Update. Absent for
   *  release/pip engines (which keep the existing one-click "Update available"). */
  rebuild?: boolean
}

/** Resolve which update source + repo/package a registered engine checks against, and
 *  the installed version string to compare. Returns null when the engine has no known
 *  honest update source (e.g. a user-added arbitrary binary we can't track upstream).
 *
 *  - kind 'llama-server' whose binPath is an official managed build → GitHub `ggml-org/
 *    llama.cpp`, installed tag parsed from the tag-keyed dir name (`llama.cpp-{tag}-{id}`).
 *  - kind 'llama-server' under engines/turboquant/ → the fork's GitHub repo; installed
 *    tag parsed from the probed version string.
 *  - kind 'mlx' / 'rapid-mlx' / 'vllm' → PyPI `mlx-lm` / `rapid-mlx` / `vllm`; installed
 *    version parsed from `version`.
 */
export interface ResolvedSource {
  source: UpdateSource
  /** GitHub `owner/repo` (github-release + source) or PyPI package name (pip). */
  ref: string
  installed: string
  /** Source mode only (ADR-088): the branch to compare commits against. Empty → the
   *  repo's default branch (resolved via the GitHub `HEAD` commits ref). */
  branch?: string
}

const OFFICIAL_LLAMA_REPO = 'ggml-org/llama.cpp'
const TURBOQUANT_REPO = 'AtomicBot-ai/atomic-llama-cpp-turboquant'

/** Extract a llama.cpp build tag from a tag-keyed managed install dir path
 *  (`…/engines/llama.cpp-b9608-cuda/…`), or '' when the path isn't that shape. */
export function tagFromManagedBinPath(binPath: string): string {
  const m = /[\\/]engines[\\/]llama\.cpp-([^\\/]+?)-(?:cuda|rocm|sycl|vulkan|metal|cpu)[\\/]/.exec(binPath)
  return m ? m[1] : ''
}

/** Extract the llama.cpp backend id (cuda/rocm/sycl/vulkan/metal/cpu) from a tag-keyed
 *  managed install dir path, or '' when the path isn't an official managed build. The
 *  rollback-safe update needs this to re-provision the SAME backend at the new tag. */
export function backendIdFromBinPath(binPath: string): string {
  const m = /[\\/]engines[\\/]llama\.cpp-[^\\/]+?-(cuda|rocm|sycl|vulkan|metal|cpu)[\\/]/.exec(binPath)
  return m ? m[1] : ''
}

/** Pull the first `b<number>` build tag out of a probed version string (forks embed
 *  it, e.g. "version: 1.2.3 (b9608)" or "… build b9608"), or '' when none is present. */
export function tagFromVersionString(version: string): string {
  const m = /\bb\d+\b/i.exec(version)
  return m ? m[0] : ''
}

/** Extract `owner/repo` from a GitHub repo URL (ADR-088), tolerating a `.git` suffix,
 *  a trailing slash, and `http(s)://`/`www.`/bare `github.com/` forms. Returns null when
 *  the URL isn't a recognizable GitHub repo URL. PURE — the source-mode update resolver
 *  uses it to turn a user-pasted URL into the `owner/repo` the GitHub API expects. */
export function parseGitRepo(url: string): string | null {
  const m = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(
    url.trim(),
  )
  if (!m) return null
  const owner = m[1]
  const repo = m[2]
  if (!owner || !repo) return null
  return `${owner}/${repo}`
}

/** Pull the build's git short hash out of a probed version string (ADR-088): the first
 *  hex token of 7–40 chars (e.g. "1 (0a635dc)" → "0a635dc", "version: x (abcdef1234)" →
 *  "abcdef1234"). Returns '' when none is present. PURE. NOTE: a digits-only build tag
 *  like `b9608`/`9608` is NOT a hex-with-letters hash, so a version carrying only a numeric
 *  tag yields '' — there is no commit to compare. */
export function commitFromVersionString(version: string): string {
  const m = /\b[0-9a-f]{7,40}\b/i.exec(version)
  return m ? m[0] : ''
}

/** Strip a leading package-name label off a probed pip version string ("mlx-lm 0.31.2"
 *  / "vllm 0.11.2" → "0.31.2" / "0.11.2"); returns the trimmed input otherwise. */
export function versionFromPipString(version: string): string {
  const m = /(\d+(?:\.\d+)*\S*)\s*$/.exec(version.trim())
  return m ? m[1] : version.trim()
}

const isManagedLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)
const isTurboquant = (binPath: string) => /[\\/]engines[\\/]turboquant[\\/]/.test(binPath)

const KOBOLDCPP_REPO = 'LostRuins/koboldcpp'
const LLAMAFILE_REPO = 'Mozilla-Ocho/llamafile'

export function resolveUpdateSource(engine: Engine): ResolvedSource | null {
  // Source-built provenance (ADR-088) takes precedence: when the engine carries a
  // parseable GitHub source repo, compare its built commit hash against the repo's
  // latest commit (notify-only "rebuild" — we can't recompile).
  if (engine.sourceRepo) {
    const ref = parseGitRepo(engine.sourceRepo)
    if (ref) {
      return {
        source: 'source',
        ref,
        branch: engine.sourceBranch || '',
        installed: commitFromVersionString(engine.version),
      }
    }
  }
  if (engine.kind === 'mlx') return { source: 'pip', ref: 'mlx-lm', installed: versionFromPipString(engine.version) }
  if (engine.kind === 'rapid-mlx') return { source: 'pip', ref: 'rapid-mlx', installed: versionFromPipString(engine.version) }
  if (engine.kind === 'vllm') return { source: 'pip', ref: 'vllm', installed: versionFromPipString(engine.version) }
  // KoboldCpp / llamafile: single-binary engines provisioned from GitHub releases. Their
  // installed version IS the stored release tag (vX.Y.Z / X.Y.Z); compareBuildTags falls
  // back to semver ordering for non-`b<number>` tags.
  if (engine.kind === 'koboldcpp') return { source: 'github-release', ref: KOBOLDCPP_REPO, installed: engine.version }
  if (engine.kind === 'llamafile') return { source: 'github-release', ref: LLAMAFILE_REPO, installed: engine.version }
  if (engine.kind === 'llama-server') {
    if (isManagedLlama(engine.binPath)) {
      return { source: 'github-release', ref: OFFICIAL_LLAMA_REPO, installed: tagFromManagedBinPath(engine.binPath) }
    }
    if (isTurboquant(engine.binPath)) {
      return { source: 'github-release', ref: TURBOQUANT_REPO, installed: tagFromVersionString(engine.version) }
    }
  }
  // User-added arbitrary binaries: no honest upstream to compare against.
  return null
}

/** Resolve the real latest version/tag for a source. GitHub releases/latest for
 *  github-release; PyPI JSON `info.version` for pip. Throws on network failure (the
 *  caller maps that to an `offline` status — it never fabricates a latest). */
export async function fetchLatest(src: ResolvedSource, signal?: AbortSignal): Promise<string> {
  if (src.source === 'pip') {
    const res = await fetch(`https://pypi.org/pypi/${src.ref}/json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'turbollm' },
      signal,
    })
    if (!res.ok) throw new Error(`pypi query failed: HTTP ${res.status}`)
    const data = (await res.json()) as { info?: { version?: string } }
    return data.info?.version ?? ''
  }
  // Source-built engines (ADR-088): the repo's latest commit sha on the branch.
  if (src.source === 'source') return latestCommitSha(src.ref, src.branch ?? '', signal)
  return latestReleaseTag(src.ref, signal)
}

/** Produce an {@link UpdateStatus} for one engine. Resolves the source, fetches the
 *  real latest, and compares — never inventing a latest on failure. `fetcher` is
 *  injectable so tests can drive the comparison + offline behavior without network. */
export async function computeUpdateStatus(
  engine: Engine,
  fetcher: (src: ResolvedSource, signal?: AbortSignal) => Promise<string> = fetchLatest,
  signal?: AbortSignal,
): Promise<UpdateStatus> {
  const checkedAt = new Date().toISOString()
  const src = resolveUpdateSource(engine)
  if (!src) {
    return { installed: engine.version || '', latest: null, hasUpdate: false, checkedAt, error: 'no_source', comparable: false }
  }
  let latest: string
  try {
    latest = await fetcher(src, signal)
  } catch {
    // Network failure / offline: report the "couldn't check" state, NEVER a false latest.
    return { installed: src.installed, latest: null, hasUpdate: false, checkedAt, error: 'offline', comparable: false }
  }
  if (!latest) {
    return { installed: src.installed, latest: null, hasUpdate: false, checkedAt, error: 'offline', comparable: false }
  }
  // Source-built (ADR-088): two commit SHAs can't be ordered, so "different short-sha →
  // newer source available". An empty installed (no commit hash in the version string)
  // means there's nothing to compare → no_source. Carry the latest short sha (7 chars).
  if (src.source === 'source') {
    const latestShort = latest.slice(0, 7)
    if (!src.installed) {
      return { installed: '', latest: latestShort, hasUpdate: false, checkedAt, error: 'no_source', comparable: false, rebuild: true }
    }
    const same = src.installed.slice(0, 7).toLowerCase() === latestShort.toLowerCase()
    return {
      installed: src.installed,
      latest: latestShort,
      hasUpdate: !same,
      checkedAt,
      comparable: true,
      rebuild: true,
    }
  }
  const cmp = compareVersions(src.source, src.installed, latest)
  return {
    installed: src.installed,
    latest,
    hasUpdate: cmp === 'newer',
    checkedAt,
    comparable: cmp !== 'unknown',
  }
}

// ─── In-memory cache (timestamped) ───────────────────────────────────────────

/** Process-lifetime cache of the last update check per engine id, with its
 *  timestamp (carried inside the status as `checkedAt`). Offline-first: a cached
 *  status survives a later network failure so the UI keeps showing the last real
 *  answer instead of flapping to "couldn't check". */
export class UpdateChecker {
  private cache = new Map<string, UpdateStatus>()

  constructor(private fetcher: (src: ResolvedSource, signal?: AbortSignal) => Promise<string> = fetchLatest) {}

  /** Last cached status for an engine id, or undefined when never checked. */
  get(engineId: string): UpdateStatus | undefined {
    return this.cache.get(engineId)
  }

  /** All cached statuses keyed by engine id. */
  all(): Record<string, UpdateStatus> {
    return Object.fromEntries(this.cache)
  }

  /** Re-check one engine and cache the result. On an offline result we KEEP a prior
   *  successful status (don't overwrite a real latest with "couldn't check") but bump
   *  nothing — the UI relative time naturally ages. Returns the status used. */
  async check(engine: Engine, signal?: AbortSignal): Promise<UpdateStatus> {
    const fresh = await computeUpdateStatus(engine, this.fetcher, signal)
    if (fresh.error === 'offline') {
      const prior = this.cache.get(engine.id)
      // Keep the last successful answer if we have one; otherwise cache the offline state.
      if (prior && prior.latest !== null) return prior
    }
    this.cache.set(engine.id, fresh)
    return fresh
  }

  /** Check a batch of engines (used by the scheduler + the GET endpoint). Sequential
   *  to be gentle on the upstream APIs; the set is tiny (a handful of engines). */
  async checkAll(engines: Engine[], signal?: AbortSignal): Promise<Record<string, UpdateStatus>> {
    for (const e of engines) {
      try {
        await this.check(e, signal)
      } catch {
        /* a single engine's failure never aborts the batch */
      }
    }
    return this.all()
  }

  /** Drop cache entries for engines that no longer exist (removed/disabled). */
  prune(liveIds: Set<string>): void {
    for (const id of [...this.cache.keys()]) {
      if (!liveIds.has(id)) this.cache.delete(id)
    }
  }
}

/** How often the background checker re-checks installed engines (ADR-085). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h
