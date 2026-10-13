// Default-engine provisioning (ADR-024 + ADR-025). On first run, download the
// official upstream llama.cpp prebuilt for the user's OS/arch + the **fastest
// backend their GPU supports** from GitHub Releases (ggml-org/llama.cpp) into
// the app-data engines dir. No bundling, no system paths, dependency-free
// (Node fetch; PowerShell Expand-Archive / tar for extraction). The user can
// override the backend; we fall back GPU → Vulkan → CPU if a build won't run.
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { getSysInfo, primaryVendor, type GpuVendor } from '../sysinfo/sysinfo'
// nvidia-smi and probe are leaf modules (the former imports only node builtins, the latter
// only config), so importing them keeps this module free of an import cycle.
import { driverMaxCuda, nvidiaComputeCaps } from './nvidia-smi'
import { listDevices } from './probe'
import { extractZipAll } from './zip-reader'

const execFileP = promisify(execFile)

/** Build standard GitHub API headers, injecting a token so authenticated requests
 *  get 5,000 req/hour instead of the 60/hour unauthenticated limit.
 *
 *  `tokenFn` is supplied by the caller (the daemon passes `() => cfg.gh.token`).
 *  An empty/unset token falls back to the `GITHUB_TOKEN` env var, preserving the old
 *  env-only path for local dev or container setups. Callers spread the result into
 *  their fetch() headers object. */
/** Ambient provider for the user's configured GitHub token, registered once at startup by
 *  {@link setGithubTokenProvider}. Without it, only call sites that explicitly threaded a
 *  `tokenFn` were authenticated — which meant a token saved in Settings raised the rate limit
 *  for the branch dropdown but NOT for engine update checks or downloads, so those kept
 *  failing at 60 requests/hour with a token sitting right there unused. */
let ambientTokenFn: (() => string) | null = null

/** Wire the config store into every GitHub call in the process. Called once during daemon
 *  startup; safe to call again (last registration wins). */
export function setGithubTokenProvider(fn: (() => string) | null): void {
  ambientTokenFn = fn
}

export function githubHeaders(
  extra?: Record<string, string>,
  tokenFn?: () => string,
): Record<string, string> {
  const base: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'turbollm',
  }
  // Explicit argument wins, then the user's configured token, then the env var. Each step is
  // guarded so a throwing/absent provider degrades to unauthenticated rather than breaking
  // the request outright.
  let token = ''
  try { token = tokenFn?.() ?? '' } catch { token = '' }
  if (!token) { try { token = ambientTokenFn?.() ?? '' } catch { token = '' } }
  if (!token) token = process.env.GITHUB_TOKEN?.trim() ?? ''
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
// cross-compiles it via the Android NDK (manually for now; the CI workflow for this was
// removed after it never passed) and hosts the archive as a plain file on this Hugging Face
// model repo, not a GitHub release — there's no "tag" to track, just whatever's at `main`.
const ANDROID_ENGINE_HF_URL = 'https://huggingface.co/mohitsoni48/turbollm-android-engine/resolve/main'
// CUDA toolkit line for Windows prebuilts (13.x is required for Blackwell / RTX 50xx).
const CUDA_VER = '13.3'

/** The server binary name for a platform: upstream names its Windows build `llama-server.exe`
 *  and every other build `llama-server`. Defaults to this daemon's OS. Take the platform as an
 *  argument whenever the question is about an ARCHIVE's platform rather than the machine's — an
 *  uploaded or downloaded zip can be for another OS (a Windows zip inspected on Linux, or the
 *  reverse), and looking for one name while filtering for the other silently finds nothing. */
export const serverBinNameFor = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'llama-server.exe' : 'llama-server'

