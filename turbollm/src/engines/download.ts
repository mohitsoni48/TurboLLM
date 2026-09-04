// Default-engine provisioning (ADR-024 + ADR-025). On first run, download the
// official upstream llama.cpp prebuilt for the user's OS/arch + the **fastest
// backend their GPU supports** from GitHub Releases (ggml-org/llama.cpp) into
// the app-data engines dir. No bundling, no system paths, dependency-free
// (Node fetch; PowerShell Expand-Archive / tar for extraction). The user can
// override the backend; we fall back GPU → Vulkan → CPU if a build won't run.
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { GpuVendor } from '../sysinfo/sysinfo'

const execFileP = promisify(execFile)

/** Build standard GitHub API headers, injecting a `GITHUB_TOKEN` env var if present
 *  so authenticated requests get 5,000 req/hour instead of the 60/hour unauthenticated
 *  limit. Callers spread the result into their fetch() headers object. */
export function githubHeaders(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'turbollm',
  }
  const token = process.env.GITHUB_TOKEN?.trim()
  if (token) base['Authorization'] = `Bearer ${token}`
  return { ...base, ...extra }
}

/**
 * Remove the com.apple.quarantine extended attribute that macOS sets on any
 * file downloaded from the internet. Without this, Gatekeeper silently blocks
 * execution of extracted engine binaries and the probe times out.
 * Exported for unit testing; not part of the public API.
 */
export function stripMacOsQuarantine(dir: string): void {
  if (process.platform !== 'darwin') return
  try {
    execFileSync('xattr', ['-r', '-d', 'com.apple.quarantine', dir])
  } catch {
    // xattr exits non-zero when the attribute is absent — not an error
  }
}

// Pinned known-good upstream build. Bump deliberately after testing.
export const LLAMA_BUILD = 'b9608'
const REPO = 'ggml-org/llama.cpp'
// Upstream publishes no Android build (see availableBackends()'s android branch) — TurboLLM
// cross-compiles it via the Android NDK in CI (.github/workflows/android-llama-build.yml) and
// hosts it on its own releases, tagged `android-<LLAMA_BUILD>` so it tracks the exact same
// upstream commit as every other platform without coupling to the app's own release cadence.
const ANDROID_REPO = 'mohitsoni48/TurboLLM'
// CUDA toolkit line for Windows prebuilts (13.x is required for Blackwell / RTX 50xx).
const CUDA_VER = '13.3'

const serverBin = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

export type BackendId = 'cuda' | 'rocm' | 'sycl' | 'vulkan' | 'metal' | 'cpu'

export interface BackendDef {
  id: BackendId
  label: string
  /** Archives to download + extract into the same dir (main binary first). */
  assets: string[]
  /** Defaults to upstream llama.cpp (REPO). Set when a backend's prebuilt is hosted
   *  elsewhere — Android's has no upstream prebuilt at all, so TurboLLM hosts its own. */
  repo?: string
  /** Defaults to provisionBackend()'s `tag` param. Set when the release lives under a
   *  different tag than the plain build tag — Android's own releases are tagged
   *  `android-<tag>` to stay distinguishable from TurboLLM's own app-version tags on the
   *  same repo. */
  releaseTag?: string
}

const plat = () => process.platform
const arch = () => (process.arch === 'arm64' ? 'arm64' : 'x64')

