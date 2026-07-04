// cloudflared provisioning (Cloud Launch, ADR-045/152). cloudflared ships raw
// executables on Windows/Linux but a .tgz archive on macOS (verified against the
// live `cloudflare/cloudflared` GitHub release — not a fixed shape across
// platforms like KoboldCpp), so provisioning branches on that instead of
// assuming one shape everywhere.
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { downloadFile, extractArchive, findFile, latestGithubRelease, type ProvisionProgress, type ReleaseAsset } from '../engines/download'

export const CLOUDFLARED_REPO = 'cloudflare/cloudflared'

/** The dir cloudflared is provisioned into (own top-level dir under the data dir —
 *  it isn't an inference engine, so it doesn't live under engines/). */
export function cloudflaredDir(dataDir: string): string {
  return join(dataDir, 'cloudflared')
}

/** Local filename for the provisioned cloudflared binary. */
export function cloudflaredBinName(platform = process.platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

export function cloudflaredBinPath(dataDir: string, platform = process.platform): string {
  return join(cloudflaredDir(dataDir), cloudflaredBinName(platform))
}

/** The release asset name for this OS/arch, or null when cloudflared publishes none
 *  (e.g. Windows arm64). Windows/Linux assets are raw executables; macOS ships a
 *  .tgz archive (verified against the live release — the one real platform split
 *  in this repo's otherwise-single-binary tools). */
export function cloudflaredAssetName(platform = process.platform, archStr = process.arch): string | null {
  if (platform === 'win32') {
    return archStr === 'x64' ? 'cloudflared-windows-amd64.exe' : null
  }
  if (platform === 'linux') {
    if (archStr === 'arm64') return 'cloudflared-linux-arm64'
    if (archStr === 'x64') return 'cloudflared-linux-amd64'
    return null
  }
  if (platform === 'darwin') {
    return archStr === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
  }
  return null
}

/** Pick the cloudflared asset for this box out of a release's asset list, by exact
 *  name match against {@link cloudflaredAssetName}. Null when unpublished for this
 *  OS/arch, or the asset isn't present in this particular release. */
export function pickCloudflaredAsset(
  assets: ReleaseAsset[],
  platform = process.platform,
  archStr = process.arch,
): ReleaseAsset | null {
  const want = cloudflaredAssetName(platform, archStr)
  if (!want) return null
  return assets.find((a) => a.name === want) ?? null
}

export interface CloudflaredRuntime {
  binPath: string
  version: string
}

/**
 * Provision cloudflared: resolve the latest GitHub release, pick the asset for this
 * OS/arch, download it, and (macOS) extract the .tgz — or (Windows/Linux) use the
 * raw executable directly — then (POSIX) mark it executable. Cache-checked: a
 * prior successful provision is reused as-is.
 */
export async function ensureCloudflared(
  dataDir: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<CloudflaredRuntime> {
  const dir = cloudflaredDir(dataDir)
  const binPath = cloudflaredBinPath(dataDir)

  const rel = await latestGithubRelease(CLOUDFLARED_REPO, signal)
  const version = rel.tag_name ?? ''

  if (existsSync(binPath)) return { binPath, version }

  const asset = pickCloudflaredAsset(rel.assets ?? [])
  if (!asset) throw new Error('no_release_asset')

  mkdirSync(dir, { recursive: true })
  onProgress?.({ phase: 'downloading', pct: 0 })

  if (asset.name.endsWith('.tgz')) {
    // macOS: download the archive to a temp file, extract into the final dir, then
    // locate the binary inside (extractArchive also strips the quarantine xattr).
    const tmp = join(dir, asset.name)
    try {
      await downloadFile(asset.browser_download_url, tmp, onProgress, signal)
      onProgress?.({ phase: 'extracting', pct: -1 })
      await extractArchive(tmp, dir)
      rmSync(tmp, { force: true })
    } catch (e) {
      rmSync(tmp, { force: true })
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
    const found = findFile(dir, 'cloudflared')
    if (!found) throw new Error('cloudflared not found in extracted archive')
    chmodSync(found, 0o755)
    return { binPath: found, version }
  }

  // Windows/Linux: raw executable, download straight to the final path.
  await downloadFile(asset.browser_download_url, binPath, onProgress, signal)
  if (process.platform !== 'win32') {
    try {
      chmodSync(binPath, 0o755)
    } catch {
      /* best-effort — a non-executable file fails loudly at spawn instead */
    }
  }
  return { binPath, version }
}