const serverBin = serverBinNameFor()

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
  /** Overrides the whole GitHub-releases URL template with `${downloadBaseUrl}/${asset}` —
   *  for a backend hosted somewhere that isn't GitHub Releases at all (Android's engine is a
   *  plain file on a Hugging Face model repo's `resolve/main`, not a tagged release). Takes
   *  priority over `repo`/`releaseTag` when set. */
  downloadBaseUrl?: string
  /** Per-asset regex (parallel to `assets`) to resolve the REAL filename from the release's
   *  asset list at download time, instead of trusting the literal name in `assets[i]`. Set
   *  when upstream is known to rename this asset across releases without warning — llama.cpp
   *  renamed the Windows ROCm archive from `*-bin-win-hip-radeon-x64.zip` to
   *  `*-bin-win-rocm-<toolkit-ver>-x64.zip` mid-stream (GitHub #220), which turned every
   *  hardcoded filename into a 404 the moment the pinned/latest tag crossed that rename.
   *  `undefined` at an index keeps the old literal-URL behavior for that asset. */
  assetPatterns?: (RegExp | undefined)[]
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
      // Upstream has renamed this archive at least once (`*-bin-win-hip-radeon-x64.zip` →
      // `*-bin-win-rocm-<toolkit-ver>-x64.zip`, GitHub #220) without any deprecation window,
      // so the literal name below is only a fallback label — assetPatterns resolves the
      // real filename from the release's own asset list at download time and survives the
      // next rename too.
      {
        id: 'rocm',
        label: 'ROCm / HIP (AMD Radeon)',
        assets: [`llama-${tag}-bin-win-hip-radeon-x64.zip`],
        assetPatterns: [/^llama-.+-bin-win-(?:hip-radeon|rocm-[\d.]+)-x64\.zip$/i],
      },
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
  // Android: Node reports process.platform === 'android'. Upstream publishes NO prebuilt that
  // runs on Android — the Ubuntu binaries are glibc and won't load against Android's bionic
  // libc (GitHub #52 item 6 / ADR-390/391) — so TurboLLM cross-compiles its own via the
  // Android NDK and hosts it on ANDROID_ENGINE_HF_URL instead. CPU-only for v1 (see
  // CMAKE_CONFIGURE_ARGS_ANDROID in build-prereqs.ts for why); asset naming otherwise matches
  // every other platform's `llama-<tag>-bin-<os>-<arch>.tar.gz` convention.
  if (plat() === 'android') {
    return [
      {
        id: 'cpu',
        label: 'CPU',
        assets: [`llama-${tag}-bin-android-${a}.tar.gz`],
        downloadBaseUrl: ANDROID_ENGINE_HF_URL,
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
  fetchImpl: typeof fetch = fetch,
  /** The expected archive hash, verified as the body streams in; a mismatch deletes the file. */
  expectedSha256?: string,
): Promise<void> {
  const res = await fetchImpl(url, { redirect: 'follow', signal })
  if (!res.ok || !res.body) throw Object.assign(new Error(`download failed: HTTP ${res.status}`), { code: 'download_failed' })
  const total = Number(res.headers.get('content-length') ?? 0)
  const hash = expectedSha256 ? createHash('sha256') : null
  let got = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    hash?.update(chunk)
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
  // Integrity, when the release publishes GitHub's own `sha256:` asset digest: a 530 MB engine
  // archive is far too large to trust to a truncated-but-2xx response.
  if (expectedSha256 && hash && hash.digest('hex') !== expectedSha256.toLowerCase()) {
    rmSync(dest, { force: true })
    throw new Error('checksum_failed: the downloaded archive did not match the published sha256')
  }
}

export type ArchiveExtractor =
  | { kind: 'powershell' }
  | { kind: 'tar'; cmd: string; args: string[] }
  | { kind: 'node-zip' }
  | { kind: 'unsupported'; reason: string }

/** PURE: which tool extracts this archive on this platform. The archive's format decides, not
 *  just the OS: GNU tar (Linux, Termux) cannot read zip, and PowerShell's Expand-Archive cannot
 *  read tar.gz. Existing callers keep their tool: a Windows .zip is Expand-Archive, a POSIX
 *  .tar.gz/.tgz is `tar -xzf`. */
export function archiveExtractor(
  archive: string,
  destDir: string,
  platform: NodeJS.Platform,
  env: { SystemRoot?: string },
  exists: (path: string) => boolean,
): ArchiveExtractor {
  const name = archive.toLowerCase()
  if (name.endsWith('.zip')) return zipExtractor(archive, destDir, platform)
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return tarGzExtractor(archive, destDir, platform, env, exists)
  return { kind: 'unsupported', reason: `Unsupported archive format: ${basename(archive)}` }
}

function zipExtractor(archive: string, destDir: string, platform: NodeJS.Platform): ArchiveExtractor {
  if (platform === 'win32') return { kind: 'powershell' }
  if (platform === 'darwin') return { kind: 'tar', cmd: 'tar', args: ['-xf', archive, '-C', destDir] }
  return { kind: 'node-zip' }
}

function tarGzExtractor(
  archive: string,
  destDir: string,
  platform: NodeJS.Platform,
  env: { SystemRoot?: string },
  exists: (path: string) => boolean,
): ArchiveExtractor {
  const args = ['-xzf', archive, '-C', destDir]
  if (platform !== 'win32') return { kind: 'tar', cmd: 'tar', args }
  const systemTar = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  if (!exists(systemTar)) return { kind: 'unsupported', reason: 'This Windows install has no tar.exe, so a .tar.gz cannot be extracted.' }
  return { kind: 'tar', cmd: systemTar, args }
}

/**
 * Extract an archive into destDir with the tool `archiveExtractor` picks. A tool failure
 * (corrupt archive, a symlink Windows cannot create, a truncated file) becomes an Error with
 * code 'extract_failed'; a ZipError from the pure-Node zip path passes through unchanged.
 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  const extractor = archiveExtractor(archive, destDir, process.platform, process.env, existsSync)
  switch (extractor.kind) {
    case 'node-zip':
      extractZipAll(readFileSync(archive), destDir)
      break
    case 'unsupported':
      throw extractionError('unsupported_archive', extractor.reason)
    case 'powershell':
      await runExtractionTool(archive, 'powershell', powershellExpandArgs(archive, destDir), { maxBuffer: 16 * 1024 * 1024 })
      break
    case 'tar':
      await runExtractionTool(archive, extractor.cmd, extractor.args, {})
      break
  }
  stripMacOsQuarantine(destDir)
}

function powershellExpandArgs(archive: string, destDir: string): string[] {
  const ps = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
  return ['-NoProfile', '-NonInteractive', '-Command', ps]
}

async function runExtractionTool(archive: string, cmd: string, args: string[], options: { maxBuffer?: number }): Promise<void> {
  try {
    await execFileP(cmd, args, options)
  } catch (e) {
    const original = e instanceof Error ? e.message : String(e)
    throw extractionError('extract_failed', `Could not extract ${basename(archive)}: ${original.slice(0, 500)}`, e)
  }
}

function extractionError(code: 'extract_failed' | 'unsupported_archive', message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code })
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
  const tmpPaths: string[] = []
  try {
    for (let i = 0; i < parts; i++) {
      const part = i + 1
      const pattern = backend.assetPatterns?.[i]
      let assetName = backend.assets[i]
      let url: string
      if (backend.downloadBaseUrl) {
        url = `${backend.downloadBaseUrl}/${assetName}`
      } else {
        const repo = backend.repo ?? REPO
        const releaseTag = backend.releaseTag ?? tag
        if (pattern) {
          // The literal name in `assets[i]` is only a fallback label — upstream is known to
          // rename this asset across releases (GitHub #220), so resolve the real filename
          // from the release's own asset list instead of guessing it.
          const releaseAssets = await releaseAssetsForTag(repo, releaseTag, signal)
          const found = releaseAssets.find((a) => pattern.test(a.name))
          if (!found) throw new Error(`no release asset matching ${pattern} in ${repo}@${releaseTag}`)
          assetName = found.name
          url = found.browser_download_url
        } else {
          url = `https://github.com/${repo}/releases/download/${releaseTag}/${assetName}`
        }
      }
      const tmp = join(enginesRoot, assetName)
      tmpPaths.push(tmp)
      onProgress?.({ phase: 'downloading', pct: 0, part, parts })
      await downloadFile(url, tmp, (p) => onProgress?.({ ...p, part, parts }), signal)
      onProgress?.({ phase: 'extracting', pct: -1, part, parts })
      await extractArchive(tmp, destDir)
      rmSync(tmp, { force: true })
    }
  } catch (e) {
    // Cancelled or failed mid-download: remove partial archives + the half-built
    // backend dir so it isn't mistaken for an installed backend.
    for (const tmp of tmpPaths) rmSync(tmp, { force: true })
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
  /** GitHub's own `sha256:<hex>` for the asset, when the release publishes one (newer
   *  releases do; older ones and other hosts leave it null). Verified by `downloadFile`. */
  digest?: string | null
  size?: number
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
  published_at?: string
  prerelease?: boolean
  draft?: boolean
  assets?: ReleaseAsset[]
}

/** Resolve the latest GitHub release of `repo` (tag + assets) via the public API.
 *  Used by the honest update check (update.ts) to compare the installed tag against
 *  upstream. Throws on a non-2xx response (caller maps it to an offline/error state). */
/** Thrown when GitHub refuses a request because the API rate limit is exhausted, as opposed
 *  to any other failure. Callers distinguish it so the user is told the truth ("rate limit
 *  reached — add a token") instead of a misleading "offline": the machine has a perfectly good
 *  network connection, it has simply spent its 60 unauthenticated requests for the hour. */
export class GithubRateLimitError extends Error {
  constructor(repo: string) {
    super(`GitHub API rate limit exhausted while querying ${repo}`)
    this.name = 'GithubRateLimitError'
  }
}

/** Thrown when a release lookup SUCCEEDED but nothing in it can run on this machine — the
 *  distinct answer for "no prebuilt for your hardware". Kept apart from a transport failure so
 *  the update check reports `no_release_asset` instead of the misleading `offline`: the API
 *  answered, the machine is online, there is simply no build for it. */
export class NoReleaseAssetError extends Error {
  constructor(message = 'no_release_asset') {
    super(message)
    this.name = 'NoReleaseAssetError'
  }
}

/** GitHub signals an exhausted quota as 403 (primary limit) or 429 (secondary limit) with
 *  `x-ratelimit-remaining: 0`. A 403 WITHOUT that header is a genuine permission error and
 *  must stay a normal failure — never tell someone to fix a token that is already valid. */
export function isRateLimited(res: Response): boolean {
  return (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0'
}

export async function latestGithubRelease(repo: string, signal?: AbortSignal): Promise<GithubRelease> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(apiUrl, {
    headers: githubHeaders(),
    signal,
  })
  if (isRateLimited(res)) throw new GithubRateLimitError(repo)
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

/** Resolve the newest `b<number>`-style release tag (e.g. `b10818`) of `repo`, or '' when the
 *  repo publishes none.
 *
 *  Needed because llama.cpp tags EVERY build as `b#####` but also cuts occasional semver
 *  releases (`v0.4.0`) — and GitHub's `releases/latest` returns the semver one. An engine
 *  installed from a `b#####` build then gets compared against `v0.4.0`, the two formats are
 *  incomparable, and the update UI reports "update status unavailable" indefinitely even
 *  though hundreds of newer builds exist. Comparing like with like is the only honest answer.
 *
 *  Sorted by build NUMBER, not by release date or list order: releases are returned newest-
 *  first by creation time, which is not the same ordering as the build counter. */
export async function latestBuildTagRelease(repo: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: githubHeaders(),
    signal,
  })
  if (isRateLimited(res)) throw new GithubRateLimitError(repo)
  if (!res.ok) throw new Error(`could not list ${repo} releases: HTTP ${res.status}`)
  const data = (await res.json()) as { tag_name?: string }[]
  let best = ''
  let bestNum = -1
  for (const rel of data) {
    const tag = (rel.tag_name ?? '').trim()
    const m = /^v?b(\d+)$/i.exec(tag)
    if (!m) continue
    const n = Number(m[1])
    if (Number.isInteger(n) && n > bestNum) {
      bestNum = n
      best = tag
    }
  }
  return best
}

