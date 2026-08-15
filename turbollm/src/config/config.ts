// Config load/save/migrate (spec 01). Ports the verified Go implementation to
// TypeScript. Single-threaded event loop => config.update() is atomic per call,
// so no locking is needed. Unknown JSON fields ride along on `data` and are
// preserved across round-trips for free.
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SCHEMA_VERSION = 4

/** VRAM headroom slider bounds (MB) for auto-tune's spill-safety margin (see
 *  {@link Config.vramHeadroomMb} and `bench.ts`'s `overHeadroom`). */
export const VRAM_HEADROOM_MIN_MB = 300
export const VRAM_HEADROOM_MAX_MB = 2048
export const VRAM_HEADROOM_DEFAULT_MB = 1024
/** Special sentinel, distinct from the {@link VRAM_HEADROOM_MIN_MB}–{@link VRAM_HEADROOM_MAX_MB}
 *  safety-margin range: an explicit opt-in to let auto-tune spill PAST all VRAM headroom during
 *  its MoE hill-climb search (`bench.ts`'s `moeSearch`), trading the safety margin for a real
 *  measured tok/s gain when one exists. Founder call, 2026-07-17 (after live-testing the
 *  hill-climb unconditionally): the hill-climb must never silently override a user's configured
 *  safety margin, so it's gated on this exact value — anything in 1–299 is invalid, same as
 *  before. The Settings slider snaps straight from {@link VRAM_HEADROOM_MIN_MB} to this value. */
export const VRAM_HEADROOM_SPILL_MB = 0

export interface FlagInfo {
  name: string
  kind: 'enum' | 'boolean' | 'valued'
  enumValues?: string[]
}

export interface Capabilities {
  kvTypes: string[]
  flags: string[]
  /** One entry per probed flag, capturing its inferred argument shape. Reserved for a generic
   *  "Advanced parameters" UI (spec 22) — built, then removed after live testing found it
   *  overwhelming for a real engine's ~300 probed flags (v1.10.2); no current consumer renders
   *  this, but it still backs `kvTypes`'s generic derivation. Optional: absent for engine kinds
   *  that never go through probe.ts's --help scrape (mlx/rapid-mlx/vllm/sglang, which register
   *  with a hand-written `{ kvTypes: [], flags: [] }` literal — see api/routes.ts) and for
   *  engines registered by a daemon predating this field (backfilled by the next reprobe — see
   *  registry.ts's isStaleCapabilities). Treat undefined as "nothing to show yet", never an
   *  error. */
  flagInfo?: FlagInfo[]
}
/** Per-engine auto-update policy (ADR-085, Phase 6). Default 'notify' (badge the UI;
 *  never auto-apply). 'off' = ignore; 'auto' = apply a found update when the engine is idle. */
export type UpdatePolicy = 'off' | 'notify' | 'auto'

export interface Engine {
  id: string
  name: string
  binPath: string
  kind: string
  version: string
  capabilities: Capabilities
  addedAt: string
  /** Auto-update policy (ADR-085). Absent in pre-Phase-6 configs → 'notify' on load. */
  updatePolicy?: UpdatePolicy
  /** Optional source-repo URL this engine was built from (ADR-088). When set to a
   *  GitHub repo, the update check compares the built commit hash against the repo's
   *  latest commit and surfaces a notify-only "newer source available → rebuild".
   *  Also seeds future telemetry. Absent on engines added before ADR-088. */
  sourceRepo?: string
  /** Optional branch to compare commits against (ADR-088). Empty/absent → the repo's
   *  default branch (resolved via the `HEAD` commits ref). */
  sourceBranch?: string
  /** Set only when this build was pinned to an exact historical commit (build-runner's
   *  `commit` field), e.g. for A/B-ing a specific past commit against the branch tip.
   *  Distinct from `sourceBranch` deliberately — a pinned-commit build must never be
   *  treated as "the same engine, just rebuilt" as a plain branch-tip build of the same
   *  repo (registration would silently replace one with the other). */
  sourceCommit?: string
  /** Set only when this build applied a pinned third-party patch on top of `sourceCommit`
   *  (build-runner's `patchUrl`), e.g. an architecture not yet in mainline llama.cpp. Provenance
   *  only — records that this binary isn't a plain build of `sourceRepo`@`sourceCommit`. */
  sourcePatchUrl?: string
}

/** A custom (non-catalog) engine's identity, remembered independent of its live
 *  {@link Engine} registration (GitHub: "custom engine treated as an outsider").
 *
 *  A catalog engine (llama.cpp, TurboQuant, …) can be disabled then re-enabled instantly
 *  because its fixed, hardcoded homepage URL lets the backend re-scan disk for a still-built
 *  binary. A custom repo has no such fixed identity anywhere else in the system — once its
 *  {@link Engine} row is removed (Disable), nothing remembers which repo it came from. This
 *  record is that memory: written when a non-catalog engine is added, kept across a Disable
 *  (registry.remove), and only dropped on an explicit purge/delete — so Enable can re-detect
 *  the still-built binary and re-register it with no rebuild, the same as a catalog engine. */
export interface CustomEngineSource {
  name: string
  /** Binary path at the time this was recorded. Still valid after a Disable (files are only
   *  removed on purge) — used to both re-register on Enable and to check the build still
   *  exists on disk before offering that. */
  binPath: string
  kind: string
  sourceRepo?: string
  sourceBranch?: string
  sourceCommit?: string
  sourcePatchUrl?: string
  addedAt: string
}
export interface Daemon {
  host: string
  port: number
  lanBind: boolean
  /** When LAN-exposed, require an API key for non-loopback requests (spec 06 §5).
   *  Off = open/unauthenticated LAN access (no key needed). Default on. */
  requireApiKey: boolean
  authToken: string
  idleTtlMinutes: number
  openBrowserOnStart: boolean
  theme: string
  autoGenerateTitles: boolean
  /** Release 3: background extraction of durable facts from the user's own chat messages,
   *  injected into future new conversations. Off by default — unlike autoGenerateTitles,
   *  this builds a persistent cross-conversation profile of the user, so it's opt-in
   *  (same trust-surface posture as lanBind), not default-on. Two-layer gate:
   *  `experimental.memory` (below) is the master "is this feature unlocked at all"
   *  switch — MemorySection's own UI in Settings → General only renders when it's on, and
   *  extraction only runs when BOTH it and this field are true (chat-routes.ts). This field is
   *  the finer opt-in WITHIN that (do you actually want facts remembered). Code used to follow
   *  this same two-layer shape via `experimental.code` — removed when Code graduated out of
   *  experimental status and became available to everyone by default (ADR-280). */
  autoMemoryEnabled: boolean
  /** Experimental features (2026-07-14, preparing for wider distribution): still-in-progress
   *  capabilities gated behind an explicit opt-in toggle in Settings → Experimental, off by
   *  default for new/distributed installs. */
  experimental: ExperimentalFeatures
}
export interface ExperimentalFeatures {
  /** Master gate for the Memory feature — visibility AND behavior. When off:
   *  MemorySection (Settings → General) does not render at all, and auto-memory extraction
   *  never runs regardless of `autoMemoryEnabled` (chat-routes.ts checks both). When on, the
   *  section reappears in its ORIGINAL location in General — this does NOT relocate Memory's
   *  settings into the Experimental tab, only gates whether they're reachable at all. */
  memory: boolean
  /** Gates the Cloud Launch / RunPod deploy-link surface (ADR-153's cloudDeploy config,
   *  previously only reachable via the internal-only TURBOLLM_FEATURES=cloud-deploy env var,
   *  features.ts — this is now the primary, user-facing way to turn it on). */
  cloudDeploy: boolean
  /** Master gate for the Routines feature — visibility AND behavior, same two-layer shape as
   *  `memory`. When off (the default for every install, new or upgraded — Routines never shipped
   *  outside this gate): the Routines mode tab/nav badge/routes do not render at all, and
   *  `create_routine` refuses to create anything from chat, the in-app Code (pi) agent, the
   *  external claude_cli MCP bridge, or a direct REST POST /api/v1/routines — regardless of who's
   *  asking. Existing routine tools (list/update/delete/run_routine_now) and REST routes besides
   *  create are left reachable, matching this file's existing "gate only what's asked" posture
   *  (routine-routes.ts's own doc comments make the same call for delete_routine/list_routines). */
  routines: boolean
}
export interface Telemetry {
  level: string
  machineId: string
}
/** One persisted auto-tune result (spec 09 §1, 01 §4), keyed by modelKey in
 *  {@link Config.benchResults}. Survives restart so the model list/detail can show
 *  "N tok/s on your machine". Additive: absent in pre-bench configs (normalize seeds {}). */
