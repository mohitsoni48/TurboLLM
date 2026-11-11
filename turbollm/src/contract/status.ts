// The GET /api/v1/status contract: types only, shared by the daemon (which `satisfies` them where it builds the
// payload) and the web app (which imports them with `import type` through the `@contract/*` alias).
// A field is optional here when an older daemon or a Turbo Link peer may omit it; the daemon still has to send
// every field this file declares (a field it sends that is not declared here fails to compile on its side).
// Declare nothing here that needs a runtime import: contract.test.ts rejects it.

/** Mirrors the daemon's `FAIL_REASONS` (src/telemetry/core/enums.ts), which is what
 *  `classifyLoadFailure` returns. `screens/onboarding/recovery.ts` checks its runtime
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
  /** Name of the engine the failed load ran on, and of the model it tried ('' when no load is recorded). Absent from an
   *  older daemon: the banner then reads "Model load failed". */
  engineName?: string
  modelName?: string
  /** Key of the model the failed load tried ('' when no load is recorded); what the banner's Retry loads. Absent from
   *  an older daemon: the banner then falls back to `lastLoaded`. */
  modelKey?: string
  /** False when that engine is not expected to load that model (the Models screen's compatibleWithActiveEngine for
   *  it): a model "Show models for every engine" lists loads only on the selected engine, so the recovery offers no
   *  engine advice and no re-download for it. Absent from an older daemon (read as true). */
  expectedToLoad?: boolean
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
  /** Id of the engine the loaded model actually runs on ('' when none). Not always `id` (the active engine): an engine
   *  install or Enable activates another engine without stopping the model. Absent from older daemons. */
  servingId?: string
  /** Kind of the engine in `servingId` ('' when none). Absent from older daemons. */
  servingKind?: string
  /** Name of the engine in `servingId` ('' when none). Absent from older daemons. */
  servingName?: string
  /** The exact command last spawned, formatted for copy-paste into a terminal.
   *  Present only while this engine is the one actually running/starting. */
  launchCommand?: string
  /** How many generations the engine can serve at once (llama.cpp `--parallel N`). Omitted, not defaulted to 1, when the
   *  engine advertises no slot count: "unknown" and "exactly one" are different answers. */
  parallelSlots?: number
}

/** Loaded model from GET /api/v1/status (null when none). */
export type LoadedModel = {
  key: string
  name: string
  quant: string
  ctx: number
  vision: boolean
  /** The model takes audio as input: a recording can be sent to it as it is, not only as its transcript. Absent from
   *  daemons that predate voice input. */
  audio?: boolean
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
  /** False when POST /engines/backends/cancel can't stop this run (first-run seed, auto-update,
   *  uv/pip runtime installs). Absent from daemons that predate it. */
  cancellable?: boolean
  /** When this run began (epoch ms), kept on its failure; 0 when idle. Identifies the run, so a dismissed failure
   *  is told from a retry's. Absent from daemons that predate it. */
  startedAt?: number
}

/** In-app compile-from-source status (ADR-100), from GET /api/v1/status. A build streams
 *  a phase + a log tail (clone/cmake output) rather than a byte percentage. */