/** Resolve the asset list of ONE specific release of `repo` by its exact tag (as opposed to
 *  {@link latestGithubRelease}, which always resolves whichever release GitHub calls
 *  "latest"). Used to look up the real filename of an asset upstream is known to rename
 *  across releases (see {@link BackendDef.assetPatterns}) — provisioning always targets a
 *  specific tag (pinned, or the one the update check resolved), never just "latest". */
export async function releaseAssetsForTag(repo: string, tag: string, signal?: AbortSignal): Promise<ReleaseAsset[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(),
    signal,
  })
  if (isRateLimited(res)) throw new GithubRateLimitError(repo)
  if (!res.ok) throw new Error(`could not query ${repo} release ${tag}: HTTP ${res.status}`)
  const data = (await res.json()) as GithubRelease
  return data.assets ?? []
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
  if (isRateLimited(res)) throw new GithubRateLimitError(repo)
  if (!res.ok) throw new Error(`could not query ${repo} commits: HTTP ${res.status}`)
  const data = (await res.json()) as { sha?: string }
  return data.sha ?? ''
}


// TurboQuant (AtomicBot-ai/atomic-llama-cpp-turboquant) publishes one release per version,
// tagged `b<upstream build>-<semver>` (e.g. `b10298-2.0.0`), carrying every platform/backend
// as `llama-turboquant-<os>-<arch>[-<backend>].{tar.gz,zip}`. Until mid-2026 it instead cut one
// release PER PLATFORM (`turboquant-linux-x64-vulkan-<sha>`) with the same asset names, so the
// resolver matches on asset NAMES, never on tag shape: the newest release that has any asset
// this machine can run wins, and the old per-platform releases still resolve as a fallback.
// `dev-latest` is a rolling prerelease and is skipped.

