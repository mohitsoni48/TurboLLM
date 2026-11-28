// The CUDA runtime a Windows CUDA engine build does not carry (ADR-175, ADR-453). Official llama.cpp ships
// ggml-cuda.dll without cudart64_*.dll, and a fork's release often has no runtime pack at all. Without the
// runtime beside the binary, ggml cannot load the CUDA backend and the engine runs on the CPU with no error.
// When a release ships none, the official llama.cpp runtime pack of the same CUDA major version is used: the
// runtime DLLs keep their names across minor versions (cudart64_13.dll), and a newer minor runtime serves a
// build linked against an older one.
import { cmpMajorMinor } from './cuda-provision'
import { OFFICIAL_LLAMA_CPP_REPO, TQ_CUDART_TAG } from './download'
import { classifyReleaseAsset, releaseByTag, type AssetArch, type ClassifiedAsset } from './release-assets'

// `cuda13` / `cu12`: a CUDA build whose minor version the name does not give.
const MAJOR_ONLY_CUDA = /(?:^|[-_.])cu(?:da)?[-_]?(\d{1,2})(?=[-_.]|$)/

export function cudaMajorOfBuildName(buildName: string): number | null {
  const versioned = classifyReleaseAsset({ name: buildName, browser_download_url: '' }).cudaVersion
  if (versioned) return majorOf(versioned)
  const majorOnly = MAJOR_ONLY_CUDA.exec(buildName.toLowerCase())
  return majorOnly ? Number(majorOnly[1]) : null
}

export function pickOfficialRuntimePack(
  assets: ClassifiedAsset[],
  cudaMajor: number,
  arch: AssetArch | null,
): ClassifiedAsset | null {
  const packs = assets.filter((asset) => isRuntimePackFor(asset, cudaMajor, arch))
  const newestFirst = packs.sort((a, b) => cmpMajorMinor(b.cudaVersion!, a.cudaVersion!))
  return newestFirst[0] ?? null
}

/** The official runtime pack for `build`, or null when there is none to offer. Never throws, because a runtime
 *  that cannot be fetched (offline, rate limit, no pack for this major) must not fail an install that otherwise
 *  works: the install lands and the missing-runtime warning stays. Only a cancellation is rethrown. */
export async function findOfficialRuntimePack(
  build: ClassifiedAsset,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<ClassifiedAsset | null> {
  const cudaMajor = cudaMajorOfBuildName(build.name)
  if (cudaMajor === null) return null
  try {
    const official = await releaseByTag(OFFICIAL_LLAMA_CPP_REPO, TQ_CUDART_TAG, signal, fetchImpl)
    return pickOfficialRuntimePack(official.assets.map(classifyReleaseAsset), cudaMajor, build.arch)
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

function isRuntimePackFor(asset: ClassifiedAsset, cudaMajor: number, arch: AssetArch | null): boolean {
  return (
    asset.companion === 'cudart' &&
    asset.archive !== null &&
    asset.os === 'windows' &&
    asset.arch === arch &&
    asset.cudaVersion !== null &&
    majorOf(asset.cudaVersion) === cudaMajor
  )
}

function majorOf(cudaVersion: string): number {
  return Number(cudaVersion.split('.')[0])
}