export type EngineBuild = {
  active: boolean
  phase: 'provisioning' | 'preparing' | 'cloning' | 'configuring' | 'compiling' | 'registering' | 'done' | 'error'
  engine: string
  log: string[]
  error: string | null
  /** The run installs a build tool (the CUDA Toolkit download, a build guide prerequisite) and builds no engine.
   *  Absent from daemons that predate it: see isToolInstall. */
  toolInstall?: boolean
  /** The finished build ('done') is the selected engine: false after a rebuild of an engine the user had not selected,
   *  which leaves the selection as it was. Absent from daemons that predate it, which made every build they registered
   *  the selected engine. */
  activated?: boolean
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

export type Status = {
  version: string
  engine: EngineRuntime
  model: LoadedModel | null
  /** The last model (and engine) the user loaded, config-tracked by the daemon and sent on
   *  every status poll. Survives a FAILED load — `model` above is null then — which is
   *  what makes a one-click retry of the thing that just broke possible at all. */
  lastLoaded?: LastLoaded
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
  /** The loaded Jev model, or null when none is (ADR-434 (i)(1)). Absent from an older
   *  daemon and over Turbo Link, which is read as "unknown", not as "none". */
  jev?: JevStatus | null
  /** The loaded Laya model, or null (ADR-443). It keeps the System One playground open but, unlike a Jev
   *  model, never takes the Workspace over. Absent from an older daemon and over Turbo Link. */
  laya?: LayaStatus | null
  /** The alive text classification model, whichever runtime serves it, or null (ADR-444). The Jev one wins when
   *  both are alive. Absent from an older daemon and over Turbo Link: read `jev`, `laya` and the catalog then. */
  textClassification?: TextClassificationStatus | null
  /** How many models are loaded beside the primary (alive pool slots, an embedding or Laya load included). Local only;
   *  absent from an older daemon and over Turbo Link. */
  poolModels?: number
  /** Which server features are on (LAN listener, remote access, Turbo Link peers). Local only; absent from an older
   *  daemon and over Turbo Link. */
  serving?: ServingStatus
  /** Cloud Launch tunnel (ADR-045/152): null until a tunnel is active or no remote-access manager exists. */
  tunnel?: TunnelStatus | null
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

/** The three NLI classes. Twin of src/models/jev.ts; a model declares them itself
 *  (config.json `id2label`), so probabilities are always read through the model's
 *  own label order rather than a hardcoded one. */
export type JevLabel = 'contradiction' | 'entailment' | 'neutral'

/** The alive Jev model on GET /api/v1/status — local only, never part of the Turbo
 *  Link façade's status. Null when none is loaded, which is what puts Workspace back
 *  to Chat/Code/Routines (ADR-434 (i)(1)). */
export type JevStatus = {
  key: string
  name: string
  labels: JevLabel[]
  state: 'starting' | 'running' | 'stopping'
  slot: 'primary' | 'pool'
}

/** The alive Laya model, from /api/v1/status (ADR-443). Always in its own pool slot. */
export type LayaStatus = {
  key: string
  name: string
  checkpoints: string[]
  state: 'starting' | 'running' | 'stopping'
}

/** The engine a text classification model runs on (ADR-444): vLLM for a Jev model, the Laya engine for a Laya
 *  one. Twin of `TextClassifierRuntime` in src/models/text-classifier.ts. */
export type TextClassificationRuntime = 'vllm' | 'laya'

/** Jev and Laya as one feature on /api/v1/status (ADR-444); twin of src/api/text-classification-status.ts.
 *  `runtime: 'vllm'` is a Jev model, which takes the Workspace over; `'laya'` never does. `labels` comes with a
 *  Jev model, `checkpoints` with a Laya one. */
export type TextClassificationStatus = {
  key: string
  name: string
  runtime: TextClassificationRuntime
  state: 'starting' | 'running' | 'stopping'
  slot: 'primary' | 'pool'
  labels?: JevLabel[]
  checkpoints?: string[]
}

/** The model and engine the user last loaded (config.lastLoaded); both are '' before any load. */
export type LastLoaded = {
  modelKey: string
  engineId: string
}

/** What GET /api/v1/status reports of the server's reach (serving-status.ts). */
export type ServingStatus = {
  /** The main listener is bound beyond loopback (the address really bound, not the setting). */
  lan: boolean
  /** Remote access is up, or on its way up or back (a tunnel or Tailscale Serve/Funnel). */
  remote: boolean
  /** How many Turbo Link peers this daemon hosts, while Turbo Link is switched on. */
  linkPeers: number
}

/** Back-compat wire shape of `/status`'s `tunnel` field (spec 30 §5); external recipes read it as is. */
export type TunnelStatus = {
  active: boolean
  url: string | null
  error: string | null
}