export interface BenchResult {
  modelKey: string
  tps: number
  ttftMs: number
  vramMb: number | null
  params: { ctx: number; ngl: number; nglFit?: boolean; nCpuMoe: number; nCpuMoeFit?: boolean; parallel: number; kvTypeK: string; flashAttn: string }
  ts: string
}
export interface ApiKey {
  id: string
  name: string
  hash: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}
export interface LastLoaded {
  modelKey: string
  engineId: string
}
export interface HF {
  token: string
}
/** Web-search backend selection (F-020). */
export type SearchProvider = 'tavily' | 'kagi' | 'searxng'
export interface SearchConfig {
  provider: SearchProvider
  tavilyApiKey?: string
  kagiApiKey?: string
  searxngUrl?: string
}

/** Built-in tool configuration (v0.7.0). */
export interface ToolsConfig {
  /** Legacy Tavily key (pre-F-020). Migrated into `search.tavilyApiKey` on load; kept for read. */
  tavily?: { apiKey: string }
  /** Pluggable web-search provider config (F-020). */
  search?: SearchConfig
  /** Global per-tool approval policy (tool-call approval gate). Every tool defaults
   *  to 'ask' unless explicitly set here to 'allow' or 'deny'. A per-conversation
   *  override (Conversation.toolOverrides) takes precedence over this map. */
  toolPolicies?: Record<string, 'ask' | 'allow' | 'deny'>
  /** Master toggle (Settings → Tool permissions), default OFF: when true, every tool
   *  call that would otherwise show an "awaiting approval" prompt runs immediately
   *  instead. Only silences a resolved 'ask' — an explicit 'deny' (global or
   *  per-conversation) is still honored; see resolveToolPolicy. */
  autoAllowAll?: boolean
}

/** One MCP server the daemon manages as a tool provider (v0.7.0). */
export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  /** stdio only — command to spawn */
  command?: string
  /** stdio only — argv after command */
  args?: string[]
  /** stdio only — extra env vars for the child process */
  env?: Record<string, string>
  /** sse only — base URL of the MCP server */
  url?: string
  /** sse only — Bearer token injected as Authorization header on every request (ADR-124) */
  apiKey?: string
  enabled: boolean
}

/** MCP host configuration (v0.7.0). */
export interface McpConfig {
  servers: McpServer[]
}

/** Gateway intelligence (v0.6.0): auto model-swap + keep-N pool. */
export interface Gateway {
  /** When true, gateway requests that include a `model` field auto-load the named
   *  model if it isn't already running. Default on. */
  autoSwap: boolean
  /** Maximum number of models to keep loaded simultaneously. Default 1 = pure
   *  swap (unload A, load B). Values 2–4 keep multiple models hot in a pool with
   *  LRU eviction. Capped at 4. */
  keepN: number
}

/** ComfyUI GPU-coordination (so the LLM engine and ComfyUI don't fight over VRAM).
 *  Push-based: a one-time-installed ComfyUI custom node calls TurboLLM the moment a
 *  render starts (TurboLLM unloads the model + blocks loads) and when the queue drains
 *  (TurboLLM reloads the model it unloaded). No polling — see {@link ComfyGuard}. */
export interface ComfyUI {
  enabled: boolean
  /** Absolute path to the ComfyUI `custom_nodes` dir the gate node was installed into
   *  (set by the in-app installer). Empty until installed — lets the UI show state. */
  gatePath: string
  /** ComfyUI's HTTP origin (e.g. `http://127.0.0.1:8188`). Used by the REVERSE gate to
   *  call ComfyUI's native `POST /free` so it drops its VRAM before TurboLLM loads a
   *  model. Empty disables the reverse direction (we can't reach ComfyUI). */
  url: string
  /** Reverse gate (F-011): when TurboLLM is about to load a model, first ask ComfyUI to
   *  free its VRAM. The symmetric counterpart of the forward (acquire/release) gate —
   *  whoever the user is actively driving wins the GPU. Off by default. */
  reverseGate: boolean
  /** Persist the llama-server KV prompt cache to disk before a ComfyUI-forced unload and
   *  restore it on reload, so a long prefix isn't re-prefilled. Opt-in; llama.cpp
   *  text-only. See slot-cache.ts. */
  cachePersist: boolean
}
/** Guided/1-click compile-from-source settings (ADR-089 + ADR-100). The build runs
 *  `git clone` + `cmake` in the daemon process, which inherits the daemon's PATH. When
 *  the user's CUDA Toolkit / compiler lives in a conda env or a custom location (not on
 *  the system PATH), `nvcc` etc. aren't found and the build can't see CUDA. These dirs are
 *  prepended to PATH for BOTH the prerequisite probe and the actual build, so the user can
 *  point at their conda env's bin (or the CUDA bin) and have it picked up. Absolute paths. */
export interface BuildConfig {
  toolchainDirs: string[]
}
/** Standing-context filename candidates for Code's AGENTS.md-style injection
 *  (persona.ts's agentsMdBlock) — tried in order per side, first EXISTING match wins. Global-
 *  only for now (applies to every repo alike, not a per-repo setting — see decision-log for the
 *  rationale): solves the common "this repo uses CLAUDE.md, not AGENTS.md" case with zero
 *  configuration, since the shipped defaults already include CLAUDE.md. Entries must be
 *  RELATIVE (validate() below rejects an absolute one with a clean 400) — persona.ts still
 *  containment-checks each one again at read time regardless, since config.json is hand-editable
 *  and route-level validation alone can't be trusted as the only gate. */
export interface CodeConfig {
  /** Tried against each repo's own root. Defaults mirror persona.ts's own
   *  DEFAULT_AGENTS_MD_PROJECT_CANDIDATES (duplicated as a literal, not imported — config.ts
   *  stays dependency-free of feature modules by design; update both if this ever changes). */
  agentsMdProjectCandidates: string[]
  /** Tried against the global TurboLLM data dir (~/.turbollm). Mirrors persona.ts's
   *  DEFAULT_AGENTS_MD_GLOBAL_CANDIDATES. */
  agentsMdGlobalCandidates: string[]
  /** Which coding agent new Code sessions launch with. 'turbollm' is the built-in
   *  pi-SDK-backed chat UI (unchanged); the others launch full-screen inside the
   *  embedded terminal (turbollm launch <agent>, cli-launch.ts). Read ONCE at session
   *  creation and stamped onto the AgentRun (code-routes.ts) — a session's agent never
   *  changes after creation, same as repoRoot. Changing this only affects sessions
   *  created afterward. */
  defaultAgent: 'turbollm' | 'pi' | 'claude' | 'opencode'
}
/** Cloud Launch deploy-link settings (ADR-153, RunPod recipe). RunPod is the only
 *  provider for now — a user who has published their own RunPod Template (following
 *  deploy/runpod/README.md) pastes its ID here; the Developer screen's "Deploy on
 *  RunPod" button just constructs and opens RunPod's own one-click deploy link with
 *  it. No credentials involved — full API-driven auto-provisioning is a separate,
 *  bigger, not-yet-built feature (the BYO-cloud orchestration line, ADR-003). */
export interface CloudDeployConfig {
  runpodTemplateId: string
}
/** A user-created chat Agent (Customize → Agents): a named system prompt with a
 *  scoped skill + tool allow-list, selected when starting a new conversation —
 *  distinct from {@link AgentType} below, which scopes the separate pi-driven
 *  background-run engine (filesystem read/write roots, max iterations). Chat
 *  agents never touch the filesystem outside the normal tool-approval gate. */
export interface CustomChatAgent {
  id: string
  name: string
  description: string
  systemPrompt: string
  /** Skill ids (from the shared skill library) auto-enabled when a conversation
   *  starts with this agent. */
  skillIds: string[]
  /** Tool names (built-ins + MCP) this agent may call. Baked into the conversation
   *  at creation time as an allow-list (spec: chat agents §1). */
  tools: string[]
}
/** A saved customization of a built-in agent (Customize → Agents "Edit" + Reset).
 *  Keyed by the built-in's fixed frontend id (e.g. 'default', 'code') — only the
 *  fields the user changed need be present; Reset deletes the entry, reverting to
 *  the frontend's hardcoded default. */
export type BuiltinAgentOverride = Partial<Pick<CustomChatAgent, 'name' | 'description' | 'systemPrompt' | 'skillIds' | 'tools'>>
/** One agent definition (spec 13 §2.1). Every agent — default, subagents, future
 *  write-capable coding agents — is an instance of this schema. */
