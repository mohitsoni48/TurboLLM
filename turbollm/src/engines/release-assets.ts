/**
 * Classify, rank and pair the assets of an arbitrary GitHub release so an engine prebuilt can be
 * installed from any fork (GitHub #276). The classifiers and rankers are PURE: no I/O, no clock,
 * no network. The release resolvers further down (releaseByTag and friends) are the I/O half and
 * fetch from the GitHub API.
 * Names are split into whole tokens, never substring-matched, because `win` is inside `darwin`
 * and `mac` is inside `machine`.
 */
import type { GpuVendor } from '../sysinfo/sysinfo'
import { cmpMajorMinor } from './cuda-provision'
import {
  GithubRateLimitError,
  githubHeaders,
  isRateLimited,
  type GithubRelease,
  type ReleaseAsset,
} from './download'
import { parseGitRepo } from './github-repo'
import type { ReleaseProvenance } from './release-install'
import { compareBuildTags, parseBuildTag } from './version-compare'

export type AssetOs = 'windows' | 'linux' | 'macos' | 'android'
export type AssetBackend = 'cuda' | 'rocm' | 'sycl' | 'vulkan' | 'metal' | 'cpu' | 'opencl' | 'other'
export type ArchiveKind = 'zip' | 'tar.gz'
export type AssetArch = 'x64' | 'arm64' | 'other'

export interface ClassifiedAsset {
  name: string
  url: string
  size: number | null
  os: AssetOs | null
  arch: AssetArch | null
  backend: AssetBackend
  cudaVersion: string | null
  archive: ArchiveKind | null
  companion: 'cudart' | null
}

const OS_BY_TOKEN: Record<string, AssetOs> = {
  win: 'windows',
  windows: 'windows',
  ubuntu: 'linux',
  linux: 'linux',
  macos: 'macos',
  mac: 'macos',
  darwin: 'macos',
  osx: 'macos',
  android: 'android',
}

const ARCH_BY_TOKEN: Record<string, AssetArch> = {
  arm64: 'arm64',
  aarch64: 'arm64',
  x64: 'x64',
  amd64: 'x64',
  s390x: 'other',
  ppc64le: 'other',
  riscv64: 'other',
  armv7: 'other',
  armv7l: 'other',
  i386: 'other',
  i686: 'other',
  x86: 'other',
}

const BACKEND_BY_TOKEN: Record<string, AssetBackend> = {
  cuda: 'cuda',
  rocm: 'rocm',
  hip: 'rocm',
  sycl: 'sycl',
  vulkan: 'vulkan',
  metal: 'metal',
  opencl: 'opencl',
  cpu: 'cpu',
  openvino: 'other',
  kompute: 'other',
  musa: 'other',
  cann: 'other',
}

// Also the older llama.cpp spellings `cuda-cu12.4`, `cudart-...-cu12.4` and `cublas-cu12.2.0`, plus
// a patch component (`cuda-12.4.1`); only major.minor is kept. Forks also write it undotted, PyTorch
// style: `cu124` / `cuda-118` is 12.4 / 11.8, two digits of major and one of minor (every CUDA since
// 10.0). Such a build used to read as `cpu`: no cudart pairing, and ranked below Vulkan on NVIDIA.
const CUDA_VERSION = /(?:^|[-_])cu(?:da)?[-_]?(?:(\d+)\.(\d+)(?:\.\d+)?|(\d{2})(\d))(?=$|[-_])/

// `cuda12` / `cu12`: a CUDA build, but its minor version is unknown (and `cu92` was 9.2), so it gets no
// cudaVersion: it ranks as CUDA, and no cudart is paired with it, since one of the wrong minor version
// could lack what the build was linked against.
const CUDA_MAJOR_ONLY = /^cu(?:da)?\d{1,2}$/

export function classifyReleaseAsset(asset: ReleaseAsset & { size?: number }): ClassifiedAsset {
  const archive = archiveKindOf(asset.name)
  const stem = stripArchiveExtension(asset.name.toLowerCase())
  const tokens = nameTokens(stem)
  const os = firstMapped(tokens, OS_BY_TOKEN)
  const cuda = CUDA_VERSION.exec(stem)
  const cudaVersion = cuda ? `${cuda[1] ?? cuda[3]}.${cuda[2] ?? cuda[4]}` : null
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size ?? null,
    os,
    arch: firstMapped(tokens, ARCH_BY_TOKEN),
    // A CUDA version with no backend token (`cublas-cu12.2.0`, `cuda12.4`, a `cu12.4` cudart, `cu124`, `cuda12`) is a
    // CUDA build.
    backend:
      firstMapped(tokens, BACKEND_BY_TOKEN) ??
      (cudaVersion || tokens.some((t) => CUDA_MAJOR_ONLY.test(t)) ? 'cuda' : os === 'macos' ? 'metal' : 'cpu'),
    cudaVersion,
    archive,
    companion: tokens.includes('cudart') ? 'cudart' : null,
  }
}

