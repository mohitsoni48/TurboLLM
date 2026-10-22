// Default-engine provisioning (ADR-024 + ADR-025). On first run, download the
// official upstream llama.cpp prebuilt for the user's OS/arch + the **fastest
// backend their GPU supports** from GitHub Releases (ggml-org/llama.cpp) into
// the app-data engines dir. No bundling, no system paths, dependency-free
// (Node fetch; PowerShell Expand-Archive / tar for extraction). The user can
// override the backend; we fall back GPU → Vulkan → CPU if a build won't run.
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, join, relative, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tetheredExecFile } from '../util/tether'
import type { GpuVendor } from '../sysinfo/sysinfo'
import { quotePowerShellArg } from '../util/shell-command'
import { extractZipAll } from './zip-reader'

// Tied to the daemon (util/tether.ts): an extraction the daemon does not live to see ends with it. Its errors
// name the real program (tar, powershell), as execFile's did.
const execFileP = tetheredExecFile({ kind: 'extract' })

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
    // Synchronous on the daemon's event loop, so bounded: a large engine tree on a slow disk held the daemon for as
    // long as the filesystem took. What xattr prints is not the daemon's to log (execFileSync passes stderr on).
    execFileSync('xattr', ['-r', '-d', 'com.apple.quarantine', dir], { timeout: 30_000, stdio: 'ignore' })
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

/** Why an update must not replace an engine's files right now (a model was started on it during the download), or
 *  null. Re-run right before the swap; a refusal throws with code `engine_in_use` and leaves the old files. */
export type SwapGuard = () => string | null

function throwIfSwapBlocked(blockSwap: SwapGuard | undefined): void {
  const blocked = blockSwap?.()
  if (blocked) throw Object.assign(new Error(blocked), { code: 'engine_in_use' })
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  opts: { blockSwap?: SwapGuard } = {},
): Promise<void> {
  const res = await fetchImpl(url, { redirect: 'follow', signal })
  if (!res.ok || !res.body) throw Object.assign(new Error(`download failed: HTTP ${res.status}`), { code: 'download_failed' })
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
  // Stream into a sibling `.part` and rename only once the whole body arrived. Written straight to
  // `dest`, a dropped connection or a quit left a truncated file there — and KoboldCpp/llamafile
  // treat an existing binary as installed, so the next Install registered the broken one.
  const part = `${dest}.part`
  try {
    await pipeline(body, createWriteStream(part), { signal })
    // An update replaces the binary an engine runs from. Its caller stopped the engine before the download, which
    // takes minutes: a model loaded on it meanwhile would have its executable replaced under it (on Windows the
    // rename fails after ~3 s with a bare EPERM instead of saying what to do).
    throwIfSwapBlocked(opts.blockSwap)
    await renameWithRetry(part, dest)
  } catch (e) {
    // Best effort: AV/the indexer can hold the fresh .part on Windows, and a throw here would replace e
    // (a Cancel's AbortError would become a failure). A leftover .part is truncated by the next download.
    try {
      rmSync(part, { force: true })
    } catch {
      /* best effort */
    }
    throw e
  }
}

/** renameSync, retried for ~3 s on Windows. Windows refuses to rename a directory while any file
 *  under it is open (whatever the share mode, surfaced as EPERM; EACCES/EBUSY likewise), and
 *  real-time AV and the search indexer open freshly written files for a moment — exactly what a
 *  just-staged install or download is (graceful-fs retries its win32 renames for the same reason).
 *  POSIX rename ignores open handles, so elsewhere a failure is real and thrown at once. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let delay = 100; ; delay *= 2) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || delay > 1600 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

/** The release tag a single-binary engine (KoboldCpp, llamafile) was downloaded as, recorded
 *  beside it by {@link recordReleaseTag}; '' for an install that predates the record. */
export function recordedReleaseTag(binPath: string): string {
  try {
    return readFileSync(`${binPath}.version`, 'utf8').trim()
  } catch {
    return ''
  }
}