export interface AgentType {
  id: string
  name: string
  description: string
  /** The agent's persona — its system prompt (spec 13 redesign §1.1). */
  systemPrompt?: string
  builtin?: boolean
  skills: string[]
  readRoots: string[]
  writeRoots: string[]
  callableAgents: string[]
  /** Tools this agent may NOT use (Pass D). Every tool — built-ins + MCP — is on by
   *  default; an id listed here is withheld. Empty/undefined = all tools available. */
  disabledTools?: string[]
  maxIterations?: number
}

/** Agents config block (spec 13 §2.1). Lives in config.json under `agents`. */
export interface AgentsConfig {
  agents: AgentType[]
}

/** Global model defaults (spec 05 §3): the base LoadProfile values applied when a
 *  model is first seen and has no saved per-model profile. Saved profiles and
 *  per-request overrides still take precedence; these only replace the built-in
 *  heuristics for the listed fields. */
export interface ModelDefaults {
  ctx: number
  ngl: number
  imageMaxTokens?: number
  /** Hard cap on tokens generated per response (0 = unlimited). Applied to in-app
   *  chat and clamped onto external gateway requests so nothing on this machine can
   *  exceed it. */
  maxTokens?: number
}
/** TRANSITIONAL (A1/A2): carries the model path + extra args until the
 *  model/profile system (spec 05, A4) replaces it. */
export interface DevModel {
  modelPath: string
  extraArgs: string[]
  label: string
}
/** One engine's saved profile for a model (issue #35), timestamped so
 *  {@link getModelProfile} can fall back to whichever engine's profile was saved most
 *  recently when the requested engine has none of its own. */
export interface ProfileEntry {
  profile: unknown
  updatedAt: string
}
/** A named saved load-config for a model (ADR-353). Many per modelKey, versus the single
 *  per-(model, engine) ProfileEntry in Config.modelProfiles. `profile` is `unknown`
 *  deliberately: config.ts must not import LoadProfile from models/profile.ts, which imports
 *  from this file. Consumers cast, exactly as every ProfileEntry.profile call site does. */
export interface ModelPreset {
  id: string
  name: string
  /** Engine this preset was tuned on; '' = any engine. */
  engineId: string
  profile: unknown
  updatedAt: string
  origin: 'manual' | 'autotune'
  /** tok/s measured by the auto-tune run that minted this (origin === 'autotune'). */
  benchTps?: number
}
export interface Config {
  version: number
  daemon: Daemon
  telemetry: Telemetry
  apiKeys: ApiKey[]
  engines: Engine[]
  /** Custom (non-catalog) engine identities, kept across Disable — see {@link CustomEngineSource}. */
  customEngineSources: CustomEngineSource[]
  activeEngineId: string
  modelDirs: string[]
  /** The folder downloads/imports land in (spec 01 §3, ADR-035). When '' or not in
   *  modelDirs, the FIRST entry in modelDirs is the effective default. */
  primaryModelDir: string
  /** Saved per-model LoadProfiles, nested by (modelKey → engineId → {@link ProfileEntry})
   *  so two installed engines (even two builds of the same kind, e.g. llama.cpp CUDA vs
   *  Vulkan, each with its own {@link Engine.id}) keep independent tunes for the same
   *  model (issue #35). There's no fixed "default engine" to fall back to — the codebase
   *  has no reliable way to tell mainline llama.cpp apart from a fork like ik_llama.cpp or
   *  TurboQuant (both share `kind: 'llama-server'`) — so {@link getModelProfile} instead
   *  falls back to whichever engine's profile for the model was saved most recently
   *  (each entry carries its own `updatedAt`). The v2→v3 migration wraps each old flat
   *  profile into a single entry under the reserved engineId `'*'` (see {@link normalize}).
   *  `profile` values are still `unknown` (validated/shaped elsewhere as {@link LoadProfile}). */
  modelProfiles: Record<string, Record<string, ProfileEntry>>
  /** Named model load presets (ADR-353): modelKey → presets. Complements modelProfiles, which
   *  stays, keeps being written, and remains the fallback — zero presets ⇒ behaviour identical
   *  to pre-feature. Seeded from modelProfiles on load; accumulates as auto-tune mints. */
  modelPresets: Record<string, ModelPreset[]>
  /** Pinned preset per model (ADR-353 D4): modelKey → preset id. Cleared by a manual profile
   *  save, a profile reset, and deleting the pinned preset. */
  lastPresetId: Record<string, string>
  /** Persisted auto-tune results keyed by modelKey (spec 09 §1, 01 §4). Additive;
   *  absent in old configs → normalize seeds {}. Never throws on load. */
  benchResults: Record<string, BenchResult>
  /** VRAM to keep free during auto-tune's offload search (MB), so a later desktop /
   *  ComfyUI VRAM grab can't tip the chosen config into a sysmem spill (bench.ts's
   *  `overHeadroom`). User-configurable via a Settings slider,
   *  {@link VRAM_HEADROOM_MIN_MB}–{@link VRAM_HEADROOM_MAX_MB}, default
   *  {@link VRAM_HEADROOM_DEFAULT_MB} — OR the {@link VRAM_HEADROOM_SPILL_MB} sentinel (0), an
   *  explicit opt-in to let auto-tune's MoE hill-climb spill past all headroom for more t/s.
   *  Absent in pre-this-feature configs → normalize seeds the default. */
  vramHeadroomMb: number
  lastLoaded: LastLoaded
  autoLoadOnStart: boolean
  hf: HF
  modelDefaults: ModelDefaults
  featuredOverrideUrl: string
  comfyui: ComfyUI
  gateway: Gateway
  tools: ToolsConfig
  mcp: McpConfig
  /** Agents + skills configuration (spec 13 §2.1). */
  agents: AgentsConfig
  /** User-created chat Agents (Customize → Agents) — separate from {@link agents}
   *  above (the background pi-agent-run schema). */
  customAgents: CustomChatAgent[]
  /** Per-built-in-agent customizations (Customize → Agents "Edit" + Reset). */
  builtinAgentOverrides: Record<string, BuiltinAgentOverride>
  /** Compile-from-source settings (ADR-089/100): toolchain dirs prepended to PATH. */
  build: BuildConfig
  /** Code's AGENTS.md-style standing-context candidate lists. */
  code: CodeConfig
  /** Cloud Launch deploy-link settings (ADR-153). */
  cloudDeploy: CloudDeployConfig
  devModel?: DevModel
  /** Onboarding progress (spec 25 §3, ADR-338). Absent on pre-v1.11 configs;
   *  `normalizeOnboarding` supplies the default, so no migration step is needed. */
  /** Persisted onboarding progress. Deliberately a loose structural shape rather than an import of
   *  `OnboardingState` — config.ts is the low-level store and must not depend on a feature module.
   *  The nulls are real: `profile` and `completedAt` are null until the user picks a profile and
   *  finishes, and `normalizeOnboarding` (onboarding/state.ts) re-validates whatever is read back,
   *  so a hand-edited config degrades to the safe default instead of failing a daemon boot. */
  onboarding?: {
    status?: string
    profile?: string | null
    completedAt?: number | null
    schemaVersion?: number
    everLoadedModel?: boolean
  }
}

export class ValueError extends Error {
  constructor(
    public field: string,
    msg: string,
  ) {
    super(`${field}: ${msg}`)
    this.name = 'ValueError'
  }
}

/** Pre-0.x location: the platform config dir (`%APPDATA%`, `~/Library/Application
 *  Support`, `~/.config`). Kept only so {@link migrateLegacyDataDir} can move old
 *  state into the canonical `~/.turbollm` dir. */
function legacyDataDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'turbollm')
}

/** Canonical data directory: `~/.turbollm` on every OS (one stable, discoverable
 *  home for config, chats, engines, caches — same model as `~/.ollama`). All
 *  daemon state lives here; a `--config` override redirects it elsewhere. */
export function defaultDataDir(): string {
  return join(homedir(), '.turbollm')
}

export function defaultConfigPath(): string {
  return join(defaultDataDir(), 'config.json')
}

/** One-time move of pre-0.x state from the platform config dir into `~/.turbollm`,
 *  so existing config/engines/chats/caches survive the relocation. No-op once the
 *  new dir exists, when there's nothing to migrate, or when the two coincide.
 *  Call ONLY for the default location — never when `--config` overrides the path. */