export function assetKey(assetName: string, tag: string): string {
  const withoutTag = removeTag(assetName.toLowerCase(), tag.toLowerCase())
  return withoutTag.replace(/[-_]{2,}/g, '-').replace(/^[-_]+/, '')
}

export function parseRepoInput(raw: string): string | null {
  const input = raw.trim()
  const repo = /github\.com\//i.test(input) ? parseGitRepo(stripReleasesSuffix(input)) : bareRepo(input)
  return repo !== null && isSafeRepo(repo) ? repo : null
}

export interface HostProfile {
  platform: NodeJS.Platform
  arch: string
  gpuVendor: GpuVendor
  hasGpu: boolean
  amdApuOnly: boolean
  driverMaxCuda: string | null
}

export interface RankedAsset {
  name: string
  size: number | null
  os: AssetOs | null
  arch: AssetArch | null
  backend: AssetBackend
  cudaVersion: string | null
  compatible: boolean
  reason: string | null
  recommended: boolean
  companions: { name: string; size: number | null }[]
}

export function rankReleaseAssets(assets: ClassifiedAsset[], host: HostProfile): RankedAsset[] {
  const listed = assets.filter((a) => a.archive !== null && a.companion === null)
  const judged = listed.map((asset) => ({ asset, incompatibility: incompatibilityWith(asset, host) }))
  const runnable = judged.filter((j) => j.incompatibility === null).map((j) => j.asset)
  const blocked = judged.filter((j) => j.incompatibility !== null)

  const rows = [
    ...runnable.sort(byPreference(host)).map((asset) => toRow(asset, assets, true, driverCaveat(asset, host))),
    ...blocked
      .sort((a, b) => a.asset.name.localeCompare(b.asset.name))
      .map((j) => toRow(j.asset, assets, false, j.incompatibility)),
  ]
  const best = rows.find((r) => r.compatible)
  if (best) best.recommended = true
  return rows
}

export function companionsFor(main: ClassifiedAsset, all: ClassifiedAsset[]): ClassifiedAsset[] {
  if (main.os !== 'windows' || main.backend !== 'cuda' || main.cudaVersion === null) return []
  return all.filter(
    (c) =>
      c.companion === 'cudart' &&
      c.archive !== null &&
      c.os === main.os &&
      c.arch === main.arch &&
      c.cudaVersion !== null &&
      cmpMajorMinor(c.cudaVersion, main.cudaVersion!) === 0,
  )
}

const HOST_OS: Partial<Record<string, AssetOs>> = {
  win32: 'windows',
  linux: 'linux',
  darwin: 'macos',
  android: 'android',
}

const OS_LABEL: Record<AssetOs, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', android: 'Android' }

function incompatibilityWith(asset: ClassifiedAsset, host: HostProfile): string | null {
  if (asset.os === null) return 'no operating system in the name'
  if (asset.os !== HOST_OS[host.platform]) return `${OS_LABEL[asset.os]} build`
  if (asset.arch === 'other') return `${otherArchToken(asset.name)} build`
  if (asset.arch !== null && asset.arch !== hostArch(host)) return `${asset.arch} build`
  return null
}

function hostArch(host: HostProfile): AssetArch | null {
  return host.arch === 'x64' || host.arch === 'arm64' ? host.arch : null
}

function otherArchToken(name: string): string {
  const tokens = nameTokens(stripArchiveExtension(name.toLowerCase()))
  return tokens.find((t) => ARCH_BY_TOKEN[t] === 'other') ?? 'unsupported architecture'
}

function driverCaveat(asset: ClassifiedAsset, host: HostProfile): string | null {
  if (!exceedsDriver(asset, host)) return null
  return `needs CUDA ${asset.cudaVersion}, driver supports ${host.driverMaxCuda}`
}

function exceedsDriver(asset: ClassifiedAsset, host: HostProfile): boolean {
  return (
    asset.backend === 'cuda' &&
    asset.cudaVersion !== null &&
    host.driverMaxCuda !== null &&
    cmpMajorMinor(asset.cudaVersion, host.driverMaxCuda) > 0
  )
}

