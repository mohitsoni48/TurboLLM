// Single typed API client. Every server interaction goes through here (spec 00 §4) —
// no inline fetch in components. Errors are normalized to ApiError carrying the
// daemon's error envelope { code, message } (spec 00 §3).

import type {
  BuildPrereqs,
  ChatCompletionResponse,
  ChatMessage,
  DownloadRecord,
  DownloadsList,
  Engine,
  EngineBackends,
  EngineCatalog,
  EngineRecommendationResult,
  EngineLogs,
  EngineUpdates,
  EnginesList,
  EngineScanResult,
  UpdatePolicy,
  HfRepoDetail,
  HfSearchResult,
  HfSortOption,
  HfTokenTest,
  LoadProfile,
  ModelDetail,
  ModelDirs,
  ModelsList,
  Status,
  AppUpdate,
  TokenUsageStats,
  TokenUsageRange,
} from './types'

const AUTH_KEY = 'tllm.authToken'

/** Error thrown by the API client; preserves the daemon's machine-checkable code. */
export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/** Auth header for every client request — shared with chat-api.ts so chat works over
 *  LAN too (the daemon requires a key for non-loopback requests, spec 06 §5). */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(AUTH_KEY)
  return token ? { 'X-TurboLLM-Auth': token } : {}
}

/** Persist (or clear) the API key this client sends as X-TurboLLM-Auth. Needed for
 *  LAN access, where the daemon requires a key for non-loopback requests (spec 06 §5). */
