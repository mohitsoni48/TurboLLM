// Shared TS types mirroring the Go daemon API JSON (spec 02). Keep these in sync
// with the daemon contract; the typed client in lib/api.ts returns these shapes.

/** Mirrors the daemon's `FAIL_REASONS` (src/telemetry/core/enums.ts), which is what
 *  `classifyLoadFailure` returns. Declared here because this file is the designated
 *  mirror of the daemon contract; `screens/onboarding/recovery.ts` checks its runtime
 *  array against this union rather than re-declaring it, so the two cannot drift. */
export type LoadFailure =
  | 'oom'
  | 'no_engine'
  | 'bad_gguf'
  | 'unsupported_arch'
  | 'timeout'
  | 'cancelled'
  | 'other'

export type EngineState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export type EngineError = {
  code: string
  message: string
  exitCode?: number
  logTail?: string[]
  /** Server-side classification of this failure (`classifyLoadFailure`, ADR-338
   *  Decision 4). Drives the one-click recovery offered in the error banner.
   *  Optional because a daemon older than the field simply omits it — the UI
   *  then falls back to `other`, which still offers a next action. */
  failReason?: LoadFailure
}

/** Active engine runtime state from GET /api/v1/status (spec 02 §1). */
export type EngineRuntime = {
  id: string
  name: string
  kind?: string
  state: EngineState
  error?: EngineError
  port?: number
  pid?: number
  /** The exact command last spawned, formatted for copy-paste into a terminal.
   *  Present only while this engine is the one actually running/starting. */
  launchCommand?: string
}

/** Loaded model from GET /api/v1/status (null when none). */
export type LoadedModel = {
  key: string
  name: string
  quant: string
  ctx: number
  vision: boolean
  loadElapsedMs?: number
}

/** Default-engine provisioning progress (ADR-024), from GET /api/v1/status. */
export type EngineProvision = {
  active: boolean
  phase: 'idle' | 'downloading' | 'extracting' | 'error'
  backend: string
  pct: number // 0..1 while downloading; -1 = indeterminate (extracting)
  part?: number // 1-based current archive (multi-asset backends like CUDA)
  parts?: number // total archives for this backend
  error: string | null
}

/** In-app compile-from-source status (ADR-100), from GET /api/v1/status. A build streams
 *  a phase + a log tail (clone/cmake output) rather than a byte percentage. */
export type EngineBuild = {
  active: boolean
  phase: 'provisioning' | 'preparing' | 'cloning' | 'configuring' | 'compiling' | 'registering' | 'done' | 'error'
  engine: string
  log: string[]
  error: string | null
}

/** Live running-session stats (B4), from GET /api/v1/status. Null unless the
 *  engine is running; resets each time the engine starts/stops. */
export type EngineStats = {
  requests: number
  inputTokens: number
  outputTokens: number
  avgPromptTps: number
  avgGenTps: number
  sinceMs: number
  /** Completions streaming through the engine right now; >0 shows a live
   *  "Generating…" indicator in the engine card. */
  activeRequests: number
}

/** One candidate the auto-tune sweep evaluated (spec 09 §1). `outcome` is 'ok' on a
 *  measured run, else the failure mode — the sweep records it and continues. */
export type BenchCandidate = {
  label: string
  params: { ctx: number; ngl: number; nglFit?: boolean; nCpuMoe: number; nCpuMoeFit?: boolean; parallel: number; kvTypeK: string; flashAttn: string }
  outcome: 'ok' | 'timeout' | 'crash' | 'oom'
  tps: number | null
  ttftMs: number | null
  vramMb: number | null
}

/** Live auto-tune state from GET /status `bench` (spec 09 §1). `done`/`error` linger
 *  after a finished run so the detail dialog can show the result. */
export type BenchState = {
  running: boolean
  modelKey?: string
  step?: string
  bestTps?: number
  candidates?: BenchCandidate[]
  done?: boolean
  error?: string
  /** Winning candidate of a finished run — drives the Save/Cancel results dialog. The profile is
   *  only persisted when the user clicks Save (POST /bench/save). */
  result?: {
    params: BenchCandidate['params']
    tps: number
    ttftMs: number
    vramMb: number | null
    /** The complete sampling the winning profile will be saved with (card values merged in) —
     *  drives the full-config table in the results dialog. */
    sampling?: CardSampling
    /** The subset of `sampling` that came from the model's HF card (ADR-099) — marks those rows
     *  "from model card". Absent when no card / nothing parsed. */
    recommendedSampling?: CardSampling
  }
}

