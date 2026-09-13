// ngrok provisioning (ADR-422 Phase 3, spec 30 §3.5). Mirrors tunnel/provision.ts's
// cache-check -> download -> extract -> chmod shape for cloudflared.
//
// Unlike cloudflared, ngrok is not fetched off a GitHub release: it is hosted on equinox.io's
// own CDN. Two equinox URL shapes exist and only one of them is safe to hardcode here:
//   - https://dl.equinox.io/ngrok/ngrok-v3/stable/archive lists EVERY past release, and each
//     file on that page carries its own random per-artifact hash
//     (e.g. .../a/6nG16rF52TE/ngrok-v3-3.39.11-darwin-arm64.tar.gz) that changes release to
//     release — not something a static constant can track.
//   - https://dl.equinox.io/ngrok/ngrok-v3/stable (the "Latest" page, no /archive) instead
//     publishes a fixed "channel" URL that equinox itself keeps pointed at whatever the
//     current stable build is: base https://bin.equinox.io/c/bNyj1mQVY4c/, filenames named
//     `ngrok-v3-stable-<os>-<arch>.<ext>` with no version number baked in. This is the one
//     that behaves like cloudflared's GitHub "latest release" tag, and it's the one verified
//     here (curl -sL the page, then curl -sI each candidate URL for a live HTTP 200).
//
// Verified live (see ngrok.test.ts for the full fixture comment): Windows ships ONLY a .zip,
// Linux ships ONLY a .tgz, and macOS ships both a .tgz and a .zip (this picks .tgz, matching
// Linux and what extractArchive's non-Windows path already shells out to: `tar -xzf`). This is
// NOT the "raw exe on Win/Linux, .tgz on macOS" split ADR-153 found for cloudflared — ngrok
// archives every platform, including Windows.
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { downloadFile, extractArchive, findFile, type ProvisionProgress } from '../../engines/download'

const EQUINOX_BASE = 'https://bin.equinox.io/c/bNyj1mQVY4c'

/** The dir ngrok is provisioned into (own top-level dir under the data dir, same as
 *  cloudflared — it isn't an inference engine, so it doesn't live under engines/). */
export function ngrokDir(dataDir: string): string {
  return join(dataDir, 'ngrok')
}

/** Local filename for the provisioned ngrok binary. */
export function ngrokBinName(platform = process.platform): string {
  return platform === 'win32' ? 'ngrok.exe' : 'ngrok'
}

export function ngrokBinPath(dataDir: string, platform = process.platform): string {
  return join(ngrokDir(dataDir), ngrokBinName(platform))
}

/** The published "stable channel" asset URL for this OS/arch, or null when ngrok publishes
 *  none. Filenames and extensions here are what the live equinox "Latest" page actually
 *  serves today — verified, not assumed (see the module comment above and ngrok.test.ts's
 *  fixture comment for the exact evidence). */
export function ngrokAssetUrl(platform: string = process.platform, archStr: string = process.arch): string | null {
  const os =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  if (!os) return null
  const arch = archStr === 'x64' ? 'amd64' : archStr === 'arm64' ? 'arm64' : null
  if (!arch) return null
  const ext = os === 'windows' ? 'zip' : 'tgz'
  return `${EQUINOX_BASE}/ngrok-v3-stable-${os}-${arch}.${ext}`
}

export interface NgrokRuntime {
  binPath: string
}

/**
 * Provision ngrok: cache-check first (a prior successful provision is reused as-is), then
 * resolve the asset URL for this OS/arch, download it, extract it, locate the binary inside,
 * and (POSIX) mark it executable — the same pipeline as ensureCloudflared.
 */
export async function ensureNgrok(
  dataDir: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<NgrokRuntime> {
  const dir = ngrokDir(dataDir)
  const binPath = ngrokBinPath(dataDir)
  if (existsSync(binPath)) return { binPath } // cache-check first, same as ensureCloudflared

  const url = ngrokAssetUrl()
  if (!url) throw new Error(`ngrok publishes no build for ${process.platform}/${process.arch}`)
  mkdirSync(dir, { recursive: true })

  const archive = join(dir, url.split('/').pop() ?? 'ngrok-archive')
  try {
    await downloadFile(url, archive, onProgress, signal)
    onProgress?.({ phase: 'extracting', pct: -1 })
    await extractArchive(archive, dir)
    rmSync(archive, { force: true })
  } catch (e) {
    // Cancelled or failed mid-download/extract: remove the partial archive + the half-built
    // dir so it isn't mistaken for a completed install (same cleanup ensureCloudflared does).
    rmSync(archive, { force: true })
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  const found = findFile(dir, ngrokBinName())
  if (!found) throw new Error('ngrok archive did not contain the expected binary')
  if (process.platform !== 'win32') chmodSync(found, 0o755)
  return { binPath: found }
}