export function setAuthToken(token: string): void {
  const t = token.trim()
  if (t) localStorage.setItem(AUTH_KEY, t)
  else localStorage.removeItem(AUTH_KEY)
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(),
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  let body = init?.body
  if (init && 'json' in init && init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }

  const res = await fetch(path, { ...init, headers, body })

  if (res.status === 204) return undefined as T

  const text = await res.text()
  const data = text ? safeJson(text) : undefined

  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(
      env?.error?.code ?? 'http_error',
      env?.error?.message ?? `Request failed with status ${res.status}.`,
      res.status,
    )
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ── Status ───────────────────────────────────────────────────────────────────
export function getStatus(): Promise<Status> {
  return request<Status>('/api/v1/status')
}

/** Live running-session stats (B4) ride on the status payload — surfaced from the
 *  status poll rather than a separate endpoint. Re-exported for convenience. */
export type { EngineStats } from './types'

// ── Token usage dashboard (Release 3) ────────────────────────────────────────
export function getTokenUsage(range: TokenUsageRange = 'all'): Promise<TokenUsageStats> {
  return request<TokenUsageStats>(`/api/v1/tokens/usage?range=${range}`)
}

// ── Engines registry (spec 02 §2) ────────────────────────────────────────────
export function listEngines(): Promise<EnginesList> {
  return request<EnginesList>('/api/v1/engines')
}

/** Add succeeds with `warning: 'no_version'` (non-blocking) when the binary
 *  probed OK but no version string was found (spec 03 §2 `probe_no_version`). */
export type AddEngineResult = Engine & { warning: 'no_version' | null }

export function addEngine(input: {
  name: string
  binPath: string
  /** Optional GitHub source-repo URL the build came from (ADR-088) — enables the
   *  notify-only "newer source available → rebuild" check. Omitted when empty. */
  sourceRepo?: string
  sourceBranch?: string
}): Promise<AddEngineResult> {
  return request<AddEngineResult>('/api/v1/engines', { method: 'POST', json: input })
}

/** Guided Add-engine scan (engine overhaul, Phase 3): given a chosen FOLDER or a
 *  binary file, locate + probe the server binary. Read-only — registration still
 *  goes through {@link addEngine}. Throws ApiError on a ProbeError (wrong-OS/timeout). */
export function scanEngineFolder(path: string): Promise<EngineScanResult> {
  return request<EngineScanResult>('/api/v1/engines/scan', { method: 'POST', json: { path } })
}

export function getEngineBackends(): Promise<EngineBackends> {
  return request<EngineBackends>('/api/v1/engines/backends')
}

/** First-install a llama.cpp backend build (seeds the pinned LLAMA_BUILD). When the build
 *  is already on disk the daemon returns `{ accepted: false, alreadyInstalled: true, build }`
 *  (no download). Use {@link updateBackend} to honestly check + upgrade to the real latest. */
export function installBackend(
  backend: string,
): Promise<{ accepted: boolean; backend?: string; alreadyInstalled?: boolean; build?: string }> {
  return request('/api/v1/engines/backends/install', { method: 'POST', json: { backend } })
}

export function installMlx(): Promise<{ accepted: true; engine: 'mlx' }> {
  return request('/api/v1/engines/mlx', { method: 'POST', json: {} })
}

export function installRapidMlx(): Promise<{ accepted: true; engine: 'rapid-mlx' }> {
  return request('/api/v1/engines/rapid-mlx', { method: 'POST', json: {} })
}

export function getEngineCatalog(): Promise<EngineCatalog> {
  return request<EngineCatalog>('/api/v1/engines/catalog')
}

/** Hardware-level fit for the WHOLE catalog (engine overhaul, Phase 2). Incompatible
 *  engines come back WITH a reason so the UI greys them ("grey + reason, don't hide"). */
export function getEngineRecommendation(): Promise<EngineRecommendationResult> {
  return request<EngineRecommendationResult>('/api/v1/engines/recommendation')
}

/** Compile-from-source prereq check (ADR-089/100). Read-only: detects the Windows/Linux +
 *  CUDA build toolchain (with the configured toolchain-dir PATH override applied).
 *  `supported:false` on macOS (parked elsewhere). */
export function getBuildPrereqs(): Promise<BuildPrereqs> {
  return request<BuildPrereqs>('/api/v1/build/prereqs')
}

/** Start a 1-click in-app build (ADR-100). 202 immediately; progress streams via
 *  GET /api/v1/status `engineBuild`. Windows/Linux + CUDA only; local-host only. */
export function runBuild(args: { repoUrl: string; branch?: string; name?: string }): Promise<{ accepted: boolean }> {
  return request('/api/v1/build/run', { method: 'POST', json: args })
}

/** Cancel an in-progress 1-click build (ADR-100). */
export function cancelBuild(): Promise<{ ok: boolean }> {
  return request('/api/v1/build/cancel', { method: 'POST', json: {} })
}

/** Auto-download a CUDA Toolkit from NVIDIA (ADR-101) so a build can compile. 202 + progress
 *  via GET /status engineBuild (phase 'provisioning'); on success its bin dir is added to the
 *  build environment. Windows + local-host only. */
export function provisionCuda(): Promise<{ accepted: boolean }> {
  return request('/api/v1/build/cuda', { method: 'POST', json: {} })
}

export function installVllm(): Promise<{ accepted: true; engine: 'vllm' }> {
  return request('/api/v1/engines/vllm', { method: 'POST', json: {} })
}

export function installTurboquant(): Promise<{ accepted: true; engine: 'turboquant' }> {
  return request('/api/v1/engines/turboquant', { method: 'POST', json: {} })
}

export function installKoboldcpp(): Promise<{ accepted: true; engine: 'koboldcpp' }> {
  return request('/api/v1/engines/koboldcpp', { method: 'POST', json: {} })
}

export function installLlamafile(): Promise<{ accepted: true; engine: 'llamafile' }> {
  return request('/api/v1/engines/llamafile', { method: 'POST', json: {} })
}

export function cancelBackendDownload(): Promise<{ ok: boolean }> {
  return request('/api/v1/engines/backends/cancel', { method: 'POST', json: {} })
}

export function deleteEngineBackend(id: string): Promise<{ ok: true }> {
  return request(`/api/v1/engines/backends/${encodeURIComponent(id)}`, { method: 'DELETE', json: {} })
}

/** De-pinned, rollback-safe update for an official llama.cpp backend (ADR-085). Resolves
 *  the REAL latest upstream tag, downloads + probes it, swaps + GCs the old build only on
 *  success. Returns `{ accepted:false, alreadyLatest:true, build }` when a real check
 *  confirms you're current; 503 `offline` when GitHub couldn't be reached. */
export function updateBackend(
  id: string,
): Promise<{ accepted: boolean; backend?: string; build?: string; alreadyLatest?: boolean }> {
  return request(`/api/v1/engines/backends/${encodeURIComponent(id)}/update`, { method: 'POST', json: {} })
}

// ── Honest engine update status + auto-update policy (ADR-085, Phase 6) ────────
/** Per-engine update status (installed/latest/hasUpdate/checkedAt) + current policies.
 *  `?refresh=1` forces a live re-check; otherwise the cache is served (offline-first). */
export function getEngineUpdates(refresh = false): Promise<EngineUpdates> {
  return request<EngineUpdates>(`/api/v1/engines/updates${refresh ? '?refresh=1' : ''}`)
}

/** App self-update check (F-006, ADR-031): is a newer TurboLLM published on npm than the
 *  running version? Offline-first — serves the daemon's 24h cache; `?refresh=1` forces a
 *  live re-check. Informational only; npm performs the upgrade. */
export function getAppUpdate(refresh = false): Promise<AppUpdate> {
  return request<AppUpdate>(`/api/v1/app/update${refresh ? '?refresh=1' : ''}`)
}

/** Set an engine's auto-update policy (off | notify | auto). */
export function setEngineUpdatePolicy(id: string, policy: UpdatePolicy): Promise<unknown> {
  return request(`/api/v1/engines/${encodeURIComponent(id)}/update-policy`, {
    method: 'PUT',
    json: { policy },
  })
}

export function renameEngine(id: string, name: string): Promise<Engine> {
  return request<Engine>(`/api/v1/engines/${encodeURIComponent(id)}`, {
    method: 'PUT',
    json: { name },
  })
}

export function removeEngine(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/engines/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/** Unregister a catalog engine AND delete its installed files from disk.
 *  Models are never touched — only the engine's install dir under engines/. */
export function purgeEngine(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/engines/${encodeURIComponent(id)}?purge=1`, {
    method: 'DELETE',
  })
}

/** Enable an installed llama.cpp backend without re-downloading (register + activate). */
export function enableBackend(id: string): Promise<{ ok: true; engineId: string }> {
  return request<{ ok: true; engineId: string }>(
    `/api/v1/engines/backends/${encodeURIComponent(id)}/enable`,
    { method: 'POST' },
  )
}

/** Update (upgrade) the vLLM engine to the latest release (passes -U to uv pip install). */
export function updateVllm(): Promise<{ accepted: true; engine: 'vllm' }> {
  return request('/api/v1/engines/vllm?update=1', { method: 'POST', json: {} })
}

/** Update (upgrade) the MLX engine to the latest release (passes --upgrade to uv pip install). */
export function updateMlx(): Promise<{ accepted: true; engine: 'mlx' }> {
  return request('/api/v1/engines/mlx?update=1', { method: 'POST', json: {} })
}

/** Update (upgrade) the Rapid-MLX engine to the latest release (passes --upgrade to uv pip install). */
export function updateRapidMlx(): Promise<{ accepted: true; engine: 'rapid-mlx' }> {
  return request('/api/v1/engines/rapid-mlx?update=1', { method: 'POST', json: {} })
}

/** Update (re-download latest release) the TurboQuant engine. */
export function updateTurboquant(): Promise<{ accepted: true; engine: 'turboquant' }> {
  return request('/api/v1/engines/turboquant?update=1', { method: 'POST', json: {} })
}

/** Update (re-download latest release) the KoboldCpp engine. */
export function updateKoboldcpp(): Promise<{ accepted: true; engine: 'koboldcpp' }> {
  return request('/api/v1/engines/koboldcpp?update=1', { method: 'POST', json: {} })
}

/** Update (re-download latest release) the llamafile engine. */
export function updateLlamafile(): Promise<{ accepted: true; engine: 'llamafile' }> {
  return request('/api/v1/engines/llamafile?update=1', { method: 'POST', json: {} })
}

export function activateEngine(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/v1/engines/${encodeURIComponent(id)}/activate`,
    { method: 'POST' },
  )
}

export function reprobeEngine(id: string): Promise<Engine> {
  return request<Engine>(`/api/v1/engines/${encodeURIComponent(id)}/reprobe`, {
    method: 'POST',
  })
}

// ── Engine lifecycle (spec 02 §3) ────────────────────────────────────────────
export function startEngine(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/start', { method: 'POST', json: {} })
}

export function stopEngine(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/stop', { method: 'POST', json: {} })
}

export function restartEngine(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/restart', { method: 'POST', json: {} })
}

// ── Engine logs ───────────────────────────────────────────────────────────────
export function getEngineLogs(tail = 200): Promise<EngineLogs> {
  return request<EngineLogs>(`/api/v1/engine/logs?tail=${tail}`)
}

/** URL for the SSE live log tail (consumed via EventSource). */
export const engineLogStreamUrl = '/api/v1/engine/logs/stream'

// ── Filesystem browser (spec 03 §9) ──────────────────────────────────────────
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}
export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