/** Card-derived recommended sampling (ADR-099). Field names mirror the profile's `Sampling`
 *  block; only the knobs the card stated are present. */
export type CardSampling = {
  temp?: number
  topP?: number
  topK?: number
  minP?: number
}

/** Live per-request progress for the engine card (spec 11), from GET /api/v1/status.
 *  Null unless a completion is actively streaming through the engine. */
export type LiveGeneration = {
  phase: 'prompt' | 'gen'
  /** Prompt-processing percent (0–100) during the prefill phase; 0 in gen phase. */
  pct: number
  /** Output tokens produced so far (live, approximate) during the gen phase. */
  outputTokens: number
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

export type HwUsage = {
  /** Busy percent over the last sample interval, null on the very first sample. */
  cpuPct: number | null
  ram: { usedMb: number; totalMb: number }
  gpus: HwGpuUsage[]
  sampledAt: number
}

export type Status = {
  version: string
  engine: EngineRuntime
  model: LoadedModel | null
  /** Key of the last model the user loaded, config-tracked by the daemon and sent on
   *  every status poll. Survives a FAILED load — `model` above is null then — which is
   *  what makes a one-click retry of the thing that just broke possible at all. */
  lastLoaded?: string
  /** Turbo Link (ADR-382): the qualified `<machine>/<model>` id this INSTALL is pointed at,
   *  or '' for this machine's own engine. Daemon-side so every surface agrees — this browser,
   *  another device's browser, and `turbollm launch <cli>`, which has no access to any of
   *  them. Absent from an older daemon, which is read as ''. */
  selectedRemoteModel?: string
  engineStats?: EngineStats | null
  liveGeneration?: LiveGeneration | null
  bench: BenchState
  downloads: { active: number }
  engineProvision?: EngineProvision
  /** In-app compile-from-source status (ADR-100). */
  engineBuild?: EngineBuild
  /** Whether this install can spawn a PTY at all — `node-pty` is an optional native dependency,
   *  so a healthy install may simply not have it. Gates whether terminal-only Code agents are
   *  offered at all. Optional here so an older daemon (which never sends it) is treated as
   *  unknown by the caller rather than as a hard "unavailable". */
  terminalAvailable?: boolean
  /** ComfyUI GPU coordination state (null when the feature is off / not wired). */
  comfyui?: ComfyRuntime | null
  /** Background agent tasks (reviewer + skill distill) — running + recently finished. */
  agentTasks?: AgentTask[]
  telemetryLevel: string
  uptimeSec: number
  /** Locally-enabled feature flags (TURBOLLM_FEATURES env var) — internal/dev only,
   *  deliberately undocumented; see turbollm/src/features.ts. */
  features?: string[]
}

/** One background agent task surfaced via GET /status `agentTasks`. */
export type AgentTask = {
  id: string
  kind: 'review' | 'skill_from_conversation' | 'skill_from_folder'
  convId?: string
  agentId: string
  label: string
  status: 'running' | 'done' | 'failed'
  steps: string[]
  result?: string
  error?: string
  startedAt: number
  endedAt?: number
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
  error?: 'offline'
  comparable: boolean
}

/** Live ComfyUI coordination state (GET /api/v1/status). Drives the "paused while
 *  ComfyUI renders" indicator and the reason a model load was refused. */
export type ComfyRuntime = {
  enabled: boolean
  /** The gate node has been installed (a path is recorded). */
  installed: boolean
  /** Holding the GPU for ComfyUI right now (model unloaded, loads blocked). */
  held: boolean
  blocked: boolean
  suspendedModelKey: string | null
  /** ms since the last acquire/release signal from ComfyUI, or null if none yet. */
  lastSignalAgoMs: number | null
  /** Version number found in the installed __init__.py, or null if unreadable. */
  installedVersion: number | null
  /** Current gate version shipped with this TurboLLM build. */
  currentVersion: number
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

export type Engine = {
  id: string
  name: string
  binPath: string
  kind?: string
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
 *  a pre-filled suggested name. ProbeError surfaces as an ApiError (wrong-OS / timeout). */
export type EngineScanResult =
  | { found: false }
  | {
      found: true
      binPath: string
      version: string
      capabilities: EngineCapabilities
      suggestedName: string
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
  error?: 'offline' | 'no_source'
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
  note?: string
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

// ── Models (discovery, spec 04) ──────────────────────────────────────────────
export type ModelEntry = {
  key: string
  name: string
  path: string
  dir: string
  format: 'gguf' | 'mlx'
  sizeBytes: number
  sizeLabel: string
  arch: string
  quant: string
  nativeCtx: number
  blockCount: number
  headCountKv: number
  moe: boolean
  expertCount: number
  /** >0 when the GGUF carries a built-in NextN multi-token-prediction head. */
  nextnLayers: number
  vision: boolean
  /** True for MLX-format models whose config.json declares an audio_config (an audio
   *  tower/encoder, e.g. gemma4's Conformer audio module). Always false for GGUF. */
  audio: boolean
  mmprojPath: string | null
  hasChatTemplate: boolean
  /** True when the model's chat template supports a `reasoning_effort` control
   *  (low/medium/xhigh) — Qwen3.8's reasoning-depth control. Composers gate the
   *  ReasoningEffortSelect vs ThinkingBudgetSlider choice on this flag. */
  reasoningEffort: boolean
  /** True when the model is an embedding model (BERT-family or embed filename pattern).
   *  Activates --embeddings at startup so /v1/embeddings is available. */
  embedding: boolean
  incomplete: boolean
  parseError: string | null
  loaded: boolean
  hasProfile: boolean
  benchTps: number | null
  /** Most-recent gen t/s recorded for this model in chat (spec 04 §5); null if
   *  never chatted with. */
  lastTps: number | null
  /** Live gen t/s for the currently-loaded model; null unless this model is loaded
   *  and a recent figure exists (best-effort until a full session accumulator lands). */
  liveTps: number | null
  /** Whether the currently-active engine can load this model's format (ADR-044).
   *  Drives the model-list filter (GGUF under llama.cpp; safetensors under MLX/vLLM).
   *  True when no engine is active. */
  compatibleWithActiveEngine: boolean
  /** Source HF repo — confirmed from download provenance, or inferred from the
   *  on-disk layout (<root>/<owner>/<repo>/<file>) for imported files. Null when it
   *  can't be determined. Lets the library open the model's HF page (card + quants). */
  sourceRepo?: string | null
  mtime: string
}

export type ModelsList = {
  models: ModelEntry[]
  scanning: boolean
  lastScanAt: string
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
  extraArgs: string[]
  /** llama.cpp --batch-size. Prompt processing batch size. 0 / absent = engine default (2048). */
  batchSize?: number
  /** llama.cpp --ubatch-size. Physical micro-batch size. 0 / absent = engine default (512). */
  uBatchSize?: number
  /** Speculative `draft` mode window (GitHub #35). --draft-max; absent = 16 default. */
  draftMax?: number
  /** Speculative `draft` mode window (GitHub #35). --draft-min; absent = 1 default. */
  draftMin?: number
  tunedBy?: string
}

/** A named saved load-config for a model (ADR-353). Mirrors the backend's ModelPreset;
 *  `profile` is `Partial<LoadProfile>` here since presets saved by older builds may be
 *  missing newer fields — the dialog deep-merges them onto the current draft. */
export type ModelPreset = {
  id: string
  name: string
  /** Engine this preset was tuned on; '' = any engine. */
  engineId: string
  profile: Partial<LoadProfile>
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
}

export type HfSearchResult = {
  results: HfSearchItem[]
}

/** Mirrors src/hf/hf.ts HfSortOption. 'best-match' is HF's own relevance ranking for a
 *  text query (meaningless when browsing with no query — the daemon falls back to
 *  'trending' there). */
export type HfSortOption = 'best-match' | 'trending' | 'downloads' | 'likes' | 'modified' | 'created'

/** One logical file in a repo (spec 10 §3): GGUF split parts are grouped into one
 *  entry with summed size and `parts` > 1; safetensors component files each get
 *  their own entry with `safetensors: true`. */
export type HfRepoFile = {
  name: string
  quant: string
  sizeBytes: number
  parts: number
  mmproj: boolean
  /** True for safetensors component files (MLX and vLLM repos). */
  safetensors?: boolean
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
  /** True while the daemon is still computing content hashes to confirm whether
   *  size-matching local files are this repo's quants (spec 10 §3). The UI re-polls
   *  until it clears, then the "Downloaded" badges are final. */
  verifying?: boolean
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
}

export type DownloadsList = {
  downloads: DownloadRecord[]
}
