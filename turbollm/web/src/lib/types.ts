// Shared TS types for the daemon's API JSON; the typed client in lib/api.ts returns these shapes.
// Types the daemon builds a response from live in src/contract/ (types only) and are re-exported below, so call
// sites keep importing from here; the daemon `satisfies` those same declarations, so the two sides cannot drift.
// The rest are still declared by hand in this file: move one into src/contract/ when its route gains a `satisfies`.
import type {
  AgentTask, BenchCandidate, BenchState, CardSampling, ComfyRuntime, EngineBuild, EngineError, EngineProvision,
  EngineRuntime, EngineState, EngineStats, JevLabel, JevStatus, LastLoaded, LayaStatus, LiveGeneration, LoadedModel, LoadFailure,
  ServingStatus, Status, TextClassificationRuntime, TextClassificationStatus, TunnelStatus,
} from '@contract/status'
import type { JevInfo, LayaInfo, LitertlmSampler, ModelEntry, ModelsList } from '@contract/models'

export type {
  AgentTask, BenchCandidate, BenchState, CardSampling, ComfyRuntime, EngineBuild, EngineError, EngineProvision,
  EngineRuntime, EngineState, EngineStats, JevLabel, JevStatus, LastLoaded, LayaStatus, LiveGeneration, LoadedModel, LoadFailure,
  ServingStatus, Status, TextClassificationRuntime, TextClassificationStatus, TunnelStatus,
  JevInfo, LayaInfo, LitertlmSampler, ModelEntry, ModelsList,
}

/** Live hardware usage (ADR-383) — the /api/v1/hwstats body. MUST stay structurally
 *  identical to `HwGpuUsage` in `src/sysinfo/usage-parse.ts`: the two declarations drift
 *  silently otherwise, and only tsc over both trees plus the route test catch it. */
export type HwGpuUsage = {
  index: number
  name: string
  /** Utilization percent, or null when the reader has no value for this card (fail open —
   *  null renders as —, never 0). */
  utilPct: number | null
  vramUsedMb: number | null
  /** Always a number: the reader's total when it reports one, else the SysInfo-detected total. */
  vramTotalMb: number
  /** Windows WDDM shared (system-memory) usage; null elsewhere. */
  vramSharedMb: number | null
  /** True when `vramUsedMb` is a slice of system RAM rather than a second pool (Apple Silicon,
   *  AMD APUs, iGPUs). The UI MUST branch on this, never on vendor: independent RAM + VRAM bars
   *  on a unified box double-count the same bytes (ADR-306 / GitHub #164). */
  unified: boolean
}

/** Disk throughput, MB/s (10^6 bytes). Null fields/whole value mean "nothing to report" —
 *  no reader for this platform or no second sample yet to rate against — never a fabricated 0. */
export type HwDiskUsage = {
  /** MB/s read. On a COMBINED reader (macOS) this is the read+write TOTAL, not the read half. */
  readMBps: number | null
  /** Always null when `combined` is true — the platform reports no split. */
  writeMBps: number | null
  /** True when the platform reports one un-split throughput figure. The UI MUST branch on this
   *  rather than on `writeMBps === null`, which cannot distinguish "no split exists" from
   *  "the write figure was unreadable". */
  combined: boolean
}

export type HwUsage = {
  /** Busy percent over the last sample interval, null on the very first sample. */
  cpuPct: number | null
  ram: { usedMb: number; totalMb: number }
  gpus: HwGpuUsage[]
  /** GitHub #211 follow-up: lets the Monitor tab show whether disk I/O is the bottleneck
   *  during model load or a long KV-cache-memory session. Null before the first rated sample,
   *  or on a platform with no disk reader. */
  disk: HwDiskUsage | null
  sampledAt: number
}

/** App self-update check (F-006, GET /api/v1/app/update). Is a newer TurboLLM published
 *  on npm than the running version? `latest` is null + `error:'offline'` when the npm
 *  registry was unreachable (the UI then stays silent — never a false "up to date"). */
export type AppUpdate = {
  /** The running version. */
  installed: string
  /** The npm `latest`, or null when the check failed (offline). */
  latest: string | null
  hasUpdate: boolean
  checkedAt: string
  error?: 'offline' | 'rate_limited'
  comparable: boolean
  /** How this daemon is installed (spec 29 B.1). Decides what the update dialog may
   *  offer — a wrong guess is worse than no button, so the daemon classifies rather than
   *  the browser. Optional: a daemon older than this feature simply omits it. */
  method?: 'npm_global' | 'npx' | 'electron' | 'docker' | 'android' | 'source' | 'unknown'
  /** May the daemon apply the update itself (POST /api/v1/app/update)? */
  canSelfUpdate?: boolean
  /** The copyable manual command. Always present when there is one — this is what keeps
   *  the dialog from dead-ending on Docker / source / unknown installs. */
  command?: string
  /** One sentence explaining what to do instead, when self-update isn't offered. */
  note?: string
  /** App-level update policy (spec 29 B.4), same vocabulary as the per-engine one. */
  policy?: UpdatePolicy
  /** The version whose toast the user already dismissed, so it never nags twice. */
  dismissedVersion?: string
}