/** List a directory under the daemon's home dir (loopback + home-confined,
 *  enforced server-side). Omit `path` to start at the home directory. */
export function browseFs(path?: string): Promise<FsListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return request<FsListing>(`/api/v1/fs/browse${q}`)
}

/** Current branch + known local branches for a folder, local-only (Code launchpad's
 *  repo picker). `isRepo` is false for a plain (non-git) scratch folder — not an error. */
export interface GitBranchInfo {
  isRepo: boolean
  branch: string
  branches: string[]
}
export function getGitBranch(path: string): Promise<GitBranchInfo> {
  return request<GitBranchInfo>(`/api/v1/fs/git-branch?path=${encodeURIComponent(path)}`)
}

// ── Models (discovery, spec 04) ──────────────────────────────────────────────
export function getModels(): Promise<ModelsList> {
  return request<ModelsList>('/api/v1/models')
}

export function rescanModels(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/models/rescan', { method: 'POST', json: {} })
}

export function getModelDirs(): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs')
}

export function addModelDir(dir: string): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs', { method: 'POST', json: { dir } })
}

export function removeModelDir(dir: string): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs', { method: 'DELETE', json: { dir } })
}

/** Set the primary download/import folder (spec 01 §3, ADR-035). `dir` must be one
 *  of the configured model folders; returns the updated modeldirs payload. */
