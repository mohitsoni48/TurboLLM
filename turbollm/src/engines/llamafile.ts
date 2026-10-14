// llamafile engine provisioning + launch (engine overhaul, Phase 4). llamafile
// (Mozilla-Ocho/llamafile) is a single self-contained executable that bundles
// llama.cpp's server. It is a *new engine kind* (`kind:'llamafile'`) — NOT the
// llama-server kind — for one concrete reason: the standalone `llamafile` binary is
// multi-mode (CLI chat by default) and must be told to run as a server with
// `--server --no-webui`, whereas `llama-server` is server-by-default. Once in server
// mode it IS llama.cpp's server, so it accepts the same flags (-m/--host/--port/-ngl/
// -c) and serves /health + /v1/chat/completions — the shared probeReady() and the
// llama.cpp model-field semantics (ignored; no alias) both apply unchanged.
//
// Provisioned from GitHub releases (Mozilla-Ocho/llamafile): the release ships a RAW
// portable executable named `llamafile-<version>` (Cosmopolitan APE — one file runs on
// Windows/macOS/Linux, x64+arm64). There is nothing to extract.
//
// Server flags verified against the llamafile README + llama.cpp server docs:
//   --server            run in server mode (required; the binary is CLI-by-default)
//   --no-webui          serve the OpenAI API only (no bundled web UI / browser tab).
//                       NB: modern llamafile is llama.cpp's server — the old `--nobrowser`
//                       flag was removed (it errors), `--no-webui` is the current spelling.
//   -m <path>           load an external GGUF
//   --host <addr> / --port <n>
//   -ngl <n>            GPU layers ; -c <n> context size
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { downloadFile, latestGithubRelease, recordedReleaseTag, recordReleaseTag, type ProvisionProgress, type ReleaseAsset } from './download'

export const LLAMAFILE_REPO = 'Mozilla-Ocho/llamafile'

/** The portable `llamafile` executable name in a release, e.g. `llamafile-0.10.3`.
 *  llamafile is a Cosmopolitan APE: ONE file runs on every OS/arch, so the asset is
 *  not platform-specific — we pick by the `llamafile-<version>` name, excluding the
 *  `-thin` variant (which omits the bundled GPU support) and non-binary assets
 *  (`.zip`). Returns null when no such asset is present. */
export function pickLlamafileAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  // Match `llamafile-<version>` exactly: starts with a digit, version chars only
  // (digits/dots), and ends right there — so `-thin`, `.zip`, and the sibling tools
  // (`whisperfile-…`, `diffusionfile-…`, `zipalign-…`) are all excluded.
  return assets.find((a) => /^llamafile-\d[\d.]*$/.test(a.name)) ?? null
}

/** Local filename for the provisioned llamafile binary. On Windows a Cosmopolitan APE
 *  must end in `.exe` to be executable; POSIX runs it directly. */
export function llamafileBinName(platform = process.platform): string {
  return platform === 'win32' ? 'llamafile.exe' : 'llamafile'
}

export function llamafileDir(enginesRoot: string): string {
  return join(enginesRoot, 'llamafile')
}
export function llamafileBinPath(enginesRoot: string, platform = process.platform): string {
  return join(llamafileDir(enginesRoot), llamafileBinName(platform))
}

export interface LlamafileRuntime {
  /** Path to the downloaded llamafile binary. */
  binPath: string
  /** Resolved release tag (e.g. 0.10.3). */
  version: string
}

/**
 * Provision llamafile: resolve the latest GitHub release, download the portable
 * `llamafile-<version>` executable into <root>/llamafile/ (named with the platform's
 * extension so it's runnable), and (POSIX) mark it executable. Returns the binary path
 * + release tag. `replace` (an update) re-downloads the latest even when a binary is
 * present; the download only replaces it once complete, so a failed fetch or download
 * leaves the working binary in place.
 */
export async function ensureLlamafile(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
  opts: { replace?: boolean } = {},
): Promise<LlamafileRuntime> {
  const dir = llamafileDir(root)
  const binPath = llamafileBinPath(root)

  const rel = await latestGithubRelease(LLAMAFILE_REPO, signal)
  const version = rel.tag_name ?? ''

  // Already installed: report the release it was downloaded as, not the latest — Disable → Install
  // re-registers an older binary, and labelling it latest made the update check say "up to date".
  if (existsSync(binPath) && !opts.replace) return { binPath, version: recordedReleaseTag(binPath) || version }

  const asset = pickLlamafileAsset(rel.assets ?? [])
  if (!asset) throw new Error('no_release_asset')

  mkdirSync(dir, { recursive: true })
  onProgress?.({ phase: 'downloading', pct: 0 })
  await downloadFile(asset.browser_download_url, binPath, onProgress, signal)
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
 * Command + args to launch llamafile in server mode for a model. `--server
 * --no-webui` put the multi-mode binary into llama.cpp's HTTP server; from there it
 * speaks the same protocol as llama-server. `extraArgs` carries the model's llama.cpp
 * load flags built by the existing {@link profileToArgs} (llamafile understands the
 * same flag names), so the rich per-model profile flows straight through.
 */
export function llamafileServerCommand(
  binPath: string,
  model: string,
  port: number,
  host: string,
  extraArgs: string[] = [],
): { cmd: string; args: string[] } {
  return {
    cmd: binPath,
    args: ['--server', '--no-webui', '-m', model, '--host', host, '--port', String(port), ...extraArgs],
  }
}