export function recordReleaseTag(binPath: string, tag: string): void {
  try {
    writeFileSync(`${binPath}.version`, `${tag}\n`)
  } catch {
    /* best effort — it only labels the version */
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
  // Pinned like Windows' System32 tar.exe: only bsdtar reads zip, and a GNU tar first on PATH
  // (Homebrew's gnubin) would fail every .zip. /usr/bin/tar on macOS is always bsdtar.
  if (platform === 'darwin') return { kind: 'tar', cmd: '/usr/bin/tar', args: ['-xf', archive, '-C', destDir] }
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
      await extractZipAll(await readFile(archive), destDir)
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

/** PURE: the `powershell -Command` arguments that run Expand-Archive. The paths go through quotePowerShellArg:
 *  escaping only the ASCII ' left a typographic one (U+2018-U+201B, which PowerShell also reads as a single quote)
 *  to end the string early, so a data dir under a profile such as C:\Users\O’Brien failed every .zip extraction
 *  with "The path '...\O' either does not exist". Exported for its test, which needs no Windows. */
export function powershellExpandArgs(archive: string, destDir: string): string[] {
  const ps = `Expand-Archive -LiteralPath ${quotePowerShellArg(archive)} -DestinationPath ${quotePowerShellArg(destDir)} -Force`
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

/** Delete what a failed or cancelled install left (a partial archive, a half-extracted dir, a stage) on the way out
 *  of a catch or finally. With retries, since on Windows AV/the indexer briefly holds files that were extracted
 *  moments ago, and never throwing: a throw there replaces the error in flight, so a Cancel's AbortError (a quiet
 *  cancel) or the extraction's own error was reported as "Could not install …: EBUSY". A leftover archive or stage
 *  is replaced or cleared by the next install (downloadFile's own .part cleanup works the same way). A leftover
 *  install dir may not be: provisionBackend takes a markerless non-CUDA dir that holds llama-server for an older
 *  install, and provisionTurboquant any dir that holds one. That gap is older; the delete that threw left it too. */
function removeAfterFailure(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* best effort */
  }
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
    // backend dir so it isn't mistaken for an installed backend. Best effort, as
    // removeAfterFailure says: a throw here replaced e, so a Cancel became a failure.
    for (const tmp of tmpPaths) removeAfterFailure(tmp)
    removeAfterFailure(destDir)
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

/** Written into the working TurboQuant install right before an update parks it at .turboquant-old, and removed once
 *  the new install passed `verify`: while the parked install carries it, the update that parked it never finished and
 *  it is still the working build. */
const TURBOQUANT_UPDATE_INCOMPLETE_MARKER = '.turbollm-update-incomplete'

/** Best effort, with retries (Windows AV/indexer locks are brief). A marker left in turboquant/ itself is never read
 *  (only a parked install's is), and the next park writes it anew. */
function clearTurboquantUpdateMarker(dir: string): void {
  try {
    rmSync(join(dir, TURBOQUANT_UPDATE_INCOMPLETE_MARKER), { force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* best effort */
  }
}

/** Put the parked TurboQuant install back when an update was cut off (the daemon exited or died) after parking it at
 *  .turboquant-old and before the new install passed its probe: between the two renames (no install in place), or
 *  while the new one was probed. Nothing did, so the engine stayed on a build that never ran here, its only working
 *  build in a hidden folder, and the next update took that folder for a leftover and deleted it. Such a parked
 *  install still carries TURBOQUANT_UPDATE_INCOMPLETE_MARKER; the unverified install beside it is moved into the
 *  update's stage, which the next update clears first. A parked install without the marker is a leftover whose
 *  delete failed after its update passed, left for the next update to delete: also when turboquant/ is gone beside
 *  it (a Purge renames away only that), where putting it back would show TurboQuant installed again and hand its old
 *  binary to the next Install instead of a download. A rename that fails leaves everything for the next call. Runs
 *  at boot and at the start of every update and Install; returns false when the parked install is still the working
 *  build and could not be put back. */
export function restoreInterruptedTurboquantUpdate(enginesRoot: string): boolean {
  const destDir = join(enginesRoot, 'turboquant')
  const parked = join(enginesRoot, '.turboquant-old')
  if (!existsSync(join(parked, TURBOQUANT_UPDATE_INCOMPLETE_MARKER))) return true
  try {
    if (existsSync(destDir)) {
      const stageRoot = join(enginesRoot, '.turboquant-update')
      mkdirSync(stageRoot, { recursive: true })
      renameSync(destDir, join(stageRoot, `unverified-${Date.now()}`))
    }
    renameSync(parked, destDir)
  } catch {
    return false
  }
  clearTurboquantUpdateMarker(destDir)
  return true
}

/** Provision TurboQuant's prebuilt `llama-server` into `<enginesRoot>/turboquant/`,
 *  resolving the right per-platform source (HF on Windows, GitHub elsewhere) via the
 *  download → extract → locate pipeline. Throws `no_release_asset` when this platform
 *  has no prebuilt. `replace` (an update) fetches the latest even when an install exists:
 *  it is extracted into a staging dir and swapped in only once it holds a llama-server,
 *  so a failed lookup, download or extract leaves the working install untouched.
 *  `verify` (an update only) runs with the new install in place and the old one still
 *  parked; when it throws (the caller probes the new binary there and registers it), the
 *  new install is moved out and the old one put back, so a build that does not run here
 *  never replaces one that does. An update cut off before verify passed is put back at the
 *  next start, or by the next update or Install first ({@link restoreInterruptedTurboquantUpdate}).
 *  `blockSwap` (an update only) re-runs right before the swap. */
export async function provisionTurboquant(
  enginesRoot: string,
  repo: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
  opts: { replace?: boolean; verify?: (bin: string) => Promise<void>; blockSwap?: SwapGuard } = {},
): Promise<string> {
  const destDir = join(enginesRoot, 'turboquant')
  // An update cut off before its new build passed the probe left the working build parked: put it back first. An
  // update's leftover delete below would take it. An Install (after a boot that could not move it back, turboquant/
  // gone, its entry left on the missing binary) downloaded beside it, and the next start swapped that download out for
  // it. When it cannot be put back it is still the only working build, so stop.
  if (!restoreInterruptedTurboquantUpdate(enginesRoot)) {
    throw new Error(
      `An earlier TurboQuant update was cut short and its working build, kept at ${join(enginesRoot, '.turboquant-old')}, ` +
        'could not be moved back yet. Try again in a moment.',
    )
  }
  if (opts.replace) {
    // Provision into a staging root exactly as a first install would, then swap the dirs.
    const stageRoot = join(enginesRoot, '.turboquant-update')
    const stagedDir = join(stageRoot, 'turboquant')
    rmSync(stageRoot, { recursive: true, force: true }) // a stale stage from an interrupted update
    try {
      const stagedBin = await provisionTurboquant(stageRoot, repo, onProgress, signal)
      // The download took minutes: a model loaded on the engine meanwhile must not have its files swapped under it.
      throwIfSwapBlocked(opts.blockSwap)
      const parked = existsSync(destDir) ? join(enginesRoot, '.turboquant-old') : null
      if (parked) {
        // A leftover of an earlier update whose delete below failed. Retries: Windows AV/indexer locks are brief.
        rmSync(parked, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        // Parked, it stays the working build until the new one passed verify below: marked first, so the next start
        // (or update) puts it back when the daemon exits or dies before then (restoreInterruptedTurboquantUpdate).
        writeFileSync(join(destDir, TURBOQUANT_UPDATE_INCOMPLETE_MARKER), '')
        try {
          await renameWithRetry(destDir, parked)
        } catch (e) {
          clearTurboquantUpdateMarker(destDir)
          throw e
        }
      }
      try {
        // The staged tree was extracted moments ago: AV/the indexer may still hold its files open.
        await renameWithRetry(stagedDir, destDir)
      } catch (e) {
        if (parked) {
          await renameWithRetry(parked, destDir)
          clearTurboquantUpdateMarker(destDir)
        }
        throw e
      }
      const bin = join(destDir, relative(stagedDir, stagedBin))
      try {
        await opts.verify?.(bin)
      } catch (e) {
        // The new build does not run here. Deleting the old one first and probing after left the broken binary in
        // place under the old build's version, so the same update kept being offered and an `auto` engine
        // downloaded it again on every check. Back to the stage (removed below), and the old install back.
        try {
          await renameWithRetry(destDir, stagedDir)
          if (parked) {
            await renameWithRetry(parked, destDir)
            clearTurboquantUpdateMarker(destDir)
          }
        } catch {
          /* the probe error stays the reported cause; a parked old install is still at .turboquant-old, marked */
        }
        throw e
      }
      // The new install is in place: deleting the old one is best effort, never a failed update (the next one
      // removes a leftover first). From here a parked old one is a leftover: its marker goes first, so a failed
      // delete of it is never taken for an update cut short.
      if (parked) {
        clearTurboquantUpdateMarker(parked)
        try {
          rmSync(parked, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          /* best effort */
        }
      }
      return bin
    } finally {
      // After a failed swap the stage still holds those fresh files, and a throw here would mask the real error.
      removeAfterFailure(stageRoot)
    }
  }
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
    removeAfterFailure(tmp)
    removeAfterFailure(destDir)
    throw e
  }

  const bin = findServer(destDir)
  if (!bin) throw new Error('llama-server not found in extracted TurboQuant archive')
  return bin
}
