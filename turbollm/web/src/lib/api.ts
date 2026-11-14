// Single typed API client. Every server interaction goes through here (spec 00 §4) —
// no inline fetch in components. Errors are normalized to ApiError carrying the
// daemon's error envelope { code, message } (spec 00 §3).

import type { DaemonSettings, DaemonSettingsPatch, McpServer, SettingsPatchResponse, TelemetryLevel } from '@contract/settings'
import type {
  BuildPrereqs,
  ChatCompletionResponse,
  ChatMessage,
  DownloadRecord,
  DownloadsList,
  HeldDownload,
  Engine,
  EngineBackends,
  EngineCatalog,
  EngineRecommendationResult,
  EngineLogs,
  RequestLogEntry,
  RequestLogList,
  EngineUpdates,
  EnginesList,
  EngineScanResult,
  RankedReleaseAsset,
  ReleaseAssetListing,
  ReleaseInstallPlan,
  ReleaseJobView,
  HwUsage,
  UpdatePolicy,
  HfRepoDetail,
  HfSearchCategory,
  HfSearchRows,
  HfSortOption,
  HfTokenTest,
  UserSetProfile,
  ModelDetail,
  ModelDirs,
  ModelPreset,
  ModelsList,
  Status,
  AppUpdate,
  AppUpdateProgress,
  TokenUsageStats,
  TokenUsageRange,
} from './types'
import { markHostKeyNeeded } from './auth-signal'

const AUTH_KEY = 'tllm.authToken'

/** Error thrown by the API client; preserves the daemon's machine-checkable code. */
export class ApiError extends Error {
  code: string
  status: number
  /** The capability a 403 named, when it named one (Turbo Link's peer-side admin proxy
   *  relays the host's `error.capability` — see link-admin-routes.ts). Optional and unset
   *  everywhere else; `describeRemoteFailure` is the only reader. Kept here rather than in
   *  a subclass so the many `instanceof ApiError` checks across the app keep working. */
  capability?: string
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

/** The raw stored key, for the one surface that can't send a header — a browser
 *  WebSocket handshake (terminal-connection.ts) — and so must put it in the URL instead. */
export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_KEY)
}

const authTokenListeners = new Set<() => void>()

/** Persist (or clear) the API key this client sends as X-TurboLLM-Auth. Needed for
 *  LAN access, where the daemon requires a key for non-loopback requests (spec 06 §5). */
export function setAuthToken(token: string): void {
  const t = token.trim()
  if (t) localStorage.setItem(AUTH_KEY, t)
  else localStorage.removeItem(AUTH_KEY)
  authTokenListeners.forEach((l) => l())
}

/** Runs `listener` after each setAuthToken, which is how the key prompt stores a key, and when
 *  another tab of this origin sets or clears the stored key. A live tail refused 401/403 for want
 *  of a key waits on it to reopen with the new one (sse.ts subscribeSse): nothing else would tell
 *  it the prompt was answered. The key is in localStorage, which every tab of the origin shares,
 *  but setAuthToken in another tab runs only that tab's listeners: a tail here woke only on a key
 *  stored in its own tab, so one pasted into the other tab's prompt left it dead while the rest
 *  of this page, which reads the key afresh per request, went on with it. The browser tells the
 *  other tabs with a 'storage' event (key null for a clear()). Returns the unsubscribe. */