export function migrateLegacyDataDir(): void {
  const next = defaultDataDir()
  const prev = legacyDataDir()
  if (prev === next || existsSync(next) || !existsSync(prev)) return
  try {
    mkdirSync(dirname(next), { recursive: true })
    renameSync(prev, next) // same volume (both under the home tree) → atomic
  } catch {
    // Cross-device or a locked file (e.g. an old daemon still holding the DB):
    // fall back to a recursive copy and leave the legacy dir in place.
    try {
      cpSync(prev, next, { recursive: true })
    } catch {
      /* leave legacy state where it is; a fresh default config will be written */
      return
    }
  }
  // Engine binPaths are absolute and may point into the old data dir (managed
  // llama.cpp builds live under <dataDir>/engines/…). Repoint them at the new
  // location so they don't dangle after the move.
  try {
    const cfgPath = join(next, 'config.json')
    if (!existsSync(cfgPath)) return
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { engines?: { binPath?: string }[] }
    let changed = false
    for (const e of cfg.engines ?? []) {
      if (typeof e.binPath === 'string' && e.binPath.startsWith(prev)) {
        e.binPath = next + e.binPath.slice(prev.length)
        changed = true
      }
    }
    if (changed) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  } catch {
    /* best effort — a dangling managed build is pruned at startup anyway */
  }
}

export function defaultConfig(): Config {
  return {
    version: SCHEMA_VERSION,
    daemon: {
      host: '127.0.0.1',
      port: 6996,
      lanBind: false,
      requireApiKey: true,
      authToken: '',
      idleTtlMinutes: 60,
      openBrowserOnStart: true,
      theme: 'system',
      autoGenerateTitles: true,
      autoMemoryEnabled: false,
      experimental: { memory: false, cloudDeploy: false, routines: false },
    },
    telemetry: { level: 'full', machineId: '' },
    apiKeys: [],
    engines: [],
    customEngineSources: [],
    activeEngineId: '',
    modelDirs: [],
    primaryModelDir: '',
    modelProfiles: {},
    modelPresets: {},
    lastPresetId: {},
    benchResults: {},
    vramHeadroomMb: VRAM_HEADROOM_DEFAULT_MB,
    lastLoaded: { modelKey: '', engineId: '' },
    autoLoadOnStart: false,
    hf: { token: '' },
    modelDefaults: { ctx: 8192, ngl: 99, imageMaxTokens: 0, maxTokens: 0 },
    featuredOverrideUrl: '',
    comfyui: { enabled: false, gatePath: '', url: '', reverseGate: false, cachePersist: false },
    gateway: { autoSwap: true, keepN: 1 },
    tools: {},
    mcp: { servers: [] },
    agents: { agents: [] },
    customAgents: [],
    builtinAgentOverrides: {},
    build: { toolchainDirs: [] },
    code: { agentsMdProjectCandidates: ['AGENTS.md', 'agents.md', 'CLAUDE.md'], agentsMdGlobalCandidates: ['agents.md', 'AGENTS.md', 'CLAUDE.md'], defaultAgent: 'turbollm' },
    cloudDeploy: { runpodTemplateId: '' },
  }
}

export class ConfigStore {
  private constructor(
    private data: Config,
    private filePath: string,
    private brokenPath = '',
  ) {}

  static load(path: string): ConfigStore {
    if (!existsSync(path)) {
      const store = new ConfigStore(defaultConfig(), path)
      store.save()
      return store
    }
    let raw: Record<string, unknown>
    const text = readFileSync(path, 'utf8')
    try {
      raw = JSON.parse(text) as Record<string, unknown>
    } catch {
      const backup = `${path}.broken-${Math.floor(Date.now() / 1000)}`
      writeFileSync(backup, text)
      const store = new ConfigStore(defaultConfig(), path, backup)
      store.save()
      return store
    }
    const version = typeof raw.version === 'number' ? raw.version : 0
    const cfg = version < SCHEMA_VERSION ? migrate(raw, version) : (raw as unknown as Config)
    normalize(cfg)
    const store = new ConfigStore(cfg, path)
    store.save() // persist migration/normalization
    return store
  }

  snapshot(): Config {
    return structuredClone(this.data)
  }

  /** Mutate the config under one synchronous call, then validate + persist. */
  update(fn: (c: Config) => void): void {
    const work = structuredClone(this.data)
    fn(work)
    validate(work)
    this.data = work
    this.save()
  }

  dir(): string {
    return dirname(this.filePath)
  }
  path(): string {
    return this.filePath
  }
  brokenBackup(): string {
    return this.brokenPath
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.filePath) // libuv MoveFileEx replaces on Windows
  }
}

// ---- migration & validation ---------------------------------------------

function migrate(raw: Record<string, unknown>, from: number): Config {
  const cfg = defaultConfig()
  if (typeof raw.host === 'string') cfg.daemon.host = raw.host
  if (typeof raw.port === 'number') cfg.daemon.port = raw.port

  const old = raw.engine as { name?: string; binPath?: string; args?: string[] } | undefined
  if (old?.binPath) {
    const eng: Engine = {
      id: randomUUID(),
      name: old.name || 'llama-server',
      binPath: old.binPath,
      kind: 'llama-server',
      version: '',
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    cfg.engines.push(eng)
    cfg.activeEngineId = eng.id
    const { modelPath, extra } = splitLaunchArgs(old.args || [])
    if (modelPath) cfg.devModel = { modelPath, extraArgs: extra, label: old.name || '' }
  }
  cfg.version = SCHEMA_VERSION
  // Carry EVERY top-level key from the old file forward — both unknown keys (ride-along)
  // and known ones (engines/apiKeys/modelProfiles/benchResults/modelDirs/lastLoaded/…).
  // Copying known keys too is required now that this runs for v2→v3 (issue #35): the
  // ancient pre-v1 path only special-cases the legacy engine/host/port keys, so for a
  // v2 config the rest of migrate() is a no-op and dropping known keys here would wipe
  // real user data. normalize() reseats/validates each field afterward (including the
  // shape migration of modelProfiles), so an old value simply gets normalized in place.
  for (const [k, v] of Object.entries(raw)) {
    if (k !== 'engine' && k !== 'host' && k !== 'port' && k !== 'version') {
      ;(cfg as unknown as Record<string, unknown>)[k] = v
    }
  }
  // v3→v4 (ADR-299, revised by the ADR-299-Decision-4 supersession on 2026-08-01): every
  // pre-existing config already has telemetry.level stored as 'off', because
  // normalizeTelemetryLevel() has coerced any missing/legacy value to 'off' since
  // ADR-041 — and TELEMETRY_UI_ENABLED was false for this product's ENTIRE life until
  // ADR-299 shipped, so no human could ever have chosen 'off' through the UI. That makes
  // it a synthetic default, not a real choice, so it is bumped to the new default ('full')
  // rather than left stuck opted-out forever with no consent card left to ever ask.
  // Gated on `_from < 4` (not merely "this is inside migrate()") so a future, unrelated
  // v4→v5 migration cannot re-fire this and overwrite a REAL 'off' choice a user makes
  // after this release.
  if (from < 4 && cfg.telemetry.level === 'off') cfg.telemetry.level = 'full'
  return cfg
}

/** Extract the model path (after -m/--model) and the remaining args minus the
 *  flags the manager injects itself. */
export function splitLaunchArgs(args: string[]): { modelPath: string; extra: string[] } {
  let modelPath = ''
  const extra: string[] = []
  let skipNext = false
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const a = args[i]
    if (a === '-m' || a === '--model') {
      modelPath = args[i + 1] ?? ''
      skipNext = true
    } else if (a === '--host' || a === '--port') {
      skipNext = true
    } else if (a === '--metrics' || a === '--no-webui') {
      // manager injects these; drop
    } else {
      extra.push(a)
    }
  }
  return { modelPath, extra }
}