/** What the TurboQuant variant choice depends on. `driverCuda` is the NVIDIA driver's max
 *  CUDA version from nvidia-smi ("13.4"), or null when it can't be read; `computeCaps` the
 *  compute capability of each NVIDIA GPU ([12.0] for an RTX 5090), [] when unknown. */
export interface TurboquantHw {
  platform: string
  arch: string
  vendor: GpuVendor
  hasGpu: boolean
  driverCuda: string | null
  computeCaps: number[]
}

/** One installable TurboQuant build: `name` is the asset stem after `llama-turboquant-`.
 *  `cudartPack` names an official llama.cpp runtime archive that must be extracted beside the
 *  binary — the fork's Windows CUDA 13.3 zip ships ggml-cuda.dll without cudart64_13 /
 *  cublas64_13 / cublasLt64_13 (its CUDA 12.4 zip and every Linux CUDA archive bundle them). */
export interface TurboquantVariant {
  name: string
  cudartPack?: string
}

const TQ_WIN_CUDA13_RUNTIME = 'cudart-llama-bin-win-cuda-13.3-x64.zip'

/** Upstream llama.cpp release whose assets carry {@link TQ_WIN_CUDA13_RUNTIME}. Pinned to its
 *  OWN constant, not LLAMA_BUILD: the pack's name is versioned (`…-cuda-13.3-…`), so it exists
 *  in only some upstream releases, and riding on LLAMA_BUILD meant an unrelated routine bump
 *  could start 404ing the Windows CUDA 13.3 install with nothing to catch it. The pack is
 *  resolved by NAME out of this tag's asset list, so a rename or removal fails loudly. */
const TQ_CUDART_TAG = 'b9608'

/** "13.4" ≥ "13.0"? Numeric major.minor compare; false for null/garbage. */
function cudaAtLeast(have: string | null, want: string): boolean {
  if (!have) return false
  const [hm, hn] = have.split('.').map(Number)
  const [wm, wn] = want.split('.').map(Number)
  if (!Number.isFinite(hm)) return false
  return hm !== wm ? hm > wm : (hn || 0) >= (wn || 0)
}

/** PURE: the TurboQuant builds this machine can run, best first. NVIDIA gets CUDA, gated on
 *  both the driver and the GPUs' compute capability:
 *   - the 13.3 build needs a CUDA 13 driver, and CUDA 13 dropped GPUs older than Turing (< 7.5);
 *   - the 12.4 build has no Blackwell kernels (≥ 10.0) — measured: it detects an RTX 5090,
 *     then aborts with a CUDA error in the first flash-attention launch.
 *  Unknown compute capabilities ([]) gate on the driver alone. With no usable CUDA build
 *  (old driver, unreadable nvidia-smi, or a mix of very old and very new GPUs) → Vulkan.
 *  AMD, Intel and other GPUs get Vulkan (the fork's ROCm archive relies on a system ROCm
 *  install we can't verify); no GPU gets the CPU build. Empty → no prebuilt for this platform
 *  (→ build from source). */
export function turboquantCandidates(hw: TurboquantHw): TurboquantVariant[] {
  const arch = hw.arch === 'arm64' ? 'arm64' : 'x64'
  if (hw.platform === 'darwin') return arch === 'arm64' ? [{ name: 'macos-arm64' }] : []
  const os = hw.platform === 'win32' ? 'windows' : hw.platform === 'linux' ? 'linux' : null
  if (!os) return []
  const out: TurboquantVariant[] = []
  if (hw.vendor === 'nvidia') {
    const caps = hw.computeCaps
    const cuda13Gpus = caps.every((c) => c >= 7.5)
    const cuda12Gpus = caps.every((c) => c < 10)
    if (cuda13Gpus && cudaAtLeast(hw.driverCuda, '13.0')) {
      out.push(os === 'windows'
        ? { name: `windows-${arch}-cuda-13.3`, cudartPack: TQ_WIN_CUDA13_RUNTIME }
        : { name: `linux-${arch}-cuda-13.3` })
    }
    if (arch === 'x64' && cuda12Gpus && cudaAtLeast(hw.driverCuda, '12.4')) out.push({ name: `${os}-x64-cuda-12.4` })
  }
  // The fork only ships CUDA 12.4/Vulkan/CPU builds for x64; arm64 Linux has CUDA 13.3 only.
  if (arch === 'x64') out.push(hw.hasGpu ? { name: `${os}-x64-vulkan` } : { name: `${os}-x64-cpu` })
  return out
}

