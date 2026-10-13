// CUDA Toolkit auto-provisioning from NVIDIA's official redistributable archives (ADR-101).
// When a 1-click build can't find a CUDA Toolkit, we download the minimal component set
// needed to COMPILE llama.cpp with CUDA — nvcc + cudart + cublas + the CCCL/nvrtc headers —
// extract them, and MERGE them into one toolkit root under `<dataDir>/cuda/<version>/`. The
// resulting `bin` dir is then used as a build toolchain dir (it holds nvcc + the runtime DLLs).
//
// Source: https://developer.download.nvidia.com/compute/cuda/redist/ — the same per-component
// archives conda-forge/pip wheels are built from. Each version has a `redistrib_<ver>.json`
// manifest mapping every component to a per-platform { relative_path, sha256, size }.
//
// Windows + x86_64 only, matching the guided build's scope (Linux/macOS build is parked).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadFile, extractArchive } from './download'
import { driverMaxCuda } from './nvidia-smi'

const REDIST_BASE = 'https://developer.download.nvidia.com/compute/cuda/redist/'

/** Components required to BUILD a CUDA llama.cpp:
 *  - cuda_nvcc:   the compiler DRIVER (nvcc, ptxas) — but NOT cicc (see libnvvm below)
 *  - cuda_cudart: the runtime (cudart.lib/dll + cuda_runtime.h + the `crt/` header WRAPPERS)
 *  - libcublas:   cuBLAS + cuBLASLt (libs + DLLs + headers) — the large one (~400 MB)
 *  - cuda_cccl:   Thrust/CUB headers that ggml-cuda includes
 *  We deliberately do NOT pull cuda_nvrtc (~318 MB): ggml-cuda is ahead-of-time compiled,
 *  so runtime compilation isn't needed — the prebuilt llama.cpp CUDA releases omit it too. */
export const CUDA_REQUIRED_COMPONENTS = ['cuda_nvcc', 'cuda_cudart', 'libcublas', 'cuda_cccl']

/** Optional components — present in newer redists (CUDA 13+), skipped silently when absent
 *  (in CUDA 12.x they're folded into cuda_nvcc / cuda_cudart, so they don't exist separately):
 *  - libnvvm:  `nvvm/bin/cicc` — the internal compiler nvcc shells out to. Without it nvcc's
 *    own compiler-identification step fails ("cicc … error 0x1"), so NOTHING CUDA compiles.
 *  - cuda_crt: the REAL `include/crt/*.h` headers (host_config.h, …). In CUDA 13+, cuda_cudart
 *    ships only thin `include/<name>.h` wrappers that `#include "crt/<name>"`; the real headers
 *    live here. Without it every CUDA compile dies on "Cannot open include file: 'crt/host_config.h'". */
export const CUDA_OPTIONAL_COMPONENTS = ['libnvvm', 'cuda_crt']

/** Redist versions we know how to assemble, newest first. We pick the newest whose
 *  major.minor the installed driver supports. 12.8+ is required for Blackwell (sm_120);
 *  13.0 for the very newest. Older entries keep things working on older drivers. */
export const KNOWN_CUDA_VERSIONS = ['13.0.1', '13.0.0', '12.8.1', '12.6.3', '12.4.1']

export interface CudaProvisionProgress {
  phase: 'resolving' | 'downloading' | 'extracting' | 'assembling'
  /** Human line for the build log. */
  message: string
  /** 0..1 within the current component download, when known. */
  pct?: number
}

export interface CudaToolkit {
  /** Toolkit root (`<dataDir>/cuda/<version>`). */
  root: string
  /** `<root>/bin` — contains nvcc + the runtime DLLs; use as a build toolchain dir. */
  binDir: string
  version: string
}

/** PURE: `major.minor` of a version string ("13.0.1" → "13.0"), for driver comparison. */
export function majorMinor(v: string): string {
  const p = v.split('.')
  return `${p[0] ?? '0'}.${p[1] ?? '0'}`
}

/** PURE: numeric compare of "X.Y" strings; ≤ 0 when a ≤ b. */
export function cmpMajorMinor(a: string, b: string): number {
  const [am, an] = a.split('.').map(Number)
  const [bm, bn] = b.split('.').map(Number)
  return am !== bm ? am - bm : (an || 0) - (bn || 0)
}

/** PURE: from `KNOWN_CUDA_VERSIONS` (newest first), the newest whose major.minor is ≤ the
 *  driver's max. When the driver is unknown, fall back to the newest known version. */
export function pickCudaVersion(driverMax: string | null, known = KNOWN_CUDA_VERSIONS): string {
  if (!driverMax) return known[0]
  const dm = majorMinor(driverMax)
  return known.find((v) => cmpMajorMinor(majorMinor(v), dm) <= 0) ?? known[known.length - 1]
}

type RedistManifest = Record<string, undefined | { ['windows-x86_64']?: { relative_path: string } }>

/** Fetch the redist manifest for `version`; null if it doesn't exist (so the caller can
 *  fall back to an older known version). */