/** Where an in-app update has got to (GET /api/v1/app/update/progress). `done`/`failed`
 *  come from the RESTARTED daemon reading the updater helper's result file — the process
 *  that ran the update is gone by the time there is an outcome. */
export type AppUpdateProgress = {
  state: 'idle' | 'downloading' | 'installing' | 'restarting' | 'done' | 'failed'
  target: string | null
  from: string | null
  method: AppUpdate['method'] | null
  error: string | null
  at: string
}

export type FlagInfo = {
  name: string
  kind: 'enum' | 'boolean' | 'valued'
  enumValues?: string[]
}

/** A registered engine (GET /api/v1/engines, config §3 shape). */
export type EngineCapabilities = {
  kvTypes: string[]
  flags: string[]
  flagInfo?: FlagInfo[]
}

/** A model file format an engine reads (the daemon's compat.ts ModelFormat). */
export type ModelFormat = 'gguf' | 'mlx' | 'litertlm'

/** Which of the in-app TurboLLM SDK's engines a row of kind 'turbollm-sdk' is (ADR-462), as the SDK reported it. */
export type SdkEngineDescriptor = {
  id: string
  kind: string
  formats: ModelFormat[]
  backends: ('cpu' | 'gpu')[]
}

export type Engine = {
  id: string
  name: string
  binPath: string
  kind?: string
  /** Set only on an in-app SDK row (kind 'turbollm-sdk'); absent on the pre-ADR-462 single SDK row. */
  sdkEngine?: SdkEngineDescriptor
  /** The model formats this row reads, computed by the daemon's engines list so the web never mirrors compat.ts. */
  formats?: ModelFormat[]
  version: string
  capabilities: EngineCapabilities
  addedAt?: string
  /** Optional source-repo URL this engine was built from (ADR-088). When set, the
   *  update check compares the built commit against the repo's latest commit and shows
   *  a notify-only "newer source available → rebuild". */
  sourceRepo?: string
  /** Optional branch to compare commits against (ADR-088). Empty → default branch. */
  sourceBranch?: string
  /** Set only when this build was pinned to an exact historical commit. */
  sourceCommit?: string
  /** Set when this engine was installed from a GitHub release asset (issue #276). */
  release?: ReleaseProvenance
}

/** Where a release-installed engine came from; mirrors backend ReleaseProvenance. */
export type ReleaseProvenance = {
  repo: string
  tag: string
  asset: string
  assetKey: string
  publishedAt: string
  prerelease: boolean
  companions: string[]
}

/** A custom (non-catalog) engine remembered even while disabled (see backend
 *  CustomEngineSource) — lets Enable re-register the still-built binary with no rebuild. */
export type CustomEngineSource = {
  name: string
  binPath: string
  kind?: string
  sourceRepo?: string
  sourceBranch?: string
  sourceCommit?: string
  sourcePatchUrl?: string
  addedAt: string
  /** Whether `binPath` still exists on disk — false means the user removed the build
   *  folder by hand; Enable can't work until it's rebuilt. */
  binPathExists: boolean
}

export type EnginesList = {
  engines: Engine[]
  activeEngineId: string
  /** Custom engines the user has added before but are not currently registered
   *  (Disabled, or never re-enabled since) — see {@link CustomEngineSource}. */
  customDisabled: CustomEngineSource[]
}

/** POST /api/v1/engines/scan result (engine overhaul, Phase 3). Read-only preflight
 *  for the guided Add-engine flow: `found:false` when no server binary turned up in
 *  the chosen folder, else the located binary + its probed version/capabilities and
 *  a pre-filled suggested name. ProbeError surfaces as an ApiError (wrong-OS / timeout).
 *  The .zip upload (/api/v1/engines/zip) answers with the same shape, plus: `warning`
 *  for a non-blocking caveat to show at the confirm step (a CUDA build without its
 *  cudart runtime), and `updated` when the upload replaced an engine that already lived
 *  in that build folder — its registration was refreshed in place, so Add is already done. */
export type EngineScanResult =
  | { found: false }
  | {
      found: true
      binPath: string
      version: string
      capabilities: EngineCapabilities
      suggestedName: string
      warning?: { code: string; message: string }
      updated?: { id: string; name: string }
    }

/** One build from a GitHub release, ranked for this machine (GET /engines/release/assets). */
export type RankedReleaseAsset = {
  name: string
  size: number | null
  os: string | null
  arch: 'x64' | 'arm64' | null
  backend: string
  cudaVersion: string | null
  compatible: boolean
  /** Why an incompatible build cannot run here. */
  reason: string | null
  recommended: boolean
  /** Archives installed alongside (e.g. the matching cudart zip). */
  companions: { name: string; size: number | null }[]
}

