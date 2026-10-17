// KoboldCpp engine provisioning + launch (engine overhaul, Phase 4). KoboldCpp
// (LostRuins/koboldcpp) is a single self-contained binary that wraps llama.cpp and
// serves BOTH its native KoboldAI API and an OpenAI-compatible API under /v1
// (/v1/models, /v1/chat/completions). Unlike llama.cpp's release archives, KoboldCpp
// ships its release assets as RAW executables (e.g. `koboldcpp.exe`,
// `koboldcpp-linux-x64`, `koboldcpp-mac-arm64`) — there is nothing to extract.
//
// It's a *new engine kind* (`kind:'koboldcpp'`): a single downloaded binary, launched
// with KoboldCpp's OWN flag names (--model/--port/--host/--gpulayers/--contextsize plus
// a GPU-backend selector). Its /health is llama.cpp's, so the shared probeReady() works.
//
// CLI flags verified against the KoboldCpp README + wiki (LostRuins/koboldcpp), v1.115.x:
//   --model <path>        load a GGUF
//   --port <n>            listen port (default 5001)
//   --host <addr>         bind address
//   --gpulayers <n>       layers to offload to GPU VRAM
//   --contextsize <n>     context window
//   --usecuda / --usevulkan / --nogpu   GPU backend selection
// OpenAI-compatible API served at /v1 (the model field is ignored — a single loaded
// model — so no served-model alias is needed, unlike vLLM).
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GpuVendor } from '../sysinfo/sysinfo'
import { downloadFile, latestGithubRelease, recordedReleaseTag, recordReleaseTag, type ProvisionProgress, type ReleaseAsset, type SwapGuard } from './download'

export const KOBOLDCPP_REPO = 'LostRuins/koboldcpp'

/** KoboldCpp release asset name for this OS/arch + GPU class. The release ships a
 *  small fixed set of RAW executables (no archives):
 *    Windows x64 : koboldcpp.exe (CUDA build) | koboldcpp-nocuda.exe (CPU/Vulkan)
 *    Linux  x64  : koboldcpp-linux-x64 (CUDA) | koboldcpp-linux-x64-nocuda
 *    macOS arm64 : koboldcpp-mac-arm64
 *  `hasNvidia` picks the CUDA build on the platforms that ship one; everything else
 *  takes the nocuda/portable build (still does Vulkan/CPU). Returns null when this
 *  OS/arch has no published KoboldCpp asset. */
export function koboldcppAssetName(
  hasNvidia: boolean,
  platform = process.platform,
  archStr = process.arch,
): string | null {
  if (platform === 'darwin') {
    // KoboldCpp publishes an Apple-Silicon build only (Metal). No x64 mac asset.
    return archStr === 'arm64' ? 'koboldcpp-mac-arm64' : null
  }
  if (platform === 'win32') {
    if (archStr !== 'x64') return null // no Windows-arm64 KoboldCpp asset
    return hasNvidia ? 'koboldcpp.exe' : 'koboldcpp-nocuda.exe'
  }
  if (platform === 'linux') {
    if (archStr !== 'x64') return null // no Linux-arm64 KoboldCpp asset
    return hasNvidia ? 'koboldcpp-linux-x64' : 'koboldcpp-linux-x64-nocuda'
  }
  return null
}

/** Local filename for the provisioned KoboldCpp binary. Keep the platform-correct
 *  extension (Windows assets are `.exe`); POSIX assets have none. */
export function koboldcppBinName(platform = process.platform): string {
  return platform === 'win32' ? 'koboldcpp.exe' : 'koboldcpp'
}

/** The dir KoboldCpp is provisioned into, and the binary path inside it. */
export function koboldcppDir(enginesRoot: string): string {
  return join(enginesRoot, 'koboldcpp')
}
export function koboldcppBinPath(enginesRoot: string, platform = process.platform): string {
  return join(koboldcppDir(enginesRoot), koboldcppBinName(platform))
}

/** Pick the KoboldCpp asset for this box out of a release's asset list, by exact name
 *  match against {@link koboldcppAssetName}. Returns null when the wanted asset isn't
 *  present (or this OS/arch has none). */
export function pickKoboldcppAsset(
  assets: ReleaseAsset[],
  hasNvidia: boolean,
  platform = process.platform,
  archStr = process.arch,
): ReleaseAsset | null {
  const want = koboldcppAssetName(hasNvidia, platform, archStr)
  if (!want) return null
  return assets.find((a) => a.name === want) ?? null
}