function toRow(asset: ClassifiedAsset, all: ClassifiedAsset[], compatible: boolean, reason: string | null): RankedAsset {
  return {
    name: asset.name,
    size: asset.size,
    os: asset.os,
    arch: asset.arch,
    backend: asset.backend,
    cudaVersion: asset.cudaVersion,
    compatible,
    reason,
    recommended: false,
    companions: companionsFor(asset, all).map((c) => ({ name: c.name, size: c.size })),
  }
}

function backendPreference(host: HostProfile): AssetBackend[] {
  if (host.platform === 'darwin') return ['metal', 'cpu']
  if (!host.hasGpu) return ['cpu', 'vulkan']
  switch (host.gpuVendor) {
    case 'nvidia':
      return ['cuda', 'vulkan', 'cpu']
    case 'amd':
      return host.amdApuOnly ? ['vulkan', 'rocm', 'cpu'] : ['rocm', 'vulkan', 'cpu']
    case 'intel':
      return ['sycl', 'vulkan', 'cpu']
    default:
      return ['vulkan', 'cpu']
  }
}

function backendRank(backend: AssetBackend, preference: AssetBackend[]): number {
  const listed = preference.indexOf(backend)
  if (listed >= 0) return listed
  const unlisted: Partial<Record<AssetBackend, number>> = { opencl: 1, other: 2 }
  return 100 + (unlisted[backend] ?? 0)
}

function byPreference(host: HostProfile): (a: ClassifiedAsset, b: ClassifiedAsset) => number {
  const preference = backendPreference(host)
  return (a, b) =>
    backendRank(a.backend, preference) - backendRank(b.backend, preference) ||
    cudaOrder(a, b, host) ||
    Number(a.arch === null) - Number(b.arch === null) ||
    Number(a.archive === 'zip') - Number(b.archive === 'zip') ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name)
}

function cudaOrder(a: ClassifiedAsset, b: ClassifiedAsset, host: HostProfile): number {
  if (a.cudaVersion === null || b.cudaVersion === null) return 0
  const aOver = exceedsDriver(a, host)
  const bOver = exceedsDriver(b, host)
  if (aOver !== bOver) return Number(aOver) - Number(bOver)
  const ascending = cmpMajorMinor(a.cudaVersion, b.cudaVersion)
  return aOver ? ascending : -ascending
}

function nameTokens(stem: string): string[] {
  return stem.replace(/x86_64/g, 'x64').split(/[-_.]/).filter(Boolean)
}

function firstMapped<V>(tokens: string[], table: Record<string, V>): V | null {
  for (const token of tokens) {
    const hit = table[token]
    if (hit !== undefined) return hit
  }
  return null
}

function archiveKindOf(name: string): ArchiveKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  return null
}

function stripArchiveExtension(lowerName: string): string {
  return lowerName.replace(/\.(zip|tar\.gz|tgz)$/, '')
}

/** Removes the tag only as a whole run of tokens: as a raw substring, a short tag such as `v4` or `12`
 *  would cut into `x64` or `cuda-12.4`, and one file name would key differently per release. Any
 *  character but a letter or digit is a boundary (`-`, `_`, `+`, `~`, a space, the archive extension's
 *  `.`), except a `.` that joins digits, as in `12.4`. */
function removeTag(lowerName: string, lowerTag: string): string {
  const bare = lowerTag.replace(/^v/, '')
  const longestFirst = [...new Set([lowerTag, bare, `v${bare}`])].filter(Boolean).sort((a, b) => b.length - a.length)
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const asTokens = (form: string, flags = '') =>
    new RegExp(`(?<![a-z0-9])(?<!\\d\\.)${escapeRegExp(form)}(?![a-z0-9])(?!\\.\\d)`, flags)
  const present = longestFirst.find((form) => asTokens(form).test(lowerName))
  return present === undefined ? lowerName : lowerName.replace(asTokens(present, 'g'), '')
}