function normalize(c: Config): void {
  const d = defaultConfig()
  c.daemon = { ...d.daemon, ...(c.daemon ?? {}) }
  c.telemetry = { ...d.telemetry, ...(c.telemetry ?? {}) }
  c.hf = { ...d.hf, ...(c.hf ?? {}) }
  // Missing in pre-modelDefaults config files → fall back to the built-in defaults
  // (treat absent as defaults; never throw on an old file).
  c.modelDefaults = { ...d.modelDefaults, ...(c.modelDefaults ?? {}) }
  c.lastLoaded = { ...d.lastLoaded, ...(c.lastLoaded ?? {}) }
  c.apiKeys ??= []
  c.engines ??= []
  c.customEngineSources ??= []
  c.modelDirs ??= []
  // Primary model dir (spec 01 §3, ADR-035): absent in old files → '' (effective
  // default falls back to the first modelDir). Never throw on an old config.
  c.primaryModelDir ??= ''
  // Per-engine model profiles (issue #35, schema v3): modelProfiles moved from a flat
  // { modelKey → profile } map to a nested { modelKey → { engineId → ProfileEntry } } map
  // so two installed engines keep independent tunes for the same model. Migrate in place,
  // shape-based and idempotent (runs every load; must not double-wrap an already-nested
  // value). Discriminator: a v2 flat profile is a LoadProfile, which always carries a
  // numeric `ctx` at its top level; a v3 nested map is keyed by engineId (UUID or the
  // reserved '*'), whose VALUES are {@link ProfileEntry} wrappers — so the map itself
  // never has a top-level numeric `ctx`. Old profiles are wrapped into a single entry
  // under the reserved fallback key '*', timestamped at migration time — this is fine
  // even though it's an approximation of "when it was really last used": it's the only
  // entry that exists yet, so it's trivially the most recent, and any future per-engine
  // save (necessarily later) naturally outranks it via getModelProfile's fallback.
  c.modelProfiles ??= {}
  for (const [modelKey, val] of Object.entries(c.modelProfiles)) {
    if (val && typeof val === 'object' && typeof (val as { ctx?: unknown }).ctx === 'number') {
      c.modelProfiles[modelKey] = { '*': { profile: val, updatedAt: new Date().toISOString() } }
    }
  }
  // Seed modelPresets from modelProfiles (ADR-353): a model with saved profile slots but no
  // presets yet gets one preset per engine slot, so an upgrade never loses the user's tunes.
  // Idempotent — a present array (EVEN AN EMPTY ONE) means "already seeded", so this never
  // re-mints. modelProfiles is only READ here: never deleted, never modified.
  c.modelPresets ??= {}
  for (const [modelKey, byEngineRaw] of Object.entries(c.modelProfiles)) {
    if (Array.isArray((c.modelPresets as Record<string, unknown>)[modelKey])) continue
    if (!byEngineRaw || typeof byEngineRaw !== 'object') continue
    const entries = Object.entries(byEngineRaw as Record<string, ProfileEntry>).filter(
      ([, e]) => !!e && typeof e === 'object' && typeof e.updatedAt === 'string' && e.profile !== undefined,
    )
    if (entries.length === 0) continue
    // Naming. One slot → "Saved". Several → qualify each one so they can be told apart in the
    // dropdown, because a list of "Saved", "Saved (2)", "Saved (3)" is useless for choosing:
    //   - engine still installed → "Saved (<engine name>)", using Engine.name VERBATIM (it is a
    //     full build label — do not prettify).
    //   - reserved ANY_ENGINE slot, or an engine since UNINSTALLED → fall back to the profile's
    //     own save date, "Saved (YYYY-MM-DD)". A date is what the user actually has to go on
    //     once the engine that produced it is gone; an engine id would be noise. Uninstalled
    //     engines are the COMMON case on a machine that churns through builds, not an edge case.
    //   - anything still colliding after that (two slots saved the same day) → " (2)", " (3)"…
    const seen = new Map<string, number>()
    c.modelPresets[modelKey] = entries.map(([engineId, entry]) => {
      const engine = engineId === ANY_ENGINE ? undefined : c.engines.find((e) => e.id === engineId)
      const qualifier = engine ? engine.name : entry.updatedAt.slice(0, 10)
      const base = entries.length === 1 ? 'Saved' : `Saved (${qualifier})`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return {
        id: randomUUID(),
        name: n > 1 ? `${base} (${n})` : base,
        engineId: engineId === ANY_ENGINE ? '' : engineId,
        profile: entry.profile,
        updatedAt: entry.updatedAt,
        origin: 'manual' as const,
      }
    })
  }
  // Persisted auto-tune results (spec 09 §1): absent in pre-bench configs → {}.
  c.benchResults ??= {}
  // VRAM headroom slider: absent/garbage (pre-feature config, or a stale out-of-range
  // value) → the default, never thrown on load — mirrors the gateway.keepN clamp below.
  // VRAM_HEADROOM_SPILL_MB (0) is a valid, distinct value — the explicit "allow spill" opt-in —
  // not an out-of-range value to normalize away.
  c.vramHeadroomMb =
    typeof c.vramHeadroomMb === 'number' &&
    (c.vramHeadroomMb === VRAM_HEADROOM_SPILL_MB || (c.vramHeadroomMb >= VRAM_HEADROOM_MIN_MB && c.vramHeadroomMb <= VRAM_HEADROOM_MAX_MB))
      ? c.vramHeadroomMb
      : VRAM_HEADROOM_DEFAULT_MB
  c.autoLoadOnStart ??= false
  c.featuredOverrideUrl ??= ''
  // ComfyUI coordination (absent in pre-comfyui configs → defaults; never throw on an
  // old file). Reseat only the known fields so the retired url/pollSeconds keys from
  // the earlier polling design don't linger on disk.
  const cu = (c.comfyui ?? {}) as Partial<ComfyUI>
  c.comfyui = {
    enabled: !!cu.enabled,
    gatePath: typeof cu.gatePath === 'string' ? cu.gatePath : '',
    // Reverse gate (F-011): ComfyUI origin + opt-in toggle. Absent in pre-F-011 configs
    // → '' / false. Reseated here (like the other known fields) so they aren't dropped.
    url: typeof cu.url === 'string' ? cu.url : '',
    reverseGate: !!cu.reverseGate,
    // KV prompt-cache persistence (F-014): opt-in. Absent in pre-F-014 configs → false.
    // Reseated like the other known fields so it isn't dropped on every load.
    cachePersist: !!cu.cachePersist,
  }
  // Gateway intelligence (v0.6.0): absent in pre-v0.6.0 configs → defaults; never throw.
  const gw = (c.gateway ?? {}) as Partial<Gateway>
  c.gateway = {
    autoSwap: gw.autoSwap !== false,
    keepN: typeof gw.keepN === 'number' && gw.keepN >= 1 ? Math.min(Math.floor(gw.keepN), 4) : 1,
  }
  // Built-in tools (v0.7.0): absent in pre-v0.7.0 configs → empty defaults.
  const tl = (c.tools ?? {}) as Partial<ToolsConfig>
  c.tools = {}
  if (tl.tavily && typeof tl.tavily.apiKey === 'string') {
    c.tools.tavily = { apiKey: tl.tavily.apiKey }
  }
  // Search provider (F-020): absent in pre-F-020 configs → default 'tavily', migrating any
  // legacy tavily.apiKey into search.tavilyApiKey so existing keys keep working.
  const sl = (tl.search ?? {}) as Partial<SearchConfig>
  const provider: SearchProvider =
    sl.provider === 'kagi' || sl.provider === 'searxng' ? sl.provider : 'tavily'
  c.tools.search = {
    provider,
    tavilyApiKey: sl.tavilyApiKey ?? c.tools.tavily?.apiKey ?? undefined,
    kagiApiKey: sl.kagiApiKey ?? undefined,
    searxngUrl: typeof sl.searxngUrl === 'string' && sl.searxngUrl.trim() ? sl.searxngUrl.trim() : undefined,
  }
  // Tool approval-gate policies (replaces the old F-019 requireRunCodeConfirmation stub):
  // always a plain object; strip any invalid values rather than crash on a garbled config.
  const rawPolicies = (tl.toolPolicies ?? {}) as Record<string, unknown>
  const toolPolicies: Record<string, 'ask' | 'allow' | 'deny'> = {}
  for (const [toolName, v] of Object.entries(rawPolicies)) {
    if (v === 'ask' || v === 'allow' || v === 'deny') toolPolicies[toolName] = v
  }
  // Migration: users who had explicitly disabled the old run_code confirmation
  // (requireRunCodeConfirmation === false) get that intent preserved as an explicit
  // 'allow' policy for run_code — but only if they haven't already set one via the
  // new toolPolicies map. Everyone else falls through to the new 'ask' default, which
  // is a strict improvement over the old permanently-broken confirmation stub.
  const legacyRequireRunCodeConfirmation = (tl as Record<string, unknown>).requireRunCodeConfirmation
  if (legacyRequireRunCodeConfirmation === false && toolPolicies.run_code === undefined) {
    toolPolicies.run_code = 'allow'
  }
  c.tools.toolPolicies = toolPolicies
  c.tools.autoAllowAll = tl.autoAllowAll === true
  // MCP host (v0.7.0): absent in pre-v0.7.0 configs → empty server list.
  const mc = (c.mcp ?? {}) as Partial<McpConfig>
  c.mcp = {
    servers: Array.isArray(mc.servers)
      ? mc.servers.filter((s): s is McpServer =>
          typeof s === 'object' && s !== null &&
          typeof s.id === 'string' && typeof s.name === 'string' &&
          (s.transport === 'stdio' || s.transport === 'sse'))
      : [],
  }
  // Agents config (spec 13 §2.1): absent in pre-agent configs → seed the default agent.
  if (!c.agents || !Array.isArray(c.agents.agents) || c.agents.agents.length === 0) {
    const dataDir = join(homedir(), '.turbollm')
    c.agents = {
      agents: [{
        id: 'default',
        name: 'Default Agent',
        description: 'Full capabilities — all skills, reads its workspace, writes its own config dir.',
        builtin: true,
        skills: ['*'],
        readRoots: [dataDir],
        writeRoots: [dataDir],
        callableAgents: ['*'],
        maxIterations: 30,
      }],
    }
  } else {
    // Ensure the builtin default exists; don't create a second one.
    if (!c.agents.agents.some(a => a.builtin)) {
      const dataDir = join(homedir(), '.turbollm')
      c.agents.agents.unshift({
        id: 'default',
        name: 'Default Agent',
        description: 'Full capabilities — all skills, reads its workspace, writes its own config dir.',
        builtin: true,
        skills: ['*'],
        readRoots: [dataDir],
        writeRoots: [dataDir],
        callableAgents: ['*'],
        maxIterations: 30,
      })
    }
  }
  // Custom chat agents (Customize → Agents): absent in pre-feature configs → [].
  // Filter to well-shaped entries rather than throwing on a garbled config.
  c.customAgents = Array.isArray(c.customAgents)
    ? c.customAgents.filter((a): a is CustomChatAgent =>
        !!a && typeof a === 'object' &&
        typeof (a as CustomChatAgent).id === 'string' && typeof (a as CustomChatAgent).name === 'string')
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: typeof a.description === 'string' ? a.description : '',
        systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : '',
        skillIds: Array.isArray(a.skillIds) ? a.skillIds.filter((s): s is string => typeof s === 'string') : [],
        tools: Array.isArray(a.tools) ? a.tools.filter((t): t is string => typeof t === 'string') : [],
      }))
    : []
  // Model load presets (ADR-353): absent in pre-feature configs → {}. Defensively filter to
  // well-shaped entries rather than throwing on a hand-edited config. Arrays are KEPT even when
  // they filter down to EMPTY — a present-but-empty array means "already seeded" to the seed
  // migration, and dropping the key would resurrect deleted presets on the next load.
  c.modelPresets ??= {}
  const cleanedPresets: Record<string, ModelPreset[]> = {}
  for (const [modelKey, rawArr] of Object.entries(c.modelPresets as Record<string, unknown>)) {
    if (!Array.isArray(rawArr)) continue
    cleanedPresets[modelKey] = rawArr
      .filter((p): p is ModelPreset =>
        !!p && typeof p === 'object' &&
        typeof (p as ModelPreset).id === 'string' && typeof (p as ModelPreset).name === 'string' &&
        typeof (p as ModelPreset).engineId === 'string' &&
        typeof (p as ModelPreset).updatedAt === 'string' &&
        ((p as ModelPreset).origin === 'manual' || (p as ModelPreset).origin === 'autotune'))
      .map((p) => ({
        id: p.id,
        name: p.name,
        engineId: p.engineId,
        profile: p.profile,
        updatedAt: p.updatedAt,
        origin: p.origin,
        ...(typeof p.benchTps === 'number' && Number.isFinite(p.benchTps) ? { benchTps: p.benchTps } : {}),
      }))
  }
  c.modelPresets = cleanedPresets
  // Pins: keep only those that still resolve to a surviving preset of the same model.
  c.lastPresetId ??= {}
  const cleanedPins: Record<string, string> = {}
  for (const [modelKey, pin] of Object.entries(c.lastPresetId as Record<string, unknown>)) {
    if (typeof pin !== 'string' || !pin) continue
    if (!(cleanedPresets[modelKey] ?? []).some((p) => p.id === pin)) continue
    cleanedPins[modelKey] = pin
  }
  c.lastPresetId = cleanedPins
  // Built-in agent overrides (Customize → Agents "Edit" + Reset): absent in
  // pre-feature configs → {}. Filter to well-shaped entries.
  const rawOverrides = (c.builtinAgentOverrides ?? {}) as Record<string, unknown>
  const builtinAgentOverrides: Record<string, BuiltinAgentOverride> = {}
  for (const [id, v] of Object.entries(rawOverrides)) {
    if (!v || typeof v !== 'object') continue
    const o = v as Partial<BuiltinAgentOverride>
    const clean: BuiltinAgentOverride = {}
    if (typeof o.name === 'string') clean.name = o.name
    if (typeof o.description === 'string') clean.description = o.description
    if (typeof o.systemPrompt === 'string') clean.systemPrompt = o.systemPrompt
    if (Array.isArray(o.skillIds)) clean.skillIds = o.skillIds.filter((s): s is string => typeof s === 'string')
    if (Array.isArray(o.tools)) clean.tools = o.tools.filter((t): t is string => typeof t === 'string')
    if (Object.keys(clean).length) builtinAgentOverrides[id] = clean
  }
  c.builtinAgentOverrides = builtinAgentOverrides
  // Compile-from-source toolchain dirs (ADR-089/100): absent in pre-build configs → [].
  // Keep only non-empty strings; the validator enforces absolute paths.
  const bd = (c.build ?? {}) as Partial<BuildConfig>
  c.build = {
    toolchainDirs: Array.isArray(bd.toolchainDirs)
      ? bd.toolchainDirs.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
      : [],
  }
  // AGENTS.md candidate lists: absent/empty in pre-this-decision configs → the real defaults
  // (NOT []), so a fresh/upgraded config resolves standing context exactly like the old hardcoded
  // 'AGENTS.md'/'agents.md' literals did, plus CLAUDE.md. The validator enforces relative paths.
  const cc = (c.code ?? {}) as Partial<CodeConfig>
  const cleanCandidates = (v: unknown, fallback: string[]): string[] => {
    const filtered = Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()) : []
    return filtered.length > 0 ? filtered : fallback
  }
  const ALLOWED_AGENTS = new Set(['turbollm', 'pi', 'claude', 'opencode'])
  c.code = {
    agentsMdProjectCandidates: cleanCandidates(cc.agentsMdProjectCandidates, ['AGENTS.md', 'agents.md', 'CLAUDE.md']),
    agentsMdGlobalCandidates: cleanCandidates(cc.agentsMdGlobalCandidates, ['agents.md', 'AGENTS.md', 'CLAUDE.md']),
    // Unrecognized/absent → 'turbollm' (the built-in chat UI), never a silently-broken terminal launch.
    defaultAgent: ALLOWED_AGENTS.has(cc.defaultAgent as string) ? (cc.defaultAgent as CodeConfig['defaultAgent']) : 'turbollm',
  }
  // Cloud Launch deploy-link settings (ADR-153): absent in pre-ADR-153 configs → ''.
  const cd = (c.cloudDeploy ?? {}) as Partial<CloudDeployConfig>
  c.cloudDeploy = { runpodTemplateId: typeof cd.runpodTemplateId === 'string' ? cd.runpodTemplateId.trim() : '' }
  // Experimental feature flags (2026-07-14): absent in pre-this-decision configs → default
  // false for cloudDeploy, same conservative posture as lanBind. `memory` is the one
  // exception: a config that ALREADY had autoMemoryEnabled=true (the user had genuinely opted
  // in before this gate existed) migrates to memory=true too, so the section they were already
  // using doesn't silently vanish from Settings → General the moment they upgrade — a config
  // that never turned it on gets memory=false, the same conservative default as everything else.
  // `code` was removed from this shape entirely (ADR-280) when Code graduated out of
  // experimental status — an old config's stale `experimental.code` value (if any survives in
  // an on-disk config.json from before this change) is simply dropped here, not migrated,
  // since there's no longer a field for it to migrate into.
  // `routines` (2026-08-04): unlike `memory`, Routines never shipped to any install outside this
  // gate, so there is no pre-existing "already opted in" signal to migrate forward — every config,
  // new or upgraded, defaults to false until a human flips it on in Settings → Experimental.
  const ex = (c.daemon.experimental ?? {}) as Partial<ExperimentalFeatures>
  c.daemon.experimental = {
    memory: ex.memory === true || c.daemon.autoMemoryEnabled === true,
    cloudDeploy: ex.cloudDeploy === true,
    routines: ex.routines === true,
  }
  // Telemetry level (spec 09 §3): the UI exposes 'off' | 'anon' | 'full'. Migrate
  // legacy/unknown values safely → 'off' (the conservative, opt-in default).
  c.telemetry.level = normalizeTelemetryLevel(c.telemetry.level)
  for (const e of c.engines) {
    e.capabilities ??= { kvTypes: [], flags: [] }
    e.capabilities.kvTypes ??= []
    e.capabilities.flags ??= []
    // Per-engine auto-update policy (ADR-085): absent/garbage in pre-Phase-6 configs
    // → 'notify' (the safe default — surface updates, never silently auto-apply).
    e.updatePolicy = e.updatePolicy === 'off' || e.updatePolicy === 'auto' ? e.updatePolicy : 'notify'
  }
  if (c.activeEngineId && !c.engines.some((e) => e.id === c.activeEngineId)) c.activeEngineId = ''
  if (!c.activeEngineId && c.engines.length > 0) c.activeEngineId = c.engines[0].id
  // A primary that no longer exists in modelDirs (folder removed/renamed) falls
  // back to the effective default (first dir) — reset rather than throw.
  if (c.primaryModelDir && !c.modelDirs.includes(c.primaryModelDir)) c.primaryModelDir = ''
  c.version = SCHEMA_VERSION
}