export function setPrimaryModelDir(dir: string): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs/primary', { method: 'POST', json: { dir } })
}

/** Delete a model's file(s) from disk (spec 05). Returns the removed paths; 409
 *  `model_loaded` if the model is currently loaded in the running engine. */
export function deleteModel(key: string): Promise<{ ok: true; deleted: string[] }> {
  return request<{ ok: true; deleted: string[] }>(`/api/v1/models/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

// ── Load profiles + load flow (A4, spec 05) ──────────────────────────────────
// Profiles are per-engine (issue #35): pass the installed engine's id so reads/writes
// hit that engine's slot. Omitting engineId on read lets the server fall back to the
// active engine, then the '*' migrated/global profile.
export function getModelDetail(key: string, engineId?: string): Promise<ModelDetail> {
  const q = engineId ? `?engine=${encodeURIComponent(engineId)}` : ''
  return request<ModelDetail>(`/api/v1/models/${encodeURIComponent(key)}${q}`)
}

export function saveModelProfile(key: string, profile: LoadProfile, engineId: string): Promise<LoadProfile> {
  return request<LoadProfile>(`/api/v1/models/${encodeURIComponent(key)}/profile?engine=${encodeURIComponent(engineId)}`, {
    method: 'PUT',
    json: profile,
  })
}

export function resetModelProfile(key: string, engineId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/models/${encodeURIComponent(key)}/profile/reset?engine=${encodeURIComponent(engineId)}`, {
    method: 'POST',
    json: {},
  })
}

/** Load a model by key, optionally with one-off profile overrides (spec 05 §7). */
export function loadModel(modelKey: string, profileOverrides?: Partial<LoadProfile>): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/start', {
    method: 'POST',
    json: { modelKey, profileOverrides },
  })
}

// ── Auto-benchmark + auto-tune (spec 09 §1) ──────────────────────────────────
/** Start an auto-tune sweep for a model. 202; progress polls /status `bench`. Throws
 *  ApiError 409 when a run or the engine is busy (caller stops the engine first). */
export function startBench(modelKey: string, base?: Partial<LoadProfile>): Promise<{ accepted: true }> {
  return request<{ accepted: true }>('/api/v1/bench', { method: 'POST', json: { modelKey, base } })
}