export type ReleaseAssetListing = {
  repo: string
  tag: string
  publishedAt: string
  prerelease: boolean
  /** True when the newest release had nothing for this OS and an older one was chosen. */
  fellBack: boolean
  assets: RankedReleaseAsset[]
  /** The repo has releases but no build runs on this machine: `assets` are shown with their
   *  reasons only, nothing can be installed (from a 404 `no_compatible_asset`). */
  noCompatible?: true
}

export type ReleaseInstallPlan = { repo: string; tag: string; asset: string }

export type ReleaseJobErrorCode =
  | 'no_server_binary'
  | 'zip_too_large'
  | 'bad_zip'
  | 'download_failed'
  | 'cancelled'
  | 'unsupported_archive'
  | 'extract_failed'
  | 'github_rate_limited'
  | (string & {})

/** GET /engines/release/install: the single-slot install job. */
export type ReleaseJobView = {
  state: 'idle' | 'running' | 'ready' | 'updated' | 'error'
  plan?: ReleaseInstallPlan
  result?: EngineScanResult
  updated?: { id: string; name: string }
  error?: { code: ReleaseJobErrorCode; message: string }
}

/** A selectable llama.cpp backend variant (ADR-025). A "build" of the official
 *  engine. `engineId` is the registered engine to activate once installed.
 *  `enabled` = a registry engine entry exists for this binary (files on disk + registered).
 *  `installed` = binary files exist on disk (superset of `enabled`). */
export type BackendInfo = {
  id: string
  label: string
  installed: boolean
  /** True when the binary is registered in the engine registry (installed + enabled). */
  enabled: boolean
  recommended: boolean
  active: boolean
  engineId: string
}

export type MlxInfo = {
  supported: boolean
  installed: boolean
  /** True when the MLX engine is registered in the engine registry. */
  enabled: boolean
  active: boolean
  engineId: string
}

export type EngineBackends = {
  vendor: string
  recommended: string
  gpus: { name: string; vramMb: number; vendor: string }[]
  backends: BackendInfo[]
  mlx: MlxInfo
}

export type EngineLogs = {
  lines: string[]
  /** Model keys of the loaded pool slots whose own log `?model=` can read (keep-N, embedding, Laya). */
  slots?: string[]
}

// ── Honest engine update status (ADR-085, Phase 6) ────────────────────────────
/** Per-engine auto-update policy. Default 'notify'. */
export type UpdatePolicy = 'off' | 'notify' | 'auto'

/** One engine's update status from GET /api/v1/engines/updates. `latest` is null when
 *  the check could not complete (offline) — the UI must show "couldn't check", never a
 *  fabricated "up to date". `comparable` is false when latest couldn't be parsed/compared. */
export type EngineUpdateStatus = {
  installed: string
  latest: string | null
  hasUpdate: boolean
  checkedAt: string
  error?: 'offline' | 'rate_limited' | 'no_release_asset' | 'no_source'
  comparable: boolean
  /** Set for source-built engines (ADR-088): the update is a source change that can't be
   *  auto-applied (TurboLLM can't recompile). The UI shows "newer source available →
   *  rebuild" + a repo link instead of a one-click Update. Absent for release/pip. */
  rebuild?: boolean
}

/** GET /api/v1/engines/updates payload: per-engine-id status + current policy. */
export type EngineUpdates = {
  updates: Record<string, EngineUpdateStatus>
  policies: Record<string, UpdatePolicy>
}

/** One entry in the engine catalog (ADR-044). Mirrors src/engines/catalog.ts. */
export type CatalogEngine = {
  id: string
  name: string
  kind: string
  description: string
  provision: 'github-release' | 'pip' | 'builtin'
  homepage: string
  repo?: string
  platforms: string[]
  support: 'stable' | 'experimental'
  installEndpoint: string
  comingSoon?: boolean
  /** Offers "Install prebuilt" from the repo's GitHub releases (ADR-453). */
  releaseInstall?: boolean
  note?: string
  /** The default branch for this repo (e.g. 'master' for llama.cpp, 'main' for most others).
    *  Used to pre-select the branch in the dropdown. */
  defaultBranch?: string
  /** Pin the build-from-source to an exact commit (7-40 hex) — e.g. the commit a `patchUrl`
    *  was authored against. */
  sourceCommit?: string
  /** URL of a unified-diff patch applied on top of `sourceCommit` before compiling (an arch not
   *  yet in mainline, e.g. solar_open2). Sent to /build/run with `patchSha256`. */
  patchUrl?: string
  /** Pinned SHA-256 the downloaded `patchUrl` is verified against (backend hard-fails on a
   *  mismatch). Set iff `patchUrl` is set. */
  patchSha256?: string
  /** Whether this engine can run on the current OS. */
  supportedHere: boolean
  /** Whether the engine's files exist on disk (disk-based check). */
  installed?: boolean
  /** Whether a registry engine entry exists for this engine (files installed AND registered). */
  enabled?: boolean
  /** This catalog engine was compiled from source (ADR-100): manage it via Rebuild, not a
   *  prebuilt Update. True whether currently registered or just on disk (disabled). */
  sourceBuilt?: boolean
  /** Registry id of the matched source-built engine (when enabled) — for disable/delete/policy. */
  sourceEngineId?: string
  /** Branch the source-built engine was compiled from (for a Rebuild). */
  sourceBranch?: string
  /** Path to the built binary (used to Enable a built-but-disabled source engine). */
  sourceBinPath?: string
  /** Registry id of the release-installed engine this card owns (issue #276). Ownership comes
   *  only from the backend; the web never matches a release engine to a card by repo. */
  releaseEngineId?: string
  /** Provenance of that release engine (or of the remembered disabled one). */
  release?: ReleaseProvenance
  /** Binary of the owned release engine, or of a disabled one that can be Enabled again. */
  releaseBinPath?: string
  /** Installable variants (one per hardware path). Optional — llama.cpp derives its
   *  variants at call time; other engines list them inline or leave undefined. */
  variants?: EngineVariant[]
}

