// Where whisper.cpp's `whisper-server` comes from, and installing one.
//
// Speech-to-text runs on whisper.cpp's own HTTP server, a separate program the daemon starts (whisper-server.ts).
// It is looked for, in order: the path saved in Settings, the Android app's bundled copy, the one TurboLLM installed,
// and one already on the machine (Homebrew, a distro package, a build on the PATH).
//
// The install is whisper.cpp's own release build: its CI publishes CPU builds for Windows and Linux on `b<number>`
// tags. One tag is pinned here with each archive's sha256, as download.ts pins LLAMA_BUILD: what gets installed is
// the build this code was written against, checked byte for byte, and a new whisper.cpp release cannot change what a
// TurboLLM release installs. whisper.cpp publishes no macOS binary (Homebrew carries it), and the Android app can only
// run what it ships, so neither has an install here (installHint says what to do instead).
//
// It lives in its own folder under the data dir, like cloudflared (tunnel/provision.ts): it is not an inference engine
// the registry lists.
import { randomUUID } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { SttInstallHint, SttServerSource } from '../contract/voice'
import { downloadFile, extractArchive, findFile, renameWithRetry, type ProvisionProgress } from '../engines/download'
import { packagedAndroidApp } from '../engines/zip-install'
import { provisionOnce } from '../tunnel/provision'

export const WHISPER_REPO = 'ggml-org/whisper.cpp'

/** The whisper.cpp release the install uses. Its assets' sha256 are below; bump both together. */
export const WHISPER_BUILD = 'b5454'

interface ReleaseAsset {
  name: string
  sha256: string
}