export function subscribeAuthToken(listener: () => void): () => void {
  authTokenListeners.add(listener)
  const onStorage = (e: StorageEvent) => { if (e.key === AUTH_KEY || e.key === null) listener() }
  window.addEventListener('storage', onStorage)
  return () => {
    authTokenListeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown; rescue?: (status: number, data: unknown) => T | undefined },
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
    const rescued = init?.rescue?.(res.status, data)
    if (rescued !== undefined) return rescued
    const env = data as { error?: { code?: string; message?: string } } | undefined
    // A host-only setting refused for want of a valid key: ask for one (auth-signal.ts).
    if (res.status === 403 && env?.error?.code === 'api_key_required') markHostKeyNeeded()
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

// ── Telemetry (spec 23 §3.8) ─────────────────────────────────────────────────
/** Fire-and-forget UI click tracking. Never awaited by callers and never lets a tracking
 *  failure surface — a click must always do its real job even if the daemon is unreachable
 *  or telemetry is off (the daemon-side gate, Emitter.canSend, is the actual consent check;
 *  this just gets the click there). `screen`/`action` are validated server-side against the
 *  closed enums (`events/ui.ts`) — an unrecognized value is silently dropped, not thrown. */
export function track(screen: string, action: string): void {
  void request('/api/v1/telemetry/ui', { method: 'POST', json: { screen, action } }).catch(() => {})
}

/** Report the outcome of an onboarding recovery attempt (`onboarding_recovery`,
 *  spec 25 §8.2). Same fire-and-forget contract as `track` above.
 *
 *  Call this when the remedy SETTLES, not when the button is clicked — the whole
 *  value of the event is `outcome`, and a click alone cannot know it. `failure`
 *  and `action` are validated server-side against the closed enums
 *  (`events/onboarding.ts`); anything unrecognized is silently dropped. */
export function trackRecovery(failure: string, action: string, outcome: 'ok' | 'fail'): void {
  void request('/api/v1/telemetry/recovery', { method: 'POST', json: { failure, action, outcome } }).catch(() => {})
}

/** Same as {@link trackRecovery}, for the case where the browser holds the daemon's own
 *  raw error STRING rather than an already-classified reason (a failed download's
 *  `error` field). The text is sent back to the daemon purely so it can classify it into
 *  a closed-enum member there — it never becomes part of a telemetry event, which is what
 *  keeps the "no free-form strings ever leave the machine" guarantee intact for an event
 *  that is necessarily triggered from the UI. */
export function trackRecoveryText(failureText: string, action: string, outcome: 'ok' | 'fail'): void {
  void request('/api/v1/telemetry/recovery', { method: 'POST', json: { failureText, action, outcome } }).catch(() => {})
}

// ── Status ───────────────────────────────────────────────────────────────────
export function getStatus(): Promise<Status> {
  return request<Status>('/api/v1/status')
}

// ── Hardware monitor (ADR-383) ─────────────────────────────────────────────
/** The freshest live CPU/RAM/GPU usage sample. A GET that also (re)arms the daemon's
 *  self-stopping sampler: every caller is a subscriber, and 6 s after the last one leaves
 *  the sampling loop stops itself — so a mounted-but-unwanted poll is the whole cost model. */
export function getHwStats(): Promise<HwUsage> {
  return request<HwUsage>('/api/v1/hwstats')
}

// ── Coding-agent availability ────────────────────────────────────────────────
/** Whether each terminal-agent CLI is actually installed on this machine, and the command that
 *  installs it. Label/description deliberately are NOT here — those live in code-types.ts's
 *  CODE_AGENTS so that copy has exactly one owner. */
export type AgentAvailability = {
  id: string
  installed: boolean
  installCommand: string
  /** An install of it is running in the daemon, whichever page started it: the install goes on
   *  when that page closes or reloads, and a second Install joins it rather than starting another. */
  installing: boolean
}

export function getAgentAvailability(): Promise<{ agents: AgentAvailability[] }> {
  return request<{ agents: AgentAvailability[] }>('/api/v1/code/agents')
}

/** Run a harness's own registered install command. The caller picks only WHICH agent — never the
 *  command — so no arbitrary command can be reached from the client. */
export function installCodeAgent(id: string): Promise<{ ok: true }> {
  // `json: {}` is load-bearing, not decoration: it sets Content-Type, which the daemon now REQUIRES
  // on this route so the request is CORS-non-simple and gets preflighted. Without it a bare POST
  // from any website would reach the handler (see the route's own comment).
  return request<{ ok: true }>(`/api/v1/code/agents/${encodeURIComponent(id)}/install`, { method: 'POST', json: {} })
}

// ── Python sandbox runtime (GitHub #52) ──────────────────────────────────────
/** The sandbox's downloaded runtime: Deno plus Pyodide, fetched once when the user turns the sandbox on. */
export interface SandboxRuntimeState {
  /** The experimental flag, as the daemon reads it (always false on Android). */
  enabled: boolean
  /** False where no Deno build exists for this machine. */
  supported: boolean
  installed: { deno: string; pyodide: string } | null
  downloadBytes: number
  diskBytes: number
  job: { state: 'idle' | 'running' | 'error'; doneBytes: number; error?: { code: string; message: string } }
}

export function getSandboxRuntime(): Promise<SandboxRuntimeState> {
  return request<SandboxRuntimeState>('/api/v1/sandbox/runtime')
}

export function installSandboxRuntime(): Promise<SandboxRuntimeState> {
  return request<SandboxRuntimeState>('/api/v1/sandbox/runtime/install', { method: 'POST', json: {} })
}

export function cancelSandboxRuntime(): Promise<SandboxRuntimeState> {
  return request<SandboxRuntimeState>('/api/v1/sandbox/runtime/install', { method: 'DELETE' })
}

export function removeSandboxRuntime(): Promise<SandboxRuntimeState> {
  return request<SandboxRuntimeState>('/api/v1/sandbox/runtime', { method: 'DELETE' })
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

export interface AddEngineInput {
  name: string
  binPath: string
  /** Optional GitHub source-repo URL the build came from (ADR-088) — enables the
   *  notify-only "newer source available → rebuild" check. Omitted when empty. */
  sourceRepo?: string
  sourceBranch?: string
  /** Set only when re-registering a build pinned to an exact historical commit. */
  sourceCommit?: string
  /** Set only when re-registering a build that had a patch applied. A pinned catalog card matches
   *  its engine on repo + commit + patch, so an engine registered without it belongs to no card. */
  sourcePatchUrl?: string
}

export function addEngine(input: AddEngineInput): Promise<AddEngineResult> {
  return request<AddEngineResult>('/api/v1/engines', { method: 'POST', json: input })
}

/** Forget a DISABLED custom engine's remembered identity (backend CustomEngineSource) — no
 *  live registered engine to purge, so this is distinct from {@link purgeEngine}. Never
 *  touches files on disk; `key` is the same identity string the entry carries as `customSourceKey`. */
export function forgetCustomEngineSource(key: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/engines/custom-sources/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

/** Guided Add-engine scan (engine overhaul, Phase 3): given a chosen FOLDER or a
 *  binary file, locate + probe the server binary. Read-only — registration still
 *  goes through {@link addEngine}. Throws ApiError on a ProbeError (wrong-OS/timeout). */
export function scanEngineFolder(path: string): Promise<EngineScanResult> {
  return request<EngineScanResult>('/api/v1/engines/scan', { method: 'POST', json: { path } })
}

/** Upload a custom build .zip: the daemon searches it at any depth for the server binary
 *  and this platform's shared libraries, extracts them under its own engines storage, and
 *  probes the result. Same response contract as {@link scanEngineFolder} — registration
 *  still goes through {@link addEngine}, and Delete purges the extracted files. When the
 *  zip's name matches an engine this flow installed earlier, the response instead carries
 *  `updated` (that engine was refreshed in place) and no Add is needed. */
export function uploadEngineZip(file: File): Promise<EngineScanResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  return request<EngineScanResult>('/api/v1/engines/zip', { method: 'POST', body: form })
}

/** Remove an UNCONFIRMED .zip extraction — the Add-engine dialog's best-effort cleanup
 *  when it is dismissed between an upload and Add, so an abandoned build doesn't sit on
 *  disk forever. Server-side it only removes a marker-carrying dir no engine claims. */
export function deleteEngineZipInstall(binPath: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/engines/zip?binPath=${encodeURIComponent(binPath)}`, {
    method: 'DELETE',
  })
}

/** Builds in a repo's newest installable GitHub release, ranked for this machine. On demand
 *  only (ADR-396: it spends the user's GitHub quota), so call it from an explicit user action. */
export function listReleaseAssets(repo: string): Promise<ReleaseAssetListing> {
  return request<ReleaseAssetListing>(`/api/v1/engines/release/assets?repo=${encodeURIComponent(repo)}`, {
    rescue: (status, data) => noCompatibleListing(repo, status, data),
  })
}

/** A 404 `no_compatible_asset` still carries every build with its reason; keep them as a listing. */
function noCompatibleListing(repo: string, status: number, data: unknown): ReleaseAssetListing | undefined {
  const body = data as { error?: { code?: string }; assets?: RankedReleaseAsset[] } | undefined
  if (status !== 404 || body?.error?.code !== 'no_compatible_asset') return undefined
  return { repo, tag: '', publishedAt: '', prerelease: false, fellBack: false, assets: body.assets ?? [], noCompatible: true }
}

/** Start installing one release asset (plus its companions). Progress: {@link getReleaseInstall}. */
export function startReleaseInstall(plan: ReleaseInstallPlan): Promise<{ accepted: true }> {
  return request<{ accepted: true }>('/api/v1/engines/release/install', { method: 'POST', json: plan })
}

export function getReleaseInstall(): Promise<ReleaseJobView> {
  return request<ReleaseJobView>('/api/v1/engines/release/install')
}

/** With `binPath`: remove an UNCONFIRMED (or forgotten) release install dir. Without: abort the
 *  running install. Server-side it only removes a marker-carrying dir no engine claims. */
export function discardReleaseInstall(binPath?: string): Promise<{ ok: true }> {
  const query = binPath === undefined ? '' : `?binPath=${encodeURIComponent(binPath)}`
  return request<{ ok: true }>(`/api/v1/engines/release/install${query}`, { method: 'DELETE' })
}

/** Apply the newest update to one engine now (release engines; user_update trigger). */
export function updateEngine(id: string): Promise<{ accepted: true }> {
  return request<{ accepted: true }>(`/api/v1/engines/${encodeURIComponent(id)}/update`, { method: 'POST', json: {} })
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

export function installMlxVlm(): Promise<{ accepted: true; engine: 'mlx-vlm' }> {
  return request('/api/v1/engines/mlx-vlm', { method: 'POST', json: {} })
}

export function installLaya(): Promise<{ accepted: true; engine: 'laya' }> {
  return request('/api/v1/engines/laya', { method: 'POST', json: {} })
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
export function runBuild(args: { repoUrl: string; branch?: string; commit?: string; name?: string; patchUrl?: string; patchSha256?: string }): Promise<{ accepted: boolean }> {
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

/** Install one missing build prerequisite with the host's package manager (apt-get/dnf/pacman/
 *  zypper/brew) — the fix for a headless self-hosted box, where the install LINK only opens a
 *  page in the operator's own browser and installs nothing on the server. 202 + progress via
 *  GET /status engineBuild. Linux/macOS + local-host only. */
export function installPrereq(tool: 'git' | 'cmake' | 'cuda' | 'gcc'): Promise<{ accepted: boolean }> {
  return request('/api/v1/build/install-prereq', { method: 'POST', json: { tool } })
}

/** Fetch every branch name for a GitHub repo, with the default branch sorted first. Used by
 *  the build-from-source branch dropdown, which does its own client-side search filtering
 *  over the full list. */
export function getGitBranches(repo: string): Promise<{ total: number; branches: string[] }> {
  const params = new URLSearchParams({ repo })
  return request<{ total: number; branches: string[] }>(`/api/v1/build/git-branches?${params}`)
}

export function installVllm(): Promise<{ accepted: true; engine: 'vllm' }> {
  return request('/api/v1/engines/vllm', { method: 'POST', json: {} })
}

export function installSglang(): Promise<{ accepted: true; engine: 'sglang' }> {
  return request('/api/v1/engines/sglang', { method: 'POST', json: {} })
}

export function installLitertLm(): Promise<{ accepted: true; engine: 'litert-lm' }> {
  return request('/api/v1/engines/litert-lm', { method: 'POST', json: {} })
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

/** Apply the update and restart (spec 29 B.1). 202 on accept; a 409 carries the reason it
 *  was refused (a download in flight, a Code session running, an install method that can't
 *  self-update). The daemon goes away moments after this resolves — the caller polls
 *  {@link getAppUpdateProgress} / `/status` through the restart. */
export function applyAppUpdate(): Promise<{ ok: boolean; updating: boolean; from: string; to: string; method: string }> {
  return request('/api/v1/app/update', { method: 'POST', json: {} })
}

/** Poll an in-flight update. Also how the RESTARTED daemon reports the outcome of the
 *  update that restarted it. */
export function getAppUpdateProgress(): Promise<AppUpdateProgress> {
  return request<AppUpdateProgress>('/api/v1/app/update/progress')
}

/** Set the app-level auto-update policy (off | notify | auto). */
export function setAppUpdatePolicy(policy: UpdatePolicy): Promise<unknown> {
  return request('/api/v1/app/update-policy', { method: 'PUT', json: { policy } })
}

/** Remember that the user dismissed the toast for this exact version, so it never asks
 *  twice for the same release. */
export function dismissAppUpdate(version: string): Promise<unknown> {
  return request('/api/v1/app/update/dismiss', { method: 'POST', json: { version } })
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

/** Disable a CUSTOM (non-catalog) engine — same DELETE as removeEngine, but tells the
 *  backend to backfill its customEngineSources record first if one doesn't exist yet, so a
 *  build added before that tracking existed doesn't vanish on Disable with no way back. */
export function disableCustomEngine(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/engines/${encodeURIComponent(id)}?recordSource=1`, {
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

/** Delete a DISABLED source build's folder (engines/build/<slug>, no registered engine) without
 *  running its binary, so a build that no longer starts can still be deleted. The daemon refuses
 *  a folder any engine or remembered source still points into. */
export function deleteEngineBuild(binPath: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/engines/build?binPath=${encodeURIComponent(binPath)}`, {
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

/** Update (upgrade) the LiteRT-LM engine to the latest release (passes -U to uv pip install).
 *  The daemon re-checks PyPI first: when the installed release already IS the latest it
 *  answers `{ accepted: false, alreadyLatest: true, version }` without re-provisioning —
 *  the same honest refusal the llama.cpp backends make. */
export function updateLitertLm(): Promise<{ accepted: boolean; alreadyLatest?: boolean; version?: string; engine?: 'litert-lm' }> {
  return request('/api/v1/engines/litert-lm?update=1', { method: 'POST', json: {} })
}

/** Update (upgrade) the SGLang engine to the latest release (passes -U to uv pip install). */
export function updateSglang(): Promise<{ accepted: true; engine: 'sglang' }> {
  return request('/api/v1/engines/sglang?update=1', { method: 'POST', json: {} })
}

/** Update (upgrade) the MLX engine to the latest release (passes --upgrade to uv pip install). */
export function updateMlx(): Promise<{ accepted: true; engine: 'mlx' }> {
  return request('/api/v1/engines/mlx?update=1', { method: 'POST', json: {} })
}

/** Update (upgrade) the Rapid-MLX engine to the latest release (passes --upgrade to uv pip install). */
export function updateRapidMlx(): Promise<{ accepted: true; engine: 'rapid-mlx' }> {
  return request('/api/v1/engines/rapid-mlx?update=1', { method: 'POST', json: {} })
}

/** Update (upgrade) the MLX-VLM engine to the latest release (passes --upgrade to uv pip install). */
export function updateMlxVlm(): Promise<{ accepted: true; engine: 'mlx-vlm' }> {
  return request('/api/v1/engines/mlx-vlm?update=1', { method: 'POST', json: {} })
}

/** Update (upgrade) the Laya engine to the latest release. */
export function updateLaya(): Promise<{ accepted: true; engine: 'laya' }> {
  return request('/api/v1/engines/laya?update=1', { method: 'POST', json: {} })
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

/** `modelKey` names a specific loaded model to stop — required when it names a model in its
 *  own extra pool slot (an embedding model, ADR-389), or the engine ejected is whatever the
 *  primary manager happens to be running instead (the bug this parameter fixes). Omitted,
 *  this keeps stopping the primary manager exactly as before. */
export function stopEngine(modelKey?: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/stop', { method: 'POST', json: { modelKey } })
}

export function restartEngine(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/restart', { method: 'POST', json: {} })
}

// ── Engine logs ───────────────────────────────────────────────────────────────
/** `model`: a pool slot's model key (one of the response's `slots`) to read that slot's log; omitted, the primary's. */
export function getEngineLogs(tail = 200, model?: string): Promise<EngineLogs> {
  return request<EngineLogs>(`/api/v1/engine/logs?tail=${tail}${model ? `&model=${encodeURIComponent(model)}` : ''}`)
}

/** URL for the SSE live log tail (consumed via sse.ts's subscribeSse — not EventSource, which can't send the key). */
export const engineLogStreamUrl = '/api/v1/engine/logs/stream'

/** The live tail of a pool slot's log (`model`), or of the primary's when there is none. */
export const engineLogStreamUrlFor = (model: string) => (model ? `${engineLogStreamUrl}?model=${encodeURIComponent(model)}` : engineLogStreamUrl)

// ── Developer request log (issue #211 follow-up) ─────────────────────────────
export interface RequestLogFilter {
  limit?: number
  since?: number
  source?: RequestLogEntry['source']
  model?: string
  status?: 'ok' | 'error'
}

/** Bodies are withheld unless the caller explicitly opts in — see routes.ts's same rule. */
export function getRequests(filter: RequestLogFilter = {}, bodies = false): Promise<RequestLogList> {
  const params = new URLSearchParams()
  if (filter.limit !== undefined) params.set('limit', String(filter.limit))
  if (filter.since !== undefined) params.set('since', String(filter.since))
  if (filter.source) params.set('source', filter.source)
  if (filter.model) params.set('model', filter.model)
  if (filter.status) params.set('status', filter.status)
  if (bodies) params.set('bodies', '1')
  const qs = params.toString()
  return request<RequestLogList>(`/api/v1/requests${qs ? `?${qs}` : ''}`)
}

export function getRequestDetail(id: string): Promise<{ entry: RequestLogEntry }> {
  return request<{ entry: RequestLogEntry }>(`/api/v1/requests/${encodeURIComponent(id)}`)
}

export function clearRequests(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/requests', { method: 'DELETE' })
}

/** URL for the SSE live entry stream (consumed via sse.ts's subscribeSse), same convention as
 *  {@link engineLogStreamUrl}. */
export const requestsStreamUrl = '/api/v1/requests/stream'

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

/** Hide a model by hand, or unhide it (Models → Library). The daemon keeps the flag per model key, for every page and
 *  device; GET /models then marks the model `hidden`. 404 `no_such_model` for a key the library no longer has. */
export function setModelHidden(key: string, hidden: boolean): Promise<{ key: string; hidden: boolean }> {
  return request<{ key: string; hidden: boolean }>(`/api/v1/models/${encodeURIComponent(key)}/hidden`, {
    method: 'PUT',
    json: { hidden },
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

export function saveModelProfile(key: string, profile: UserSetProfile, engineId: string): Promise<UserSetProfile> {
  return request<UserSetProfile>(`/api/v1/models/${encodeURIComponent(key)}/profile?engine=${encodeURIComponent(engineId)}`, {
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

// ── Model load presets (ADR-353) ─────────────────────────────────────────────
/** List a model's presets, newest updatedAt first. */
export function fetchModelPresets(modelKey: string): Promise<{ presets: ModelPreset[]; pinnedId: string | null }> {
  return request<{ presets: ModelPreset[]; pinnedId: string | null }>(
    `/api/v1/models/${encodeURIComponent(modelKey)}/presets`,
  )
}

/** Create a preset from the current draft. 400 `too_many_presets` at the per-model cap. */
export function createModelPreset(
  modelKey: string,
  preset: { name: string; engineId?: string; profile: UserSetProfile },
): Promise<ModelPreset> {
  return request<ModelPreset>(`/api/v1/models/${encodeURIComponent(modelKey)}/presets`, { method: 'POST', json: preset })
}

/** Update a preset. Only a `profile` change re-stamps updatedAt (retention pruning keys off it). */
export function updateModelPreset(
  modelKey: string,
  id: string,
  patch: { name?: string; engineId?: string; profile?: UserSetProfile },
): Promise<ModelPreset> {
  return request<ModelPreset>(`/api/v1/models/${encodeURIComponent(modelKey)}/presets/${id}`, { method: 'PUT', json: patch })
}

export function deleteModelPreset(modelKey: string, id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/models/${encodeURIComponent(modelKey)}/presets/${id}`, { method: 'DELETE' })
}

/** Pin a preset so the next load uses it (getModelProfile consults the pin). */
export function applyModelPreset(modelKey: string, id: string): Promise<ModelPreset> {
  return request<ModelPreset>(`/api/v1/models/${encodeURIComponent(modelKey)}/presets/${id}/apply`, { method: 'POST', json: {} })
}

/** Load a model by key, optionally with one-off profile overrides (spec 05 §7). */
export function loadModel(modelKey: string, profileOverrides?: UserSetProfile): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/start', {
    method: 'POST',
    json: { modelKey, profileOverrides },
  })
}