export type EngineCatalog = {
  engines: CatalogEngine[]
}

// ── Guided compile-from-source prereqs (ADR-089) ─────────────────────────────
/** One build-toolchain prerequisite from GET /api/v1/build/prereqs. Mirrors
 *  src/engines/build-prereqs.ts BuildPrereqTool. */
export type BuildPrereqTool = {
  id: 'git' | 'cmake' | 'cuda' | 'msvc' | 'gcc'
  name: string
  found: boolean
  version?: string
  installUrl: string
  /** Present (and non-empty) only for a MISSING tool the host's package manager can install:
   *  the ordered argv steps TurboLLM would run on the daemon machine. Absent when the website
   *  link is the only realistic path (all of Windows, CUDA on dnf/zypper, macOS's compiler). */
  installCommands?: string[][]
}

/** GET /api/v1/build/prereqs payload. Guided build supports Windows, Linux (both + CUDA) and
 *  macOS (+ Metal — no GPU-toolkit prereq, so `tools` there is just git/cmake/compiler). `os`
 *  tells the UI which toolchain shape `tools` reflects (and which manual command block to show). */
export type BuildPrereqs = {
  supported: boolean
  os: 'windows' | 'linux' | 'macos' | 'other'
  tools: BuildPrereqTool[]
  /** The host package manager the `installCommands` were generated for, or null when none was
   *  detected (always null on Windows). Lets the UI name it instead of showing a bare button. */
  packageManager: 'apt-get' | 'dnf' | 'pacman' | 'zypper' | 'brew' | null
}

// ── Engine recommendation (engine overhaul, Phase 2) ─────────────────────────
// Mirrors the backend shapes from src/engines/{hardware,catalog,recommend}.ts.
// Returned by GET /api/v1/engines/recommendation.

/** Detected hardware, mirrors src/engines/hardware.ts HardwareProfile. */
export type HardwareProfile = {
  platform: string
  arch: 'x64' | 'arm64'
  gpuVendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown'
  hasGpu: boolean
  vramMb: number
  gpuName?: string
}

/** One hardware path of a catalog engine, mirrors src/engines/catalog.ts EngineVariant. */
export type EngineVariant = {
  id: string
  label: string
  repo: string
  requires: {
    platform?: string[]
    arch?: ('x64' | 'arm64')[]
    gpuVendor?: string[]
    backend?: string
    minVramMb?: number
    minCudaCC?: number
  }
  stability: 'stable' | 'experimental'
  speed?: 'baseline' | 'fast' | 'fastest'
  backendId?: string
  hasPrebuilt: boolean
}

/** Per-engine fit over the detected hardware, mirrors src/engines/recommend.ts EngineFit.
 *  The recommendation endpoint passes plain CatalogEngine[] (no `supportedHere`/disk
 *  flags), so the embedded engine omits those projection-only fields. */
export type EngineFit = {
  engine: Omit<CatalogEngine, 'supportedHere' | 'installed' | 'enabled'>
  variants: EngineVariant[]
  compatible: EngineVariant[]
  /** Set when compatible.length === 0 — why this box can't run the engine. */
  incompatibleReason?: string
  recommended: boolean
}

/** The headline pick + per-engine fits, mirrors src/engines/recommend.ts EngineRecommendation. */
export type EngineRecommendation = {
  recommended: { engineId: string; variantId: string } | null
  fits: EngineFit[]
}

/** GET /api/v1/engines/recommendation payload. */
export type EngineRecommendationResult = {
  hardware: HardwareProfile
  recommendation: EngineRecommendation
}

/** Error envelope used for every non-2xx response (spec 00 §3). */
export type ApiErrorEnvelope = {
  error: { code: string; message: string }
}