/** whisper.cpp's CPU builds at {@link WHISPER_BUILD}, by `<platform>-<arch>`. */
const RELEASE_ASSETS: Readonly<Record<string, ReleaseAsset>> = {
  'linux-x64': { name: 'whisper-bin-ubuntu-x64.tar.gz', sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c' },
  'linux-arm64': { name: 'whisper-bin-ubuntu-arm64.tar.gz', sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149' },
  'win32-x64': { name: 'whisper-bin-x64.zip', sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  'win32-arm64': { name: 'whisper-bin-win-cpu-arm64.zip', sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d' },
}

/** The file whisper.cpp's Android build is shipped as: an executable has to be a `lib*.so` in the APK's native library
 *  folder to be runnable there at all. */
export const ANDROID_WHISPER_SERVER = 'libwhisper_server.so'

/** The Android app's GPU build of the same server, beside it unless the app was built without one (TurboLLM-Android,
 *  -PturbollmWhisperVulkan=false): whisper-server with ggml's Vulkan backend linked in. A second file, so that a
 *  Vulkan driver that takes the process down takes only this one, and the CPU server is still there to go back to. */
export const ANDROID_WHISPER_SERVER_GPU = 'libwhisper_server_vk.so'

/** Written into the install folder last, holding the release tag: a folder without it is an install that did not
 *  finish. */
const INSTALL_MARKER = '.turbollm-provisioned'

/** Everything whisper keeps under the data dir. */
export function whisperDir(dataDir: string): string {
  return join(dataDir, 'whisper')
}

/** Downloaded models, and any ggml model the user drops in. */
export function whisperModelsDir(dataDir: string): string {
  return join(whisperDir(dataDir), 'models')
}

/** The managed whisper-server install. */
export function whisperServerDir(dataDir: string): string {
  return join(whisperDir(dataDir), 'server')
}

export function whisperServerBinName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
}

/** The release archive for this machine, or null when whisper.cpp publishes none for it. */
export function whisperReleaseAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ReleaseAsset | null {
  return RELEASE_ASSETS[`${platform}-${arch}`] ?? null
}

export function whisperReleaseUrl(asset: ReleaseAsset): string {
  return `https://github.com/${WHISPER_REPO}/releases/download/${WHISPER_BUILD}/${asset.name}`
}

/** What to tell the user where there is nothing to install with one click; null where there is. */
export function installHint(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR?: string } = process.env,
): SttInstallHint | null {
  if (packagedAndroidApp(platform, env)) return 'android'
  if (whisperReleaseAsset(platform, arch)) return null
  return platform === 'darwin' ? 'homebrew' : 'build'
}

export type ResolvedWhisperServer =
  /** `gpuPath`: a second build to run when the GPU is asked for, where `path` itself cannot use one (the Android
   *  app's pair). Absent where one binary does both. */
  | { ok: true; path: string; source: SttServerSource; version: string; gpuPath?: string }
  /** `custom_missing`: Settings names a path with no file there. It is not skipped for the next source: the user
   *  chose that binary, and silently running another would hide the typo. */
  | { ok: false; reason: 'custom_missing' | 'none' }

export interface ResolveInput {
  dataDir: string
  /** `speechToText.serverPath`. */
  customPath: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/** The whisper-server to run, by the order in this file's header. */
export function resolveWhisperServer(input: ResolveInput): ResolvedWhisperServer {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const custom = input.customPath.trim()
  if (custom) {
    return isFile(custom) ? { ok: true, path: custom, source: 'custom', version: '' } : { ok: false, reason: 'custom_missing' }
  }
  const nativeLibDir = env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
  if (platform === 'android' && nativeLibDir) {
    const bundled = join(nativeLibDir, ANDROID_WHISPER_SERVER)
    if (isFile(bundled)) {
      const gpu = join(nativeLibDir, ANDROID_WHISPER_SERVER_GPU)
      return { ok: true, path: bundled, source: 'bundled', version: '', ...(isFile(gpu) ? { gpuPath: gpu } : {}) }
    }
  }
  const managed = managedWhisperServer(input.dataDir, platform)
  if (managed) return { ok: true, path: managed.path, source: 'managed', version: managed.version }
  const onPath = findOnPath(whisperServerBinName(platform), platform, env)
  return onPath ? { ok: true, path: onPath, source: 'system', version: '' } : { ok: false, reason: 'none' }
}

/** The managed install's binary and release tag, or null when there is no finished install. */
export function managedWhisperServer(dataDir: string, platform: NodeJS.Platform = process.platform): { path: string; version: string } | null {
  const dir = whisperServerDir(dataDir)
  let version: string
  try {
    version = readFileSync(join(dir, INSTALL_MARKER), 'utf8').trim()
  } catch {
    return null
  }
  const path = findFile(dir, whisperServerBinName(platform))
  return path ? { path, version } : null
}

/** Folders a package manager installs into that a desktop app's PATH leaves out: an app started from Finder or a
 *  launcher gets the system's minimal PATH, not the shell's, so Homebrew's `whisper-server` was there and not found. */
const EXTRA_BIN_DIRS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin'],
  linux: ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'],
}

function findOnPath(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter), ...(EXTRA_BIN_DIRS[platform] ?? [])]
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isRunnable(candidate, platform)) return candidate
  }
  return null
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isRunnable(path: string, platform: NodeJS.Platform): boolean {
  if (!isFile(path)) return false
  if (platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The environment a whisper-server runs in: its own folder first on the library path. whisper.cpp's release builds
 *  load libwhisper and the ggml backends from beside the executable; their RPATH covers Linux, and this covers a build
 *  without one, as probe.ts does for an engine. */
export function whisperServerEnv(binPath: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (platform === 'win32') return env
  const dir = dirname(binPath)
  const out: NodeJS.ProcessEnv = { ...env, LD_LIBRARY_PATH: env.LD_LIBRARY_PATH ? `${dir}:${env.LD_LIBRARY_PATH}` : dir }
  if (platform === 'darwin') out.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${dir}:${env.DYLD_LIBRARY_PATH}` : dir
  return out
}

export interface InstallDeps {
  download?: typeof downloadFile
  extract?: typeof extractArchive
  platform?: NodeJS.Platform
  arch?: string
}

/** Install whisper.cpp's release build of whisper-server under the data dir, replacing any earlier install. The archive
 *  is staged beside the install folder and swapped in whole once it is complete, so a download that fails or is
 *  cancelled leaves the previous install as it was. The caller stops a running whisper-server first: Windows cannot
 *  replace a folder a program runs from.
 *
 *  Throws `no_release_asset` where whisper.cpp publishes no build for this machine. */
export async function installWhisperServer(
  dataDir: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
  deps: InstallDeps = {},
): Promise<{ path: string; version: string }> {
  // One install at a time (a second request joins the first): two would share nothing on disk, each staging in its
  // own folder, but the loser's swap would delete the winner's files while they are being started.
  return provisionOnce(whisperServerDir(dataDir), () => install(dataDir, onProgress, signal, deps))
}

async function install(
  dataDir: string,
  onProgress: ((p: ProvisionProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  deps: InstallDeps,
): Promise<{ path: string; version: string }> {
  const platform = deps.platform ?? process.platform
  const asset = whisperReleaseAsset(platform, deps.arch ?? process.arch)
  if (!asset) throw Object.assign(new Error('whisper.cpp publishes no whisper-server build for this machine.'), { code: 'no_release_asset' })

  const root = whisperDir(dataDir)
  const stage = join(root, `.server-${randomUUID()}.tmp`)
  mkdirSync(stage, { recursive: true })
  try {
    const archive = join(stage, asset.name)
    onProgress?.({ phase: 'downloading', pct: 0 })
    await (deps.download ?? downloadFile)(whisperReleaseUrl(asset), archive, onProgress, signal, fetch, { expectedSha256: asset.sha256 })
    onProgress?.({ phase: 'extracting', pct: -1 })
    await (deps.extract ?? extractArchive)(archive, stage)
    rmSync(archive, { force: true })
    signal?.throwIfAborted()

    const staged = findFile(stage, whisperServerBinName(platform))
    if (!staged) throw Object.assign(new Error(`${asset.name} has no ${whisperServerBinName(platform)} in it.`), { code: 'extract_failed' })
    if (platform !== 'win32') chmodSync(staged, 0o755)
    writeFileSync(join(stage, INSTALL_MARKER), `${WHISPER_BUILD}\n`)

    const dest = whisperServerDir(dataDir)
    await rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    await renameWithRetry(stage, dest)
  } catch (e) {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  const installed = managedWhisperServer(dataDir, platform)
  if (!installed) throw Object.assign(new Error('The whisper-server install did not complete.'), { code: 'extract_failed' })
  return installed
}

/** Remove the managed install. True when there was one. */
export async function removeWhisperServer(dataDir: string): Promise<boolean> {
  const dir = whisperServerDir(dataDir)
  if (!existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  return true
}