// ── Auto-benchmark + auto-tune (spec 09 §1) ──────────────────────────────────
/** Start an auto-tune sweep for a model. 202; progress polls /status `bench`. Throws
 *  ApiError 409 when a run or the engine is busy (caller stops the engine first). */
export function startBench(modelKey: string, base?: UserSetProfile): Promise<{ accepted: true }> {
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
// The GET/PATCH /api/v1/settings types are the daemon's contract (src/contract/settings.ts), derived there from its
// SETTINGS table; re-exported so callers keep importing them from here.
export type {
  ComfyUiSettings, DaemonSettings, DaemonSettingsPatch, McpServer, ModelDefaults, RebindInfo, RemoteAccessSettings, SearchProvider,
  SettingsPatchResponse, TelemetryLevel, ToolPolicy,
} from '@contract/settings'
/** Install the ComfyUI gate node into the given ComfyUI folder (or its custom_nodes
 *  dir). One-time setup; returns where it was written. */
export function installComfyGate(path: string): Promise<{ ok: boolean; path: string; base: string; note?: string }> {
  return request('/api/v1/comfyui/install', { method: 'POST', json: { path } })
}

/** Remove the installed gate node and forget its path. */
export function uninstallComfyGate(): Promise<{ ok: boolean }> {
  return request('/api/v1/comfyui/uninstall', { method: 'POST', json: {} })
}

/** What the daemon sends for every MCP stdio env value (routes.ts's MCP_ENV_MASK, same string):
 *  env holds the servers' credentials, so its values are write-only. Sent back unchanged in a
 *  PUT, a masked value keeps the stored one. */
export const MCP_ENV_MASK = '••••••••'

export function getSettings(): Promise<DaemonSettings> {
  return request<DaemonSettings>('/api/v1/settings')
}

export function saveSettings(patch: DaemonSettingsPatch): Promise<SettingsPatchResponse> {
  return request<SettingsPatchResponse>('/api/v1/settings', { method: 'PATCH', json: patch })
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

/** One entry in the local submission log (ADR-299): an event that ACTUALLY left
 *  this machine, stored verbatim so it can be checked against our claims. */
export type SentEntry = { sentAt: string; event: Record<string, unknown> }

export function getTelemetryLog(): Promise<{ entries: SentEntry[] }> {
  return request<{ entries: SentEntry[] }>('/api/v1/telemetry/log')
}

/** Mint a new anonymous machine id, discarding anything queued under the old one. */
export function regenerateMachineId(): Promise<{ machineId: string }> {
  return request<{ machineId: string }>('/api/v1/telemetry/regenerate-id', { method: 'POST' })
}

/** LAN network info (spec 08 §2): expose state, the reachable LAN URL, and whether
 *  an API key exists (required for non-local access). `requireApiKey` + `isHost` mirror the
 *  backend's /api/v1/keys host gate so the UI can honestly reflect the same rule. */
export type NetworkInfo = {
  lanBind: boolean
  lanUrl: string
  hasApiKey: boolean
  requireApiKey: boolean
  isHost: boolean
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
/** Whether the daemon's host gate (auth.ts hostGate) takes the key this browser now sends: GET
 *  /api/v1/keys is behind that gate and changes nothing, and answers 403 to a missing, wrong or
 *  revoked key or a remote-access token (401 with requireApiKey on or through a tunnel).
 *  EnginesScreen asks it before a git build's Remove, and App.tsx before closing the prompt a
 *  host-only setting raised once a key judged by /status is stored. Any other failure, a dropped
 *  connection or no answer in time say, says nothing about the key, so it counts as accepted, as
 *  before the check. */
export async function hostKeyAccepted(): Promise<boolean> {
  return (await keyCheck('/api/v1/keys', authHeaders(), hostGateVerdict)) !== 'refused'
}
/** What a check said about a key pasted into the key prompt (App.tsx useKeyPrompt), which replaces
 *  the stored one only when 'accepted'. 'unchecked' is no answer about the key at all: a dropped
 *  connection, or a tunnel's or proxy's 5xx while the daemon restarts. The stored key can be a
 *  remote-access token, shown once and never again, so that must not count as taken: a typo
 *  pasted while the daemon was restarting replaced it as surely as one the daemon refused. No
 *  answer within KEY_CHECK_TIMEOUT_MS is 'unchecked' too. */
export type KeyCheck = 'accepted' | 'refused' | 'unchecked'
/** `key` checked at the host gate (see hostKeyAccepted), which is also Code's gate (auth.ts
 *  codeAuth): for a key pasted into the prompt a host-only change or Code raised (auth-signal.ts).
 *  Only a 2xx takes it. */
export function hostKeyCheck(key: string): Promise<KeyCheck> {
  return keyCheck('/api/v1/keys', { 'X-TurboLLM-Auth': key }, hostGateVerdict)
}
/** `key` checked by lanAuth through GET /api/v1/status, for a key pasted into the prompt a 401
 *  from /status raised: only a 401 refuses it. A 403 is a remote-access token without config:read,
 *  a key that works for everything it was given (connection-state.ts's scopedTokenLimited), so it
 *  takes the key as a 2xx does. */
export function statusKeyCheck(key: string): Promise<KeyCheck> {
  return keyCheck('/api/v1/status', { 'X-TurboLLM-Auth': key }, (status) =>
    status === 401 ? 'refused' : (status >= 200 && status < 300) || status === 403 ? 'accepted' : 'unchecked')
}
function hostGateVerdict(status: number): KeyCheck {
  return status === 401 || status === 403 ? 'refused' : status >= 200 && status < 300 ? 'accepted' : 'unchecked'
}
/** How long a key check waits for an answer before it gives up, as 'unchecked'. */
export const KEY_CHECK_TIMEOUT_MS = 10_000
/** GET `path` with `auth` and what `verdict` makes of the answer. A plain fetch, not request(): a
 *  check's refusal must not raise the auth signals (auth-signal.ts) the prompt it answers is built
 *  on, and the stored key must not be touched. A dropped connection is 'unchecked', and so is no
 *  answer within KEY_CHECK_TIMEOUT_MS. */
async function keyCheck(path: string, auth: Record<string, string>, verdict: (status: number) => KeyCheck): Promise<KeyCheck> {
  const headers = { Accept: 'application/json', ...auth }
  // A key with a character no request header can carry (a curly quote or a zero-width space
  // pasted along with it) made fetch throw before anything was sent, which read as a dropped
  // connection: the prompt said to try again in a moment, which never helped. No key has such a
  // character, so it is refused, without a request.
  try {
    new Headers(headers)
  } catch {
    return 'refused'
  }
  // A check with no answer at all (a tunnel holding the connection open) kept AuthGate's Connect
  // disabled, with no hint, for as long as it was out, and the prompt a 401 from /status opens has
  // no "Not now": nothing on it could be clicked. So it gives up, and says no more than a dropped
  // connection does.
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), KEY_CHECK_TIMEOUT_MS)
  try {
    const res = await fetch(path, { headers, signal: abort.signal })
    return verdict(res.status)
  } catch {
    return 'unchecked'
  } finally {
    clearTimeout(timer)
  }
}
export function createApiKey(name: string): Promise<ApiKeyCreated> {
  return request<ApiKeyCreated>('/api/v1/keys', { method: 'POST', json: { name } })
}
export function deleteApiKey(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
/** The daemon refuses this GET without `X-TurboLLM-UI` (auth.ts lanAuth): it can replace a CLI
 *  key, and a page on another site cannot add a custom header without a CORS preflight.
 *  `mint: false` is a fetch the user did not click for: a LAN-bound daemon then answers 409
 *  `lan_bound` instead of minting a new `cli-<name>` key (which revokes the previous one). */
export function getConnect(cli: string, opts: { mint?: boolean } = {}): Promise<ConnectInfo> {
  const query = opts.mint === false ? '?mint=0' : ''
  return request<ConnectInfo>(`/api/v1/connect/${encodeURIComponent(cli)}${query}`, { headers: { 'X-TurboLLM-UI': '1' } })
}

// ── System info (spec 05 §6) ─────────────────────────────────────────────────
export interface SysInfo {
  os: string
  cpu: string
  cores: number
  ramMB: number
  gpus: Array<{ name: string; vramMb: number; vendor: string }>
  /** True inside the packaged Android app: the engines that exist are the ones shipped in the
   *  APK, and install / build / add-your-own cannot work there at all (Android's W^X hardening —
   *  see the daemon-side field in src/sysinfo/sysinfo.ts for why). Note this is NOT the same as
   *  "os starts with android": Termux reports android too, and everything works normally there.
   *  Optional so an older daemon (or a test fixture) simply reads as false. */
  bundledEnginesOnly?: boolean
}

export function getSysInfo(): Promise<SysInfo> {
  return request<SysInfo>('/api/v1/sysinfo')
}

// ── Hugging Face discovery (spec 10 §2–4, §7 rewrite) ────────────────────────
/** Search (q set) or browse (q blank) HF repos, sorted by `sort`. Each row carries
 *  `localCount` (variants already in library). The library/format filter adapts to the
 *  active engine server-side — never hardcoded to GGUF — unless `category` asks for a
 *  category, which ignores the engine. */
export function hfSearch(
  q: string,
  sort: HfSortOption = 'best-match',
  category?: HfSearchCategory,
): Promise<HfSearchRows> {
  const categoryParam = category ? `&category=${category}` : ''
  return request<HfSearchRows>(`/api/v1/hf/search?q=${encodeURIComponent(q)}&sort=${sort}${categoryParam}`)
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
 *  the response carries every record created. `existing`: the rows already downloading,
 *  queued or paused that hold files the request names (they get no second row), by id, name
 *  and status; absent from a daemon older than it. */
export function enqueueDownload(input: {
  repo?: string
  rfilename?: string
  url?: string
  size?: number
  sha256?: string
  subdir?: string
  /** With `subdir`: the whole folder download this file is one of, every file of it by where
   *  its own request puts it (`<subdir>/<basename>`) and its size. The daemon checks free disk
   *  for each file against the total of those not already downloading, so a folder that does
   *  not fit has none of its files queued. */
  folder?: { files: { path: string; size: number }[] }
  /** Onboarding-only (spec 25 §5.4 / ADR-338 Decision 6): drop the shared mmproj vision
   *  projector a blessed catalog GGUF would otherwise expand into — "never pull mmproj-*.gguf
   *  — pure added download before first token." Discover's own manual picks never set this. */
  excludeMmproj?: boolean
}): Promise<{ downloads: DownloadRecord[]; existing?: HeldDownload[] }> {
  return request<{ downloads: DownloadRecord[]; existing?: HeldDownload[] }>('/api/v1/downloads', { method: 'POST', json: input })
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

/** Stop a downloading or queued download but keep its partial file, for {@link resumeDownload}. */
export function pauseDownload(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/downloads/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
    json: {},
  })
}

export function resumeDownload(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/downloads/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    json: {},
  })
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

/** Fetch `path` with the API key and save the response as a browser download (Blob + a temporary
 *  `<a download>`, named from the daemon's Content-Disposition). A plain `<a href>` can't send
 *  X-TurboLLM-Auth, so over LAN/remote access it would save the daemon's 401 JSON instead of the
 *  file. Rejects with an `ApiError` on a non-OK response, so the caller can toast it. */
async function downloadWithAuth(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { headers: { Accept: 'application/json', ...authHeaders() } })
  if (!res.ok) {
    const env = safeJson(await res.text().catch(() => '')) as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Download failed with status ${res.status}.`, res.status)
  }
  const cd = res.headers.get('Content-Disposition') ?? ''
  const nameMatch = cd.match(/filename="([^"]+)"/)
  const filename = nameMatch ? nameMatch[1] : fallbackName
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Trigger a browser download of the chat as a .turbollm-chat.json file. Rejects when the export
 *  fails (401 on LAN without a key, deleted chat, network error) so the caller can tell the user. */
export function downloadChatExport(convId: string): Promise<void> {
  return downloadWithAuth(`/api/v1/conversations/${encodeURIComponent(convId)}/export?format=export`, 'chat.turbollm-chat.json')
}

/** Download the last auto-tune run's log (GET /api/v1/bench/log). Rejects like {@link downloadChatExport}. */
export function downloadBenchLog(): Promise<void> {
  return downloadWithAuth('/api/v1/bench/log', 'autotune-log.json')
}

/** Import a chat from a parsed JSON object. Returns the new conversation id. */
export function importChat(payload: unknown): Promise<{ id: string }> {
  return request<{ id: string }>('/api/v1/conversations/import', {
    method: 'POST',
    json: payload,
  })
}