// ── Chat (minimal, non-streaming — full chat is a later milestone) ───────────
export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  role: ChatRole
  content: string
}

export type ChatCompletionResponse = {
  choices?: { message?: { content?: string } }[]
}

// ── Jev — NLI cross-encoders (ADR-434) ───────────────────────────────────────
/** The loaded Jev model as a screen knows it. The daemon always names the slot, but a client
 *  that cannot read /status has to read the model off the catalog instead (ADR-422), and
 *  the catalog cannot tell which slot the engine took: `null` says so rather than guessing
 *  `primary` and skipping the ADR-427 (c) eject. */
export type LoadedJev = Omit<JevStatus, 'slot'> & {
  slot: JevStatus['slot'] | null
  /** Set for a Laya model (ADR-443): the checkpoints it answers with. A Laya model has no labels of its own. */
  checkpoints?: string[]
}

export type ClassifyRequest = {
  model: string
  premise: string
  hypotheses: string[]
}

export type ClassifyResponse = {
  model: string
  results: Array<{ hypothesis: string; label: JevLabel; probs: Record<JevLabel, number> }>
  usage: { prompt_tokens: number; total_tokens: number }
}

export type RerankRequest = {
  model: string
  query: string
  /** The gateway also accepts `{ text }` objects; this app only ever sends strings. */
  documents: string[]
  top_n?: number
  /** API-only (ADR-434 (d)) — the playground keeps the gateway's default. */
  hypothesis_template?: string
}

export type RerankResponse = {
  model: string
  /** Sorted by `relevance_score` descending; `index` points back into `documents`. */
  results: Array<{ index: number; document: { text: string }; relevance_score: number; label: JevLabel }>
  usage: { prompt_tokens: number; total_tokens: number }
}

/** One thing a model load would interrupt right now (ADR-434 (i)(3)). `load`: a model loading;
 *  `tune`: an auto-tune run; `skill`: a skill being written. */
export type ActiveWorkItem = {
  kind: 'chat' | 'code' | 'routine' | 'load' | 'tune' | 'skill'
  id: string
  label: string
}

export type ActiveWork = {
  /** Work in progress on the engine. */
  items: ActiveWorkItem[]
  /** Chats parked on a tool-call approval: they wait on a person, so they are not in `items`, but
   *  a load still interrupts them. Absent from a daemon before it (a page left open across an
   *  update), read as none. */
  waiting?: ActiveWorkItem[]
  /** A generation running through the gateway. It has no item of its own: the daemon
   *  knows a request is in flight, not whose it is. */
  engineGenerating: boolean
}

export type ModelDirs = {
  dirs: string[]
  /** The EFFECTIVE primary folder downloads/imports land in (spec 01 §3, ADR-035):
   *  the configured primary, or the first folder when unset. '' when no folders. */
  primaryDir: string
}

// ── Token usage dashboard (Release 3) ────────────────────────────────────────
export type ActivityBucket = {
  start: string
  totalTokens: number
  messageCount: number
}

export type TokenActivity = {
  granularityHours: 1 | 12 | 24
  buckets: ActivityBucket[]
}

export type ModelUsage = {
  modelKey: string
  displayName: string
  messageCount: number
  promptTokens: number
  genTokens: number
  totalTokens: number
}

export type DailyModelBreakdown = {
  date: string
  totalTokens: number
  byModel: { modelKey: string; tokens: number }[]
}

export type TokenUsageRange = 'all' | '30d' | '7d'

export type TokenUsageStats = {
  range: TokenUsageRange
  sessions: number
  messages: number
  totalTokens: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  peakHour: number | null
  favoriteModel: string | null
  firstMessageAt: string | null
  lifetimeTotalTokens: number
  milestone: { achieved: number | null; next: number | null; progressPct: number | null }
  activity: TokenActivity
  dailyByModel: DailyModelBreakdown[]
  byModel: ModelUsage[]
  api: ApiUsageStats
}

/** Gateway (external-client) token usage — Claude Code, other CLIs/extensions hitting
 *  /v1/messages or /v1/chat/completions (GitHub #71). This isolated breakdown (by source, by
 *  model) is separate, but TokenUsageStats.totalTokens/lifetimeTotalTokens/milestone already
 *  INCLUDE it — see db.ts's ApiUsageStats doc comment for why. */
export type ApiUsageSource = 'anthropic' | 'openai'

export type ApiModelUsage = {
  modelKey: string
  displayName: string
  requests: number
  promptTokens: number
  genTokens: number
  totalTokens: number
}

export type ApiUsageStats = {
  range: TokenUsageRange
  requests: number
  totalTokens: number
  lifetimeTotalTokens: number
  bySource: { source: ApiUsageSource; requests: number; totalTokens: number }[]
  byModel: ApiModelUsage[]
}