/** Every backend with a usable upstream prebuilt for this OS/arch, GPU-first. */
export function availableBackends(tag = LLAMA_BUILD): BackendDef[] {
  const a = arch()
  const def = (id: BackendId, label: string, ...assets: string[]): BackendDef => ({ id, label, assets })

  if (plat() === 'darwin') {
    // The macOS Metal binary also runs in CPU-only mode — same asset, two backend
    // entries so the recommender always has a cpu variant. Note: both entries point
    // at the identical archive, so if a Metal build is broken the cpu entry won't
    // rescue it — it will fail identically.
    return [
      def('metal', 'Metal (Apple GPU)', `llama-${tag}-bin-macos-${a}.tar.gz`),
      def('cpu', 'CPU', `llama-${tag}-bin-macos-${a}.tar.gz`),
    ]
  }
  if (plat() === 'win32') {
    if (a === 'arm64') return [def('cpu', 'CPU', `llama-${tag}-bin-win-cpu-arm64.zip`)]
    return [
      def('cuda', 'CUDA (NVIDIA)', `llama-${tag}-bin-win-cuda-${CUDA_VER}-x64.zip`, `cudart-llama-bin-win-cuda-${CUDA_VER}-x64.zip`),
      def('rocm', 'ROCm / HIP (AMD Radeon)', `llama-${tag}-bin-win-hip-radeon-x64.zip`),
      def('sycl', 'SYCL (Intel)', `llama-${tag}-bin-win-sycl-x64.zip`),
      def('vulkan', 'Vulkan (any GPU)', `llama-${tag}-bin-win-vulkan-x64.zip`),
      def('cpu', 'CPU', `llama-${tag}-bin-win-cpu-x64.zip`),
    ]
  }
  if (plat() === 'linux') {
    // NOTE: upstream ships NO Linux CUDA prebuilt — NVIDIA on Linux uses Vulkan
    // (or a bring-your-own CUDA build).
    const list = [
      def('rocm', 'ROCm (AMD)', `llama-${tag}-bin-ubuntu-rocm-7.2-${a}.tar.gz`),
      def('sycl', 'SYCL (Intel)', `llama-${tag}-bin-ubuntu-sycl-fp16-${a}.tar.gz`),
      def('vulkan', 'Vulkan (any GPU)', `llama-${tag}-bin-ubuntu-vulkan-${a}.tar.gz`),
      def('cpu', 'CPU', `llama-${tag}-bin-ubuntu-${a}.tar.gz`),
    ]
    // ROCm/SYCL only ship x64; drop them on arm64.
    return a === 'arm64' ? list.filter((b) => b.id === 'vulkan' || b.id === 'cpu') : list
  }
  // Android (Termux): Node reports process.platform === 'android'. Upstream publishes NO
  // prebuilt that runs on Android — the Ubuntu binaries are glibc and won't load against
  // Android's bionic libc (GitHub #52 item 6 / ADR-390/391) — so TurboLLM cross-compiles its
  // own via the Android NDK and hosts it on ANDROID_REPO instead. CPU-only for v1 (see
  // CMAKE_CONFIGURE_ARGS_ANDROID in build-prereqs.ts for why); asset naming otherwise matches
  // every other platform's `llama-<tag>-bin-<os>-<arch>.tar.gz` convention.
  if (plat() === 'android') {
    return [
      {
        id: 'cpu',
        label: 'CPU',
        assets: [`llama-${tag}-bin-android-${a}.tar.gz`],
        repo: ANDROID_REPO,
        releaseTag: `android-${tag}`,
      },
    ]
  }
  throw new Error(`unsupported platform: ${plat()}/${process.arch}`)
}

/** The fastest backend for the detected GPU vendor. `amdApuOnly` — true when every detected
 *  AMD adapter is an integrated GPU (GitHub #103: e.g. Radeon 860M / other Ryzen AI APUs) —
 *  skips ROCm even when a ROCm build exists for this platform. ROCm's Windows/Linux support
 *  matrix already excludes most discrete consumer Radeon cards (see enumWindowsGpus's rocm-smi
 *  comment); it excludes integrated Radeon graphics even more consistently, so defaulting an
 *  APU-only box to ROCm reliably picks a backend that can't load a model at all. Vulkan always
 *  works there. Ignored (irrelevant) when a discrete AMD GPU is present. */
export function recommendBackendId(
  vendor: GpuVendor,
  hasGpu: boolean,
  tag = LLAMA_BUILD,
  amdApuOnly = false,
): BackendId {
  const ids = new Set(availableBackends(tag).map((b) => b.id))
  if (plat() === 'darwin') return 'metal'
  if (!hasGpu) return 'cpu'
  let pick: BackendId
  switch (vendor) {
    case 'nvidia':
      pick = ids.has('cuda') ? 'cuda' : 'vulkan' // no Linux CUDA prebuilt
      break
    case 'amd':
      pick = !amdApuOnly && ids.has('rocm') ? 'rocm' : 'vulkan'
      break
    case 'intel':
      pick = ids.has('sycl') ? 'sycl' : 'vulkan'
      break
    default:
      pick = 'vulkan'
  }
  return ids.has(pick) ? pick : 'cpu'
}

