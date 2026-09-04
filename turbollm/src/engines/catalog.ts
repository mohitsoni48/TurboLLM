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
// installable when a real provisioning path exists. If NEITHER build-from-source
// NOR one-click install works yet, don't list it at all — a "coming soon, not
// actually installable" entry reads as a red flag, not awareness (ADR-239). Add
// the entry once a real path (either one) is built.

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
  /** Pin the build-from-source to an exact commit SHA (7-40 hex). Set when the entry needs a
   *  specific historical commit — e.g. one that a `patchUrl` was authored against. */
  sourceCommit?: string
  /** URL of a unified-diff patch applied on top of `sourceCommit` before compiling — for an
   *  architecture not yet in the repo's mainline (e.g. solar_open2). Requires `patchSha256`. */
  patchUrl?: string
  /** Pinned lowercase 64-char hex SHA-256 the downloaded `patchUrl` is verified against before
   *  it's applied (build-runner hard-fails on a mismatch). Set iff `patchUrl` is set. */
  patchSha256?: string
  /** Installable variants (one per hardware path). Optional: llama.cpp derives
   *  its variants at call time via llamaCppVariants(); other engines list them
   *  inline or leave undefined (handled in later phases). */
  variants?: EngineVariant[]
  /** True ONLY for the backend-picker `llama.cpp` entry (ADR-388). `installEndpoint: ''` is
   *  ambiguous — it also means "no real download path, build-from-source only" (Prism,
   *  BeeLlama, ik_llama.cpp, TurboQuant, solar-open2, `llama.cpp-cuda-linux`), and those
   *  entries WANT the generic sourceRepo-based "is a build of this repo already registered?"
   *  match in `/api/v1/engines/catalog` — it is their only installed/enabled signal. The base
   *  `llama.cpp` entry is different: its installed state comes entirely from the separate
   *  backend-build detection (`LlamaCppBackendRows`, the "Manage GPU builds" expander), so
   *  letting it ALSO claim the generic sourceRepo match stole a manually source-built plain
   *  `ggml-org/llama.cpp` binary's registry id into `matchedRegistryIds` — hiding it from BOTH
   *  the custom-engine card list AND the (non-existent, for this entry) manage-actions UI the
   *  generic match implies. Set true to opt this entry out of that generic match. */
  excludeFromSourceMatch?: boolean
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
    // 'android' included: upstream has no Android prebuilt (Bionic vs. glibc), so on Android
    // this flows through the same LlamaCppBackendRows UI but availableBackends() (download.ts)
    // resolves the archive from TurboLLM's OWN cross-compiled releases instead of upstream's —
    // see ANDROID_REPO there. GitHub #52 item 6 / ADR-390/391.
    platforms: ['win32', 'darwin', 'linux', 'android'],
    support: 'stable',
    // llama.cpp expands into the backend sub-picker (existing UI); it has no single
    // install endpoint of its own.
    installEndpoint: '',
    // Its installed state comes from the separate backend-build detection (LlamaCppBackendRows),
    // not the generic sourceRepo match below — see the field's own doc comment (ADR-388).
    excludeFromSourceMatch: true,
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
    // GitHub #52 item 6, "Android out-of-box support". Fallback / advanced path, now that the
    // main llama.cpp entry above carries a real Android prebuilt (TurboLLM's own NDK cross-
    // compile, ADR-391): this stays useful for an ABI CI doesn't publish (e.g. armeabi-v7a), a
    // llama.cpp commit newer than the last CI build, or Termux itself being unavailable/broken
    // for the hosted download. Building from source inside Termux with Termux's own clang
    // produces a Bionic-native binary directly, the same "no prebuilt → build it" treatment
    // ik_llama.cpp already gets below. Termux reports process.platform === 'android' (not
    // 'linux') — see sysinfo.ts and build-prereqs.ts for the other places that matters.
    id: 'llama.cpp-android-source',
    name: 'llama.cpp (Android / Termux, build from source)',
    kind: 'llama-server',
    description: 'Official llama.cpp, CPU-only, built from source inside Termux — the advanced/fallback path when the prebuilt above (llama.cpp entry) doesn\'t fit your device.',
    provision: 'github-release',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    repo: 'ggml-org/llama.cpp',
    platforms: ['android'],
    support: 'experimental',
    installEndpoint: '',
    note: 'Run inside Termux (not the Android app store — get Termux from F-Droid or its GitHub releases). First install the toolchain: `pkg install git cmake clang`. Then use the guided build below. Real-device verified: toolchain install + partial compile confirmed live on a real Android 14 (4KB-page) emulator; a full clean build was not timed to completion in that session (GitHub #52 item 6).',
    variants: [
      {
        id: 'llama.cpp-android-source-cpu',
        label: 'CPU — build from source',
        repo: 'ggml-org/llama.cpp',
        requires: { platform: ['android'] },
        stability: 'experimental',
        speed: 'baseline',
        hasPrebuilt: false,
      },
    ],
  },
  {
    // General-purpose build-from-source entry for official llama.cpp — cross-platform,
    // branch-aware. Unlike llama.cpp-cuda-linux (Linux-only CUDA) and llama.cpp-android-source
    // (Termux-only CPU), this works on every desktop OS and lets the user pick any branch.
    // Each branch builds into its own directory and registers as a separate engine
    // (e.g. Llama-main, Llama-my-feature). The main llama.cpp entry above handles the
    // prebuilt download path; this is the source-build complement.
    id: 'llama.cpp-source',
    name: 'llama.cpp (Build from Source)',
    kind: 'llama-server',
    description:
      'Official llama.cpp, compiled from source on your machine. Pick any branch — each becomes its own engine.',
    provision: 'github-release',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    repo: 'ggml-org/llama.cpp',
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '',
    note:
      'No prebuilt binary. Select a branch below and TurboLLM clones + compiles it for you. '
      + 'Each branch you build becomes a separate engine (e.g. Llama-main, Llama-my-feature).',
    variants: [
      {
        id: 'llama.cpp-source-branch',
        label: 'Build from source',
        repo: 'ggml-org/llama.cpp',
        requires: {},
        stability: 'experimental',
        speed: 'baseline',
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
    id: 'rapid-mlx',
    name: 'Rapid-MLX',
    kind: 'rapid-mlx',
    description:
      'A fast Apple-Silicon engine built on MLX with an OpenAI-compatible server — continuous batching and prompt caching.',
    provision: 'pip',
    homepage: 'https://github.com/raullenchai/Rapid-MLX',
    repo: 'raullenchai/Rapid-MLX',
    platforms: ['darwin'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/rapid-mlx',
    note: 'macOS (Apple Silicon) only. Loads the same MLX-format model directories as the MLX engine.',
    variants: [
      {
        id: 'rapid-mlx',
        label: 'Apple Metal',
        repo: 'raullenchai/Rapid-MLX',
        requires: { platform: ['darwin'], gpuVendor: ['apple'] },
        stability: 'experimental',
        speed: 'fastest',
        hasPrebuilt: true,
      },
    ],
  },
  {
    id: 'mlx-vlm',
    name: 'MLX-VLM',
    kind: 'mlx-vlm',
    description:
      'Vision-language models (Qwen-VL, Gemma vision, LLaVA, SmolVLM, and others) on Apple Silicon via MLX, with an OpenAI-compatible server.',
    provision: 'pip',
    homepage: 'https://github.com/Blaizzy/mlx-vlm',
    repo: 'Blaizzy/mlx-vlm',
    platforms: ['darwin'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/mlx-vlm',
    note:
      'macOS (Apple Silicon) only. Loads the same MLX-format model directories as the MLX engine. ' +
      'Some architectures (e.g. Qwen-VL, SmolVLM) additionally need torch + torchvision, which are ' +
      'not installed automatically. If a model fails to load with a "missing image processor" ' +
      'error, locate the bootstrapped uv binary (find ~/.turbollm/engines/uv -name uv -type f) ' +
      'and run: <that uv path> pip install --python <this engine\'s venv>/bin/python torch torchvision. ' +
      'Tool/function calling is architecture-dependent: mlx-vlm only turns a `tools` array into ' +
      'real tool calls for the handful of chat templates it has a matching parser for. Other ' +
      'models accept the request without error but never call a tool (confirmed live on ' +
      'Qwen2.5-VL: its own /health reports "loaded_tool_parser": null).',
    variants: [
      {
        id: 'mlx-vlm',
        label: 'Apple Metal',
        repo: 'Blaizzy/mlx-vlm',
        requires: { platform: ['darwin'], gpuVendor: ['apple'] },
        stability: 'experimental',
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
      'A llama.cpp fork (ikawrakow) with CPU/GPU performance work, extra quant types, and adaptive DFlash speculative decoding. Ships llama-server but publishes no prebuilt binaries — build it, then add your own engine.',
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
  {
    id: 'prism',
    name: 'Prism (llama.cpp fork)',
    kind: 'llama-server',
    description:
      'A llama.cpp fork tuned for 1-2 bit ternary/Bonsai models. Ships llama-server but has no install endpoint here yet — build it, then add your own engine.',
    provision: 'github-release',
    homepage: 'https://github.com/PrismML-Eng/llama.cpp',
    repo: 'PrismML-Eng/llama.cpp',
    // The fork itself publishes extensive per-commit prebuilt archives (CUDA/Vulkan/ROCm ×
    // win/linux/macOS, same naming convention as official llama.cpp) — but TurboLLM doesn't
    // resolve them automatically (deliberately deferred, see ADR-238). Build-from-source only.
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '',
    note: 'Upstream publishes prebuilt binaries, but TurboLLM builds from source here (guided walkthrough) rather than resolving a specific release asset. Proven on a ternary/Bonsai-class model at 200K context (Q2_0 + q8 KV).',
    variants: [
      {
        id: 'prism-source',
        label: 'Build from source',
        repo: 'PrismML-Eng/llama.cpp',
        requires: {},
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: false,
      },
    ],
  },
  {
    id: 'beellama',
    name: 'BeeLlama.cpp',
    kind: 'llama-server',
    description:
      'A llama.cpp fork adding variance-normalized KV-cache quantization (KVarN), a KV precision tail, and adaptive DFlash speculative decoding. Ships llama-server but has no install endpoint here yet — build it, then add your own engine.',
    provision: 'github-release',
    homepage: 'https://github.com/Anbeeld/beellama.cpp',
    repo: 'Anbeeld/beellama.cpp',
    // Also publishes a full prebuilt matrix (CUDA/ROCm/Vulkan/SYCL/CPU) in one normal
    // release — but solo-maintainer, fast-churn fork (v0.4.0 dropped its own TurboQuant/TCQ
    // support), so one-click install is deliberately deferred; build-from-source only.
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '',
    note: "Upstream publishes prebuilt binaries, but TurboLLM builds from source here. The KVarN cache types (kvarn2...kvarn8, set via --cache-type-k/-v) show up directly in the KV cache type dropdown, but aren't in the auto-tune sweep yet — pick one manually.",
    variants: [
      {
        id: 'beellama-source',
        label: 'Build from source',
        repo: 'Anbeeld/beellama.cpp',
        requires: {},
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: false,
      },
    ],
  },
  {
    id: 'solar-open2',
    name: 'Solar Open 2 (patched llama.cpp)',
    kind: 'llama-server',
    description:
      "Upstage's Solar Open 2 (250B-A15B MoE) isn't in mainline llama.cpp yet — this builds official llama.cpp at a pinned commit with a community patch that adds the solar_open2 architecture, then runs it on the standard llama-server path.",
    provision: 'github-release',
    // Builds the OFFICIAL llama.cpp repo (like the prism/beellama build-from-source cards, no
    // real github-release asset is resolved) — pinned to the exact commit the patch was authored
    // against, then the checksum-verified patch is applied before compiling. The patch is an
    // INDEPENDENT community diff, NOT reviewed or endorsed by Upstage or upstream llama.cpp — same
    // fork-provenance honesty as the prism/beellama entries above (Honesty rule at the top).
    homepage: 'https://github.com/ggml-org/llama.cpp',
    repo: 'ggml-org/llama.cpp',
    sourceCommit: '846e991ec3c7ccec49112ff2c5b00b710e5f551d',
    patchUrl: 'https://huggingface.co/prometheusAIR/Solar-Open2-250B-GGUF/resolve/main/solar_open2-llama.cpp.patch',
    patchSha256: '998a9cef479d3b01f25e473793890b05b887a8ce85563431b3b053b14bb21fa8',
    platforms: ['win32', 'darwin', 'linux'],
    support: 'experimental',
    installEndpoint: '',
    note:
      'Unofficial: applies an independent community patch (not affiliated with or reviewed by Upstage or upstream llama.cpp) on top of a pinned llama.cpp commit, verified against a pinned SHA-256 before it is applied. This is a 250B-total / ~15B-active MoE — the upstream port was tested on workstation-class hardware (128GB DDR5 + a 96GB RTX PRO 6000), not a typical consumer box; GGUF quants run ~89 GiB (Q2_K) to 191 GiB (Q6_K), with IQ4_XS (~127 GiB) recommended. Two known quirks on this arch: pass -ub 512 or -ub 4096 (a batch size of -ub 2048 crashes with a CUDA illegal-memory-access), and add --no-mmap for any CPU-offloaded setup (mmap page-faulting collapses throughput ~10x on this port).',
    variants: [
      {
        id: 'solar-open2-source',
        label: 'Build from source (patched)',
        repo: 'ggml-org/llama.cpp',
        requires: {},
        stability: 'experimental',
        speed: 'baseline',
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