// ── Load profiles + VRAM fit (A4, spec 05) ───────────────────────────────────
export type Sampling = {
  temp: number
  topP: number
  topK: number
  minP: number
  repeatPenalty: number
  presencePenalty: number
  frequencyPenalty: number
  stop: string[]
}

export type LoadProfile = {
  ctx: number
  ngl: number
  /** Auto-fit: when true, omit -ngl and let llama.cpp's own -fit logic pick the GPU/CPU split. */
  nglFit?: boolean
  nCpuMoe: number
  /** Auto-fit for MoE CPU offload: when true, omit --n-cpu-moe and let -fit decide. */
  nCpuMoeFit?: boolean
  parallel: number
  /** Pin this model's engine instance to a specific loopback port. 0/undefined = auto. */
  port?: number
  kvUnified: boolean
  kvTypeK: string
  kvTypeV: string
  flashAttn: 'auto' | 'on' | 'off'
  /** KV cache location: true (default) = on the GPU; false = system RAM (--no-kv-offload). */
  kvOffload: boolean
  threads: number
  threadsBatch: number
  useMmproj: boolean
  mmprojGpu: boolean
  imageMaxTokens: number
  cacheReuse: number
  useJinja: boolean
  chatTemplateFile: string
  speculative: 'off' | 'mtp' | 'nextn' | 'draft' | 'dflash'
  mtpHeadPath: string
  draftModelPath: string
  sampling: Sampling
  contextOverflow: 'shift' | 'keep'
  nKeep: number
  ropeScalingType: 'none' | 'linear' | 'yarn'
  ropeFreqBase: number
  ropeFreqScale: number
  /** Multi-GPU split settings (ADR-054). Mirrors the daemon's GpuProfile. */
  gpu: GpuProfile
  /** vLLM-specific load controls (F-027). Mirrors the daemon's VllmProfile. */
  vllm: VllmProfile
  /** LiteRT-LM load controls. Mirrors the daemon's LitertLmProfile. */
  litertLm?: LitertLmProfile
  extraArgs: string[]
  /** llama.cpp --batch-size. Prompt processing batch size. 0 / absent = engine default (2048). */
  batchSize?: number
  /** llama.cpp --ubatch-size. Physical micro-batch size. 0 / absent = engine default (512). */
  uBatchSize?: number
  /** Speculative `draft` mode window (GitHub #35). --draft-max; absent = 16 default. */
  draftMax?: number
  /** Speculative `draft` mode window (GitHub #35). --draft-min; absent = 1 default. */
  draftMin?: number
  /** llama.cpp --load-mode (GitHub #222). How the weights are read off disk — e.g. `mmap`,
   *  `dio` (direct I/O), `read`. Empty/absent = not emitted, engine default. Free-form on
   *  purpose: the dialog renders the values the engine's own --help advertised
   *  (`Capabilities.flagInfo`), never a hardcoded list. */
  loadMode?: string
  /** llama.cpp --no-mmap (GitHub #222). Read the file into memory instead of mapping it.
   *  Absent/false = engine default (mmap on). */
  noMmap?: boolean
  /** llama.cpp --cache-ram: MiB of RAM the server may use to keep finished prompts. Absent =
   *  not emitted, engine default (8192 MiB). 0 disables the prompt cache. Whole MiB only. */
  cacheRam?: number
  tunedBy?: string
}

/** The load-profile fields the user set, as the model dialog sends and saves them (the daemon's
 *  LoadProfile.userSetOnly marks such a profile): a control the user did not move is absent, so the
 *  model's own or the automatic value applies there, and a later change to Settings > Model Defaults
 *  still reaches it. Groups the daemon merges key by key are partial too. */
export type UserSetProfile = Omit<Partial<LoadProfile>, 'sampling' | 'gpu' | 'vllm' | 'litertLm'> & {
  sampling?: Partial<Sampling>
  gpu?: Partial<GpuProfile>
  vllm?: Partial<VllmProfile>
  litertLm?: Partial<LitertLmProfile>
  userSetOnly?: boolean
}

/** A named saved load-config for a model (ADR-353). Mirrors the backend's ModelPreset;
 *  `profile` is `Partial<LoadProfile>` here since presets saved by older builds may be
 *  missing newer fields — the dialog deep-merges them onto the current draft. */
export type ModelPreset = {
  id: string
  name: string
  /** Engine this preset was tuned on; '' = any engine. */
  engineId: string
  profile: UserSetProfile
  updatedAt: string
  origin: 'manual' | 'autotune'
  /** tok/s measured by the auto-tune run that minted this (origin === 'autotune'). */
  benchTps?: number
}

export type GpuProfile = {
  /** llama.cpp --split-mode */
  splitMode: 'layer' | 'row' | 'none'
  /** llama.cpp --tensor-split per-GPU proportions (empty = even). */
  tensorSplit: number[]
  /** llama.cpp --main-gpu (-1 = engine default). */
  mainGpu: number
  /** vLLM --tensor-parallel-size (1 = single GPU). */
  tensorParallelSize: number
}

