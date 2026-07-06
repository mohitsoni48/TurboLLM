// Engine catalog (ADR-044). A hardcoded, browsable list of engines the user can
// one-click install from the Engines screen — generalizing the llama.cpp backend
// picker (download.ts) into a list that also covers Python engines (vLLM, MLX).
//
// The list itself ships in app code and updates only with app releases (no live
// catalog server — offline-first, ADR-009). Concrete versions resolve at INSTALL
// time: GitHub Releases for binary engines, the latest pip release for Python ones.
//
// Provisioning is one of:
//   - 'github-release': download a prebuilt binary asset (llama.cpp official).
//   - 'pip':            uv-bootstrapped venv + `uv pip install <pkg>` (vLLM, MLX).
//   - 'builtin':        already provisioned by another path (the auto default).
//
// Honesty rule (project HARD RULE / ADR-012 ethos): an engine is only listed as
// installable when a real provisioning path exists. Use `comingSoon: true` for
// engines without a real release path yet; remove the flag once they publish one.

import { type BackendId, availableBackends } from './download'
import type { Arch } from './hardware'
import type { GpuVendor } from '../sysinfo/sysinfo'

export type ProvisionType = 'github-release' | 'pip' | 'builtin'

// ─── Variant model (engine overhaul, Phase 1) ───────────────────────────────
// A catalog engine can ship several installable *variants* — one per hardware
// path (e.g. llama.cpp has cuda/rocm/sycl/vulkan/metal/cpu). Each variant
// declares the hardware it needs (HardwareReq); the matcher (compat.evaluate-
// Variant) decides whether the current box can run it. This is additive: every
// existing CatalogEngine field/export is unchanged and `variants` is optional.

export interface HardwareReq {
  platform?: NodeJS.Platform[]
  arch?: Arch[]
  gpuVendor?: GpuVendor[] // any-of
  backend?: BackendId
  minVramMb?: number
  /** Accepted but NOT enforced in v1 (tiered gating — we can't reliably detect
   *  compute capability yet). Kept on the type so future tiers can use it. */
  minCudaCC?: number
}

export interface EngineVariant {
  id: string
  label: string
  repo: string // OG repo (credit + source link)
  requires: HardwareReq
  stability: 'stable' | 'experimental'
  speed?: 'baseline' | 'fast' | 'fastest'
  backendId?: BackendId // set for official llama.cpp variants
  hasPrebuilt: boolean // false => "build it, then Add your own"
}

export interface CatalogEngine {
  /** Stable catalog id (not the registry engine id). */
  id: string
  /** Display name. */
  name: string
  /** Registry engine `kind` once installed ('llama-server' | 'vllm' | 'mlx'). */
  kind: string
  /** One-line description for the catalog card. */
  description: string
  /** How this engine is provisioned. */
  provision: ProvisionType
  /** Project homepage / docs. */
  homepage: string
  /** `owner/repo` for github-release provisioning (resolved at install time). */
  repo?: string
  /** Platforms the engine can RUN on (process.platform values). */
  platforms: NodeJS.Platform[]
  /** Maturity on the supported platforms. */
  support: 'stable' | 'experimental'
  /** API path to POST to in order to install (empty for backend-picker engines). */
  installEndpoint: string
  /** Listed for awareness but not yet installable (no real provisioning path). */
  comingSoon?: boolean
  /** Extra context shown under the card (support caveats, etc.). */
  note?: string
  /** Installable variants (one per hardware path). Optional: llama.cpp derives
   *  its variants at call time via llamaCppVariants(); other engines list them
   *  inline or leave undefined (handled in later phases). */
  variants?: EngineVariant[]
}

// Maps each llama.cpp BackendId to the hardware it needs + how fast it is.
// We DERIVE the variant list from availableBackends() rather than hand-listing
// the 6 backends, so the catalog never drifts from download.ts.
const LLAMA_BACKEND_REQ: Record<BackendId, { requires: HardwareReq; speed: EngineVariant['speed'] }> = {
  cuda: { requires: { gpuVendor: ['nvidia'], backend: 'cuda' }, speed: 'fast' },
  rocm: { requires: { gpuVendor: ['amd'], backend: 'rocm' }, speed: 'fast' },
  sycl: { requires: { gpuVendor: ['intel'], backend: 'sycl' }, speed: 'baseline' },
  vulkan: { requires: { backend: 'vulkan' }, speed: 'baseline' }, // any GPU
  metal: { requires: { platform: ['darwin'], gpuVendor: ['apple'], backend: 'metal' }, speed: 'fast' },
  cpu: { requires: { backend: 'cpu' }, speed: 'baseline' }, // always ok
}