/** Telemetry consent levels exposed in the UI (spec 09 §3). */
export type TelemetryLevel = 'off' | 'anon' | 'full'

/** Coerce a stored telemetry level to a known value. Migrates the legacy 'benchmarks'
 *  label → 'anon'. Missing/absent (`undefined`) and the retired first-run sentinel 'unset'
 *  (no longer written anywhere since the consent card was removed — ADR-299 Decision 4
 *  superseded 2026-08-01) are KNOWN "no real choice was ever made" states → 'full', the new
 *  default posture. Anything else unrecognized (corrupted JSON, an unexpected type, a value
 *  from a future/foreign schema) fails CLOSED to 'off' instead — this field controls how much
 *  leaves the machine, so garbage input must never silently escalate to maximum sharing
 *  (found in the release-2 review: the original one-line catch-all `return 'full'` did exactly
 *  that). Never throws either way (fail-safe on old/garbage config). */
function normalizeTelemetryLevel(level: unknown): string {
  if (level === 'off' || level === 'anon' || level === 'full') return level
  if (level === 'benchmarks' || level === 'anonymous') return 'anon' // legacy spec label
  if (level === undefined || level === null || level === 'unset') return 'full'
  return 'off'
}

function validate(c: Config): void {
  if (c.daemon.port < 1024 || c.daemon.port > 65535) {
    throw new ValueError('daemon.port', 'port must be 1024–65535')
  }
  for (const dir of c.modelDirs) {
    if (!isAbsolutePath(dir)) throw new ValueError('modelDirs', 'model directories must be absolute paths')
  }
  if (c.activeEngineId && !c.engines.some((e) => e.id === c.activeEngineId)) {
    throw new ValueError('activeEngineId', 'unknown engine id')
  }
  if (c.vramHeadroomMb !== VRAM_HEADROOM_SPILL_MB && (c.vramHeadroomMb < VRAM_HEADROOM_MIN_MB || c.vramHeadroomMb > VRAM_HEADROOM_MAX_MB)) {
    throw new ValueError('vramHeadroomMb', `must be ${VRAM_HEADROOM_SPILL_MB} (allow VRAM spill) or between ${VRAM_HEADROOM_MIN_MB} and ${VRAM_HEADROOM_MAX_MB} MB`)
  }
  // ComfyUI reverse-gate origin (F-011): empty is allowed (reverse gate just stays off);
  // if set, it must be an http(s):// origin so the `POST {url}/free` call is well-formed.
  if (c.comfyui.url && !/^https?:\/\//i.test(c.comfyui.url)) {
    throw new ValueError('comfyui.url', 'must be an http(s):// origin (e.g. http://127.0.0.1:8188)')
  }
  // Build toolchain dirs (ADR-089/100): must be absolute so they resolve the same no
  // matter the daemon's cwd when it spawns git/cmake.
  for (const dir of c.build.toolchainDirs) {
    if (!isAbsolutePath(dir)) throw new ValueError('build.toolchainDirs', 'toolchain directories must be absolute paths')
  }
  // AGENTS.md candidates: the OPPOSITE constraint from toolchainDirs — must be RELATIVE (resolved
  // against a repo root / the global data dir, never an absolute host path), and capped short so a
  // pathological config can't turn every turn into dozens of stat() calls. This is a clean-400
  // convenience, not the real security boundary — persona.ts containment-checks each entry again
  // at read time regardless, since this config is hand-editable and bypasses this route entirely.
  const MAX_AGENTS_MD_CANDIDATES = 8
  for (const [field, list] of [['code.agentsMdProjectCandidates', c.code.agentsMdProjectCandidates], ['code.agentsMdGlobalCandidates', c.code.agentsMdGlobalCandidates]] as const) {
    if (list.length > MAX_AGENTS_MD_CANDIDATES) throw new ValueError(field, `at most ${MAX_AGENTS_MD_CANDIDATES} candidates`)
    for (const entry of list) {
      if (isAbsolutePath(entry)) throw new ValueError(field, 'candidates must be relative filenames/paths, not absolute')
    }
  }
  // Agents (spec 13 §2.1): enforce the schema invariants so a bad config can't widen
  // an agent's filesystem scope or break the run manager's lookups.
  validateAgents(c)
  validateCustomAgents(c)
  validateModelPresets(c)
}