export function defaultGpu(): GpuProfile {
  return { splitMode: 'layer', tensorSplit: [], mainGpu: -1, tensorParallelSize: 1 }
}

/** vLLM load controls (F-027). Mirrors the daemon's VllmProfile; maps to vLLM CLI flags.
 *  Defaults match vLLM's own, so an untouched profile changes nothing at launch. */
export type VllmProfile = {
  /** --max-model-len (0 = derive from the model config). */
  maxModelLen: number
  /** --gpu-memory-utilization 0–1 (0.9 = vLLM default). */
  gpuMemoryUtilization: number
  /** --max-num-seqs concurrent sequences (0 = vLLM default). */
  maxNumSeqs: number
  /** --dtype compute precision. */
  dtype: 'auto' | 'bfloat16' | 'float16' | 'float32'
  /** --kv-cache-dtype (fp8 ~halves KV memory). */
  kvCacheDtype: 'auto' | 'fp8'
  /** --enforce-eager (skip CUDA graphs: less VRAM, slower). */
  enforceEager: boolean
  /** --trust-remote-code (models shipping custom modelling code). */
  trustRemoteCode: boolean
}

/** LiteRT-LM load controls. `auto` = the model's own backend: TurboLLM names none and the server takes the one the
 *  bundle declares (litert-lm.ts litertLmProfileToConfig); `gpu` forces the GPU (also where none can be detected,
 *  e.g. Android/Termux); `cpu` forces the CPU. */
export type LitertLmProfile = { backend: 'auto' | 'cpu' | 'gpu' }

export function defaultLitertLm(): LitertLmProfile {
  return { backend: 'auto' }
}

export function defaultVllm(): VllmProfile {
  return {
    maxModelLen: 0,
    gpuMemoryUtilization: 0.9,
    maxNumSeqs: 0,
    dtype: 'auto',
    kvCacheDtype: 'auto',
    enforceEager: false,
    trustRemoteCode: false,
  }
}

export type FitVerdict = 'fits' | 'tight' | 'overflow' | 'cpu' | 'unknown'

export type VramFit = {
  estMb: number
  totalVramMb: number
  pct: number
  verdict: FitVerdict
}

export type SysGpu = { name: string; vramMb: number }

export type ModelDetail = ModelEntry & {
  profile: LoadProfile
  /** The fields of the saved profile (or pinned preset) the user set, read as the daemon's userSetProfile reads them. */
  saved?: UserSetProfile
  /** The profile the model loads with when nothing is set: what a preset applied in the dialog is merged onto. */
  autoProfile?: LoadProfile
  vramFit: VramFit
  gpu: SysGpu | null
  /** All detected GPUs (ADR-054) — drives the multi-GPU split controls. */
  gpus: SysGpu[]
  /** Logical CPU cores — drives the threads slider max + the "Auto" hint. */
  cores: number
}

// ── Hugging Face discovery (spec 10) ─────────────────────────────────────────
/** A search result row (spec 10 §2). `localCount` > 0 drives the "↓ N in library"
 *  chip on the row. */
export type HfSearchItem = {
  repo: string
  downloads: number
  likes: number
  updatedAt: string
  gated: boolean
  tags: string[]
  localCount: number
  /** Only on a Text classification category row: the engine the repo loads on (ADR-444). */
  textClassification?: { runtime: TextClassificationRuntime }
}

export type HfSearchRows = { results: HfSearchItem[] }

/** Discover's "Text classification" category (ADR-444): the Laya bundles and verified Jev (NLI)
 *  models TurboLLM can run, whichever engine is active. */
export type HfSearchCategory = 'text-classification'

/** Mirrors src/hf/hf.ts HfSortOption. 'best-match' is HF's own relevance ranking for a
 *  text query (meaningless when browsing with no query — the daemon falls back to
 *  'trending' there). */
export type HfSortOption = 'best-match' | 'trending' | 'downloads' | 'likes' | 'modified' | 'created'

/** One logical file in a repo (spec 10 §3): GGUF split parts are grouped into one
 *  entry with summed size and `parts` > 1; safetensors component files each get
 *  their own entry with `safetensors: true`; .litertlm bundles each get their own
 *  self-contained entry with `litertlm: true`. */
/** The hardware a `.litertlm` bundle targets; `soc` names the one SoC a 'soc' bundle runs on. */
export type LitertlmTarget = {
  kind: 'any' | 'gpu' | 'web' | 'npu' | 'soc' | 'desktop'
  soc?: string
}