/** Ordered provisioning attempts: preferred backend, then Vulkan, then CPU. */
export function fallbackChain(preferred: BackendId, tag = LLAMA_BUILD): BackendDef[] {
  const all = availableBackends(tag)
  const order: BackendId[] = [preferred, 'vulkan', 'cpu']
  const out: BackendDef[] = []
  const seen = new Set<BackendId>()
  for (const id of order) {
    if (seen.has(id)) continue
    const def = all.find((b) => b.id === id)
    if (def) {
      out.push(def)
      seen.add(id)
    }
  }
  return out
}

export function backendDir(enginesRoot: string, id: BackendId, tag = LLAMA_BUILD): string {
  return join(enginesRoot, `llama.cpp-${tag}-${id}`)
}

/** The BackendDef for `id` at a SPECIFIC tag (the update path targets the real latest
 *  tag, not the pinned LLAMA_BUILD). Returns null when this OS/arch has no such backend. */
export function backendDefAt(id: BackendId, tag: string): BackendDef | null {
  return availableBackends(tag).find((b) => b.id === id) ?? null
}

/** An installed official-llama build of a backend, tag-AGNOSTIC: scans the engines root for
 *  every `llama.cpp-<tag>-<id>` dir and returns the NEWEST (highest `b<N>` build number) that
 *  has a server binary, or null. Resolving by scan (not by the pinned `LLAMA_BUILD` tag) is what
 *  keeps a build de-pinned by an update (ADR-085) from falsely reading as "not installed". */
export function installedBackendBuild(
  enginesRoot: string,
  id: BackendId,
): { dir: string; tag: string; bin: string } | null {
  let entries: string[]
  try {
    entries = readdirSync(enginesRoot)
  } catch {
    return null // no engines dir yet
  }
  const re = new RegExp(`^llama\\.cpp-(.+)-${id}$`)
  const buildNum = (tag: string): number => {
    const m = tag.match(/^b(\d+)$/)
    return m ? Number(m[1]) : -1
  }
  let best: { dir: string; tag: string; bin: string } | null = null
  for (const name of entries) {
    const m = re.exec(name)
    if (!m) continue
    const dir = join(enginesRoot, name)
    // A dir with a server binary but no completion marker is a partial/legacy install
    // (see PROVISION_MARKER) — must not be reported as a working, installed build.
    if (!isFullyProvisioned(dir)) continue
    const bin = findServer(dir)!
    if (!best || buildNum(m[1]) > buildNum(best.tag)) best = { dir, tag: m[1], bin }
  }
  return best
}

/** Recursively find a file by exact name under dir (first match), or null.
 *  `skipDir(name)` lets a caller prune subtrees (e.g. node_modules / dotdirs) so a
 *  huge tree can't make the scan hang — default keeps the original full-walk
 *  behavior for existing callers. */
export function findFile(dir: string, name: string, skipDir?: (dirName: string) => boolean): string | null {
  const entries = tryReaddir(dir)
  if (!entries) return null
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (skipDir?.(e.name)) continue
      const r = findFile(full, name, skipDir)
      if (r) return r
    } else if (e.name === name) {
      return full
    }
  }
  return null
}

/** Read a directory's entries, or null if it can't be read (e.g. an OS-protected folder
 *  throwing EPERM/EACCES) — lets a broad recursive scan skip past it instead of crashing. */
function tryReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

function findServer(dir: string): string | null {
  return findFile(dir, serverBin)
}

export interface ProvisionProgress {
  phase: 'downloading' | 'extracting'
  pct: number // 0..1 while downloading; -1 = indeterminate (extracting)
  part?: number // 1-based archive index (multi-asset backends like CUDA)
  parts?: number // total archives for this backend
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    if (total && onProgress) {
      const pct = got / total
      if (pct - lastPct >= 0.05) {
        lastPct = pct
        onProgress({ phase: 'downloading', pct })
      }
    }
  })
  await pipeline(body, createWriteStream(dest), { signal })
}