/** Preset cap is PER MODEL — at most this many in any one modelKey's array. (customAgents is a
 *  flat list so its cap is global; modelPresets is a Record<string, ModelPreset[]>.) */
export const MODEL_PRESET_CAP = 50

function validateModelPresets(c: Config): void {
  for (const [modelKey, presets] of Object.entries(c.modelPresets)) {
    if (presets.length > MODEL_PRESET_CAP) {
      throw new ValueError('modelPresets', `preset limit reached (${MODEL_PRESET_CAP})`)
    }
    const ids = new Set<string>()
    for (const p of presets) {
      if (!p.id.trim()) throw new ValueError('modelPresets', `preset for model "${modelKey}" needs a non-empty id`)
      if (ids.has(p.id)) throw new ValueError('modelPresets', `duplicate preset id "${p.id}" for model "${modelKey}"`)
      ids.add(p.id)
      if (!p.name.trim()) throw new ValueError('modelPresets', `preset "${p.id}" for model "${modelKey}" needs a non-empty name`)
    }
  }
}

/** Retention for auto-tune-minted presets (ADR-353). Called by bench.ts right after pushing a
 *  freshly minted preset. Rules, in order:
 *    1. Keep the newest AUTOTUNE_PRESET_RETENTION unpinned `autotune` presets; prune older.
 *    2. Never prune `manual` presets — those are the user's own saves.
 *    3. Never prune the pinned preset.
 *    4. Cap fallback: if 1–3 still leave the array over the per-model cap, prune the OLDEST
 *       NON-PINNED preset of ANY origin, repeatedly. Rule 2 yields to the cap, because
 *       validate() throws on an over-cap config and would break every unrelated settings write.
 *  If the cap cannot be met without removing the pinned preset, it UNDOES the mint instead
 *  (drops the just-pushed last element and its pin), warns, and returns. Never throws. */
export const AUTOTUNE_PRESET_RETENTION = 10
export function prunePresets(cfg: Config, modelKey: string): void {
  const arr = cfg.modelPresets[modelKey]
  if (!Array.isArray(arr) || arr.length === 0) return
  const pinnedId = (cfg.lastPresetId ?? {})[modelKey]

  const byOldest = (a: ModelPreset, b: ModelPreset) =>
    a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0

  // Rules 1–3.
  const ranked = arr.filter((p) => p.origin === 'autotune' && p.id !== pinnedId).sort(byOldest)
  const excess = new Set(
    ranked.slice(0, Math.max(0, ranked.length - AUTOTUNE_PRESET_RETENTION)).map((p) => p.id),
  )
  let cur = excess.size === 0 ? arr : arr.filter((p) => !excess.has(p.id))

  // Rule 4. Note this can remove a MANUAL preset — a save the user made by hand — because an
  // over-cap array makes validate() throw and would then break every unrelated config write.
  // That trade is deliberate, but it must never be silent: losing your own saved config with no
  // feedback is worse than the log line being noisy.
  while (cur.length > MODEL_PRESET_CAP) {
    const candidates = cur.filter((p) => p.id !== pinnedId).sort(byOldest)
    if (candidates.length === 0) break
    const victim = candidates[0]
    if (victim.origin === 'manual') {
      console.warn(
        `[presets] model "${modelKey}" is at the ${MODEL_PRESET_CAP}-preset cap — deleting your oldest saved preset "${victim.name}" (${victim.updatedAt}) to make room. Delete some presets to stop this.`,
      )
    }
    cur = cur.filter((p) => p.id !== victim.id)
  }

  if (cur.length > MODEL_PRESET_CAP) {
    // Nothing removable — undo the mint rather than break the pin.
    if (arr[arr.length - 1].id === pinnedId) delete cfg.lastPresetId[modelKey]
    cfg.modelPresets[modelKey] = arr.slice(0, -1)
    console.warn(
      `[presets] model "${modelKey}" is at the ${MODEL_PRESET_CAP}-preset cap with nothing prunable — the auto-tune mint was skipped; the tuned profile was still saved`,
    )
    return
  }
  if (cur.length === arr.length) return
  cfg.modelPresets[modelKey] = cur
}