export interface KoboldcppRuntime {
  /** Path to the downloaded koboldcpp binary. */
  binPath: string
  /** Resolved release tag (e.g. v1.115.2). */
  version: string
}

/**
 * Provision KoboldCpp: resolve the latest GitHub release, pick the asset for this
 * OS/arch + GPU class, download the RAW binary into <root>/koboldcpp/, and (POSIX)
 * mark it executable. Returns the binary path + the release tag. `hasNvidia` selects
 * the CUDA build where one exists. `replace` (an update) re-downloads the latest even
 * when a binary is present; the download only replaces it once complete, so a failed
 * fetch or download leaves the working binary in place. `blockSwap` re-runs right before
 * that replacement (a model started on the engine during the download refuses it).
 */
export async function ensureKoboldcpp(
  root: string,
  hasNvidia: boolean,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
  opts: { replace?: boolean; blockSwap?: SwapGuard } = {},
): Promise<KoboldcppRuntime> {
  const dir = koboldcppDir(root)
  const binPath = koboldcppBinPath(root)

  const rel = await latestGithubRelease(KOBOLDCPP_REPO, signal)
  const version = rel.tag_name ?? ''

  // Already installed: report the release it was downloaded as, not the latest — Disable → Install
  // re-registers an older binary, and labelling it latest made the update check say "up to date".
  if (existsSync(binPath) && !opts.replace) return { binPath, version: recordedReleaseTag(binPath) || version }

  const asset = pickKoboldcppAsset(rel.assets ?? [], hasNvidia)
  if (!asset) throw new Error('no_release_asset')

  mkdirSync(dir, { recursive: true })
  onProgress?.({ phase: 'downloading', pct: 0 })
  await downloadFile(asset.browser_download_url, binPath, onProgress, signal, undefined, { blockSwap: opts.blockSwap })
  // POSIX: the downloaded executable needs the execute bit; Windows ignores chmod.
  if (process.platform !== 'win32') {
    try {
      chmodSync(binPath, 0o755)
    } catch {
      /* best-effort — a non-executable file fails loudly at spawn instead */
    }
  }
  recordReleaseTag(binPath, version)
  return { binPath, version }
}

/**
 * Command + args to launch KoboldCpp's server for a model. Mirrors mlx/vllm
 * ServerCommand shape. `extraArgs` carries the model's KoboldCpp load flags built by
 * {@link koboldcppProfileToArgs}; the manager injects nothing else for this kind.
 * The GPU-backend flag (--usecuda/--usevulkan/--nogpu) is decided from the detected
 * vendor and lives in `extraArgs` too (see koboldcppProfileToArgs).
 */
export function koboldcppServerCommand(
  binPath: string,
  model: string,
  port: number,
  host: string,
  extraArgs: string[] = [],
): { cmd: string; args: string[] } {
  return {
    cmd: binPath,
    args: ['--model', model, '--host', host, '--port', String(port), '--skiplauncher', ...extraArgs],
  }
}

/** Map a load profile's relevant fields to KoboldCpp CLI flags. KoboldCpp uses its own
 *  flag names, so this is a small, explicit mapping (not the llama-server arg-map):
 *    ctx  → --contextsize
 *    ngl  → --gpulayers   (only when > 0; 0 = CPU, emit nothing)
 *  Plus the GPU backend selector from the detected vendor:
 *    nvidia → --usecuda ; any other GPU → --usevulkan ; no GPU → --nogpu
 *  User `extraArgs` pass through last so they can override anything. */
export function koboldcppProfileToArgs(
  p: { ctx: number; ngl: number; extraArgs?: string[] },
  vendor: GpuVendor,
  hasGpu: boolean,
): string[] {
  const a: string[] = []
  if (p.ctx > 0) a.push('--contextsize', String(p.ctx))
  if (p.ngl > 0) a.push('--gpulayers', String(p.ngl))
  // GPU backend: KoboldCpp's nocuda/portable build still accepts --usevulkan; the CUDA
  // build accepts --usecuda. We pick by vendor and fall back to Vulkan for any GPU.
  if (!hasGpu || p.ngl <= 0) a.push('--nogpu')
  else if (vendor === 'nvidia') a.push('--usecuda')
  else a.push('--usevulkan')
  if (p.extraArgs?.length) a.push(...p.extraArgs)
  return a
}
