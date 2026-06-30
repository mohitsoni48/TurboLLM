// Config load/save/migrate (spec 01). Ports the verified Go implementation to
// TypeScript. Single-threaded event loop => config.update() is atomic per call,
// so no locking is needed. Unknown JSON fields ride along on `data` and are
// preserved across round-trips for free.
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SCHEMA_VERSION = 3

/** VRAM headroom slider bounds (MB) for auto-tune's spill-safety margin (see
 *  {@link Config.vramHeadroomMb} and `bench.ts`'s `overHeadroom`). */
export const VRAM_HEADROOM_MIN_MB = 300
export const VRAM_HEADROOM_MAX_MB = 2048
export const VRAM_HEADROOM_DEFAULT_MB = 1024

export interface Capabilities {
  kvTypes: string[]
  flags: string[]
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
  params: { ctx: number; ngl: number; nCpuMoe: number; parallel: number; kvTypeK: string; flashAttn: string }
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
/** Cloud Launch deploy-link settings (ADR-153, RunPod recipe). RunPod is the only
 *  provider for now — a user who has published their own RunPod Template (following
 *  deploy/runpod/README.md) pastes its ID here; the Developer screen's "Deploy on
 *  RunPod" button just constructs and opens RunPod's own one-click deploy link with
 *  it. No credentials involved — full API-driven auto-provisioning is a separate,
 *  bigger, not-yet-built feature (the BYO-cloud orchestration line, ADR-003). */
export interface CloudDeployConfig {
  runpodTemplateId: string
}
/** One agent definition (spec 13 §2.1). Every agent — default, subagents, future
 *  write-capable coding agents — is an instance of this schema. */
export interface AgentType {
  id: string
  name: string
  description: string
  builtin?: boolean
  skills: string[]
  readRoots: string[]
  writeRoots: string[]
  callableAgents: string[]
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
export interface Config {
  version: number
  daemon: Daemon
  telemetry: Telemetry
  apiKeys: ApiKey[]
  engines: Engine[]
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
  /** Persisted auto-tune results keyed by modelKey (spec 09 §1, 01 §4). Additive;
   *  absent in old configs → normalize seeds {}. Never throws on load. */
  benchResults: Record<string, BenchResult>
  /** VRAM to keep free during auto-tune's offload search (MB), so a later desktop /
   *  ComfyUI VRAM grab can't tip the chosen config into a sysmem spill (bench.ts's
   *  `overHeadroom`). User-configurable via a Settings slider,
   *  {@link VRAM_HEADROOM_MIN_MB}–{@link VRAM_HEADROOM_MAX_MB}, default
   *  {@link VRAM_HEADROOM_DEFAULT_MB}. Absent in pre-this-feature configs → normalize
   *  seeds the default. */
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
  /** Compile-from-source settings (ADR-089/100): toolchain dirs prepended to PATH. */
  build: BuildConfig
  /** Cloud Launch deploy-link settings (ADR-153). */
  cloudDeploy: CloudDeployConfig
  devModel?: DevModel
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
    },
    telemetry: { level: 'unset', machineId: '' },
    apiKeys: [],
    engines: [],
    activeEngineId: '',
    modelDirs: [],
    primaryModelDir: '',
    modelProfiles: {},
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
    build: { toolchainDirs: [] },
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

function migrate(raw: Record<string, unknown>, _from: number): Config {
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
  // Persisted auto-tune results (spec 09 §1): absent in pre-bench configs → {}.
  c.benchResults ??= {}
  // VRAM headroom slider: absent/garbage (pre-feature config, or a stale out-of-range
  // value) → the default, never thrown on load — mirrors the gateway.keepN clamp below.
  c.vramHeadroomMb =
    typeof c.vramHeadroomMb === 'number' && c.vramHeadroomMb >= VRAM_HEADROOM_MIN_MB && c.vramHeadroomMb <= VRAM_HEADROOM_MAX_MB
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
  // Compile-from-source toolchain dirs (ADR-089/100): absent in pre-build configs → [].
  // Keep only non-empty strings; the validator enforces absolute paths.
  const bd = (c.build ?? {}) as Partial<BuildConfig>
  c.build = {
    toolchainDirs: Array.isArray(bd.toolchainDirs)
      ? bd.toolchainDirs.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
      : [],
  }
  // Cloud Launch deploy-link settings (ADR-153): absent in pre-ADR-153 configs → ''.
  const cd = (c.cloudDeploy ?? {}) as Partial<CloudDeployConfig>
  c.cloudDeploy = { runpodTemplateId: typeof cd.runpodTemplateId === 'string' ? cd.runpodTemplateId.trim() : '' }
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

/** Telemetry consent levels exposed in the UI (spec 09 §3). The stored config may
 *  additionally hold the first-run sentinel 'unset' (drives the consent modal); it
 *  is preserved on disk but maps to 'off' when surfaced as a settings enum value. */
export type TelemetryLevel = 'off' | 'anon' | 'full'

/** Coerce a stored telemetry level to a known value. Preserves the first-run
 *  sentinel 'unset'; migrates the legacy 'benchmarks' label → 'anon'; anything
 *  unrecognized → 'off'. Never throws (fail-safe on old/garbage config). */
function normalizeTelemetryLevel(level: unknown): string {
  if (level === 'unset' || level === 'off' || level === 'anon' || level === 'full') return level
  if (level === 'benchmarks' || level === 'anonymous') return 'anon' // legacy spec label
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
  if (c.vramHeadroomMb < VRAM_HEADROOM_MIN_MB || c.vramHeadroomMb > VRAM_HEADROOM_MAX_MB) {
    throw new ValueError('vramHeadroomMb', `must be between ${VRAM_HEADROOM_MIN_MB} and ${VRAM_HEADROOM_MAX_MB} MB`)
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