/** Custom chat agents (Customize → Agents): unique non-empty ids/names, capped list. */
const CUSTOM_AGENT_CAP = 50
function validateCustomAgents(c: Config): void {
  const ids = new Set<string>()
  for (const a of c.customAgents) {
    if (!a.id.trim()) throw new ValueError('customAgents', 'every agent needs a non-empty id')
    if (ids.has(a.id)) throw new ValueError('customAgents', `duplicate agent id "${a.id}"`)
    ids.add(a.id)
    if (!a.name.trim()) throw new ValueError('customAgents', `agent "${a.id}" needs a non-empty name`)
  }
  if (c.customAgents.length > CUSTOM_AGENT_CAP) {
    throw new ValueError('customAgents', `agent limit reached (${CUSTOM_AGENT_CAP})`)
  }
  if (Object.keys(c.builtinAgentOverrides).length > CUSTOM_AGENT_CAP) {
    throw new ValueError('builtinAgentOverrides', `override limit reached (${CUSTOM_AGENT_CAP})`)
  }
}

/** Validate the agents config block (spec 13 §2.1). Keeps the FS-scope invariant
 *  (write confined to ~/.turbollm in v1) and the structural guarantees the run
 *  manager + routes rely on (unique ids, exactly one builtin). */
function validateAgents(c: Config): void {
  const dataDir = join(homedir(), '.turbollm')
  const agents = c.agents?.agents ?? []
  const ids = new Set<string>()
  let builtins = 0
  for (const a of agents) {
    if (!a.id || typeof a.id !== 'string') throw new ValueError('agents', 'every agent needs a non-empty id')
    if (ids.has(a.id)) throw new ValueError('agents', `duplicate agent id "${a.id}"`)
    ids.add(a.id)
    if (!a.name || typeof a.name !== 'string' || !a.name.trim()) throw new ValueError('agents', `agent "${a.id}" needs a non-empty name`)
    if (a.builtin) builtins++
    if (!Array.isArray(a.skills)) throw new ValueError('agents', `agent "${a.id}" skills must be an array`)
    if (!Array.isArray(a.callableAgents)) throw new ValueError('agents', `agent "${a.id}" callableAgents must be an array`)
    for (const r of a.readRoots ?? []) {
      if (typeof r !== 'string' || (r !== '<dataDir>' && !isAbsolutePath(r))) {
        throw new ValueError('agents', `agent "${a.id}" readRoots must be absolute paths`)
      }
    }
    // Write scope is the security-sensitive one (v1 invariant: write only ~/.turbollm).
    // Reject any writeRoot that isn't absolute OR escapes the data dir.
    for (const r of a.writeRoots ?? []) {
      if (typeof r !== 'string' || (r !== '<dataDir>' && !isAbsolutePath(r))) {
        throw new ValueError('agents', `agent "${a.id}" writeRoots must be absolute paths`)
      }
      if (r !== '<dataDir>' && !isWithinDir(r, dataDir)) {
        throw new ValueError('agents', `agent "${a.id}" writeRoots must be within ${dataDir} (v1 invariant)`)
      }
    }
    if (a.maxIterations !== undefined) {
      if (!Number.isInteger(a.maxIterations) || a.maxIterations < 1 || a.maxIterations > 200) {
        throw new ValueError('agents', `agent "${a.id}" maxIterations must be an integer 1–200`)
      }
    }
  }
  if (agents.length > 0 && builtins !== 1) {
    throw new ValueError('agents', `exactly one builtin agent is required (found ${builtins})`)
  }
}

/** Path-containment check used by config validation (separate from the runtime
 *  fs-guard, which canonicalizes symlinks). Normalizes separators for comparison. */
function isWithinDir(p: string, dir: string): boolean {
  const norm = (s: string) => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const np = norm(p)
  const nd = norm(dir)
  return np === nd || np.startsWith(nd + '/')
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

export function findEngine(engines: Engine[], id: string): Engine | undefined {
  return engines.find((e) => e.id === id)
}

/** Reserved engineId the v2→v3 migration parks every pre-existing flat profile under
 *  (issue #35). Not otherwise special — it's just one more entry in the per-model map,
 *  and only wins in {@link getModelProfile} when it happens to be the most recent (or
 *  only) one; a fresher per-engine save on any real engine outranks it. */
export const ANY_ENGINE = '*'

/** Resolve a model's saved profile for a specific installed engine (issue #35). Returns
 *  that engine's own profile if one exists; otherwise falls back to whichever engine's
 *  profile for this model was saved most recently (there's no fixed "default engine" to
 *  fall back to — mainline llama.cpp and forks like ik_llama.cpp/TurboQuant are
 *  indistinguishable in this codebase, both `kind: 'llama-server'` — so "last used" is
 *  the simplest fallback that doesn't require identifying any engine specially). Returns
 *  undefined if the model has no saved profile on any engine. The single read seam every
 *  caller routes through instead of indexing `cfg.modelProfiles[key]` directly. */
export function getModelProfile(cfg: Config, modelKey: string, engineId: string): unknown {
  // Pinned preset (ADR-353 D4) outranks the saved per-engine profiles — but ONLY when its
  // engine matches. The engine check is load-bearing: engines keep independent tunes per model
  // (issue #35), so a preset tuned on ONE engine must not shadow another engine's profile —
  // auto-tune seeds its search from this function and needs "this engine's own" profile.
  // A pin pointing at a deleted preset, or at a preset for another engine, falls straight
  // through to the logic below. `?? {}` guards hand-built Configs that skip normalize().
  const pinnedId = (cfg.lastPresetId ?? {})[modelKey]
  if (pinnedId) {
    const pinned = (cfg.modelPresets ?? {})[modelKey]?.find((p) => p.id === pinnedId)
    if (pinned && (pinned.engineId === '' || pinned.engineId === engineId)) return pinned.profile
  }
  const byEngine = cfg.modelProfiles[modelKey]
  if (!byEngine) return undefined
  const exact = byEngine[engineId]
  if (exact) return exact.profile
  // `>=` (not `>`): object key insertion order matches save order, so on an exact
  // millisecond tie (two rapid-fire saves) the later-inserted entry — the truly more
  // recent one — wins instead of whichever key happened to iterate first.
  let mostRecent: ProfileEntry | undefined
  for (const entry of Object.values(byEngine)) {
    if (!mostRecent || entry.updatedAt >= mostRecent.updatedAt) mostRecent = entry
  }
  return mostRecent?.profile
}

/** Write a model's saved profile into one engine's slot only (issue #35), stamped with
 *  the current time so {@link getModelProfile}'s "last used" fallback can compare across
 *  engines. Creates the per-model map if absent; never touches other engines' profiles
 *  for the same model. */
export function setModelProfile(cfg: Config, modelKey: string, engineId: string, profile: unknown): void {
  ;(cfg.modelProfiles[modelKey] ??= {})[engineId] = { profile, updatedAt: new Date().toISOString() }
}

/** Delete a model's saved profile for one engine only (issue #35). Prunes the per-model
 *  map when its last slot is removed so `hasProfile`-style emptiness checks stay accurate. */
export function deleteModelProfile(cfg: Config, modelKey: string, engineId: string): void {
  const byEngine = cfg.modelProfiles[modelKey]
  if (!byEngine) return
  delete byEngine[engineId]
  if (Object.keys(byEngine).length === 0) delete cfg.modelProfiles[modelKey]
}

/** Apply the global "max response tokens" cap. `limit <= 0` means unlimited (return
 *  the request's own value untouched). Otherwise return the smaller of the requested
 *  value and the limit; when the request set no value, fall back to the limit. */
export function clampMaxTokens(requested: number | null | undefined, limit: number): number | undefined {
  if (!Number.isFinite(limit) || limit <= 0) return requested ?? undefined
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return limit
  return Math.min(requested, limit)
}