/** Cancel the active sweep: stops after the current step, leaves the engine stopped,
 *  keeps partial results (spec 09 AC#3). No-op when nothing is running. */
export function cancelBench(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/bench/cancel', { method: 'POST', json: {} })
}

/** Persist the finished auto-tune's winning profile (the user clicked Save). 409 if nothing to save. */
export function saveBench(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/bench/save', { method: 'POST', json: {} })
}

// ── Settings (daemon config UI subset) ───────────────────────────────────────
/** Global model defaults (spec 05 §3): base load values applied to never-seen
 *  models that have no saved per-model profile. */
export type ModelDefaults = {
  ctx: number
  ngl: number
  imageMaxTokens?: number
  /** Hard cap on tokens generated per response (0 = unlimited). Applies to in-app
   *  chat and clamps external (Claude Code) requests too. */
  maxTokens?: number
}

/** Telemetry consent level (spec 09 §3): off | anonymous benchmarks | + crash. */
export type TelemetryLevel = 'off' | 'anon' | 'full'

/** ComfyUI GPU coordination (push). When enabled and the gate node is installed in
 *  ComfyUI, TurboLLM unloads the model + blocks loads while ComfyUI renders, then
 *  reloads it when the queue drains. `gatePath` is where the node was installed. */
export type ComfyUiSettings = {
  enabled: boolean
  gatePath: string
  /** ComfyUI's HTTP origin (e.g. http://127.0.0.1:8188). Used by the REVERSE gate to
   *  call ComfyUI's native `POST /free` before TurboLLM loads a model (F-011). */
  url: string
  /** Reverse gate (F-011): when TurboLLM is about to load a model, first ask ComfyUI to
   *  free its VRAM. The symmetric counterpart of the forward pause-for-ComfyUI gate. */
  reverseGate: boolean
  /** KV prompt-cache persistence (F-014): save the model's prompt cache to disk before a
   *  ComfyUI-forced unload and restore it on reload, so a long prefix isn't re-prefilled.
   *  Opt-in; llama.cpp text-only. */
  cachePersist: boolean
}

/** Install the ComfyUI gate node into the given ComfyUI folder (or its custom_nodes
 *  dir). One-time setup; returns where it was written. */
export function installComfyGate(path: string): Promise<{ ok: boolean; path: string; base: string; note?: string }> {
  return request('/api/v1/comfyui/install', { method: 'POST', json: { path } })
}

/** Remove the installed gate node and forget its path. */
export function uninstallComfyGate(): Promise<{ ok: boolean }> {
  return request('/api/v1/comfyui/uninstall', { method: 'POST', json: {} })
}

export type McpServer = {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  /** sse only — Bearer token for Authorization header (ADR-124) */
  apiKey?: string
  enabled: boolean
}

export type DaemonSettings = {
  idleTtlMinutes: number
  /** Listen port (spec 08 §2). Takes effect on the next daemon restart. */
  port: number
  theme: string
  autoGenerateTitles: boolean
  /** Release 3: background extraction of durable facts from the user's own chat messages,
   *  injected into future new conversations. Off by default (opt-in trust surface). */
  autoMemoryEnabled: boolean
  openBrowserOnStart: boolean
  autoLoadOnStart: boolean
  /** VRAM to keep free during auto-tune's offload search, MB (300–2048, default 1024). A
   *  later desktop / ComfyUI VRAM grab can't tip a config tuned with less headroom into a
   *  sysmem spill. */
  vramHeadroomMb: number
  /** Expose the API on the local network (spec 08 §2). Changing this requires a
   *  daemon restart to take effect (POST /api/v1/daemon/restart). */
  lanBind: boolean
  /** Require an API key for non-loopback requests when LAN-exposed (spec 06 §5).
   *  Off = open/unauthenticated LAN access. */
  requireApiKey: boolean
  telemetryLevel: TelemetryLevel
  modelDefaults: ModelDefaults
  /** ComfyUI GPU coordination settings. */
  comfyui: ComfyUiSettings
  /** Whether an HF token is stored (spec 10 §4). The token itself is never echoed
   *  back — write it via {@link saveSettings}'s `hfToken` patch field only. */
  hfTokenSet: boolean
  /** Gateway intelligence settings (ADR-06x): model auto-swap + keep-N pool. */
  gateway: { autoSwap: boolean; keepN: number }
  /** Whether a Tavily API key is configured (legacy mirror of `search.tavilyKeySet`). */
  tavilyKeySet: boolean
  /** Web-search provider config (F-020). Keys are write-only — only "is it set" booleans
   *  come back; `searxngUrl` is not a secret so it is echoed. */
  search: {
    provider: SearchProvider
    tavilyKeySet: boolean
    kagiKeySet: boolean
    searxngUrl: string
  }
  /** MCP server list. */
  mcp: { servers: McpServer[] }
  /** Build environment (ADR-100): folders prepended to PATH for compile-from-source so a
   *  conda-env / custom-path CUDA Toolkit + compiler are found. Not secret — echoed back. */
  build: { toolchainDirs: string[] }
  /** Tool-call approval gate (F-025): per-tool default policy. Missing tools default
   *  to 'ask'. Keyed by tool name (e.g. 'run_code', 'mcp__server__tool'). */
  toolPolicies: Record<string, ToolPolicy>
  /** Cloud Launch deploy-link settings (ADR-153). The RunPod Template ID the user
   *  published themselves — not a secret, just an id, echoed back as-is. */
  cloudDeploy: { runpodTemplateId: string }
}

