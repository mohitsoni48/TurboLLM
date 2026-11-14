// The GET/PATCH /api/v1/settings contract: types only, shared by the daemon and the web app (`import type` through the
// `@contract/*` alias). The daemon's payload type is derived from its SETTINGS table (src/config/settings-schema.ts), and
// that file fails to compile unless the derived type has exactly this file's top-level keys and is assignable to
// DaemonSettings, so a setting added to the table must be declared here too.
// A field is optional here when an older daemon omits it.
// Declare nothing here that needs a runtime import: contract.test.ts rejects it.

/** Global model defaults (spec 05 §3): base load values applied to never-seen
 *  models that have no saved per-model profile. */
export type ModelDefaults = {
  ctx: number
  ngl: number
  imageMaxTokens?: number
  /** Hard cap on tokens generated per response (0 = unlimited). Applies to in-app
   *  chat and clamps external (Claude Code) requests too. */
  maxTokens?: number
  /** Default K / V cache types for a model with none saved ('' or absent = automatic). */
  kvTypeK?: string
  kvTypeV?: string
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

export type McpServer = {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  /** stdio only. Read back with each value as MCP_ENV_MASK, never the value itself. */
  env?: Record<string, string>
  url?: string
  /** sse only — Bearer token for Authorization header (ADR-124). Write-only: sent on add/edit,
   *  never returned ('' on edit removes it). */
  apiKey?: string
  /** Read-only, from the settings payload: whether a Bearer key is stored. */
  apiKeySet?: boolean
  enabled: boolean
}

/** Tool-call approval gate policy (mirrors turbollm/src/tools/tool-policy.ts). */
export type ToolPolicy = 'ask' | 'allow' | 'deny'

export type SearchProvider = 'tavily' | 'kagi' | 'searxng'

/** Remote access (ADR-422): the settings-payload mirror of the daemon's redacted `remoteAccess` block. Secrets are
 *  write-only — the `has*` booleans say whether one is stored, never what it is, same posture as hfToken/ghTokenSet.
 *  `provider` is hand-kept in sync with `RemoteProviderId` (config.ts REMOTE_PROVIDERS). */
export interface RemoteAccessSettings {
  enabled: boolean
  provider: 'cloudflare-quick' | 'cloudflare-named' | 'tailscale-serve' | 'tailscale-funnel' | 'ngrok' | 'custom'
  ingressPort: number
  cloudflare: { hasTunnelToken: boolean; hostname: string; accessTeamDomain: string; accessAud: string; requireAccess: boolean }
  ngrok: { hasAuthtoken: boolean; domain: string }
  tailscale: { port: number }
  custom: { publicUrl: string }
  /** Capability scope minted remote tokens receive (ADR-422 §6.3). Not secret — a capability
   *  list, not a credential — so it is echoed back as stored, unlike the `has*` secrets above. */
  tokenGrant: { capabilities: string[]; models?: string[] }
  lastUrl: string
}

export type DaemonSettings = {
  idleTtlMinutes: number
  /** Listen port (spec 08 §2). Takes effect on the next daemon restart. */
  port: number
  theme: string
  /** Human-readable name this machine reports to a Turbo Link peer (ADR-376). Empty
   *  means "use the OS hostname" — the daemon resolves the fallback, never the browser. */
  machineName: string
  autoGenerateTitles: boolean
  /** Release 3: background extraction of durable facts from the user's own chat messages,
   *  injected into future new conversations. Off by default (opt-in trust surface). */
  autoMemoryEnabled: boolean
  openBrowserOnStart: boolean
  autoLoadOnStart: boolean
  /** Settings → Models, "Show models for every engine": list every model, not only those the selected engine can run
   *  (they still load only on it, and fail with its error if it cannot). Off by default; absent from older daemons. */
  showAllEngineModels?: boolean
  /** VRAM to keep free during auto-tune's offload search, MB (300–2048, default 1024) — OR 0, an
   *  explicit opt-in letting the MoE hill-climb spill past all headroom for more t/s. A later
   *  desktop / ComfyUI VRAM grab can't tip a config tuned with less headroom into a sysmem spill. */
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
  /** Gateway intelligence settings (ADR-06x): model auto-swap + keep-N pool, and the `/v1/*` request-body cap in MB
   *  (1–4096, default 128; host-only, no Settings control; absent from older daemons). */
  gateway: { autoSwap: boolean; keepN: number; maxBodyMb?: number }
  /** Developer request log (issue #211 follow-up): whether the log captures at all, and
   *  whether captured entries include full prompt/response TEXT. `captureBodies` defaults off
   *  — it lives in Settings → Privacy & telemetry, not Developer/Engines, because it's a
   *  privacy choice: the log itself is always in-memory-only regardless of this flag.
   *  `maxEntries` is config-file only. */
  requestLog: { enabled: boolean; captureBodies: boolean; maxEntries?: number }
  /** Data retention (daemon chat/retention.ts): a daily sweep folds raw gateway usage older than `apiUsageRawDays`
   *  (31-3650) into daily totals, which the usage dashboards still count, and keeps the newest `routineRunsKept`
   *  (10-100000) runs per routine. On by default (90 days, 200 runs). */
  retention: { enabled: boolean; apiUsageRawDays: number; routineRunsKept: number }
  /** Whether an HF token is stored (spec 10 §4). The token itself is never echoed
   *  back — write it via the `hfToken` patch field only. */
  hfTokenSet: boolean
  /** Whether a GitHub token is stored (same write-only semantics as HF). */
  ghTokenSet: boolean
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
  /** Code's AGENTS.md-style standing-context candidate lists (config.ts's CodeConfig) — tried
   *  in order per side, first EXISTING file wins. Not secret — echoed back.
   *  defaultAgent: which coding agent new Code sessions launch with (CodeAgentSection.tsx). */
  code: { agentsMdProjectCandidates: string[]; agentsMdGlobalCandidates: string[]; defaultAgent: 'turbollm' | 'pi' | 'claude' | 'opencode' }
  /** Cloud Launch deploy-link settings (ADR-153). The RunPod Template ID the user
   *  published themselves — not a secret, just an id, echoed back as-is. */
  cloudDeploy: { runpodTemplateId: string }
  /** Experimental feature flags (2026-07-14, Settings → Experimental). Off by default for
   *  new/distributed installs. Code used to be one of these — removed when it graduated to
   *  generally available (ADR-280). `routines` (2026-08-04): Routines never shipped
   *  outside this gate, so it defaults to off for every install, new or upgraded.
   *  `turboLink` (2026-08-21, ADR-376): fully built and green, but never
   *  verified against a real second machine, so it is opt-in. While it is off the Turbo Link
   *  section does not render, `useLinks`/`useRemoteModels` do not fetch, and every merged
   *  fleet list falls back to local-only rows with no origin column and no machine filter. */
  experimental: { memory: boolean; cloudDeploy: boolean; routines: boolean; turboLink: boolean; remoteAccess: boolean; sandbox: boolean }
  /** Tool-call approval gate (F-025): per-tool default policy. Missing tools default
   *  to 'ask'. Keyed by tool name (e.g. 'run_code', 'mcp__server__tool'). */
  toolPolicies: Record<string, ToolPolicy>
  /** Master toggle (Settings → Tool permissions), default off: when true, every tool
   *  call that would show an "awaiting approval" prompt runs immediately instead.
   *  Only silences a resolved 'ask' — an explicit 'deny' is still honored. */
  autoAllowAll: boolean
  /** How long a chat reply waits for the answers to its tool calls set to Ask, all its calls
   *  together, in whole minutes (0-1440, default 30); past it they are not run and the reply goes
   *  on. 0 waits until answered. Optional: a daemon from before the setting does not send it. */
  chatApprovalWaitMinutes?: number
  /** Remote access (ADR-422). */
  remoteAccess: RemoteAccessSettings
  /** Files the download manager streams at once (1–8, default 2). Host-only, no Settings control; absent from older daemons. */
  downloadConcurrency?: number
  /** Seconds a native engine's load may show no progress before it is stopped (0–600, default 120; 0 = off). Host-only,
   *  no Settings control; absent from older daemons. */
  engineLoadStallSeconds?: number
}

/** Settings patch: the persisted {@link DaemonSettings} fields plus write-only credentials. Every nested block is
 *  patchable per field: the daemon applies each member independently, so a patch sends only what it changes. */
export type DaemonSettingsPatch = Partial<Omit<DaemonSettings, 'comfyui' | 'tavilyKeySet' | 'search' | 'mcp' | 'experimental' | 'code' | 'requestLog' | 'retention' | 'remoteAccess' | 'modelDefaults' | 'gateway'>> & {
  /** `gatePath` is owned by the ComfyUI install endpoints. */
  comfyui?: Partial<ComfyUiSettings>
  modelDefaults?: Partial<ModelDefaults>
  gateway?: Partial<DaemonSettings['gateway']>
  experimental?: Partial<DaemonSettings['experimental']>
  /** `enabled`/`lastUrl` are excluded (M5, final-review.md): both are runtime-owned by /remote/start and /remote/stop,
   *  and the PATCH handler ignores them, so typing them as patchable would typecheck a write that does nothing. */
  remoteAccess?: Partial<Omit<RemoteAccessSettings, 'cloudflare' | 'ngrok' | 'tailscale' | 'custom' | 'enabled' | 'lastUrl'>> & {
    cloudflare?: { tunnelToken?: string; hostname?: string; accessTeamDomain?: string; accessAud?: string; requireAccess?: boolean }
    ngrok?: { authtoken?: string; domain?: string }
    tailscale?: { port?: number }
    custom?: { publicUrl?: string }
    tokenGrant?: { capabilities?: string[]; models?: string[] }
  }
  code?: Partial<DaemonSettings['code']>
  /** The Privacy & telemetry "Log prompts and responses" checkbox flips `captureBodies` without resending `enabled`.
   *  `maxEntries` is config-file only, so it is not patchable. */
  requestLog?: Partial<Pick<DaemonSettings['requestLog'], 'enabled' | 'captureBodies'>>
  retention?: Partial<DaemonSettings['retention']>
  /** Write-only: set or clear ('') the stored Hugging Face token (spec 10 §4). */
  hfToken?: string
  /** Write-only: set or clear ('') the stored GitHub token. Raises the GitHub API rate limit
   *  for branch lookups from 60 to 5,000 requests/hour. Never echoed back — read the boolean
   *  `ghTokenSet` from {@link DaemonSettings} instead. */
  ghToken?: string
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

/** A LAN/port change re-points the listener in place (no full restart). Present on a
 *  save that changed `lanBind`/`port`; `portChanged` means the client must hop to the
 *  new port (a LAN-only change is seamless on 127.0.0.1). */
export type RebindInfo = { portChanged: boolean; port: number; lanBind: boolean }

/** What PATCH /api/v1/settings answers: the saved settings, plus `rebind` when the save moved the listener. */
export type SettingsPatchResponse = DaemonSettings & { rebind?: RebindInfo }