async function fetchManifest(version: string, signal: AbortSignal): Promise<RedistManifest | null> {
  const res = await fetch(`${REDIST_BASE}redistrib_${version}.json`, { redirect: 'follow', signal })
  if (!res.ok) return null
  return (await res.json()) as RedistManifest
}

/** Resolve a usable CUDA version + its manifest: starting at the driver-preferred version,
 *  walk `KNOWN_CUDA_VERSIONS` until a manifest actually exists. Throws if none resolve. */
async function resolveVersion(driverMax: string | null, signal: AbortSignal): Promise<{ version: string; manifest: RedistManifest }> {
  const preferred = pickCudaVersion(driverMax)
  const ordered = [preferred, ...KNOWN_CUDA_VERSIONS.filter((v) => v !== preferred)]
  for (const version of ordered) {
    const manifest = await fetchManifest(version, signal)
    if (manifest) return { version, manifest }
  }
  throw new Error('Could not reach NVIDIA to resolve a CUDA Toolkit version (offline?).')
}

/** Download the build component set for a resolved version, extract each, and merge them
 *  into one toolkit root. Idempotent: if `<dataDir>/cuda/<version>/bin/nvcc.exe` already
 *  exists we reuse it. Returns the toolkit (its `bin` dir is a ready build toolchain dir). */
export async function provisionCuda(
  dataDir: string,
  onProgress: (p: CudaProvisionProgress) => void,
  signal: AbortSignal,
): Promise<CudaToolkit> {
  if (process.platform !== 'win32') {
    throw new Error('Automatic CUDA download is currently Windows x86_64 only.')
  }
  onProgress({ phase: 'resolving', message: 'Checking your NVIDIA driver and resolving a CUDA version…' })
  const driverMax = await driverMaxCuda()
  const { version, manifest } = await resolveVersion(driverMax, signal)
  onProgress({
    phase: 'resolving',
    message: `Using CUDA ${version}${driverMax ? ` (driver supports up to ${driverMax})` : ''}.`,
  })

  const root = join(dataDir, 'cuda', version)
  const binDir = join(root, 'bin')
  // Reuse a complete prior install.
  if (existsSync(join(binDir, 'nvcc.exe'))) {
    onProgress({ phase: 'assembling', message: `CUDA ${version} already downloaded — reusing it.` })
    return { root, binDir, version }
  }

  // Resolve the component archive URLs up front. Required components fail fast if missing;
  // optional ones (e.g. cuda_crt, absent on CUDA 12.x) are simply skipped when not present.
  const relOf = (id: string) => manifest[id]?.['windows-x86_64']?.relative_path
  const components: { id: string; url: string }[] = []
  for (const id of CUDA_REQUIRED_COMPONENTS) {
    const rel = relOf(id)
    if (!rel) throw new Error(`CUDA ${version} manifest is missing ${id} for windows-x86_64.`)
    components.push({ id, url: REDIST_BASE + rel })
  }
  for (const id of CUDA_OPTIONAL_COMPONENTS) {
    const rel = relOf(id)
    if (rel) components.push({ id, url: REDIST_BASE + rel })
  }

  const work = join(tmpdir(), `tllm-cuda-${version}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  // Build into a temp root first, then atomically swap in, so an interrupted download never
  // leaves a half-assembled toolkit that looks complete.
  const stageRoot = `${root}.partial`
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(stageRoot, { recursive: true })

  try {
    for (let i = 0; i < components.length; i++) {
      const { id, url } = components[i]
      const zip = join(work, `${id}.zip`)
      onProgress({ phase: 'downloading', message: `Downloading ${id} (${i + 1}/${components.length})…`, pct: 0 })
      await downloadFile(url, zip, (p) => onProgress({ phase: 'downloading', message: `Downloading ${id} (${i + 1}/${components.length})…`, pct: p.pct }), signal)
      const exDir = join(work, id)
      mkdirSync(exDir, { recursive: true })
      onProgress({ phase: 'extracting', message: `Extracting ${id}…` })
      await extractArchive(zip, exDir)
      // Each archive contains a single `<id>-windows-x86_64-<ver>-archive/` folder with
      // bin/ include/ lib/ … — merge that folder's contents into the shared toolkit root.
      const inner = readdirSync(exDir).map((n) => join(exDir, n)).find((p) => existsSync(join(p, 'include')) || existsSync(join(p, 'bin')) || existsSync(join(p, 'lib')))
      const srcRoot = inner ?? join(exDir, readdirSync(exDir)[0] ?? '')
      cpSync(srcRoot, stageRoot, { recursive: true, force: true })
      rmSync(zip, { force: true })
    }
    if (!existsSync(join(stageRoot, 'bin', 'nvcc.exe'))) {
      throw new Error('Assembled CUDA toolkit is missing bin/nvcc.exe — the component set may have changed.')
    }
    // Swap staged → final.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(dataDir, 'cuda'), { recursive: true })
    cpSync(stageRoot, root, { recursive: true, force: true })
    onProgress({ phase: 'assembling', message: `CUDA ${version} ready.` })
    return { root, binDir, version }
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(stageRoot, { recursive: true, force: true })
  }
}