export interface TurboquantResolution {
  tag: string
  variant: TurboquantVariant
  assetName: string
  url: string
  /** GitHub's `sha256:<hex>` for the asset, when the release publishes one — what
   *  `provisionTurboquant` hands to `downloadFile` to verify. */
  digest?: string
}

/** PURE: a fork release tag `b<upstream build>-<semver>` split into its parts
 *  (`b10298-2.0.0` → build 10298, semver [2,0,0]). null for the fork's earlier per-platform
 *  tags (`turboquant-linux-x64-vulkan-<sha>`), which carry no version at all. */
export function parseTurboquantReleaseTag(tag: string): { build: number; semver: number[] } | null {
  const m = /^b(\d+)-(\d+(?:\.\d+)*)$/i.exec(tag.trim())
  return m ? { build: Number(m[1]), semver: m[2].split('.').map(Number) } : null
}

/** PURE: numeric compare of two dotted versions ("1.7.1" vs "1.7.0"); a missing part counts
 *  as 0, so "2.0" and "2.0.0" are equal. */
function cmpDotted(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** PURE: which of two fork release tags is newer (-1 = `a` older, 1 = `a` newer, 0 = equal or
 *  unorderable). The fork's semver decides first, then the upstream build — the same rule
 *  update.ts's `compareTurboquantTags` applies to an installed tag, so the release an install
 *  picks and the release the update check compares against cannot disagree. Legacy
 *  per-platform tags (see {@link parseTurboquantReleaseTag}) have no version and sort BELOW
 *  every `b<build>-<semver>` tag; two of them are equal, keeping the API's order between them. */
export function compareTurboquantReleaseTags(a: string, b: string): number {
  const pa = parseTurboquantReleaseTag(a)
  const pb = parseTurboquantReleaseTag(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  const bySemver = cmpDotted(pa.semver, pb.semver)
  if (bySemver !== 0) return bySemver
  return pa.build === pb.build ? 0 : pa.build < pb.build ? -1 : 1
}

/** PURE: every install attempt for this machine, best first — each candidate that has an asset
 *  in the NEWEST release carrying any of them, in candidate order (the fork ships every
 *  platform/backend in one release, so the alternates come from that same tag). Empty when no
 *  release fits this OS/arch/GPU.
 *
 *  "Newest" is the HIGHEST tag, not the first one the API lists: GitHub orders releases by
 *  creation time, so a patch cut for an older line (`b10269-1.7.1`, published after
 *  `b10298-2.0.0`) would otherwise win every resolution and silently downgrade both fresh
 *  installs and explicit updates. Same trap the llama.cpp build-tag resolver documents. */
export function turboquantInstallPlan(
  releases: GithubRelease[],
  candidates: TurboquantVariant[],
  platform: string,
): TurboquantResolution[] {
  const exts = platform === 'win32' ? ['.zip', '.tar.gz'] : ['.tar.gz', '.zip']
  const assetOf = (rel: GithubRelease, name: string) =>
    exts.map((ext) => rel.assets?.find((a) => a.name === `llama-turboquant-${name}${ext}`)).find(Boolean)
  let best: GithubRelease | null = null
  for (const rel of releases) {
    if (rel.draft || rel.prerelease || !rel.tag_name) continue
    if (!candidates.some((v) => assetOf(rel, v.name))) continue
    if (!best?.tag_name || compareTurboquantReleaseTags(rel.tag_name, best.tag_name) > 0) best = rel
  }
  if (!best?.tag_name) return []
  const release = best
  const tag: string = best.tag_name
  const out: TurboquantResolution[] = []
  const push = (variant: TurboquantVariant) => {
    const asset = assetOf(release, variant.name)
    if (asset) out.push({ tag, variant, assetName: asset.name, url: asset.browser_download_url, digest: asset.digest ?? undefined })
  }
  for (const variant of candidates) push(variant)
  // CPU is the fork's x64 last resort, appended AFTER every GPU-capable build: it is only
  // worth its download once the GPU builds have failed to come up, and it is what keeps a
  // machine whose GPU backend won't load from ending up with no engine at all. (An x64
  // machine with no GPU already has it first, from turboquantCandidates.)
  const os = platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : null
  const cpuLastResort = os && candidates.some((c) => c.name.includes('-x64-')) ? `${os}-x64-cpu` : null
  if (cpuLastResort && !out.some((r) => r.variant.name === cpuLastResort)) push({ name: cpuLastResort })
  return out
}

/** PURE: the single best TurboQuant build for this machine, or null when none fits. This is the
 *  update check's answer, which only needs the tag an install would actually land on. */
export function resolveTurboquantRelease(
  releases: GithubRelease[],
  candidates: TurboquantVariant[],
  platform: string,
): TurboquantResolution | null {
  return turboquantInstallPlan(releases, candidates, platform)[0] ?? null
}

/** Memo of {@link detectTurboquantHw} for the process lifetime — see that function. */
let turboquantHwMemo: Promise<TurboquantHw> | null = null

/** This machine's {@link TurboquantHw}, resolved ONCE per process and reused. Each resolution
 *  spawns `nvidia-smi` twice with an 8 s timeout apiece, and the daemon re-runs the update
 *  check on a timer, so re-deriving it per call was pure waste. Process-lifetime caching is
 *  the deliberate tradeoff: a driver or GPU swapped in while the daemon runs is picked up on
 *  the next restart, not mid-process — EXCEPT when the probe came back without a driver
 *  version on an NVIDIA box, which is a failed probe rather than a machine description, and is
 *  re-run on the next call. `probe` is the test seam for that policy (production callers pass
 *  nothing); {@link resetTurboquantHwCache} drops the memo outright. */
export function detectTurboquantHw(probe: () => Promise<TurboquantHw> = detectTurboquantHwUncached): Promise<TurboquantHw> {
  if (!turboquantHwMemo) {
    const pending = probe()
    turboquantHwMemo = pending
    // An NVIDIA box whose driver version we could not read (nvidia-smi timed out, or the
    // driver was mid-update) is not a stable answer: caching it would pin this machine to
    // Vulkan — and, through needsTurboquantReprovision, could replace a working CUDA install —
    // for the daemon's lifetime. Drop it once it settles so the next caller re-probes.
    void pending.then(
      (hw) => { if (hw.vendor === 'nvidia' && hw.driverCuda === null) turboquantHwMemo = null },
      () => { turboquantHwMemo = null },
    )
  }
  return turboquantHwMemo
}

/** Drop the memoized hardware (tests, and any caller that must re-probe on purpose). */
export function resetTurboquantHwCache(): void {
  turboquantHwMemo = null
}

async function detectTurboquantHwUncached(): Promise<TurboquantHw> {
  const info = getSysInfo()
  const vendor = primaryVendor(info)
  let driverCuda: string | null = null
  let computeCaps: number[] = []
  if (vendor === 'nvidia') [driverCuda, computeCaps] = await Promise.all([driverMaxCuda(), nvidiaComputeCaps()])
  return { platform: process.platform, arch: process.arch, vendor, hasGpu: info.gpus.length > 0, driverCuda, computeCaps }
}

/** A repo's releases, in GitHub's own (creation-time) order, following pagination until a short
 *  page comes back. The fork publishes ~a dozen releases today, but a repo that grows past 100
 *  would otherwise silently hide its newest tag from every resolver here. */
async function listGithubReleases(repo: string, signal?: AbortSignal, maxPages = 3): Promise<GithubRelease[]> {
  const out: GithubRelease[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: githubHeaders(),
      signal,
    })
    if (isRateLimited(res)) throw new GithubRateLimitError(repo)
    if (!res.ok) throw new Error(`could not list ${repo} releases: HTTP ${res.status}`)
    const batch = (await res.json()) as GithubRelease[]
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

/** The ordered TurboQuant install plan for `hw`: every candidate the newest fitting release
 *  carries, best first. Empty when nothing fits this machine. Shared by the install, the
 *  update apply AND the update check, so the check can never offer a tag the apply wouldn't
 *  install (see latestTagForInstalled for how that once went wrong). */
export async function fetchTurboquantPlan(repo: string, hw: TurboquantHw, signal?: AbortSignal): Promise<TurboquantResolution[]> {
  return turboquantInstallPlan(await listGithubReleases(repo, signal), turboquantCandidates(hw), hw.platform)
}

/** True when `dir` holds a CUDA backend without its runtime beside it — what an install
 *  interrupted between the Windows CUDA 13.3 binary and its runtime pack leaves behind. Run
 *  like that, ggml can't load the CUDA backend and silently falls back to CPU. */
function cudaRuntimeMissing(dir: string): boolean {
  try {
    const files = readdirSync(dir)
    const hasCudaBackend = files.some((f) => /^(?:lib)?ggml-cuda\.(?:dll|so)$/i.test(f))
    const hasRuntime = files.some((f) => /^cudart64_\d+\.dll$|^libcudart\.so/i.test(f))
    return hasCudaBackend && !hasRuntime
  } catch {
    return false
  }
}

/** The provision marker's contents. `variant` is what makes a driver/GPU change detectable:
 *  see {@link needsTurboquantReprovision}. */
export interface TurboquantMarker {
  tag?: string
  variant?: string
  assets?: string[]
  backfilled?: boolean
}

/** Read the provision marker from a build dir, or null when absent/unreadable. */
function readTurboquantMarker(destDir: string): TurboquantMarker | null {
  try {
    return JSON.parse(readFileSync(join(destDir, PROVISION_MARKER), 'utf8')) as TurboquantMarker
  } catch {
    return null
  }
}

/** The installed TurboQuant server under `destDir`, or null when absent or incomplete. A
 *  marker-less dir (installed before the marker existed) counts unless its CUDA runtime is
 *  missing; the marker is backfilled so this is derived once. */
function installedTurboquant(destDir: string): string | null {
  const bin = findServer(destDir)
  if (!bin) return null
  if (existsSync(join(destDir, PROVISION_MARKER))) return bin
  if (cudaRuntimeMissing(dirname(bin))) return null
  try { writeFileSync(join(destDir, PROVISION_MARKER), JSON.stringify({ backfilled: true })) } catch { /* re-derived next time */ }
  return bin
}

/** PURE: the compute-backend family a variant name names (`linux-x64-cuda-13.3` → `cuda`), or
 *  null when the name carries no backend suffix (the macOS archive, which is Metal). */
function turboquantBackend(name: string): string | null {
  if (/macos/i.test(name)) return 'metal'
  return /-(cuda-[\d.]+|rocm|vulkan|cpu)$/i.exec(name)?.[1]?.split('-')[0]?.toLowerCase() ?? null
}

/** The `--list-devices` name prefixes that prove a variant's backend loaded, or null when
 *  there is nothing to prove (the CPU build). Prefixes, not equality, because ggml appends the
 *  device index (`CUDA0`, `Vulkan0`, `MTL0`) and HIP builds report either ROCm or HIP. */
function loadedDevicePrefixes(name: string): string[] | null {
  switch (turboquantBackend(name)) {
    case 'cuda': return ['cuda']
    case 'rocm': return ['rocm', 'hip', 'roc']
    case 'vulkan': return ['vulkan']
    case 'metal': return ['mtl', 'metal']
    default: return null
  }
}

/** Whether the freshly installed binary actually LOADS the backend its variant promises. The
 *  failure this catches is silent: the process starts, no GPU device appears, and ggml runs on
 *  the CPU without an error (the unverified Windows CUDA 13.3 path; a CUDA 12.4 build on a GPU
 *  whose kernels it lacks). null from `listDevices` means the output format wasn't recognised,
 *  which counts as "cannot tell" → true: we only reject a build when the binary DID print a
 *  device list and our backend wasn't in it. */
async function backendLoads(bin: string, variant: TurboquantVariant): Promise<boolean> {
  const want = loadedDevicePrefixes(variant.name)
  if (!want) return true
  const devices = await listDevices(bin)
  if (devices === null) return true
  return devices.some((d) => want.some((p) => d.toLowerCase().startsWith(p)))
}

/** PURE: whether an already-installed build has to be replaced because this machine can no
 *  longer run it — the marker records the variant we installed, and no candidate of the same
 *  backend family is on offer today. In practice only the CUDA families can drop out (the GPU
 *  was swapped for another vendor's, or for a generation the build has no kernels for); a
 *  Vulkan/CPU/Metal build runs anywhere its platform allows and is never replaced, and neither
 *  is an install on a machine whose GPU has merely stopped being visible: candidates collapse
 *  to the CPU build then, and an unreadable `nvidia-smi` must never delete a working GPU
 *  install. `hw` makes the same call for the other shape of an unreadable probe — an NVIDIA
 *  machine whose DRIVER VERSION could not be read (the GPU is still visible, so the candidates
 *  collapse to Vulkan, which would replace a working CUDA build on a failed probe).
 *  Marker-less installs have nothing to compare and are left alone too. */
export function needsTurboquantReprovision(
  marker: TurboquantMarker | null,
  candidates: TurboquantVariant[],
  hw?: TurboquantHw,
): boolean {
  const installed = marker?.variant ? turboquantBackend(marker.variant) : null
  if (!installed || installed === 'cpu') return false
  if (candidates.length === 1 && turboquantBackend(candidates[0].name) === 'cpu') return false
  // "The driver version is unknown" is not "there is no CUDA build for this machine": on an
  // NVIDIA box that is the probe having failed, and acting on it costs the user their CUDA
  // install (and a ~500 MB Vulkan download) until nvidia-smi answers again.
  if (hw?.vendor === 'nvidia' && hw.driverCuda === null) return false
  return !candidates.some((c) => turboquantBackend(c.name) === installed)
}

/** The bare hex from GitHub's `sha256:<hex>` asset digest, or undefined when it isn't one. */
function sha256Of(digest?: string): string | undefined {
  return digest?.startsWith('sha256:') ? digest.slice('sha256:'.length) : undefined
}

/** The upstream runtime pack named `packName`, looked up by NAME in its pinned tag's asset list
 *  so both the URL and the published sha256 come from the API instead of a hand-built path. */
async function runtimePackArchive(packName: string, signal?: AbortSignal): Promise<{ name: string; url: string; sha256?: string }> {
  const asset = (await releaseAssetsForTag(REPO, TQ_CUDART_TAG, signal)).find((a) => a.name === packName)
  if (!asset) throw new Error(`no_release_asset: ${REPO}@${TQ_CUDART_TAG} does not carry ${packName}`)
  return { name: asset.name, url: asset.browser_download_url, sha256: sha256Of(asset.digest ?? undefined) }
}

/** Download + extract ONE planned variant into `destDir` and return its server binary. The
 *  provision marker is written only once every archive is in place, so an install interrupted
 *  between the binary and its runtime pack is never mistaken for a complete one. */
async function installTurboquantVariant(
  enginesRoot: string,
  destDir: string,
  resolved: TurboquantResolution,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const archives: { name: string; url: string; sha256?: string }[] = [
    { name: resolved.assetName, url: resolved.url, sha256: sha256Of(resolved.digest) },
  ]
  if (resolved.variant.cudartPack) archives.push(await runtimePackArchive(resolved.variant.cudartPack, signal))
  // Older fork releases publish no per-asset digest, so a download from them is size-checked
  // but not checksum-verified. Say so instead of implying a guarantee that isn't there.
  for (const archive of archives) {
    if (!archive.sha256) console.warn(`[turboquant] ${archive.name} carries no published sha256 — this download cannot be checksum-verified`)
  }

  mkdirSync(destDir, { recursive: true })
  const parts = archives.length
  const tmpPaths: string[] = []
  try {
    for (const [i, archive] of archives.entries()) {
      const part = i + 1
      const tmp = join(enginesRoot, archive.name)
      tmpPaths.push(tmp)
      onProgress?.({ phase: 'downloading', pct: 0, part, parts })
      await downloadFile(archive.url, tmp, (p) => onProgress?.({ ...p, part, parts }), signal, fetch, archive.sha256)
      onProgress?.({ phase: 'extracting', pct: -1, part, parts })
      // The runtime pack's DLLs sit at its root; Windows only searches the exe's own dir.
      const bin = i === 0 ? null : findServer(destDir)
      await extractArchive(tmp, bin ? dirname(bin) : destDir)
      rmSync(tmp, { force: true })
    }
  } catch (e) {
    for (const tmp of tmpPaths) rmSync(tmp, { force: true })
    rmSync(destDir, { recursive: true, force: true })
    throw e
  }

  const bin = findServer(destDir)
  if (!bin) throw new Error('llama-server not found in extracted TurboQuant archive')
  // A `.tar.gz` carries the mode, but the pure-Node zip path writes plain files (the same
  // reason release-install.ts chmods after extracting) — a Linux machine falling back to a
  // .zip asset would otherwise get a binary it cannot run.
  if (process.platform !== 'win32') chmodSync(bin, 0o755)
  writeFileSync(
    join(destDir, PROVISION_MARKER),
    JSON.stringify({ tag: resolved.tag, variant: resolved.variant.name, assets: archives.map((a) => a.name) }),
  )
  return bin
}

/** Swap a fully-installed staging dir in as the live install: park the old dir, rename the new
 *  one in, then delete the old — never a moment where neither exists, and the parked dir is
 *  renamed back if the swap itself fails (on Windows a just-probed .exe can stay locked by
 *  antivirus for a moment: EPERM/EBUSY). Mirrors zip-install's promoteProbedInstall. */
function promoteTurboquantStaging(enginesRoot: string, stageDir: string, destDir: string): void {
  const parked = existsSync(destDir) ? join(enginesRoot, 'build', `.turboquant-${randomUUID().slice(0, 8)}.old`) : null
  if (parked) renameSync(destDir, parked)
  try {
    renameSync(stageDir, destDir)
  } catch (e) {
    if (parked) renameSync(parked, destDir)
    throw e
  }
  if (parked) {
    try {
      rmSync(parked, { recursive: true, force: true })
    } catch {
      /* best effort — the new install is already in place */
    }
  }
}

/** Provision TurboQuant's prebuilt `llama-server` into `<enginesRoot>/turboquant/`: resolve the
 *  newest release that fits this machine, then download → extract (plus the CUDA runtime pack
 *  when the variant needs one) → locate → verify the backend it promised actually loads.
 *
 *  The plan is walked in order, so a build that installs but whose backend doesn't come up
 *  falls through to the next candidate (CUDA 13.3 → CUDA 12.4 → Vulkan → CPU), and the LAST
 *  candidate is kept with a warning rather than thrown away: a machine with nothing left to
 *  try is better off with a build that runs (ggml falls back to the CPU) than with no engine
 *  at all. Throws `no_release_asset` when no prebuilt fits at all.
 *
 *  `force` re-installs even though a complete install is already there — what the update path
 *  wants, having already decided the installed tag is behind. It still resolves before deleting
 *  anything, and every candidate is built and checked in a staging dir that is only swapped in
 *  once it passed, so a failed forced update leaves the old build exactly where it was. */
export async function provisionTurboquant(
  enginesRoot: string,
  repo: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
  hw?: TurboquantHw,
  force = false,
): Promise<string> {
  const destDir = join(enginesRoot, 'turboquant')
  const hardware = hw ?? (await detectTurboquantHw())
  const existing = installedTurboquant(destDir)
  if (existing && !force && !needsTurboquantReprovision(readTurboquantMarker(destDir), turboquantCandidates(hardware), hardware)) {
    // Strip quarantine even on the fast-path: a previous failed probe leaves the
    // directory intact with the quarantine attribute still set.
    stripMacOsQuarantine(destDir)
    return existing
  }
  // Resolve BEFORE removing anything: a lookup that fails (offline, rate-limited) must not
  // destroy an install that is sitting there working.
  const plan = await fetchTurboquantPlan(repo, hardware, signal)
  if (!plan.length) throw new NoReleaseAssetError()
  // Each candidate is downloaded, extracted and backend-checked in a hidden staging sibling
  // (the probe runs against the staging path), and only the winner is swapped in — so a
  // download, checksum, extraction or backend failure on EVERY candidate leaves the working
  // install untouched. The install dir used to be removed up front and again per failure,
  // which is how a failed forced update took the engine away with it, leaving the registry
  // pointing at a binary that no longer existed.
  // Staged under build/ in the `.stage` convention release-install and zip-install use: same
  // naming, same volume (so the final rename is atomic), and gcAbandonedZipInstalls sweeps one
  // a hard kill left behind — age alone decides, since a staging dir never holds a registered
  // binary.
  const stageDir = join(enginesRoot, 'build', `.turboquant-${randomUUID().slice(0, 8)}.stage`)
  let lastError: unknown = null
  try {
    for (const [i, resolved] of plan.entries()) {
      try {
        rmSync(stageDir, { recursive: true, force: true })
        const stagedBin = await installTurboquantVariant(enginesRoot, stageDir, resolved, onProgress, signal)
        if (!(await backendLoads(stagedBin, resolved.variant))) {
          const backend = turboquantBackend(resolved.variant.name)
          // Not the last candidate: fall through to the next one. The last one is kept — the
          // CPU-family variants pass this check by definition, so what lands here is a GPU
          // build on a machine with no fallback left.
          if (i < plan.length - 1) {
            throw new Error(`the ${resolved.variant.name} build did not load its ${backend} backend`)
          }
          console.warn(`[turboquant] ${resolved.variant.name} is the last build available for this machine and its ${backend} backend did not come up — keeping it (ggml will fall back to the CPU)`)
        }
        promoteTurboquantStaging(enginesRoot, stageDir, destDir)
        const bin = findServer(destDir)
        if (!bin) throw new Error('llama-server vanished from the TurboQuant install dir after the swap')
        return bin
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        lastError = e
      }
    }
    throw new Error(
      `no TurboQuant build for this machine worked (tried ${plan.map((p) => p.variant.name).join(', ')}): ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  } finally {
    rmSync(stageDir, { recursive: true, force: true }) // a no-op once it was renamed into place
  }
}