function stripReleasesSuffix(url: string): string {
  return url.replace(/\/releases(?:\/tag\/[^?#]*)?\/?$/i, '')
}

function bareRepo(input: string): string | null {
  const withoutGit = input.replace(/\.git$/i, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(withoutGit) ? withoutGit : null
}

function isSafeRepo(repo: string): boolean {
  const segments = repo.split('/')
  return segments.length === 2 && segments.every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && !/^\.+$/.test(s))
}

export interface ResolvedRelease {
  repo: string
  tag: string
  publishedAt: string
  prerelease: boolean
  assets: ReleaseAsset[]
  /** True when the release came from the releases walk rather than `releases/latest`. */
  fellBack: boolean
}

export type ReleaseNotFoundCode = 'repo_not_found' | 'no_releases' | 'no_compatible_asset'

export class ReleaseNotFoundError extends Error {
  constructor(
    readonly code: ReleaseNotFoundCode,
    message: string,
    /** The newest release's assets, so a no_compatible_asset answer can still say why. */
    readonly assets: ReleaseAsset[] = [],
  ) {
    super(message)
    this.name = 'ReleaseNotFoundError'
  }
}

export interface MatchingRelease {
  tag: string
  asset: string
  publishedAt: string
}

const LIST_PAGE_SIZE = 30

export async function resolveInstallableRelease(
  repo: string,
  host: HostProfile,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedRelease> {
  const latest = await getGithubJson<GithubRelease>(repo, 'releases/latest', signal, fetchImpl)
  if (latest !== null && hasCompatibleAsset(latest, host)) return toResolved(repo, latest, false)

  const listed = await listReleases(repo, signal, fetchImpl)
  if (listed === null) {
    throw new ReleaseNotFoundError('repo_not_found', `${repo} was not found on GitHub`)
  }
  if (listed.length === 0) throw new ReleaseNotFoundError('no_releases', `${repo} has no releases`)
  const installable = listed.find((r) => r.draft !== true && hasCompatibleAsset(r, host))
  if (!installable) {
    const newest = listed.find((r) => r.draft !== true)
    throw new ReleaseNotFoundError(
      'no_compatible_asset',
      `no ${repo} release has a build for this machine`,
      newest?.assets ?? [],
    )
  }
  return toResolved(repo, installable, true)
}

export async function releaseByTag(
  repo: string,
  tag: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedRelease> {
  const release = await getGithubJson<GithubRelease>(repo, `releases/tags/${encodeURIComponent(tag)}`, signal, fetchImpl)
  if (release === null) throw new ReleaseNotFoundError('no_releases', `${repo} has no release tagged ${tag}`)
  return toResolved(repo, release, false)
}

export async function newestMatchingRelease(
  provenance: ReleaseProvenance,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MatchingRelease | null> {
  const listed = (await listReleases(provenance.repo, signal, fetchImpl)) ?? []
  const candidates = listed.filter((r) => isUpdateCandidate(r, provenance))
  // Key then classification inside each release. A key-only pass over every candidate would always
  // stop at the installed release (it is listed, and its own asset has the key), so a newer release
  // that renamed the asset would never be reached. The first match listed (newest first) is the pick,
  // and a match listed after it replaces it only with a higher version in a numbering the two share
  // (see tagNumberings): GitHub lists by creation, so a backport cut after a new major (v1.9.5
  // published after v2.0.0) came first and v2.0.0 was never offered. Versions are not compared across
  // numberings: compareBuildTags reads a date or a build number as a major version, so the installed
  // 20240501, always a candidate itself, outranked every later v1.x. A match in a numbering the pick
  // does not share, or with no version order, never replaces it, however recently it was published:
  // an engine on v0.9.0 offered v0.9.9, 20261001 and v1.0.0, listed in that order, gets v1.0.0, not
  // the later 20261001. The pick does not look at which numberings the repo used before the install:
  // the listing holds only its last 30 releases, and the installed release would then beat every later
  // one in a numbering ranked below its own, for good. Nor does it prefer the installed tag's
  // numbering: nothing tells a backport on the line the repo left (a v1.0.1 cut after the repo moved
  // to 20261001) from a line that goes on beside another (a fork's b4600 cut after its v0.4.0), so an
  // engine on 20261001 offered a v1.0.1 published after it takes v1.0.1, as on main.
  let best: MatchingRelease | null = null
  for (const release of candidates) {
    const match =
      findByAssetKey([release], provenance.assetKey) ?? findByIdenticalClassification([release], provenance.asset)
    if (!match) continue
    if (!best) best = match
    else if (sameNumbering(best.tag, match.tag) && compareBuildTags(best.tag, match.tag) === 'newer') best = match
  }
  return best
}

function toResolved(repo: string, release: GithubRelease, fellBack: boolean): ResolvedRelease {
  return {
    repo,
    tag: release.tag_name ?? '',
    publishedAt: release.published_at ?? '',
    prerelease: release.prerelease === true,
    assets: release.assets ?? [],
    fellBack,
  }
}

function hasCompatibleAsset(release: GithubRelease, host: HostProfile): boolean {
  const classified = (release.assets ?? []).map(classifyReleaseAsset)
  return rankReleaseAssets(classified, host).some((row) => row.compatible)
}

function isUpdateCandidate(release: GithubRelease, installed: ReleaseProvenance): boolean {
  if (release.draft === true) return false
  if (release.prerelease === true && !installed.prerelease) return false
  // A backport on an older version line (v1.9.5 published after v2.0.0) is not an update. Tags with
  // no version order (nightly, a commit SHA), or in different numberings, keep the publish-time rule,
  // and so does a higher version published before the installed release: a repo that renumbered its
  // tags downward (20240501 or a build number such as 4500, then v1.0.0) still lists its old releases,
  // which outrank every v1.x, so an engine on `auto` would be moved to one and never offered a v1.x again.
  const tag = release.tag_name ?? ''
  if (sameNumbering(installed.tag, tag) && compareBuildTags(installed.tag, tag) === 'older') return false
  return (release.published_at ?? '') >= installed.publishedAt
}

// The numberings a tag's version order comes from: a llama.cpp build (b4500), a plain build or date
// number (4500, 20240501), a dotted calendar version (2024.05.01) or a version (v1.2.3, 0.10.3, v5). A
// plain number under four digits is both a build number and a major version (5, then a v4.9.1
// backport). None for a tag with no order: compareBuildTags reads the leading digits of any tag, so a
// commit SHA such as 9f1e2d3 would otherwise be ordered by them (as 9) at random.
function tagNumberings(tag: string): string[] {
  const t = tag.trim()
  if (parseBuildTag(t) !== null) return ['build']
  if (/^\d+$/.test(t)) return t.length < 4 ? ['number', 'version'] : ['number']
  if (/^v?(?:19|20)\d\d\.\d/.test(t)) return ['calendar']
  return /^v?\d+(?:\.\d+|$)/.test(t) ? ['version'] : []
}

// Two tags are ordered by version only when they share a numbering. compareBuildTags reads a date, a
// build number or a year as a major version, so across a renumbering every v1.x compared older than a
// release tagged 20240501 or 4500: an engine installed from one was refused every later semver
// release, and was never offered an update again.
function sameNumbering(a: string, b: string): boolean {
  const theirs = tagNumberings(b)
  return tagNumberings(a).some((n) => theirs.includes(n))
}

// The archive kind is not part of the build: a fork that moves from .zip to .tar.gz (as llama.cpp
// itself did) ships the same build under the other extension. The installed kind only breaks ties.
function findByAssetKey(releases: GithubRelease[], key: string): MatchingRelease | null {
  for (const release of releases) {
    const keyOf = (a: ReleaseAsset) => assetKey(a.name, release.tag_name ?? '')
    const keyed = (release.assets ?? []).filter(
      (a) => archiveKindOf(a.name) !== null && stripArchiveExtension(keyOf(a)) === stripArchiveExtension(key),
    )
    const asset = keyed.find((a) => keyOf(a) === key) ?? keyed[0]
    if (asset) return toMatch(release, asset)
  }
  return null
}

function findByIdenticalClassification(releases: GithubRelease[], installedAssetName: string): MatchingRelease | null {
  const wanted = classifyReleaseAsset({ name: installedAssetName, browser_download_url: '' })
  for (const release of releases) {
    const twins = (release.assets ?? []).filter((a) => sameBuildVariant(classifyReleaseAsset(a), wanted))
    const sameArchive = twins.filter((a) => archiveKindOf(a.name) === wanted.archive)
    const pick = sameArchive.length > 0 ? sameArchive : twins
    if (pick.length > 0) return pick.length === 1 ? toMatch(release, pick[0]!) : null
  }
  return null
}

function sameBuildVariant(a: ClassifiedAsset, b: ClassifiedAsset): boolean {
  return (
    a.archive !== null &&
    a.companion === null &&
    a.os === b.os &&
    a.arch === b.arch &&
    a.backend === b.backend &&
    a.cudaVersion === b.cudaVersion
  )
}

function toMatch(release: GithubRelease, asset: ReleaseAsset): MatchingRelease {
  return { tag: release.tag_name ?? '', asset: asset.name, publishedAt: release.published_at ?? '' }
}

async function listReleases(
  repo: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<GithubRelease[] | null> {
  return getGithubJson<GithubRelease[]>(repo, `releases?per_page=${LIST_PAGE_SIZE}`, signal, fetchImpl)
}

/** Parsed JSON body, or null on a 404. Rate limiting and every other failure throw. */
async function getGithubJson<T>(
  repo: string,
  path: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, { headers: githubHeaders(), signal })
  if (isRateLimited(res)) throw new GithubRateLimitError(repo)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`could not query ${repo} ${path}: HTTP ${res.status}`)
  return (await res.json()) as T
}