/** Tool-call approval gate policy (mirrors turbollm/src/tools/tool-policy.ts). */
export type ToolPolicy = 'ask' | 'allow' | 'deny'

export type SearchProvider = 'tavily' | 'kagi' | 'searxng'

/** Settings patch: the persisted {@link DaemonSettings} fields plus a write-only
 *  `hfToken` (spec 10 §4) that sets/clears the stored Hugging Face token. `comfyui`
 *  is patchable per-field (only `enabled` is set here; `gatePath` is owned by the
 *  install endpoints). */
export type DaemonSettingsPatch = Partial<Omit<DaemonSettings, 'comfyui' | 'tavilyKeySet' | 'search' | 'mcp'>> & {
  comfyui?: Partial<ComfyUiSettings>
  hfToken?: string
  /** Write-only: set or clear the Tavily API key (legacy alias for `search.tavilyApiKey`). */
  tavilyApiKey?: string
  /** Write-only search-provider patch (F-020). Key/URL fields set or clear ('') the stored value. */
  search?: {
    provider?: SearchProvider
    tavilyApiKey?: string
    kagiApiKey?: string
    searxngUrl?: string
  }
}

export function getSettings(): Promise<DaemonSettings> {
  return request<DaemonSettings>('/api/v1/settings')
}

/** A LAN/port change re-points the listener in place (no full restart). Present on a
 *  save that changed `lanBind`/`port`; `portChanged` means the client must hop to the
 *  new port (a LAN-only change is seamless on 127.0.0.1). */
export type RebindInfo = { portChanged: boolean; port: number; lanBind: boolean }

export function saveSettings(patch: DaemonSettingsPatch): Promise<DaemonSettings & { rebind?: RebindInfo }> {
  return request<DaemonSettings & { rebind?: RebindInfo }>('/api/v1/settings', { method: 'PATCH', json: patch })
}

export function addMcpServer(server: Omit<McpServer, 'id'>): Promise<McpServer> {
  return request<McpServer>('/api/v1/mcp/servers', { method: 'POST', json: server })
}

export function updateMcpServer(id: string, patch: Partial<Omit<McpServer, 'id'>>): Promise<McpServer> {
  return request<McpServer>(`/api/v1/mcp/servers/${id}`, { method: 'PUT', json: patch })
}