/**
 * Extract an archive into destDir. Windows assets are .zip → PowerShell
 * Expand-Archive (always present, doesn't depend on which `tar` is on PATH).
 * macOS/Linux assets are .tar.gz → `tar -xzf`.
 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
    await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { maxBuffer: 16 * 1024 * 1024 })
  } else {
    await execFileP('tar', ['-xzf', archive, '-C', destDir])
  }
  stripMacOsQuarantine(destDir)
}

// Written into a backend build dir once EVERY asset (e.g. CUDA's binary + its cudart
// runtime bundle) has downloaded and extracted successfully. Its presence is what
// "installed" actually means — a dir with a server binary but no marker means an
// earlier run stopped partway (e.g. an asset was added to a backend after this dir was
// first provisioned, or a prior version only fetched one of several required assets),
// which used to be silently mistaken for a complete, working install (real bug: the CUDA
// backend then falls back to CPU with no error, because ggml-cuda.dll can't find the
// cudart64_*/cublas64_*/cublasLt64_* DLLs it needs but nothing downloaded them).
const PROVISION_MARKER = '.turbollm-provisioned'

/** Whether `dir` has the CUDA cudart runtime DLLs directly beside the server binary
 *  (`cudart64_*.dll` — extracted from the second asset). Non-recursive: the multi-asset
 *  extraction always places them at the top level, same as the server binary itself. */
function hasCudartRuntime(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => /^cudart64_\d+\.dll$/i.test(f))
  } catch {
    return false
  }
}

/** Whether every asset for this backend was ever confirmed downloaded. Presence of
 *  PROVISION_MARKER is the fast path. Builds installed by a TurboLLM version older than
 *  the marker (or before this backend needed a second asset) have no marker yet — for
 *  those, backfill: a CUDA dir only counts as complete if the cudart DLLs are actually
 *  there (the real signal this whole check exists to verify); any other backend is
 *  single-asset, so the binary alone is proof enough. Writes the marker on first pass so
 *  this only needs to re-derive it once per build dir. */
function isFullyProvisioned(dir: string): boolean {
  if (existsSync(join(dir, PROVISION_MARKER))) return !!findServer(dir)
  const bin = findServer(dir)
  if (!bin) return false
  if (/-cuda$/.test(dir) && !hasCudartRuntime(dir)) return false
  // Best-effort: a read-only dir or full disk shouldn't 500 the caller (this runs inside
  // route handlers) — a failed write just means the next call re-derives it the same way.
  try { writeFileSync(join(dir, PROVISION_MARKER), JSON.stringify({ backfilled: true })) } catch { /* re-derived next time */ }
  return true
}

/**
 * Ensure a backend is downloaded + extracted; return the llama-server path.
 * Multi-asset backends (CUDA = binary + cudart) extract into the same dir so the
 * runtime DLLs sit beside the server binary.
 */
export async function provisionBackend(
  enginesRoot: string,
  backend: BackendDef,
  tag: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const destDir = join(enginesRoot, `llama.cpp-${tag}-${backend.id}`)

  if (isFullyProvisioned(destDir)) {
    const found = findServer(destDir)
    if (found) return found
  }

  mkdirSync(destDir, { recursive: true })
  const parts = backend.assets.length
  try {
    for (let i = 0; i < parts; i++) {
      const asset = backend.assets[i]
      const part = i + 1
      const tmp = join(enginesRoot, asset)
      const url = `https://github.com/${backend.repo ?? REPO}/releases/download/${backend.releaseTag ?? tag}/${asset}`
      onProgress?.({ phase: 'downloading', pct: 0, part, parts })
      await downloadFile(url, tmp, (p) => onProgress?.({ ...p, part, parts }), signal)
      onProgress?.({ phase: 'extracting', pct: -1, part, parts })
      await extractArchive(tmp, destDir)
      rmSync(tmp, { force: true })
    }
  } catch (e) {
    // Cancelled or failed mid-download: remove partial archives + the half-built
    // backend dir so it isn't mistaken for an installed backend.
    for (const asset of backend.assets) rmSync(join(enginesRoot, asset), { force: true })
    rmSync(destDir, { recursive: true, force: true })
    throw e
  }

  const bin = findServer(destDir)
  if (!bin) throw new Error('llama-server not found in extracted archive(s)')
  writeFileSync(join(destDir, PROVISION_MARKER), JSON.stringify({ assets: backend.assets, tag }))
  return bin
}

