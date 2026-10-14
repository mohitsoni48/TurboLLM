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

const CUDA_VERSION = /(?:^|[-_])cuda[-_]?(\d+\.\d+)(?=$|[-_])/

export function classifyReleaseAsset(asset: ReleaseAsset & { size?: number }): ClassifiedAsset {
  const archive = archiveKindOf(asset.name)
  const stem = stripArchiveExtension(asset.name.toLowerCase())
  const tokens = nameTokens(stem)
  const os = firstMapped(tokens, OS_BY_TOKEN)
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size ?? null,
    os,
    arch: firstMapped(tokens, ARCH_BY_TOKEN),
    backend: firstMapped(tokens, BACKEND_BY_TOKEN) ?? (os === 'macos' ? 'metal' : 'cpu'),
    cudaVersion: CUDA_VERSION.exec(stem)?.[1] ?? null,
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

function removeTag(lowerName: string, lowerTag: string): string {
  const bare = lowerTag.replace(/^v/, '')
  const longestFirst = [...new Set([lowerTag, bare, `v${bare}`])].filter(Boolean).sort((a, b) => b.length - a.length)
  const present = longestFirst.find((form) => lowerName.includes(form))
  return present === undefined ? lowerName : lowerName.split(present).join('')
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
  return (
    findByAssetKey(candidates, provenance.assetKey) ?? findByIdenticalClassification(candidates, provenance.asset)
  )
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
  return (release.published_at ?? '') >= installed.publishedAt
}

function findByAssetKey(releases: GithubRelease[], key: string): MatchingRelease | null {
  for (const release of releases) {
    const asset = (release.assets ?? []).find(
      (a) => archiveKindOf(a.name) !== null && assetKey(a.name, release.tag_name ?? '') === key,
    )
    if (asset) return toMatch(release, asset)
  }
  return null
}

function findByIdenticalClassification(releases: GithubRelease[], installedAssetName: string): MatchingRelease | null {
  const wanted = classifyReleaseAsset({ name: installedAssetName, browser_download_url: '' })
  for (const release of releases) {
    const twins = (release.assets ?? []).filter((a) => sameBuildVariant(classifyReleaseAsset(a), wanted))
    if (twins.length > 0) return twins.length === 1 ? toMatch(release, twins[0]!) : null
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
    a.cudaVersion === b.cudaVersion &&
    a.archive === b.archive
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