export function deleteMcpServer(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/mcp/servers/${id}`, { method: 'DELETE' })
}

// ── Custom chat Agents (Customize → Agents) ───────────────────────────────────

/** A user-created chat Agent: a named system prompt with a skill + tool allow-list,
 *  selected when starting a new conversation (alongside the built-in personas). */
export type CustomAgent = {
  id: string
  name: string
  description: string
  systemPrompt: string
  skillIds: string[]
  tools: string[]
}

export function fetchChatAgents(): Promise<CustomAgent[]> {
  return request<CustomAgent[]>('/api/v1/chat-agents')
}

export function addChatAgent(agent: Omit<CustomAgent, 'id'>): Promise<CustomAgent> {
  return request<CustomAgent>('/api/v1/chat-agents', { method: 'POST', json: agent })
}

export function updateChatAgent(id: string, patch: Partial<Omit<CustomAgent, 'id'>>): Promise<CustomAgent> {
  return request<CustomAgent>(`/api/v1/chat-agents/${id}`, { method: 'PUT', json: patch })
}

export function deleteChatAgent(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/chat-agents/${id}`, { method: 'DELETE' })
}

/** A saved customization of a built-in agent — only the changed fields are present.
 *  Delete (reset) reverts to the frontend's hardcoded default for that id. */
export type BuiltinAgentOverride = Partial<Pick<CustomAgent, 'name' | 'description' | 'systemPrompt' | 'skillIds' | 'tools'>>

export function fetchBuiltinAgentOverrides(): Promise<Record<string, BuiltinAgentOverride>> {
  return request<Record<string, BuiltinAgentOverride>>('/api/v1/chat-agents/builtin-overrides')
}

export function saveBuiltinAgentOverride(id: string, override: BuiltinAgentOverride): Promise<BuiltinAgentOverride> {
  return request<BuiltinAgentOverride>(`/api/v1/chat-agents/builtin-overrides/${id}`, { method: 'PUT', json: override })
}