/** Remove EVERY installed build of a backend, tag-agnostic (`llama.cpp-<tag>-<id>` dirs —
 *  e.g. both b9744 and b9754 after a de-pinned update). Returns how many dirs were removed. */
export function deleteAllBackendBuilds(enginesRoot: string, id: BackendId): number {
  let entries: string[]
  try {
    entries = readdirSync(enginesRoot)
  } catch {
    return 0
  }
  const re = new RegExp(`^llama\\.cpp-(.+)-${id}$`)
  let removed = 0
  for (const name of entries) {
    if (!re.test(name)) continue
    rmSync(join(enginesRoot, name), { recursive: true, force: true })
    removed++
  }
  return removed
}

// ─── Generic fork provisioning from a GitHub release (ADR-044) ──────────────
// Catalog forks (e.g. TurboQuant) ship prebuilt `llama-server` binaries on their
// own GitHub Releases. We resolve the latest release at install time, pick the
// asset matching this OS/arch, then download + extract + locate the server — the
// same pipeline as the official backends, but pointed at an arbitrary repo with
// arbitrary asset names (so it survives the fork renaming its archives).

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

/** Score how well an asset name matches this OS/arch; -1 = no match (wrong OS/arch
 *  or not an archive). Higher is better — used to pick the best of several assets. */
export function scoreAsset(name: string, platform: string = process.platform, archStr: string = process.arch): number {
  const n = name.toLowerCase()
  const isArchive = n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.zip')
  if (!isArchive) return -1 // skip .dmg / .sha256 / source tarballs

  const osOk =
    platform === 'darwin'
      ? n.includes('macos') || n.includes('darwin') || n.includes('osx')
      : platform === 'win32'
        ? n.includes('win') || n.includes('windows')
        : n.includes('linux') || n.includes('ubuntu')
  if (!osOk) return -1

  // arm64 vs x64: if the name names an arch, it must be ours; unnamed = acceptable.
  const wantArm = archStr === 'arm64'
  const namesArm = n.includes('arm64') || n.includes('aarch64')
  const namesX64 = n.includes('x64') || n.includes('x86_64') || n.includes('amd64')
  if (wantArm && namesX64) return -1
  if (!wantArm && namesArm) return -1

  let score = 1
  if ((wantArm && namesArm) || (!wantArm && namesX64)) score += 2 // exact arch named
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) score += 1 // prefer tarball over zip
  return score
}

/** Pick the best-matching asset for this OS/arch, or null if the release has none. */
export function pickReleaseAsset(
  assets: ReleaseAsset[],
  platform: string = process.platform,
  archStr: string = process.arch,
): ReleaseAsset | null {
  let best: ReleaseAsset | null = null
  let bestScore = 0
  for (const a of assets) {
    const s = scoreAsset(a.name, platform, archStr)
    if (s > bestScore) {
      best = a
      bestScore = s
    }
  }
  return best
}

/** One GitHub release as we consume it (latest-release resolution). */
export interface GithubRelease {
  tag_name?: string
  assets?: ReleaseAsset[]
}

/** Resolve the latest GitHub release of `repo` (tag + assets) via the public API.
 *  Used by the honest update check (update.ts) to compare the installed tag against
 *  upstream. Throws on a non-2xx response (caller maps it to an offline/error state). */
export async function latestGithubRelease(repo: string, signal?: AbortSignal): Promise<GithubRelease> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(apiUrl, {
    headers: githubHeaders(),
    signal,
  })
  if (!res.ok) throw new Error(`could not query ${repo} releases: HTTP ${res.status}`)
  return (await res.json()) as GithubRelease
}

/** Resolve just the latest release tag of `repo` (e.g. `b9761`), or '' when the
 *  release carries no tag. Thin wrapper over {@link latestGithubRelease} for the
 *  update checker, which only needs the tag to compare. */