/** llama.cpp's variants for this OS/arch, derived from the official backend
 *  list (download.ts) so the two never diverge. */
export function llamaCppVariants(): EngineVariant[] {
  return availableBackends().map((b) => {
    const { requires, speed } = LLAMA_BACKEND_REQ[b.id]
    return {
      id: `llama.cpp-${b.id}`,
      label: b.label,
      repo: 'ggml-org/llama.cpp',
      requires,
      stability: 'stable',
      speed,
      backendId: b.id,
      hasPrebuilt: true,
    }
  })
}

const ALL: CatalogEngine[] = [
  {
    id: 'llama.cpp',
    name: 'llama.cpp',
    kind: 'llama-server',
    description:
      'The default GGUF engine. Pick the GPU backend that matches your hardware (CUDA, ROCm, Vulkan, Metal, CPU).',
    provision: 'github-release',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    repo: 'ggml-org/llama.cpp',
    platforms: ['win32', 'darwin', 'linux'],
    support: 'stable',
    // llama.cpp expands into the backend sub-picker (existing UI); it has no single
    // install endpoint of its own.
    installEndpoint: '',
  },
  {
    // Upstream publishes NO Linux CUDA prebuilt (download.ts availableBackends() — Linux
    // NVIDIA users get Vulkan from the main llama.cpp entry above). Now that the guided
    // build (ADR-100/build-runner.ts) runs on Linux too, offer official llama.cpp + CUDA
    // there as its own "build from source" card — same guided-build flow as ik_llama.cpp/
    // TurboQuant below, just pointed at the official repo. Windows/macOS never see this
    // (platforms:['linux']): Windows already gets a CUDA prebuilt, and macOS has no CUDA.
    id: 'llama.cpp-cuda-linux',
    name: 'llama.cpp (CUDA)',
    kind: 'llama-server',
    description:
      'Official llama.cpp compiled with CUDA for NVIDIA GPUs on Linux — no prebuilt is published upstream, so this uses the guided in-app build.',
    provision: 'github-release',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    repo: 'ggml-org/llama.cpp',
    platforms: ['linux'],
    support: 'experimental',
    installEndpoint: '',
    note: 'Builds the official repo with -DGGML_CUDA=ON and bundles its CUDA runtime libraries next to the binary, so it runs standalone. Manages like any other engine afterward (rebuild on a newer commit, disable, delete).',
    variants: [
      {
        id: 'llama.cpp-cuda-source',
        label: 'CUDA (NVIDIA) — build from source',
        repo: 'ggml-org/llama.cpp',
        requires: { platform: ['linux'], gpuVendor: ['nvidia'] },
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: false,
      },
    ],
  },
  {
    id: 'vllm',
    name: 'vLLM',
    kind: 'vllm',
    description:
      'High-throughput production server for safetensors / HF models, with an OpenAI-compatible API. Best for NVIDIA GPUs.',
    provision: 'pip',
    homepage: 'https://github.com/vllm-project/vllm',
    repo: 'vllm-project/vllm',
    // Listed on every platform but only stable on Linux + NVIDIA. We never hard-
    // block (ADR-044) — the install attempt fails loudly where unsupported.
    platforms: ['linux', 'darwin', 'win32'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/vllm',
    note: 'Officially supported on Linux + NVIDIA/CUDA. macOS is CPU-only experimental; Windows is unsupported upstream. Installs a multi-GB Python environment.',
    // Classification-only variant (its pip install path is unchanged). Lets the
    // matcher/recommender reason about vLLM's fit on this box: Linux + NVIDIA.
    variants: [
      {
        id: 'vllm-cuda',
        label: 'CUDA (NVIDIA)',
        repo: 'vllm-project/vllm',
        requires: { platform: ['linux'], gpuVendor: ['nvidia'] },
        stability: 'experimental',
        speed: 'fastest',
        hasPrebuilt: true,
      },
    ],
  },
  {
    id: 'mlx',
    name: 'MLX',
    kind: 'mlx',
    description: "Apple's framework for fast inference on Apple Silicon, with an OpenAI-compatible server.",
    provision: 'pip',
    homepage: 'https://github.com/ml-explore/mlx-lm',
    repo: 'ml-explore/mlx-lm',
    platforms: ['darwin'],
    support: 'stable',
    installEndpoint: '/api/v1/engines/mlx',
    note: 'macOS (Apple Silicon) only.',
    // Classification-only variant (its pip install path is unchanged). Lets the
    // matcher/recommender reason about MLX's fit on this box: macOS + Apple GPU.
    variants: [
      {
        id: 'mlx',
        label: 'Apple Metal',
        repo: 'ml-explore/mlx-lm',
        requires: { platform: ['darwin'], gpuVendor: ['apple'] },
        stability: 'stable',
        speed: 'fast',
        hasPrebuilt: true,
      },
    ],
  },
  {
    id: 'sglang',
    name: 'SGLang',
    kind: 'sglang',
    description:
      'High-throughput production server for safetensors / HF models with fast prefix caching. OpenAI-compatible. NVIDIA GPUs on Linux.',
    provision: 'pip',
    homepage: 'https://github.com/sgl-project/sglang',
    repo: 'sgl-project/sglang',
    platforms: ['linux', 'darwin', 'win32'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/sglang',
    note: 'Officially supported on Linux + NVIDIA/CUDA 12+. macOS and Windows are unsupported upstream. Installs a multi-GB Python environment.',
    variants: [
      {
        id: 'sglang-cuda',
        label: 'CUDA (NVIDIA)',
        repo: 'sgl-project/sglang',
        requires: { platform: ['linux'], gpuVendor: ['nvidia'] },
        stability: 'experimental',
        speed: 'fastest',
        hasPrebuilt: true,
      },
    ],
  },
  {
    id: 'ik_llama.cpp',
    name: 'ik_llama.cpp',
    kind: 'llama-server',
    description:
      'A llama.cpp fork (ikawrakow) with CPU/GPU performance work and extra quant types. Ships llama-server but publishes no prebuilt binaries — build it, then add your own engine.',
    provision: 'github-release',
    homepage: 'https://github.com/ikawrakow/ik_llama.cpp',
    repo: 'ikawrakow/ik_llama.cpp',
    // Buildable on all three desktop OSes, but the fork ships NO prebuilt release assets
    // (verified: its releases are source-only). So it lists as "build it → Add your own
    // engine" with the repo link, and has NO install endpoint. The day it publishes
    // prebuilt llama-server archives, flip the variant's hasPrebuilt + add an endpoint.
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '',
    note: 'No prebuilt binaries are published. Build llama-server from the fork, then use "Add your own engine" to point TurboLLM at it — it runs on the standard llama-server path.',
    variants: [
      {
        id: 'ik_llama.cpp-source',
        label: 'Build from source',
        repo: 'ikawrakow/ik_llama.cpp',
        // No hardware gate beyond "it's a llama-server build" — the user picks their own
        // backend when they compile it. hasPrebuilt:false drives the "build it" treatment.
        requires: {},
        stability: 'experimental',
        speed: 'baseline',
        hasPrebuilt: false,
      },
    ],
  },
  {
    id: 'llamafile',
    name: 'llamafile',
    kind: 'llamafile',
    description:
      "Mozilla's single-file GGUF runtime (llama.cpp's server in one portable executable). Broadly portable — runs on any OS/arch.",
    provision: 'github-release',
    homepage: 'https://github.com/Mozilla-Ocho/llamafile',
    repo: 'Mozilla-Ocho/llamafile',
    // The release ships ONE Cosmopolitan APE binary that runs on every desktop OS/arch.
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/llamafile',
    note: 'Downloads one portable executable that bundles llama.cpp. GPU acceleration depends on your platform/drivers; falls back to CPU.',
    variants: [
      {
        id: 'llamafile',
        label: 'Portable (any OS/GPU)',
        repo: 'Mozilla-Ocho/llamafile',
        // No hardware gate — the single binary runs everywhere (GPU where available, else CPU).
        requires: {},
        stability: 'experimental',
        speed: 'baseline',
        hasPrebuilt: true,
      },
    ],
  },
  {
    id: 'koboldcpp',
    name: 'KoboldCpp',
    kind: 'koboldcpp',
    description:
      'A single-binary GGUF runtime (wraps llama.cpp) with an OpenAI-compatible API. CUDA build on NVIDIA, portable Vulkan/CPU build elsewhere.',
    provision: 'github-release',
    homepage: 'https://github.com/LostRuins/koboldcpp',
    repo: 'LostRuins/koboldcpp',
    // KoboldCpp publishes raw binaries for Windows x64, Linux x64, and macOS arm64.
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/koboldcpp',
    note: 'Downloads a single KoboldCpp binary. The CUDA build is used on NVIDIA GPUs; the portable build (Vulkan/CPU) elsewhere. Windows/Linux are x64-only; macOS is Apple Silicon only.',
    variants: [
      {
        id: 'koboldcpp-cuda',
        label: 'CUDA (NVIDIA)',
        repo: 'LostRuins/koboldcpp',
        requires: { platform: ['win32', 'linux'], arch: ['x64'], gpuVendor: ['nvidia'] },
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: true,
      },
      {
        id: 'koboldcpp-portable',
        label: 'Vulkan / CPU (portable)',
        repo: 'LostRuins/koboldcpp',
        requires: { platform: ['win32', 'linux'], arch: ['x64'] },
        stability: 'experimental',
        speed: 'baseline',
        hasPrebuilt: true,
      },
      {
        id: 'koboldcpp-metal',
        label: 'Metal (Apple)',
        repo: 'LostRuins/koboldcpp',
        requires: { platform: ['darwin'], arch: ['arm64'] },
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: true,
      },
    ],
  },
  {
    id: 'turboquant',
    name: 'TurboQuant',
    kind: 'llama-server',
    description:
      'llama.cpp fork with TurboQuant KV-cache compression (turbo2/3/4) and NextN self-speculative decoding for higher throughput and longer context.',
    provision: 'github-release',
    homepage: 'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant',
    repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant',
    // A well-known llama.cpp fork. Self-contained prebuilts ship on GitHub Releases for
    // macOS-arm64 and Linux-x64 (Vulkan), resolved per-platform-tag by download.ts
    // turboquantAssetUrl (the repo tags releases PER OS, so `releases/latest` can't be
    // used). Windows is build-from-source: the only Windows binary (on HuggingFace) is a
    // MinGW build with a UCRT linkage defect that won't load on a standard box
    // (0xC0000135) and isn't self-contained — flip it to a prebuilt variant the day the
    // fork ships a working, self-contained Windows release.
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/turboquant',
    note: 'Prebuilt: macOS (Apple Silicon), Linux x64 (Vulkan). On Windows, build llama-server from the fork, then use "Add your own engine".',
    variants: [
      {
        id: 'turboquant-macos-metal',
        label: 'Metal (Apple)',
        repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant',
        requires: { platform: ['darwin'], gpuVendor: ['apple'] },
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: true,
      },
      {
        id: 'turboquant-linux-vulkan',
        label: 'Vulkan (Linux x64)',
        repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant',
        requires: { platform: ['linux'], arch: ['x64'] },
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: true,
      },
      {
        // Catch-all for hardware with no self-contained prebuilt (Windows; non-x64 Linux;
        // etc.) → "build from source → Add your own engine".
        id: 'turboquant-source',
        label: 'Build from source',
        repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant',
        requires: {},
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: false,
      },
    ],
  },
]

/** The catalog as seen on this platform: engines runnable here, plus a per-entry
 *  `supportedHere` flag so the UI can dim ones that won't run on this OS. */
export function catalogForPlatform(platform: NodeJS.Platform = process.platform): Array<CatalogEngine & { supportedHere: boolean }> {
  return ALL.map((e) => ({ ...e, supportedHere: e.platforms.includes(platform) }))
}

/** Look up a single catalog entry by id. */
export function catalogEngine(id: string): CatalogEngine | undefined {
  return ALL.find((e) => e.id === id)
}