export function resetBuiltinAgentOverride(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/chat-agents/builtin-overrides/${id}`, { method: 'DELETE' })
}

/** Re-exec the daemon so port / LAN-bind changes take effect (spec 08 §2). Returns
 *  202 immediately, then the daemon tears down and restarts; the socket briefly
 *  drops, so callers should poll /status until it responds again. */
export function restartDaemon(): Promise<{ ok: true; restarting: true }> {
  return request<{ ok: true; restarting: true }>('/api/v1/daemon/restart', { method: 'POST', json: {} })
}

/** Representative example of exactly what a given telemetry level would send
 *  (spec 09 §4). Illustrative only — nothing is transmitted. `payload` is null for
 *  'off', else an array of example events. */
export type TelemetryPreview = {
  level: TelemetryLevel
  sends: boolean
  note: string
  payload: unknown
}

export function getTelemetryPreview(level: TelemetryLevel): Promise<TelemetryPreview> {
  return request<TelemetryPreview>(`/api/v1/telemetry/preview?level=${encodeURIComponent(level)}`)
}

/** LAN network info (spec 08 §2): expose state, the reachable LAN URL, and whether
 *  an API key exists (required for non-local access). */
export type NetworkInfo = {
  lanBind: boolean
  lanUrl: string
  hasApiKey: boolean
}

export function getNetworkInfo(): Promise<NetworkInfo> {
  return request<NetworkInfo>('/api/v1/settings/network')
}

// ── API keys (spec 06 §5) ────────────────────────────────────────────────────
export interface ApiKeyMeta {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}
export interface ApiKeyCreated { key: string; meta: ApiKeyMeta }
export interface ApiKeysList { keys: ApiKeyMeta[] }
export interface ConnectStep { label: string; snippet: string; lang: string }
export interface ConnectInfo { cli: string; title: string; steps: ConnectStep[] }

export function getApiKeys(): Promise<ApiKeysList> {
  return request<ApiKeysList>('/api/v1/keys')
}
export function createApiKey(name: string): Promise<ApiKeyCreated> {
  return request<ApiKeyCreated>('/api/v1/keys', { method: 'POST', json: { name } })
}
export function deleteApiKey(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export function getConnect(cli: string): Promise<ConnectInfo> {
  return request<ConnectInfo>(`/api/v1/connect/${encodeURIComponent(cli)}`)
}

// ── System info (spec 05 §6) ─────────────────────────────────────────────────
export interface SysInfo {
  os: string
  cpu: string
  cores: number
  ramMB: number
  gpus: Array<{ name: string; vramMb: number; vendor: string }>
}

export function getSysInfo(): Promise<SysInfo> {
  return request<SysInfo>('/api/v1/sysinfo')
}

// ── Hugging Face discovery (spec 10 §2–4, §7 rewrite) ────────────────────────
/** Search (q set) or browse (q blank) HF repos, sorted by `sort`. Each row carries
 *  `localCount` (variants already in library). The library/format filter adapts to the
 *  active engine server-side — never hardcoded to GGUF. */
export function hfSearch(q: string, sort: HfSortOption = 'best-match'): Promise<HfSearchResult> {
  return request<HfSearchResult>(`/api/v1/hf/search?q=${encodeURIComponent(q)}&sort=${sort}`)
}

/** Repo detail (files + sizes + gated). `repo` is "owner/name" — the slash is part
 *  of the path so we do NOT encode it. */
export function hfRepo(repo: string): Promise<HfRepoDetail> {
  return request<HfRepoDetail>(`/api/v1/hf/models/${repo}`)
}

/** Validate an HF token against whoami-v2 (spec 10 §4). */
export function hfTokenTest(token: string): Promise<HfTokenTest> {
  return request<HfTokenTest>('/api/v1/hf/token/test', { method: 'POST', json: { token } })
}

// ── Downloads (spec 10 §5–6, §8) ──────────────────────────────────────────────
export function listDownloads(): Promise<DownloadsList> {
  return request<DownloadsList>('/api/v1/downloads')
}

/** Enqueue a download: an HF repo file {repo, rfilename} OR a raw {url}. A single HF
 *  request can fan out into several files (split shards + a shared mmproj projector), so
 *  the response carries every record created. */
export function enqueueDownload(input: {
  repo?: string
  rfilename?: string
  url?: string
  size?: number
  sha256?: string
  subdir?: string
}): Promise<{ downloads: DownloadRecord[] }> {
  return request<{ downloads: DownloadRecord[] }>('/api/v1/downloads', { method: 'POST', json: input })
}

export function cancelDownload(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/downloads/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    json: {},
  })
}

export function removeDownload(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Chat (non-streaming gateway passthrough) ─────────────────────────────────
export function chatCompletion(input: {
  model: string
  messages: ChatMessage[]
}): Promise<ChatCompletionResponse> {
  return request<ChatCompletionResponse>('/v1/chat/completions', {
    method: 'POST',
    json: { model: input.model, messages: input.messages, stream: false },
  })
}

// ── F-023: chat share ─────────────────────────────────────────────────────────

/** Get the LAN share URL for a conversation.
 *  Returns { url, onlyLocal } — onlyLocal=true when no LAN interface was found. */
export function getShareUrl(convId: string): Promise<{ url: string; onlyLocal: boolean }> {
  return request<{ url: string; onlyLocal: boolean }>(`/api/v1/conversations/${encodeURIComponent(convId)}/share-url`)
}

/** Fetch the debug snapshot JSON string for a conversation (format=debug). */
export async function getDebugSnapshot(convId: string): Promise<string> {
  const res = await fetch(`/api/v1/conversations/${encodeURIComponent(convId)}/export?format=debug`, {
    headers: { Accept: 'application/json', ...authHeaders() },
  })
  if (!res.ok) throw new ApiError('export_failed', `Export failed with status ${res.status}.`, res.status)
  return res.text()
}

// ── F-024: export / import chat ───────────────────────────────────────────────

/** Trigger a browser download of the chat as a .turbollm-chat.json file. */
export function downloadChatExport(convId: string): void {
  // Build a hidden anchor with auth header isn't possible; use a form or direct href.
  // Since the auth token may be needed, fetch the blob and trigger download via object URL.
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() }
  fetch(`/api/v1/conversations/${encodeURIComponent(convId)}/export?format=export`, { headers })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Export failed with status ${res.status}`)
      const cd = res.headers.get('Content-Disposition') ?? ''
      const nameMatch = cd.match(/filename="([^"]+)"/)
      const filename = nameMatch ? nameMatch[1] : 'chat.turbollm-chat.json'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    })
    .catch(() => { /* silently ignore — caller shows error via toast */ })
}

/** Import a chat from a parsed JSON object. Returns the new conversation id. */
export function importChat(payload: unknown): Promise<{ id: string }> {
  return request<{ id: string }>('/api/v1/conversations/import', {
    method: 'POST',
    json: payload,
  })
}