export async function latestReleaseTag(repo: string, signal?: AbortSignal): Promise<string> {
  const rel = await latestGithubRelease(repo, signal)
  return rel.tag_name ?? ''
}

/** Resolve the latest commit SHA on a branch of `repo` (ADR-088). `branch` empty →
 *  the repo's default branch (the `HEAD` commits ref resolves it). Used by the honest
 *  source-built update check to detect "newer source available → rebuild". Throws on a
 *  non-2xx response (caller maps it to an offline/error state — never fabricates a sha). */
export async function latestCommitSha(repo: string, branch = '', signal?: AbortSignal): Promise<string> {
  const ref = branch.trim() ? encodeURIComponent(branch.trim()) : 'HEAD'
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: githubHeaders(),
    signal,
  })
  if (!res.ok) throw new Error(`could not query ${repo} commits: HTTP ${res.status}`)
  const data = (await res.json()) as { sha?: string }
  return data.sha ?? ''
}


// TurboQuant ships self-contained prebuilts for macOS-arm64 and Linux-x64 (Vulkan) as
// GitHub releases tagged PER PLATFORM (turboquant-macos-arm64-*, turboquant-linux-x64-*)
// — so `releases/latest` can't be used (it's whichever platform published most recently);
// this resolver finds the newest release whose TAG matches the OS. Windows has no usable
// self-contained prebuilt (the only one, on HuggingFace, is a MinGW build with a UCRT
// linkage defect that won't load), so it returns null → "build from source".

/** Resolve the TurboQuant archive URL for this platform, or null when no self-contained
 *  prebuilt exists (→ caller falls back to "build from source"). macOS/Linux → the newest
 *  GitHub release whose TAG names this OS and carries a matching asset; Windows → null. */
export async function turboquantAssetUrl(
  repo: string,
  platform = process.platform,
  archStr = process.arch,
  signal?: AbortSignal,
): Promise<string | null> {
  if (platform === 'win32') return null // no usable self-contained Windows prebuilt
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: githubHeaders(),
    signal,
  })
  if (!res.ok) throw new Error(`could not query ${repo} releases: HTTP ${res.status}`)
  const releases = (await res.json()) as GithubRelease[]
  const osTag = platform === 'darwin' ? 'macos' : 'linux'
  for (const rel of releases) {
    if (!(rel.tag_name ?? '').toLowerCase().includes(osTag)) continue
    const asset = pickReleaseAsset(rel.assets ?? [], platform, archStr)
    if (asset) return asset.browser_download_url
  }
  return null
}

/** Provision TurboQuant's prebuilt `llama-server` into `<enginesRoot>/turboquant/`,
 *  resolving the right per-platform source (HF on Windows, GitHub elsewhere) via the
 *  download → extract → locate pipeline. Throws `no_release_asset` when this platform
 *  has no prebuilt. */
export async function provisionTurboquant(
  enginesRoot: string,
  repo: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const destDir = join(enginesRoot, 'turboquant')
  if (existsSync(destDir)) {
    const found = findServer(destDir)
    if (found) {
      // Strip quarantine even on the fast-path: a previous failed probe leaves the
      // directory intact with the quarantine attribute still set.
      stripMacOsQuarantine(destDir)
      return found
    }
  }
  const url = await turboquantAssetUrl(repo, process.platform, process.arch, signal)
  if (!url) throw new Error('no_release_asset')

  mkdirSync(destDir, { recursive: true })
  const fname = url.split('/').pop()?.split('?')[0] || 'turboquant-download.zip'
  const tmp = join(enginesRoot, fname)
  try {
    onProgress?.({ phase: 'downloading', pct: 0 })
    await downloadFile(url, tmp, onProgress, signal)
    onProgress?.({ phase: 'extracting', pct: -1 })
    await extractArchive(tmp, destDir)
    rmSync(tmp, { force: true })
  } catch (e) {
    rmSync(tmp, { force: true })
    rmSync(destDir, { recursive: true, force: true })
    throw e
  }

  const bin = findServer(destDir)
  if (!bin) throw new Error('llama-server not found in extracted TurboQuant archive')
  return bin
}