export type HfRepoFile = {
  name: string
  quant: string
  sizeBytes: number
  parts: number
  mmproj: boolean
  /** True for safetensors component files (MLX and vLLM repos). */
  safetensors?: boolean
  /** True for LiteRT-LM bundle files (.litertlm) — one self-contained model per file. */
  litertlm?: boolean
  /** For a `.litertlm` bundle: the hardware-variant label ('GPU', 'Mediatek MT6993') —
   *  the build this bundle targets. `quant` keeps its usual meaning (the precision the
   *  name states, '?' when none — same as the library), so the two never collide. */
  variant?: string
  /** For a `.litertlm` bundle: the hardware it was built for, read from its name (ADR-462). */
  target?: LitertlmTarget
  /** For a `.litertlm` bundle: whether the device the daemon runs on can run it (ADR-462). */
  runsHere?: boolean
  sha256?: string
  url: string
  /** True when this exact repo file was downloaded via TurboLLM and is still on
   *  disk (matched by sha256 or repo+filename provenance, spec 10 §3). */
  downloaded?: boolean
  /** The local model key for this file when downloaded — lets the dialog offer
   *  "Load" instead of "Download". */
  localKey?: string | null
}

export type HfRepoDetail = {
  repo: string
  gated: boolean
  license: string
  downloads: number
  likes: number
  card: string
  files: HfRepoFile[]
  /** True when the repo is a safetensors model (no GGUFs — covers MLX and vLLM). */
  safetensors?: boolean
  /** True when the repo ships LiteRT-LM bundles (.litertlm) instead of GGUF/safetensors
   *  models — `files` then holds one self-contained entry per bundle (the litert-community
   *  convention: gpu/web/device variants of the same model in one repo). */
  litertlm?: boolean
  /** True while the daemon is still computing content hashes to confirm whether
   *  size-matching local files are this repo's quants (spec 10 §3). The UI re-polls
   *  until it clears, then the "Downloaded" badges are final. */
  verifying?: boolean
  /** The repo's downloadable model directories (ADR-434 (h)). Absent for a GGUF repo,
   *  which keeps today's flat `files` list. */
  checkpoints?: HfCheckpoint[]
  /** True for a Laya repo (huggingface.co/convaiinnovations/laya): a safetensors repo with no
   *  `checkpoints` list of its own — `files` carries the whole nested layout (root config +
   *  per-checkpoint subfolders like 'multilingual/model.safetensors') as one flat download. */
  laya?: boolean
}

/** One downloadable model directory in a safetensors repo (ADR-434 (h)). A repo with
 *  exactly one behaves exactly as today; OpenJev-style repos get one row per folder. */
export type HfCheckpoint = {
  /** Repo-relative directory, POSIX '/'; '' = the repo root. */
  dir: string
  /** Last segment of `dir`, or the repo's own name for the root. */
  name: string
  /** Sum of this directory's own .safetensors files. */
  sizeBytes: number
  /** This directory's own component files, mapped exactly like the root `files` list. */
  files: HfRepoFile[]
  /** Read from this checkpoint's own config.json; null when it is not a Jev model. */
  jev: { architecture: string; verified: boolean } | null
  /** True when this checkpoint was downloaded via TurboLLM and is still on disk. */
  downloaded?: boolean
  /** The local model key for it when downloaded — lets a row offer "Load". */
  localKey?: string | null
}

export type HfTokenTest = {
  ok: boolean
  name?: string
}

// ── Downloads (spec 10 §5–6, §8) ─────────────────────────────────────────────
export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

export type DownloadRecord = {
  id: string
  name: string
  repo: string
  url: string
  dest: string
  total: number
  received: number
  status: DownloadStatus
  error: string | null
  bytesPerSec: number
  sha256?: string
  createdAt: string
  /** When it became 'done' (ISO; absent before that). */
  finishedAt?: string
}

export type DownloadsList = {
  downloads: DownloadRecord[]
}

/** A download the daemon names in a download request's `existing` (a row already holding a file
 *  the request asked for): what following or resuming it takes, not the whole row, which is the
 *  host's and a read a token that may only write downloads is refused. */
export type HeldDownload = Pick<DownloadRecord, 'id' | 'name' | 'status'>

// ── Developer request log (issue #211 follow-up) ─────────────────────────────
// Mirrors turbollm/src/observability/request-log.ts's `RequestLogEntry` — kept as a hand-written
// twin rather than a generated/shared type, matching every other daemon↔web type pair in this
// file (e.g. EngineLogs, DownloadRecord).
export type RequestLogSource = 'openai' | 'anthropic' | 'chat'

export type RequestLogEntry = {
  id: string
  ts: number
  source: RequestLogSource
  harness: string | null
  codeSessionId: string | null
  modelKey: string | null
  remote: string | null
  stream: boolean
  params: Record<string, unknown>
  counts: { messages: number; tools: number; systemChars: number }
  status: number | null
  error: { code: string; message: string } | null
  timings: { ttftMs: number | null; durationMs: number | null }
  tokens: { prompt: number; completion: number; promptTps: number | null; genTps: number | null }
  finishReason: string | null
  bodies: { request: string; response: string } | null
}

export type RequestLogList = {
  entries: RequestLogEntry[]
}
