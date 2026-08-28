// `turbollm launch <cli>` — start a coding CLI already wired to the local TurboLLM
// gateway, so it uses whatever model is loaded here instead of a cloud API (spec 06
// §6). Ships with the npm package.
//
// The daemon must already be running; this command is a thin launcher. If no model is
// loaded, it auto-loads the last-used model (or the first available one). With --model
// it resolves and loads a specific model by key/name before launching.
//
// Wiring is per-harness DATA, not per-harness branches — see CliSpec/LaunchContext:
//   - `prepareConfig` merges a durable `turbollm` provider into the harness's own config file
//     (opencode/kilo/openclaw/pi/hermes), so a later bare `opencode` stays wired. Always keyed to
//     the SHARED static token: that file outlives the launch and is shared between sessions.
//   - `env` / `args` carry everything PER-LAUNCH, including the session-scoped auth token. This
//     split is what lets two concurrent Code sessions on the same harness keep separate identities
//     at the gateway (session-auth.ts) instead of racing on one global config file.
//   - `mcpArgs` points the harness at the daemon's own MCP bridge, for harnesses with a confirmed
//     flag for it (claude). opencode carries the same bridge inside its inline config instead.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { buildShellCommand } from './util/shell-command'
import { requiresShell, resolveExecutable } from './util/resolve-executable'
import { isQualifiedId } from './link/model-id'

/** Everything a harness might need to wire itself to this daemon, resolved once per launch and
 *  handed to every per-harness hook on {@link CliSpec}. Exists so adding a harness is a data entry
 *  rather than another `if (target === 'x')` branch in launchCli. */
export interface LaunchContext {
  /** `http://127.0.0.1:<port>` — the gateway origin. */
  base: string
  port: number
  /** The token this launch should present. **Session-scoped** for an embedded-terminal launch
   *  (so the gateway can resolve it back to a Code session and apply that session's thinking
   *  budget / reasoning effort, and attribute its usage — session-auth.ts); the shared static
   *  token for a hand-run `turbollm launch <cli>`. */
  authToken: string
  /** The loaded model's stable key — what the gateway routes on. */
  pinnedModel: string
  /** The loaded model's display name. */
  modelName: string
  /** The loaded model's REAL context window, or undefined when the daemon reports none. */
  modelCtx?: number
  /** Engine slot count, or undefined when the engine does its own batching (vLLM/mlx-lm). */
  parallelSlots?: number
  /** The WHOLE model library, not just the loaded model.
   *
   *  Why it must be the whole library: claude gets a real model picker for free — the gateway
   *  advertises every model on `/v1/models` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` tells
   *  Claude Code to read it. Config-file harnesses have no such discovery channel: they can only see
   *  what we WRITE into their config. Writing only the loaded model (as this did originally) left
   *  `/model` in pi showing a single entry — founder-reported as "I can't see turbollm models" — while
   *  claude showed all of them. Empty when the library couldn't be fetched, in which case each
   *  harness's config keeps whatever it already had. */
  models: ModelEntry[]
  /** False for a background SYNC (a model load), true for an explicit `turbollm launch`. A sync
   *  refreshes model metadata only; it must never rewrite the user's own default provider/model in
   *  a third-party tool's config, because they did not ask for that by loading a model. */
  pinDefaults?: boolean
  /** Filesystem seam, so an `env` hook that has to READ the user's own config (opencode) is unit
   *  testable against an in-memory fs instead of the real home directory. */
  fs: ConfigFs
}

interface CliSpec {
  bin: string
  label: string
  install: string
  // Anthropic-protocol tools (today: claude) get ANTHROPIC_* env vars set at spawn time.
  // Config-file tools (opencode/kilo/openclaw/pi) instead get this called once before spawn
  // to merge a local-gateway provider entry into the tool's own config file.
  //
  // `fs` is threaded through from launchCli's own injected seam. It MUST be — without it these
  // implementations silently fell back to their `realFs` default, so any test that drove
  // `launchCli` with a config-file target wrote to the REAL home directory instead of its in-memory
  // fs. Found exactly that way: a new unit test quietly rewrote this machine's own
  // `~/.pi/agent/models.json` and `~/.config/opencode/opencode.json` with a stub model name.
  //
  // Takes the resolved LaunchContext (not loose positional params) so a harness can wire the
  // things that only become known at launch — above all the REAL context window, without which
  // every harness silently assumes its own default (pi: 128000, measured live as a founder-visible
  // "128K" on a 200K model).
  //
  // `apiKey` is passed separately and is deliberately the SHARED static token, never
  // `ctx.authToken`: this writes a durable file that outlives the launch (see launchCli).
  prepareConfig?: (ctx: LaunchContext, apiKey: string) => Promise<PrepareResult>
  /** Extra environment this harness needs, merged on top of {@link inheritedEnv}. Keep the
   *  per-harness wiring here rather than in launchCli — see LaunchContext. */
  env?: (ctx: LaunchContext) => Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv
  /** Extra CLI arguments this harness needs, appended after the caller's passthrough.
   *
   *  This is where a **per-session credential** belongs for a harness that accepts one as a flag
   *  (pi's `--api-key`): a token is per-process state, and writing it into the harness's SHARED
   *  global config file would let two concurrent Code sessions race, last writer winning, each
   *  silently adopting the other's identity at the gateway. */
  args?: (ctx: LaunchContext) => string[]
  /** Extra env markers to strip beyond {@link PARENT_AGENT_ENV_MARKERS} — anything that would make
   *  THIS harness believe it is a nested child of another agent run. Probe before filling in;
   *  an empty/absent list must mean "probed, none found", not "never looked". */
  parentEnvMarkers?: readonly string[]
  /** How this harness is told about TurboLLM's own MCP bridge (mcp-server.ts), which is the only
   *  way it can learn that Routines/Agents exist at all. Absent = no verified mechanism, so
   *  nothing is passed (rather than a guessed flag, which is a hard startup failure — ADR-293). */
  mcpArgs?: (configPath: string) => string[]
  // CLIs that accept a caller-chosen session id expose two mutually exclusive flags: one that
  // REGISTERS a new id, one that RESUMES an existing one. Passing the wrong one is a hard,
  // immediate failure — and the daemon genuinely cannot know which state the CLI is in, because
  // `agent_runs.terminal_launched_once` is set optimistically the moment we build the launch
  // command (terminal-routes.ts). A session the founder opened but never sent a message in was
  // never persisted by the CLI, so the next launch resumes an id the CLI has never heard of.
  // Both directions are fully recoverable by swapping the flag, so that's what we do.
  sessionFlags?: SessionFlags
}

interface SessionFlags {
  /** Flag that registers a caller-chosen id on a NEW conversation. */
  register: string
  /** Flag that resumes an EXISTING conversation by id. */
  resume: string
}

type PrepareResult = { ok: true } | { ok: false; message: string }

const AUTH_TOKEN = 'turbollm-local'

// The pi research package bootstrapped onto every launched `pi` so it ships with web search / fetch
// out of the box instead of forcing each user to install it by hand. Pinned to a SPECIFIC version on
// purpose: this is a third-party package that runs with FULL SYSTEM ACCESS in the user's environment
// (pi's own docs warn about exactly that), so pulling `@latest` would let an upstream release silently
// change what every user gets. 0.3.0 is the version reviewed here — 8 tools (websearch, codesearch,
// context7, deepwiki, web_fetch, get_fetch_content, firecrawl_scrape, firecrawl_crawl), and it works
// zero-config via the public Exa MCP server, so no API key is required. Set TOBOLLM_PI_DISABLE_SEARCH_INSTALL
// to a truthy value (1/true/yes) to opt a machine out entirely.
const PI_SEARCH_PACKAGE_NAME = '@heyhuynhgiabuu/pi-search'
const PI_SEARCH_PACKAGE_SPEC = `${PI_SEARCH_PACKAGE_NAME}@0.3.0`
const PI_SEARCH_INSTALL_DISABLED = () =>
  ['1', 'true', 'yes'].includes(process.env.TOBOLLM_PI_DISABLE_SEARCH_INSTALL?.toLowerCase() ?? '')
// The `npm:`-prefixed prefix pi stores for a package in `~/.pi/agent/settings.json`'s `packages`
// array — the `npm:` prefix, the bare name, and the trailing `@` a version specifier follows. We match
// on the NAME rather than the exact pinned version on purpose: a user's own manual install of ANY
// version is respected, so we never silently downgrade them to our pinned 0.3.0 (see
// piSearchPackagePresent). `pi install npm:<spec>` still pins the reviewed version for fresh installs.
// VERIFIED against a live `pi install` on this machine: the entry really lands in that `packages`
// array (what `pi list` reads back), so this prefix is not a guess. If pi ever moves the entry
// elsewhere, this silently stops matching and every launch reinstalls — which is why the verified
// location is called out here, as the regression guard for that assumption.
const PI_SEARCH_PACKAGES_PREFIX = `npm:${PI_SEARCH_PACKAGE_NAME}@`
// An OFFLINE machine has no recorded package, so `pi install` would otherwise retry the hung npm call
// on EVERY launch. realRunCommand/realSpawn set no deadline of their own, so we bound it: after this
// many ms we resolve false (the install is still running in the background, we just stop waiting).
const PI_SEARCH_INSTALL_TIMEOUT_MS = 30_000
/** Whether the pi-search package is ALREADY present in the user's pi packages list
 *  (~/.pi/agent/settings.json → `packages`). A fast, OFFLINE-FREE local read — that is the whole
 *  point: we must NOT run `pi install` (which hits npm, ~3 s, and hangs for offline users) on every
 *  launch. This returns false when the file is missing or unparseable, so a fresh machine falls
 *  through to the install exactly once. `stripJsonComments` reuses preparePi's own JSONC reader so a
 *  hand-edited/commented settings.json still parses. */
export async function piSearchPackagePresent(fs: ConfigFs): Promise<boolean> {
  const path = join(fs.home, '.pi', 'agent', 'settings.json')
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch {
    return false
  }
  let cfg: { packages?: unknown[] }
  try {
    cfg = JSON.parse(stripJsonComments(raw)) as typeof cfg
  } catch {
    return false
  }
  return (
    Array.isArray(cfg.packages) &&
    cfg.packages.some((p) => typeof p === 'string' && p.startsWith(PI_SEARCH_PACKAGES_PREFIX))
  )
}

const SUPPORTED: Record<string, CliSpec> = {
  claude: {
    bin: 'claude',
    label: 'Claude Code',
    install: 'npm install -g @anthropic-ai/claude-code',
    // Measured against the real CLI: both mismatches exit 1 during startup, before any TUI
    // paints or any model call is made.
    //   --session-id <existing> -> "Error: Session ID <uuid> is already in use."
    //   --resume     <unknown>  -> "No conversation found with session ID: <uuid>"
    sessionFlags: { register: '--session-id', resume: '--resume' },
    env: claudeEnv,
    mcpArgs: (configPath) => ['--mcp-config', configPath],
  },
  opencode: {
    bin: 'opencode',
    label: 'opencode',
    install: 'npm install -g opencode-ai',
    // Still merged into the user's own config file, so a hand-run `turbollm launch opencode` (and
    // any later bare `opencode`) stays wired. The per-SESSION token travels by env instead — see
    // buildOpencodeConfigContent for why the file is the wrong place for it.
    prepareConfig: (ctx, apiKey) => prepareOpencode(ctx.base, apiKey, ctx.pinnedModel, ctx.modelName, ctx.fs, ctx.modelCtx, ctx.models),
    env: async (ctx) => {
      const content = await buildOpencodeConfigContent(ctx.base, ctx.authToken, ctx.pinnedModel, ctx.modelName, ctx.port, ctx.fs, ctx.modelCtx, ctx.models)
      return content ? { OPENCODE_CONFIG_CONTENT: content } : {}
    },
    // MCP travels inside OPENCODE_CONFIG_CONTENT's own `mcp` key (above), not as a flag — opencode
    // has no `--mcp-config` equivalent (`opencode --help`, 1.18.9).
  },
  kilo: { bin: 'kilo', label: 'Kilo Code', install: 'npm install -g @kilocode/cli', prepareConfig: (ctx, apiKey) => prepareKilo(ctx.base, apiKey, ctx.pinnedModel, ctx.modelName, ctx.fs, ctx.modelCtx, ctx.models, ctx.pinDefaults ?? true) },
  openclaw: { bin: 'openclaw', label: 'openclaw', install: 'npm install -g openclaw@latest', prepareConfig: (ctx, apiKey) => prepareOpenclaw(ctx.base, apiKey, ctx.pinnedModel, ctx.modelName, ctx.fs, ctx.pinDefaults ?? true) },
  // hermes' 5th parameter is a RunCommand, not a ConfigFs — its config is YAML and is written by
  // shelling out to `hermes config set` rather than by touching the filesystem here, so it has no
  // fs seam to thread and the argument is deliberately dropped.
  hermes: {
    bin: 'hermes',
    label: 'Hermes Agent',
    install: 'npm install -g hermes-agent',
    prepareConfig: (ctx, apiKey) => prepareHermes(ctx.base, apiKey, ctx.pinnedModel, ctx.modelName),
  },
  pi: {
    bin: 'pi',
    label: 'pi',
    install: 'npm install -g @earendil-works/pi-coding-agent',
    prepareConfig: (ctx, apiKey) => preparePi(ctx.base, apiKey, ctx.pinnedModel, ctx.modelName, ctx.fs, ctx.modelCtx, ctx.models, ctx.pinDefaults ?? true),
    // `--session-id <id>` is documented as "Use exact project session ID, CREATING IT IF MISSING"
    // (`pi --help`, 0.84.2) — one flag registers *and* resumes. So pi deliberately has NO
    // sessionFlags: there is no register/resume pair to mismatch, and therefore nothing for
    // spawnWithSessionRecovery to recover from. terminal-routes.ts passes the single flag.
    args: piArgs,
    // pi discovers MCP through its own extension system (`pi install`), which is not a flag we can
    // set per launch. It does not need one for the routine/agent gap this exists to close: the
    // gateway already tells every OpenAI-protocol client how to create a Routine over REST
    // (agent-guidance.ts's routineGuidance), which is the same information writeClaudeMcpConfig
    // exists to deliver to claude. Deliberately no mcpArgs.
  },
}

/** The executable name for a launch target, or null when the target isn't supported. Exported so
 *  callers that need to PROBE a harness (routines' install preflight) ask this registry rather than
 *  assuming the target id and the binary name are the same string — they happen to match today for
 *  claude/opencode/pi, but `kilo`→`kilo` and `hermes`→`hermes` are the only reason that reads as a
 *  rule, and `deepseek`→`dsh` would break it the moment it is added. */
export function cliBin(target: string): string | null {
  return Object.hasOwn(SUPPORTED, target) ? SUPPORTED[target].bin : null
}

/** The binary, display label and install command for a launch target, or null when unsupported.
 *  Exported so the UI can tell the user WHICH command installs a harness it found missing, without
 *  keeping a second copy of that string that could drift from the one the launcher prints. */
export function cliSpecInfo(target: string): { bin: string; label: string; install: string } | null {
  // `Object.hasOwn`, not a truthiness check: SUPPORTED is a plain object literal, so
  // `SUPPORTED['constructor']` (or 'toString', '__proto__') resolves up the PROTOTYPE CHAIN to a
  // truthy value, so this returned `{bin: undefined, …}` instead of null — which then threw a
  // TypeError out of installAgent's `spec.install.split(…)` and surfaced as an HTTP 500.
  if (!Object.hasOwn(SUPPORTED, target)) return null
  const spec = SUPPORTED[target]
  return spec ? { bin: spec.bin, label: spec.label, install: spec.install } : null
}

interface DaemonStatus {
  engine?: { state?: string; parallelSlots?: number }
  model?: { name?: string; key?: string; ctx?: number } | null
  lastLoaded?: { modelKey?: string } | null
  /** Turbo Link (ADR-382): the qualified `<machine>/<model>` id the user pointed this install
   *  at in the UI, or '' / absent for 'this machine'. Daemon state, so this process can see a
   *  choice made in a browser. */
  selectedRemoteModel?: string
}

// Claude Code CLI's own documented range for CLAUDE_CODE_AUTO_COMPACT_WINDOW (env-vars docs,
// "Set the auto-compact window"): a plain token count from 100_000 to 1_000_000 — the env var
// form accepts no smaller/larger value, no `k`/`M` suffix. Below this floor there is no
// documented way to shrink the window further; see clampAutoCompactWindow's own doc comment.
const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000
const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000

/** Claude Code auto-compacts once the conversation reaches "the model's context limit" — its
 *  OWN belief about that limit, not the real engine's. For an unrecognized custom model behind a
 *  custom ANTHROPIC_BASE_URL, Claude Code has no way to learn the real number (confirmed against
 *  the CLI's own docs, 2026-08 — no env var declares a custom model's context window; only the
 *  AUTO_COMPACT_WINDOW/PCT_OVERRIDE pair below tune WHEN it compacts, never WHAT it believes the
 *  window is) and falls back to a generic assumption (the same 200K a stock Sonnet/Opus session
 *  without extended context uses). A local model's REAL context is very often far smaller — 8K–
 *  32K is common on consumer GPUs (see code-session.ts's own compactionSettingsFor comment) — so
 *  the CLI keeps resending an ever-growing conversation nowhere near ITS assumed 80%-of-200K
 *  danger zone while llama.cpp's real, much smaller n_ctx quietly overflows underneath it: the
 *  CLI never sees "getting full", it just gets a hard error once the real engine runs out of
 *  room. Pinning CLAUDE_CODE_AUTO_COMPACT_WINDOW to the REAL loaded ctx fixes this outright for
 *  any local setup with ctx >= 100_000 (this repo's own docs describe several: 200K builds are
 *  common), and meaningfully tightens the over-generous 200K-assumed default for everything down
 *  to the documented 100_000 floor. Below that floor (an 8K/16K/32K local model) there is no
 *  further, smaller value the CLI's env var accepts — this is a genuine, confirmed limit of the
 *  real `claude` binary today, not something TurboLLM can compensate for from outside it. */
export function clampAutoCompactWindow(ctx: number): number {
  return Math.min(CLAUDE_AUTO_COMPACT_WINDOW_MAX, Math.max(CLAUDE_AUTO_COMPACT_WINDOW_MIN, Math.round(ctx)))
}

/** How full CLAUDE_CODE_AUTO_COMPACT_WINDOW is allowed to get before Claude Code compacts
 *  (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, 1-100 — can only LOWER the CLI's own default, never raise
 *  it). 80 matches this codebase's own established auto-compact convention for the exact same
 *  kind of feature (ADR-132's "/compact auto-fires at 80% of the live context window", the
 *  in-app pi-based Code session's own compactionSettingsFor) — one consistent number across both
 *  surfaces rather than an arbitrary different one here. */
export const CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '80'

export interface ModelEntry {
  key: string
  name: string
  /** The model's own maximum context from its GGUF metadata — a ceiling, not what it will load with. */
  nativeCtx?: number
  /** The context window this model would ACTUALLY be loaded with, from its saved profile/preset for
   *  the active engine (`/api/v1/models`). This is the right per-model answer for a harness's
   *  picker: `nativeCtx` is merely the maximum the file allows, so a 262144-native model configured
   *  at 163328 advertised the wrong window until it happened to be the loaded one. Undefined when
   *  the model has no saved profile, where nativeCtx is the honest remaining answer. */
  configuredCtx?: number
}

/** The context window to advertise for one model, best-known first:
 *   1. `loadedCtx` — only for the model that is loaded RIGHT NOW. Authoritative: auto-tune or a
 *      VRAM-pressure fallback can land somewhere other than the saved profile asked for.
 *   2. `configuredCtx` — its saved profile for the active engine: what it WOULD load with. Correct
 *      for every model without needing it loaded first, which is the point.
 *   3. `nativeCtx` — the metadata ceiling. Only an upper bound, but better than silence.
 *   4. undefined — omit the field entirely and let the harness use its own default, rather than
 *      inventing a number. */
function advertisedCtx(m: ModelEntry, isLoaded: boolean, loadedCtx?: number): number | undefined {
  if (isLoaded && loadedCtx) return loadedCtx
  return m.configuredCtx ?? m.nativeCtx
}

// Type-safe subset of spawn's return value that launchCli actually uses. Only 'on' — the child's
// stdio handles are inherited straight from this process and never intercepted (see
// spawnWithSessionRecovery for what happened when they were).
type SpawnLike = (
  cmd: string,
  args: string[],
  opts: Parameters<typeof spawn>[2],
) => Pick<ReturnType<typeof spawn>, 'on'>

/** The real spawn used for launching a CLI. Keeps the (cmd, args, opts) shape so tests can inject
 *  a stub and assert on the arguments.
 *
 *  Prefers spawning the RESOLVED executable with an args array and no shell. That is not a
 *  micro-optimisation — it is the fix for a critical injection found in pre-release review
 *  (2026-08-01): under `shell: true` the arguments have to be flattened onto a cmd.exe command
 *  line, and cmd.exe does not honour the `\"` escape that CommandLineToArgvW does, so an argument
 *  containing a double quote escapes its quoting and everything after it is parsed as shell
 *  syntax. A Code session's first message — arbitrary user prose — reaches these arguments.
 *  Measured over nine hostile inputs: shell path 1 injection + 1 corruption, no-shell path 0 and 0.
 *  See util/resolve-executable.ts for the reproduction.
 *
 *  The shell is kept ONLY for a `.cmd`/`.bat` shim, which Node refuses to spawn without one
 *  (EINVAL, a deliberate mitigation). Node 25's DEP0190 also forbids the args-array form together
 *  with `shell: true`, so that residual path still builds one pre-quoted command line. */
const realSpawn: SpawnLike = (cmd, args, opts) => {
  if (!opts?.shell) return spawn(cmd, args, opts)

  const resolved = resolveExecutable(cmd)
  if (!requiresShell(resolved)) {
    // The safe path: no shell parses this, so no quoting rules apply at all. Verified in a real
    // ConPTY after the change — the CLI's TUI still paints in full colour, so dropping the shell
    // does not put anything between the CLI and the terminal handles (ADR-293's constraint).
    const { shell: _shell, ...rest } = opts
    return spawn(resolved ?? cmd, args, rest)
  }
  // Residual shim path (`claude.cmd` from a global npm install), which cannot avoid cmd.exe.
  // The `\"` weakness above is NOT reachable through it in the daemon-driven flow: the only
  // argument here carrying arbitrary user prose is a Code session's seeded first message, and
  // `canSeedFirstMessage` (terminal-routes.ts) refuses any message containing a double quote
  // before it is ever put on a command line. Every other argument is one of our own flags, drawn
  // from a fixed safe character set. A hand-run `turbollm launch claude "…"` can still pass a
  // quote through, but that is the user's own shell invocation, not a privilege boundary.
  return spawn(buildShellCommand(cmd, args), opts)
}

/** Run a one-shot command via `spawnImpl`, resolving false if it does not exit within `timeoutMs`.
 *  Used for the best-effort `pi install` so an OFFLINE machine cannot hang a launch on npm's own
 *  unbounded retries (realRunCommand/realSpawn set none of their own). Resolving false here does NOT
 *  kill the child — it keeps running in the background; we simply stop waiting. `spawnImpl` is injected
 *  so a test can feed a child that never exits and assert the timeout fires without waiting the real
 *  30 s. The timer is intentionally NOT unref'd — see the inline note. */
export function runWithTimeout(
  spawnImpl: SpawnLike,
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // NOTE: deliberately NOT unref'd — the timer is the only handle keeping the event loop alive in
    // the "child never exits" case, so an unref'd timer would let the loop drain and the awaited
    // promise never resolve (this exact failure, caught in CI as 'event loop has already resolved').
    // In the normal case settle() clearTimeout()s it, so there is never a lingering timer to worry
    // about holding the loop open.
    const timer = setTimeout(() => resolve(false), timeoutMs)
    // A bare `pi` is an npm `.cmd`/`.ps1` shim on Windows, which spawn() cannot resolve without a
    // shell (ENOENT otherwise) — the same reason the normal launch passes `shell: win32`. Without
    // this the best-effort install silently fails on EVERY Windows machine, so web search never
    // ships. `stdio: 'ignore'` keeps the install output out of the launch's own stderr.
    const child = spawnImpl(bin, args, { stdio: 'ignore', shell: process.platform === 'win32' })
    const settle = (code: number | null) => {
      clearTimeout(timer)
      resolve(code === 0)
    }
    child.on('error', () => settle(null))
    child.on('exit', (code) => settle(code))
  })
}

/** Fetch the current daemon status. Returns null on network error. */
async function fetchStatus(base: string, _fetch: typeof fetch = fetch): Promise<DaemonStatus | null> {
  try {
    const res = await _fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as DaemonStatus
  } catch {
    return null
  }
}

/** Fetch the model list. Returns [] on network error. */
async function fetchModels(base: string, _fetch: typeof fetch = fetch): Promise<ModelEntry[]> {
  try {
    const res = await _fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: ModelEntry[] }
    return data.models ?? []
  } catch {
    return []
  }
}

/** Every model id the daemon's OpenAI-compatible gateway currently advertises, including
 *  the qualified `<machine>/<model>` ids of every ONLINE linked host (ADR-376).
 *
 *  This is the right authority for a remote id and the local `/api/v1/models` is not:
 *  `/v1/models` lists exactly what the gateway can route right now, so a link that has
 *  gone offline contributes nothing and the id is simply absent — which is what turns a
 *  dead link into a clear "not found" at launch instead of a failure at the first prompt.
 *
 *  Returns [] on any network error, like `fetchModels`: the caller treats an empty list as
 *  "no remote model matched", which is the honest answer when we could not ask. */
async function fetchGatewayModelIds(base: string, _fetch: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await _fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> }
    return (data.data ?? []).map((e) => e.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

/**
 * Resolve a model key from a user-supplied name/key string against the library.
 * Resolution order:
 *   1. Exact key match
 *   2. Exact name match (case-sensitive)
 *   3. Case-insensitive / partial name match (first result)
 */
function resolveModelKey(models: ModelEntry[], input: string): string | null {
  // 1. Exact key match
  const byKey = models.find((m) => m.key === input)
  if (byKey) return byKey.key

  // 2. Exact name match (case-sensitive)
  const byName = models.find((m) => m.name === input)
  if (byName) return byName.key

  // 3. Case-insensitive / partial name match
  const lower = input.toLowerCase()
  const partial = models.find((m) => m.name.toLowerCase().includes(lower))
  if (partial) return partial.key

  return null
}

// ── Config-file provider merge (opencode / kilo / openclaw) ─────────────────────
// Shared FS injection point so unit tests can supply a fake home + in-memory fs
// without ever touching the real filesystem.
export interface ConfigFs {
  home: string
  readFile: (p: string) => Promise<string>
  writeFile: (p: string, data: string) => Promise<void>
  mkdir: (p: string) => Promise<void>
}

const realFs: ConfigFs = {
  home: homedir(),
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, data) => writeFile(p, data, 'utf8'),
  mkdir: async (p) => { await mkdir(p, { recursive: true }) },
}

/** The MCP config file `claude`'s own `--mcp-config` flag reads, pointing a launched session at
 *  THIS daemon's own MCP bridge (mcp-server.ts) so it can reach create_routine/list_agents/etc.
 *  — tools it otherwise has no way to even know exist: a claude_cli session is the REAL external
 *  Claude Code CLI, never routed through ToolRegistry the way chat and the in-process 'pi' agent
 *  are (mcp-server.ts's own module header has the full story — observed live, a claude_cli
 *  session asked to "create a routine" improvised an OS-level cron job with its own Bash tool
 *  instead, having no idea TurboLLM's Routines feature exists).
 *
 *  Regenerated on every launch rather than written once: content is fully determined by `port`,
 *  cheap to overwrite, and a stale port left over from a previous daemon would otherwise point
 *  the CLI at a server that no longer exists. */
export async function writeClaudeMcpConfig(port: number, fs: ConfigFs = realFs): Promise<string> {
  const dir = join(fs.home, '.turbollm')
  await fs.mkdir(dir)
  const path = join(dir, 'mcp-launch-config.json')
  const config = { mcpServers: { turbollm: { command: 'npx', args: ['turbollm', 'mcp-server', '--port', String(port)] } } }
  await fs.writeFile(path, JSON.stringify(config, null, 2))
  return path
}

/** Strips `//` and `/* *\/` comments from JSONC/JSON5 text, tracking string literals
 *  (single- and double-quoted, with escapes) so a value like `"http://host/v1"` is never
 *  mistaken for a comment. Used only to DETECT what's already in a commented config —
 *  we never write back through this (that would silently delete the user's comments). */
function stripJsonComments(text: string): string {
  let out = ''
  let inString: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'") { inString = ch; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++ // land on the closing '/'
      continue
    }
    out += ch
  }
  return out
}

/** Read + parse an existing config file. Returns:
 *   - { obj, lenient: false } — clean JSON (or the file is absent: fresh first run) —
 *     safe to rewrite.
 *   - { obj, lenient: true }  — only parsed after stripping JSONC comments — NEVER
 *     rewrite this (would silently delete the user's comments); callers may only
 *     report success if the file already has what we'd otherwise write.
 *   - { corrupt: true }       — doesn't parse even leniently; caller MUST NOT touch it. */
async function readConfigObject(
  fs: ConfigFs,
  path: string,
): Promise<{ obj: Record<string, unknown>; lenient: boolean } | { corrupt: true }> {
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch {
    return { obj: {}, lenient: false } // absent — first run
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return { obj: parsed as Record<string, unknown>, lenient: false }
    return { corrupt: true }
  } catch {
    // Not clean JSON — likely JSONC (kilo's config format allows comments, and real
    // configs use them). Retry after stripping comments before giving up.
    try {
      const parsed = JSON.parse(stripJsonComments(raw)) as unknown
      if (parsed && typeof parsed === 'object') return { obj: parsed as Record<string, unknown>, lenient: true }
      return { corrupt: true }
    } catch {
      return { corrupt: true }
    }
  }
}

/** True when an existing provider entry (opencode/kilo's `options.baseURL`, or
 *  openclaw's `baseUrl`) already points at our own gateway — used to treat a commented
 *  config that's already correctly wired as success, without ever rewriting it. Requires
 *  an exact match or a `/`-bounded prefix (not a bare `startsWith`) so e.g. `base` ending
 *  in `:6996` can never be fooled by a stored URL that merely starts with the same digits. */
function providerAlreadyPointsHere(entry: unknown, base: string): boolean {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  const options = e.options as Record<string, unknown> | undefined
  const baseUrl = (options?.baseURL ?? e.baseUrl) as string | undefined
  return typeof baseUrl === 'string' && (baseUrl === base || baseUrl.startsWith(`${base}/`))
}

/** A commented config that ISN'T already pointed at us — we can detect this but can't
 *  safely fix it (rewriting would delete the user's comments), so ask them to do it by
 *  hand, same as a genuinely unparseable file. */
function commentedConfigError(path: string, label: string): PrepareResult {
  return {
    ok: false,
    message:
      `Found an existing ${label} config at ${path} that uses comments and isn't yet ` +
      `pointed at TurboLLM — auto-merging would delete your comments when rewriting the file, ` +
      `so this is left to you.\n` +
      `Add the "turbollm" provider by hand (see the Connect screen: TurboLLM UI → Developer → Connect a tool), then run this again.`,
  }
}

/** Narrows a config sub-value to a plain object, treating absent as `{}` (fresh) but
 *  any other non-object (a user's config has e.g. `provider: "foo"`) as unsafe to
 *  merge into — callers bail out via corruptConfigError instead of throwing when a
 *  property assignment hits a primitive. */
function asObject(v: unknown): Record<string, unknown> | null {
  if (v === undefined) return {}
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Standard "can't safely touch your config" failure — points at the same info the
 *  web UI's Connect screen shows (Developer → Connect a tool). */
function corruptConfigError(path: string, label: string): PrepareResult {
  return {
    ok: false,
    message:
      `Found an existing ${label} config at ${path} that doesn't parse as JSON — not overwriting it.\n` +
      `Add the "turbollm" provider by hand (see the Connect screen: TurboLLM UI → Developer → Connect a tool), then run this again.`,
  }
}

/** The `models` map entry the opencode STACK needs for our provider — used by opencode AND
 *  kilo, which is built on that stack and uses the identical shape (verified: kilo's own bundled
 *  `models-snapshot.json` entries carry the same `id` / `name` / `limit:{context,output}` fields).
 *
 *  `limit` is where opencode learns the model's real context window; its schema requires BOTH
 *  `context` and `output` (opencode.ai/config.json). Only `context` is a MEASURED value — the window
 *  the engine actually loaded. `output` has no daemon-reported equivalent, so it is a generous UPPER
 *  BOUND rather than a guess at the true figure: the gateway's own `modelDefaults.maxTokens` cap and
 *  the engine both clamp generation independently, so a high value here can only fail to bind, never
 *  truncate a reply that would otherwise have completed.
 *
 *  Omitted entirely when the daemon reports no ctx — opencode's own default beats a made-up number.
 *  Same rule preparePi follows for `contextWindow`. */
function stackModelEntry(id: string, name: string, modelCtx?: number): Record<string, unknown> {
  const entry: Record<string, unknown> = { id, name }
  if (modelCtx) entry.limit = { context: modelCtx, output: Math.min(32768, Math.max(4096, Math.floor(modelCtx / 8))) }
  return entry
}

/** The whole library as an opencode-stack `models` MAP, same reasoning as piModelEntries — a config-file
 *  harness can only offer what we write, so writing one model left the picker with one entry.
 *
 *  Keyed by the model KEY rather than its display name: keys are unique by construction and are what
 *  the gateway routes on, whereas two library entries can share a name (the same model at two
 *  quantisations). `name` carries the human-readable label, which opencode's schema supports. */
function stackModelMap(
  models: ModelEntry[],
  loadedKey: string,
  loadedName: string,
  loadedCtx?: number,
): Record<string, unknown> {
  if (models.length === 0) return { [loadedKey]: stackModelEntry(loadedKey, loadedName, loadedCtx) }
  const out: Record<string, unknown> = {}
  for (const m of models) {
    out[m.key] = stackModelEntry(m.key, m.name, advertisedCtx(m, m.key === loadedKey, loadedCtx))
  }
  return out
}

/** opencode — merge a `turbollm` provider into ~/.config/opencode/opencode.json,
 *  preserving every sibling provider the user already configured. Shape mirrors
 *  buildConnectSnippets (routes.ts) so both surfaces stay in lockstep. */
export async function prepareOpencode(base: string, apiKey: string, modelKey: string, modelName: string, fs: ConfigFs = realFs, modelCtx?: number, models: ModelEntry[] = []): Promise<PrepareResult> {
  const path = join(fs.home, '.config', 'opencode', 'opencode.json')
  const read = await readConfigObject(fs, path)
  if ('corrupt' in read) return corruptConfigError(path, 'opencode')
  const cfg = read.obj
  const provider = asObject(cfg.provider)
  if (!provider) return corruptConfigError(path, 'opencode')
  if (read.lenient) {
    // Has comments — never rewrite. Only succeed if it's already wired to us.
    return providerAlreadyPointsHere(provider.turbollm, base) ? { ok: true } : commentedConfigError(path, 'opencode')
  }
  provider.turbollm = {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `${base}/v1`, apiKey },
    models: stackModelMap(models, modelKey, modelName, modelCtx),
  }
  cfg.provider = provider
  // Deliberately does NOT pin `cfg.model` here, unlike prepareKilo/prepareOpenclaw. This is the
  // user's OWN durable config: overwriting their default model would hijack a hand-run `opencode`
  // that has nothing to do with TurboLLM, and this file's own test pins that unrelated top-level
  // keys stay untouched. A daemon-launched session gets its pin from the per-process inline config
  // instead (buildOpencodeConfigContent) — the right scope for a per-launch choice.
  await fs.mkdir(dirname(path))
  await fs.writeFile(path, JSON.stringify(cfg, null, 2) + '\n')
  return { ok: true }
}

/** kilo — Kilo Code is built on the opencode stack and uses the SAME provider shape
 *  (verified against the live install: an array-form `models` is rejected with
 *  "Expected object"). Its real config file is `kilo.jsonc` (JSONC — comments allowed),
 *  confirmed against the live install, NOT `kilo.json`. Merge the `turbollm` provider
 *  and set it as the default via the top-level `model` string. */
export async function prepareKilo(base: string, apiKey: string, modelKey: string, modelName: string, fs: ConfigFs = realFs, modelCtx?: number, models: ModelEntry[] = [], pinDefaults = true): Promise<PrepareResult> {
  const path = join(fs.home, '.config', 'kilo', 'kilo.jsonc')
  const read = await readConfigObject(fs, path)
  if ('corrupt' in read) return corruptConfigError(path, 'Kilo Code')
  const cfg = read.obj
  const provider = asObject(cfg.provider)
  if (!provider) return corruptConfigError(path, 'Kilo Code')
  if (read.lenient) {
    // kilo.jsonc allowing comments is its NORMAL format, not an edge case — but we still
    // never rewrite one (would delete the user's comments). Already-wired configs (like
    // a hand-curated kilo.jsonc that already has a turbollm provider) succeed as-is.
    return providerAlreadyPointsHere(provider.turbollm, base) ? { ok: true } : commentedConfigError(path, 'Kilo Code')
  }
  provider.turbollm = {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `${base}/v1`, apiKey },
    // Same treatment as opencode, and for the same two reasons. (1) The WHOLE library, so kilo's
    // model picker is a real picker rather than a single row — a config-file harness can only offer
    // what we write. (2) Keyed by model KEY, not display name: this library really does contain
    // collisions (`qwen3.6-35b-a3b` at four quantisations on the founder's box), which a name-keyed
    // map silently collapsed into ONE entry, and the key is what the gateway routes on anyway.
    models: stackModelMap(models, modelKey, modelName, modelCtx),
  }
  cfg.provider = provider
  // provider/model key selects the default model kilo boots with (format: provider/mapKey) — so
  // this must be the KEY now that the map is keyed by key. It was `modelName`, which stopped
  // resolving the moment the map stopped being name-keyed.
  if (pinDefaults) cfg.model = `turbollm/${modelKey}`
  await fs.mkdir(dirname(path))
  await fs.writeFile(path, JSON.stringify(cfg, null, 2) + '\n')
  return { ok: true }
}

/** openclaw — merge a `turbollm` provider under models.providers and set it as the
 *  default primary model. Path per its docs (~/.config/openclaw/openclaw.json); the
 *  CLI isn't installed on this box to verify empirically, so the path is assumed.
 *  We write plain JSON (valid JSON5); JSON5-only files are handled on the READ side
 *  by refusing to overwrite an unparseable file. */
export async function prepareOpenclaw(base: string, apiKey: string, modelKey: string, modelName: string, fs: ConfigFs = realFs, pinDefaults = true): Promise<PrepareResult> {
  const path = join(fs.home, '.config', 'openclaw', 'openclaw.json')
  const read = await readConfigObject(fs, path)
  if ('corrupt' in read) return corruptConfigError(path, 'openclaw')
  const cfg = read.obj
  const models = asObject(cfg.models)
  const providers = models && asObject(models.providers)
  const agents = asObject(cfg.agents)
  const defaults = agents && asObject(agents.defaults)
  if (!models || !providers || !agents || !defaults) return corruptConfigError(path, 'openclaw')
  if (read.lenient) {
    return providerAlreadyPointsHere(providers.turbollm, base) ? { ok: true } : commentedConfigError(path, 'openclaw')
  }
  providers.turbollm = {
    baseUrl: `${base}/v1`,
    apiKey,
    api: 'openai-completions',
    models: [{ id: modelKey, name: modelName }],
  }
  models.providers = providers
  cfg.models = models
  if (pinDefaults) defaults.model = { primary: `turbollm/${modelKey}` }
  agents.defaults = defaults
  cfg.agents = agents
  await fs.mkdir(dirname(path))
  await fs.writeFile(path, JSON.stringify(cfg, null, 2) + '\n')
  return { ok: true }
}

/** Every library model as a pi `models` entry, with the LOADED one carrying its real loaded context
 *  window and the rest their native maximum.
 *
 *  The distinction matters: a load profile routinely caps ctx well below a model's native maximum
 *  (a 262144-native model loaded at 32768), so the loaded model's true window is the one the daemon
 *  reports, not its metadata. For every other model we have no loaded figure — `nativeCtx` is the
 *  honest best estimate, and it is corrected the moment that model becomes the loaded one.
 *
 *  Falls back to just the loaded model when the library couldn't be fetched, so a network hiccup
 *  degrades to the previous behaviour rather than writing an empty picker. */
function piModelEntries(
  models: ModelEntry[],
  loadedKey: string,
  loadedName: string,
  loadedCtx?: number,
): Array<Record<string, unknown>> {
  const entry = (key: string, name: string, ctx?: number) => ({ id: key, name, ...(ctx ? { contextWindow: ctx } : {}) })
  if (models.length === 0) return [entry(loadedKey, loadedName, loadedCtx)]
  return models.map((m) => entry(m.key, m.name, advertisedCtx(m, m.key === loadedKey, loadedCtx)))
}

/** pi — the standalone `@earendil-works/pi-coding-agent` CLI (distinct from the pi SDK
 *  TurboLLM's own Code feature embeds server-side). Custom providers are wired via two
 *  files (schema confirmed against the package's own vendored docs, `docs/models.md` +
 *  `docs/settings.md` — NOT yet live-verified against a real `pi` install, same caveat
 *  ADR-158 already accepted for opencode/openclaw):
 *   - `~/.pi/agent/models.json` — merge a `turbollm` OpenAI-compatible provider entry.
 *   - `~/.pi/agent/settings.json` — set defaultProvider/defaultModel so `pi` starts
 *     already selected on it, no manual `/model` picker needed.
 *  Both go through the same tolerant-JSON merge (readConfigObject/stripJsonComments) as
 *  opencode/kilo — never touch a config with comments or one that isn't already ours. */
export async function preparePi(base: string, apiKey: string, modelKey: string, modelName: string, fs: ConfigFs = realFs, contextWindow?: number, models: ModelEntry[] = [], pinDefaults = true): Promise<PrepareResult> {
  const modelsPath = join(fs.home, '.pi', 'agent', 'models.json')
  const modelsRead = await readConfigObject(fs, modelsPath)
  if ('corrupt' in modelsRead) return corruptConfigError(modelsPath, 'pi')
  const modelsCfg = modelsRead.obj
  const providers = asObject(modelsCfg.providers)
  if (!providers) return corruptConfigError(modelsPath, 'pi')
  if (modelsRead.lenient) {
    if (!providerAlreadyPointsHere(providers.turbollm, base)) return commentedConfigError(modelsPath, 'pi')
  } else {
    providers.turbollm = {
      baseUrl: `${base}/v1`,
      api: 'openai-completions',
      apiKey,
      // `contextWindow` is REQUIRED for correctness, not decoration. pi defaults it to 128000
      // (its own documented default, `docs/models.md`), and that default is both displayed to the
      // user and used to decide when to auto-compact:
      //     contextTokens > contextWindow - reserveTokens        (docs/compaction.md)
      // So on a model loaded with a 200K window pi showed "128K" (founder-reported live) AND would
      // have compacted far too early; on a model loaded with 8K it would never compact and would
      // overflow the real engine instead — the same class of bug ADR-341 fixed for claude via
      // CLAUDE_CODE_AUTO_COMPACT_WINDOW. Setting the real number fixes the display and the
      // compaction trigger together.
      //
      // Omitted (not guessed) when the daemon reports no ctx: pi's own default is a better answer
      // than a number we made up. `maxTokens` is deliberately left at pi's default too — the daemon
      // reports no max-output figure, and inventing one could truncate real replies.
      //
      // EVERY model in the library is listed, not just the loaded one — that is what makes pi's
      // `/model` picker a real picker (it re-reads this file each time it opens, docs/models.md).
      // Selecting a different one just sends a different model id to the gateway, which auto-swaps
      // exactly as it does for claude's own picker.
      models: piModelEntries(models, modelKey, modelName, contextWindow),
    }
    modelsCfg.providers = providers
    await fs.mkdir(dirname(modelsPath))
    await fs.writeFile(modelsPath, JSON.stringify(modelsCfg, null, 2) + '\n')
  }

  const settingsPath = join(fs.home, '.pi', 'agent', 'settings.json')
  const settingsRead = await readConfigObject(fs, settingsPath)
  if ('corrupt' in settingsRead) return corruptConfigError(settingsPath, 'pi')
  const settingsCfg = settingsRead.obj
  if (settingsRead.lenient) {
    return (settingsCfg.defaultProvider === 'turbollm' && settingsCfg.defaultModel === modelKey)
      ? { ok: true }
      : commentedConfigError(settingsPath, 'pi')
  }
  // Only at an explicit launch. A model load in the TurboLLM UI must not silently flip the default
  // provider of a `pi` the user runs by hand against their own account — the same rule
  // prepareOpencode already states for `cfg.model`, applied here after review flagged the asymmetry.
  if (pinDefaults) {
    settingsCfg.defaultProvider = 'turbollm'
    settingsCfg.defaultModel = modelKey
  }
  await fs.mkdir(dirname(settingsPath))
  await fs.writeFile(settingsPath, JSON.stringify(settingsCfg, null, 2) + '\n')
  return { ok: true }
}

// ── Per-harness wiring (CliSpec.env / .args) ────────────────────────────────────
//
// Each harness reaches TurboLLM by a different route, and — critically — each needs a way to carry
// a PER-SESSION token without writing it into a shared global config file. See CliSpec.args.

/** claude — Anthropic-protocol env wiring. Moved here verbatim from launchCli's body when the
 *  launcher became spec-driven; every value's reasoning lives on its own comment below and none of
 *  it changed. */
function claudeEnv(ctx: LaunchContext): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_BASE_URL: ctx.base,
    // No auth is enforced on the local gateway; the CLI just needs a non-empty token. A
    // session-scoped token (embedded terminal launches) takes priority over the shared static
    // one so the gateway can attribute this session's requests correctly (session-auth.ts).
    ANTHROPIC_AUTH_TOKEN: ctx.authToken,
    // Local LLMs are 30–120 s per response — raise Claude Code's request timeout so it
    // doesn't abort mid-generation. 300 s (5 min) covers even the slowest local model.
    // Zero retries: retrying a slow local model cold-starts it again and makes things worse.
    ANTHROPIC_TIMEOUT: '300000',
    ANTHROPIC_MAX_RETRIES: '0',
    // Always pin the loaded model's id (key preferred). Claude Code uses the model string
    // for real client-side bookkeeping even behind a custom base URL — the status line,
    // `/status`, and context-window / auto-compact sizing all read it — and never validates
    // it against a cloud catalog when ANTHROPIC_BASE_URL is custom.
    ANTHROPIC_MODEL: ctx.pinnedModel,
    // Opt into gateway model discovery: Claude Code queries our /v1/models at startup and
    // populates the /model picker with the local library (gateway synthesises the entries).
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    // See clampAutoCompactWindow's doc comment for the root cause and its documented
    // [100_000, 1_000_000] floor/ceiling. Only set when the daemon actually reports a real ctx —
    // an absent/zero value means "don't know", and guessing a window would be worse than leaving
    // the CLI's own generic default in place.
    ...(ctx.modelCtx ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(clampAutoCompactWindow(ctx.modelCtx)) } : {}),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
    // Cap background-agent fan-out at what the engine can actually run concurrently. The gateway
    // enforces the same limit independently (gateway.ts acquires d.gate), so a CLI that ignores
    // this still cannot exceed the engine; this is the cooperative half, which makes the excess
    // queue politely client-side instead of being held at the HTTP layer.
    ...(ctx.parallelSlots ? { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(ctx.parallelSlots) } : {}),
  }
}

/** opencode — the complete config this launch should run with, as a JSON string for
 *  `OPENCODE_CONFIG_CONTENT` ("inline json config content", confirmed in `opencode --help` on
 *  1.18.9).
 *
 *  ── Why an env var and not just the config file ────────────────────────────────────────────────
 *  `prepareOpencode` writes the `turbollm` provider into the user's own
 *  `~/.config/opencode/opencode.json`, which is right for a hand-run launch: the provider entry is
 *  durable, shared, and not secret. But it is the WRONG place for a per-session auth token — the
 *  path is global, so two concurrent Code sessions would race on it and the last writer would win,
 *  leaving one session silently presenting the other's identity to the gateway (and therefore
 *  getting the other session's thinking budget and usage attribution). An env var is per-process,
 *  so each session's token stays its own.
 *
 *  ── Why it starts from the user's real config ──────────────────────────────────────────────────
 *  Built by MERGING onto whatever the user already has, so an inline config can't silently drop
 *  their other providers, agents, or MCP servers. A happy side effect: because this is only ever
 *  read and never written back, a config containing COMMENTS is no longer a problem at all — the
 *  reason `prepareOpencode` has to refuse those is that rewriting the file would delete them.
 *  Returns null only when the file doesn't parse even leniently, where the honest move is to leave
 *  opencode to read its own file and report its own error. */
export async function buildOpencodeConfigContent(
  base: string,
  apiKey: string,
  modelKey: string,
  modelName: string,
  /** Daemon port for the MCP bridge command, or null to add no `mcp` entry at all. */
  mcpPort: number | null,
  fs: ConfigFs = realFs,
  /** The REAL loaded context window — see opencodeModelEntry. */
  modelCtx?: number,
  /** The whole library, so opencode's picker offers every model — see opencodeModelMap. */
  models: ModelEntry[] = [],
): Promise<string | null> {
  const path = join(fs.home, '.config', 'opencode', 'opencode.json')
  const read = await readConfigObject(fs, path)
  if ('corrupt' in read) return null
  const cfg = read.obj
  const provider = asObject(cfg.provider)
  if (!provider) return null
  provider.turbollm = {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `${base}/v1`, apiKey },
    models: stackModelMap(models, modelKey, modelName, modelCtx),
  }
  cfg.provider = provider
  // ── Show ONLY TurboLLM's models in this session's picker (founder-reported, 2026-08-19) ───────
  // `/models` opened onto opencode's OWN hosted providers — "OpenCode Zen" (Nemotron, DeepSeek V4,
  // Laguna, Hy3, MiMo…) and Google — with the 26 local models pushed below them, so picking the
  // obvious first entry switched to a CLOUD model and TurboLLM appeared not to change anything.
  //
  // Note this is a DIFFERENT mechanism from the credential leak fixed for pi: OpenCode Zen is
  // opencode's own built-in free service and needs none of the user's keys, so stripping
  // OPENAI_API_KEY/GEMINI_API_KEY cannot remove it. Read out of the 1.18 binary, opencode filters
  // providers with `if ((enabled ? enabled.has(id) : true) && !disabled.has(id))` — so
  // `enabled_providers` is an ALLOWLIST, and naming ours makes it the only one. Preferred over
  // `disabled_providers` precisely because it is an allowlist: a provider opencode adds in a later
  // release cannot reappear in a local-only session.
  //
  // Inline config ONLY, never the durable file — a hand-run `opencode` keeps every provider the
  // user configured. Going through `turbollm launch` is the statement that this session is local.
  cfg.enabled_providers = ['turbollm']
  // Pin the model TurboLLM actually has loaded, the same way prepareKilo/prepareOpenclaw do.
  // opencode was the ONLY harness whose model was never pinned by anything — no flag, no config key
  // — so a session booted on whatever opencode itself last selected, potentially a cloud provider
  // with no credentials. `provider/model` is opencode's documented top-level `model` format.
  cfg.model = `turbollm/${modelKey}`
  // TurboLLM's own MCP bridge, so this session can reach create_routine/list_agents/etc. The key
  // shape mirrors what `opencode mcp` manages: a local server is `{type:'local', command:[…]}`.
  if (mcpPort !== null) {
    const mcp = asObject(cfg.mcp)
    if (mcp) {
      mcp.turbollm = { type: 'local', command: ['npx', 'turbollm', 'mcp-server', '--port', String(mcpPort)], enabled: true }
      cfg.mcp = mcp
    }
  }
  return JSON.stringify(cfg)
}

/** pi — the per-session token as a real CLI flag, plus the provider/model it applies to.
 *
 *  `--api-key <key>` is the per-process seam that keeps a session-scoped secret out of the SHARED
 *  `~/.pi/agent/models.json` (see CliSpec.args). But it cannot be passed ALONE — measured live,
 *  2026-08-18, on a real launch:
 *
 *      Error: --api-key requires a model to be specified via --model, --provider/--model, or --models
 *
 *  which killed the session at startup. A key with no model is ambiguous to pi: it has no way to
 *  know WHICH provider the credential is for. `preparePi` does write defaultProvider/defaultModel
 *  into settings.json, but those defaults are evidently not consulted for this check.
 *
 *  So the provider and model are named explicitly. Verified against pi 0.84.2 — with all three
 *  flags the `turbollm` provider registers and the model is listed
 *  (`pi --provider turbollm --model <key> --api-key <tok> --list-models` exits 0 and shows it).
 *
 *  `ctx.pinnedModel` is a TurboLLM model key, which contains `|` (e.g.
 *  `qwen3.6-35b-a3b|IQ3_XXS|13211155424`) — a PIPE to cmd.exe, and pi takes the shell path on
 *  Windows because it resolves to `pi.cmd`. That is safe here only because `buildShellCommand`
 *  quotes every argument that is not in its strict safe-character allow-list, and `|` is not in it. */
function piArgs(ctx: LaunchContext): string[] {
  return ['--provider', 'turbollm', '--model', ctx.pinnedModel, '--api-key', ctx.authToken]
}

/** Runs a CLI command to completion, resolving true on exit code 0. Deliberately spawned
 *  WITHOUT a shell: hermes (the only current caller) is a real, directly-executable binary
 *  on every platform (confirmed: a native .exe on Windows, not an npm-style .cmd shim), and
 *  our own model keys contain `|` — under `shell: true` on Windows that's cmd.exe's pipe
 *  operator, silently mangling the command (args aren't escaped, only concatenated; Node
 *  itself deprecation-warns about this exact hazard). No shell means no metacharacters. */
export type RunCommand = (bin: string, args: string[]) => Promise<boolean>

export const realRunCommand: RunCommand = (bin, args) =>
  new Promise<boolean>((resolve) => {
    // Resolve first, exactly as realSpawn does, instead of handing `spawn` a bare name.
    //
    // A bare `spawn('pi', ['--version'])` FAILS on Windows even when pi is installed: libuv's own
    // PATHEXT lookup lands on `pi.cmd`, and Node refuses to spawn a `.cmd` without a shell (EINVAL,
    // a deliberate mitigation). The probe therefore reported "not installed" for every npm-shim CLI
    // — measured live: the availability endpoint said pi and opencode were missing while both were
    // on PATH and launchable. `claude` masked this for months by shipping a real `claude.exe`.
    //
    // The shell is used ONLY for that shim case, and the command is built by `buildShellCommand`,
    // which quotes each argument — so this keeps the property the no-shell choice was originally
    // protecting: our own model keys contain `|`, which cmd.exe would otherwise read as a pipe.
    // Quoting is what makes that safe, not the absence of a shell.
    const resolved = resolveExecutable(bin)
    const child = requiresShell(resolved)
      ? spawn(buildShellCommand(bin, args), { shell: true, stdio: 'ignore' })
      : spawn(resolved ?? bin, args, { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })

/** hermes — Nous Research's agent CLI. Its config is YAML, not JSON, so rather than
 *  parsing/writing it ourselves (a YAML dependency, and real risk of corrupting a
 *  hand-edited file) we shell out to hermes's own `config set <dotted.key> <value>`
 *  command, same as its own docs recommend. Schema confirmed directly against a real,
 *  live `hermes config show` on this machine (not just docs): the model block is
 *  `{ provider, base_url, default }` under the top-level `model` key. */
export async function prepareHermes(base: string, _apiKey: string, modelKey: string, _modelName: string, run: RunCommand = realRunCommand): Promise<PrepareResult> {
  const sets: Array<[string, string]> = [
    ['model.provider', 'custom'],
    ['model.base_url', `${base}/v1`],
    ['model.default', modelKey],
  ]
  for (const [key, value] of sets) {
    if (!(await run('hermes', ['config', 'set', key, value]))) {
      return {
        ok: false,
        message:
          `Failed running "hermes config set ${key} ${value}".\n` +
          `Configure it by hand: hermes config set model.provider custom && ` +
          `hermes config set model.base_url ${base}/v1 && hermes config set model.default ${modelKey}`,
      }
    }
  }
  return { ok: true }
}

/**
 * POST /api/v1/engine/start with a modelKey and poll /api/v1/status until the
 * engine reaches state='running' for that model, or until timeoutMs elapses.
 *
 * `_fetch` is injectable for tests.
 */
async function loadAndWait(
  base: string,
  modelKey: string,
  timeoutMs = 180_000,
  _fetch: typeof fetch = fetch,
): Promise<boolean> {
  // POST the load request (fire-and-forget on the daemon side — returns 202).
  const loadRes = await _fetch(`${base}/api/v1/engine/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey }),
    signal: AbortSignal.timeout(5000),
  })
  if (!loadRes.ok) return false

  // Poll status until running with the expected model key.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 1000))
    try {
      const res = await _fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) continue
      const st = (await res.json()) as DaemonStatus
      if (st.engine?.state === 'running' && st.model?.key === modelKey) return true
      // If the engine errored out, stop polling early.
      if (st.engine?.state === 'error') return false
    } catch {
      /* network hiccup — keep polling */
    }
  }
  return false
}

// ── Don't inherit the PARENT agent session's identity (founder-reported, 2026-08-01) ──────────
// Symptom, seen live in a Code terminal: the Claude CLI rendered all-white instead of its normal
// colours, and reported "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".
// Cause: the daemon happened to be started from INSIDE a Claude Code session, and `...process.env`
// below hands the launched CLI every marker that session set on the daemon. The CLI then correctly
// concludes it is a nested child of another agent run and degrades itself accordingly.
//
// This is not exotic: TurboLLM's users are people running coding agents, so starting the daemon
// from within one is an ordinary thing to do, and the failure is silent and confusing when it
// happens. A terminal-agent launch is a NEW, top-level session — it must never adopt another run's
// identity.
//
// Deliberately a targeted list, NOT a blanket `CLAUDE_*` wipe. These are all markers that exist
// only because the PARENT process was itself Claude Code / the Agent SDK; a user's own deliberate
// settings (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, feature toggles, and the like) share the prefix and
// must survive, since a hand-run `turbollm launch claude` from a normal shell is entitled to them.
// `ANTHROPIC_API_KEY` is included for a different reason: we set our own `ANTHROPIC_AUTH_TOKEN`,
// and an inherited key can take precedence over it — which would silently break the session-scoped
// token the gateway uses for per-session overrides and usage attribution (session-auth.ts).
const PARENT_AGENT_ENV_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  // ── Cloud-provider credentials (founder-reported live, 2026-08-18) ──────────────────────────
  // Symptom: pi's `/model` picker listed 38 OpenAI and 22 Google models alongside the 26 TurboLLM
  // ones. Root-caused by measurement, not guesswork — `~/.pi/agent/auth.json` was EMPTY, but the
  // daemon's environment carried the founder's own `OPENAI_API_KEY` and `GEMINI_API_KEY`, and pi
  // treats an env key as auth for its built-in providers (`pi --help`: "--api-key … (defaults to
  // env vars)"; docs/models.md: unauthed models "load but stay unavailable in /model"). Proven by
  // running the real binary both ways:
  //     pi --list-models                              -> 38 openai, 22 google, 26 turbollm
  //     env -u OPENAI_API_KEY -u GEMINI_API_KEY …     -> 26 turbollm, nothing else
  //
  // Stripping them is a correctness fix, not tidying. `turbollm launch <cli>` exists to point a
  // harness at the LOCAL model on this daemon's gateway; a harness that can still see a paid cloud
  // provider can silently run turns against it — billing the user and sending their code off-box
  // for a session they explicitly chose a local model for. Same reasoning that already strips
  // ANTHROPIC_API_KEY below, applied to the rest of the field.
  //
  // A user who genuinely wants a harness on their cloud keys runs that harness directly; going
  // through `turbollm launch` is the statement that this session is local.
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY',
  'ANTHROPIC_API_KEY',
]

/** The environment a launched CLI should inherit: everything this process has, minus any marker
 *  identifying the agent session that started the daemon. Exported for tests.
 *
 *  `extra` adds a harness's OWN nested-session markers (CliSpec.parentEnvMarkers) on top of the
 *  shared list. The shared list applies to every harness, not just claude: the daemon being started
 *  from inside a Claude Code session is what puts those markers on `process.env` in the first
 *  place, and `ANTHROPIC_API_KEY` in particular must not leak into ANY harness that might prefer it
 *  over the credential TurboLLM supplies. */
export function inheritedEnv(base: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of PARENT_AGENT_ENV_MARKERS) delete env[key]
  for (const key of extra) delete env[key]
  return env
}

/** Every launch target whose model list lives in a CONFIG FILE we write, so each must be
 *  re-stamped when the loaded model changes (see syncHarnessModelConfig). Derived from the registry
 *  rather than hand-listed, so a harness added to SUPPORTED with a `prepareConfig` is covered
 *  automatically instead of silently going stale. `claude` is absent because it has no config file —
 *  it learns its context window from an env var set at spawn. */
export const CONFIG_FILE_HARNESSES: readonly string[] =
  Object.keys(SUPPORTED).filter((k) => !!SUPPORTED[k].prepareConfig)

/** Whether this harness's own config already contains a `turbollm` provider — i.e. the user has
 *  launched it through TurboLLM at least once, so refreshing that entry is maintenance of something
 *  they opted into rather than a new file invented on their behalf.
 *
 *  Deliberately a read of the REAL config path per harness. hermes always answers false: its config
 *  is YAML written by shelling out to `hermes config set`, so there is nothing cheap to read and a
 *  probe would mean spawning a process on every model load. It is refreshed at launch instead. */
async function isAlreadyWired(target: string, port: number, fs: ConfigFs): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`
  const paths: Record<string, string> = {
    opencode: join(fs.home, '.config', 'opencode', 'opencode.json'),
    kilo: join(fs.home, '.config', 'kilo', 'kilo.jsonc'),
    openclaw: join(fs.home, '.config', 'openclaw', 'openclaw.json'),
    pi: join(fs.home, '.pi', 'agent', 'models.json'),
  }
  const path = paths[target]
  if (!path) return false
  const read = await readConfigObject(fs, path)
  if ('corrupt' in read) return false
  const cfg = read.obj
  const direct = asObject(cfg.provider)?.turbollm
  const nested = asObject(asObject(cfg.models)?.providers ?? {})?.turbollm
  const piShape = (asObject(cfg.providers) ?? {}).turbollm
  return providerAlreadyPointsHere(direct ?? nested ?? piShape, base)
}

/** Rewrite a harness's DURABLE config for the model that is loaded RIGHT NOW.
 *
 *  ── Why this exists (founder-reported live, 2026-08-19) ────────────────────────────────────────
 *  `prepareConfig` runs once, at launch. It stamps the real loaded context window onto whichever
 *  model was loaded THEN, and every other model gets its native maximum. Switch models mid-session
 *  and the harness re-reads a file that still describes the old state: measured on the founder's box,
 *  `qwen3.6-35b-a3b` (loaded at launch) correctly carried 200704 while the newly-loaded
 *  `qwen3.8-27b|Q3_K_S` showed 262144 — its native max, not the 200704 the engine had actually
 *  loaded it with. The reported symptom was pi displaying "262k" for a model loaded at ~196k.
 *
 *  Re-running the same `prepareConfig` with fresh status closes that. pi re-reads `models.json`
 *  every time `/model` opens (docs/models.md), so the corrected window is picked up with no restart.
 *
 *  ⚠️ Does NOT help a RUNNING opencode session: that one reads its config from the
 *  `OPENCODE_CONFIG_CONTENT` env var, fixed at spawn time, so its ctx stays as of launch until the
 *  terminal is relaunched. Rewriting the durable file still fixes the next launch and any hand-run
 *  `opencode`, which is why it is not skipped. */
export async function syncHarnessModelConfig(
  target: string,
  opts: { port: number; pinnedModel: string; modelName: string; modelCtx?: number; models: ModelEntry[] },
  fs: ConfigFs = realFs,
): Promise<PrepareResult> {
  const spec = Object.hasOwn(SUPPORTED, target) ? SUPPORTED[target] : undefined
  if (!spec?.prepareConfig) return { ok: true } // claude and friends carry no config file — nothing to sync

  // ── Only refresh a harness the user has ALREADY wired to TurboLLM ───────────────────────────
  // A sync runs on EVERY model load, from any path. Without this gate it created and rewrote config
  // files for all five config-file harnesses — including ones the user has never installed and
  // never launched — and `prepareHermes` even spawns `hermes config set` to do it. That is
  // unconsented mutation of another tool's settings as a side effect of loading a model.
  //
  // "Already wired" is a fact on disk: the harness's own config carries a `turbollm` provider,
  // which only a previous `turbollm launch` puts there. A harness the user has never launched is
  // left completely untouched, and starts being synced the moment they do launch it once.
  if (!(await isAlreadyWired(target, opts.port, fs))) return { ok: true }
  const base = `http://127.0.0.1:${opts.port}`
  return await spec.prepareConfig(
    {
      base,
      port: opts.port,
      // The DURABLE file always carries the shared static token, never a session-scoped one — same
      // rule launchCli follows, and for the same reason (this file outlives the launch).
      authToken: AUTH_TOKEN,
      pinnedModel: opts.pinnedModel,
      modelName: opts.modelName,
      modelCtx: opts.modelCtx,
      models: opts.models,
      // A sync refreshes model metadata only — see LaunchContext.pinDefaults.
      pinDefaults: false,
      fs,
    },
    AUTH_TOKEN,
  )
}

/** Launch `target` CLI wired to the TurboLLM gateway on 127.0.0.1:<port>. Returns
 *  the child's exit code (or a non-zero code on a setup failure). Pure launcher —
 *  it never starts the daemon itself.
 *
 *  `modelKey` — when provided, resolve + load that model before launching.
 *  `_spawn` is an optional injection point used by unit tests to capture the env
 *  passed to the child process without actually launching Claude Code.
 *  `_fetch` is an optional injection point used by unit tests to stub HTTP calls.
 *  `authToken` — when provided (embedded terminal launches, `--token`, cli.ts), used instead
 *  of the shared static AUTH_TOKEN for the `claude` target's ANTHROPIC_AUTH_TOKEN, so the
 *  gateway can tell this session's requests apart from any other concurrent terminal-agent
 *  session (session-auth.ts). A manually-run `turbollm launch claude` omits it and keeps
 *  today's shared-token behavior. */
/** Ensure a launched `pi` has the pi-search research package installed, BEST-EFFORT.
 *
 *  Only installs when the package is NOT already present (piSearchPackagePresent) — so the ~3 s
 *  network `pi install` runs AT MOST ONCE per machine, and offline/already-present launches pay
 *  nothing but a local settings read. This is the ONLY mechanism that makes the tools available by
 *  default to every TurboLLM user: `turbollm launch pi` points a standalone `pi` at the daemon over
 *  the OpenAI `/v1` API, where pi declares its own toolset and nothing can inject tools into it, so
 *  the tools have to already be present on the pi side (see ensurePiSearchPackage's caller and the
 *  no-tool-injection note there). A failure here must NEVER break the launch itself — a network
 *  blip, a missing `pi` binary, or a rejected install just degrades to "no web search" with a
 *  one-line stderr note, exactly like the MCP-bridge setup beside it.
 *
 *  `run` and `fs` are injectable so tests can assert the exact command and seed settings.json
 *  without spawning a real pi or touching the real home dir. */
export async function ensurePiSearchPackage(
  run: RunCommand = realRunCommand,
  fs: ConfigFs = realFs,
): Promise<void> {
  if (PI_SEARCH_INSTALL_DISABLED()) return
  if (await piSearchPackagePresent(fs)) return
  // realRunCommand resolves false (never throws) on a spawn error or non-zero exit, so capture the
  // result and surface it — a silently-failed install would otherwise leave the user with "no web
  // search" and no idea why. Still best-effort: the note never fails the launch itself.
  let ok = false
  try {
    ok = await run('pi', ['install', `npm:${PI_SEARCH_PACKAGE_SPEC}`])
  } catch {
    ok = false
  }
  // Disclose BOTH outcomes on stderr — neither is noisy: a success fires exactly once per machine
  // (the presence gate skips every later launch), and a failure is rare. The success disclosure is
  // the supply-chain transparency the risk demands: a successful install must NOT be silent, so a user
  // learns that full-system-access software was added and how to opt out.
  if (ok) {
    process.stderr.write(
      `Note: installed pi research tools (${PI_SEARCH_PACKAGE_SPEC}); web search is now available. ` +
      `Opt out any time with TOBOLLM_PI_DISABLE_SEARCH_INSTALL=1.\n`,
    )
  } else {
    process.stderr.write(
      `Note: could not auto-install pi research tools (${PI_SEARCH_PACKAGE_SPEC}); ` +
      `web search will be unavailable until you run: pi install npm:${PI_SEARCH_PACKAGE_SPEC}.\n`,
    )
  }
}

export async function launchCli(
  target: string,
  port: number,
  passthrough: string[],
  _spawn: SpawnLike = realSpawn,
  modelKey?: string,
  _fetch: typeof fetch = fetch,
  authToken?: string,
  _mcpFs: ConfigFs = realFs,
): Promise<number> {
  const spec = SUPPORTED[target]
  if (!target || !spec) {
    const list = Object.keys(SUPPORTED).join(', ')
    process.stderr.write(`Usage: turbollm launch <cli>   (supported: ${list})\n`)
    return 1
  }

  const base = `http://127.0.0.1:${port}`

  // Confirm the daemon is up before anything else.
  let status: DaemonStatus | null
  try {
    const res = await _fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    status = (await res.json()) as DaemonStatus
  } catch {
    process.stderr.write(
      `Could not reach TurboLLM at ${base}.\n` +
        `Start the daemon first — run \`turbollm\` in another terminal — or pass --port if it runs elsewhere.\n`,
    )
    return 1
  }

  const alreadyRunning =
    status?.engine?.state === 'running' && !!status?.model?.name

  /** Set when `--model` named a model on a LINKED host (ADR-376). Nothing about it is
   *  local: no key to resolve, nothing to load, and no local engine that has to be
   *  running — the gateway's ModelRouter routes the qualified id to the host. */
  let remoteModel: string | null = null

  if (modelKey) {
    // --model given: resolve against the library, then load if not already loaded.
    const models = await fetchModels(base, _fetch)
    const resolvedKey = resolveModelKey(models, modelKey)

    // Turbo Link fallback, and deliberately a FALLBACK rather than a first check: a local
    // key can legitimately contain a slash (`unsloth/Qwen3-GGUF`), so it parses as
    // qualified while naming no machine at all. Local resolution therefore keeps first
    // refusal and its behaviour is completely unchanged — a qualified id only reaches the
    // link path when the local library has nothing for it.
    if (!resolvedKey && isQualifiedId(modelKey)) {
      // The daemon's own `/v1/models` is the authority: it lists exactly the qualified ids
      // the gateway can actually route right now, so an offline machine's models are simply
      // absent and a typo fails HERE rather than at the user's first prompt. Matched
      // EXACTLY — the local resolver ends in a substring match, which is only safe because
      // a wrong local guess still runs on this machine with weights the user can see.
      const advertised = await fetchGatewayModelIds(base, _fetch)
      if (advertised.includes(modelKey)) remoteModel = modelKey
      else {
        const remotes = advertised.filter((id) => isQualifiedId(id))
        process.stderr.write(
          `Model not found: "${modelKey}"\n` +
            (remotes.length
              ? `Models on linked machines:\n${remotes.map((id) => `  ${id}`).join('\n')}\n`
              : `No linked machine is currently online — check Settings → Turbo Link.\n`),
        )
        return 1
      }
    }

    if (!resolvedKey && !remoteModel) {
      const list = models.map((m) => `  ${m.key}  (${m.name})`).join('\n')
      process.stderr.write(
        `Model not found: "${modelKey}"\n` +
          (list ? `Available models:\n${list}\n` : `No models in library — add one via the TurboLLM UI.\n`),
      )
      return 1
    }

    // Past the guards above, `!resolvedKey` means `remoteModel` — the model lives on
    // another machine and there is nothing to load here. Skipping the local load is the
    // whole point: a laptop borrowing a workstation's GPU must not spin up its own engine.
    if (!resolvedKey) {
      // Nothing to do.
    } else if (alreadyRunning && status?.model?.key === resolvedKey) {
      // Fall through to launch.
    } else {
      process.stdout.write(`▸ Loading model "${resolvedKey}"…\n`)
      const loaded = await loadAndWait(base, resolvedKey, 180_000, _fetch)
      if (!loaded) {
        process.stderr.write(
          `Model did not finish loading within 180 s. ` +
            `Check the TurboLLM UI for errors, or try again.\n`,
        )
        return 1
      }
      // Re-fetch status to get the model name for the launch banner.
      const refreshed = await fetchStatus(base, _fetch)
      if (refreshed) status = refreshed
    }
  } else if (status?.selectedRemoteModel && (await fetchGatewayModelIds(base, _fetch)).includes(status.selectedRemoteModel)) {
    // No --model, but the user has pointed this install at a linked machine's model (ADR-382).
    // That choice wins over BOTH auto-loading a local model and reusing whatever happens to be
    // running here: it is an explicit selection, and the founder-reported symptom was exactly
    // this branch not existing — the UI showed a linked machine while this process spent 180 s
    // failing to auto-load a local 27B nobody had asked for.
    //
    // Re-checked against the gateway's OWN advertised ids rather than trusted from config, so a
    // link that went offline since the pick simply falls through to the local path below
    // instead of pinning the CLI to a machine that cannot answer.
    remoteModel = status.selectedRemoteModel
  } else if (!alreadyRunning) {
    // No --model and no model loaded: auto-load the last-used / first available model.
    const models = await fetchModels(base, _fetch)
    if (models.length === 0) {
      process.stderr.write(
        `TurboLLM is running, but no model is loaded and no models are in the library.\n` +
          `Open ${base} → Models → add a model, then run this again.\n`,
      )
      return 1
    }
    // Prefer the true last-used model (exposed on /status as lastLoaded) when it's still
    // in the library; otherwise fall back to the first model in the list, which matches
    // the order the UI presents models.
    const lastKey = status?.lastLoaded?.modelKey
    const autoKey = lastKey && models.some((m) => m.key === lastKey) ? lastKey : models[0].key
    process.stdout.write(`▸ Auto-loading model "${autoKey}"…\n`)
    const loaded = await loadAndWait(base, autoKey, 180_000, _fetch)
    if (!loaded) {
      process.stderr.write(
        `Model did not finish loading within 180 s. ` +
          `Check the TurboLLM UI for errors, then run this again.\n`,
      )
      return 1
    }
    const refreshed = await fetchStatus(base, _fetch)
    if (refreshed) status = refreshed
  }

  // At this point we expect a model to be loaded — UNLESS it is a remote one, in which
  // case the local engine is deliberately untouched and demanding it be running would
  // refuse the one configuration Turbo Link exists to serve: a machine with no GPU of its
  // own driving a linked host's.
  let model: string
  let pinnedModel: string
  if (remoteModel) {
    model = remoteModel
    // Verbatim, qualifier and all: this is exactly what ModelRouter.resolveRemote routes on.
    pinnedModel = remoteModel
  } else {
    if (status?.engine?.state !== 'running' || !status?.model?.name) {
      process.stderr.write(
        `TurboLLM is running, but no model is loaded.\n` +
          `Open ${base} → Models → Load a model, then run this again.\n`,
      )
      return 1
    }
    model = status.model.name
    // Prefer the stable key over the display name — it's what the gateway routes on.
    pinnedModel = status.model.key ?? model
  }
  // Absent when the engine advertises no slot count (vLLM/mlx-lm do their own batching) — in that
  // case no cap is set and the CLI keeps its own default, rather than inventing a limit of 1.
  const parallelSlots = status.engine?.parallelSlots

  // "loaded" would be a lie for a model that is up on ANOTHER machine and was never loaded
  // here — and it is precisely the case the user needs the banner to confirm, since nothing
  // else on this box will show it.
  const modelNote = modelKey
    ? `model: ${model}`
    : remoteModel
      ? `using selected remote model: ${model}`
      : `using loaded model: ${model}`
  process.stdout.write(`▸ Launching ${spec.label} → TurboLLM  (${modelNote}, ${base})\n`)

  // The whole library, for the harnesses whose model picker can only offer what we write into their
  // config (see LaunchContext.models). Best-effort: `fetchModels` already returns [] on any network
  // error, and every consumer falls back to the loaded model alone, so a hiccup degrades the picker
  // rather than failing the launch. Cheap — it is one loopback request.
  const libraryModels = spec.prepareConfig ? await fetchModels(base, _fetch) : []
  // A config-file harness's picker can only offer what we write into its config, and a remote
  // model is not in the LOCAL library — so pinning `turbollm/<machine>/<model>` without adding
  // the row would point the harness at a model it does not know it has. `nativeCtx` is left
  // unset: we have no honest figure for another machine's load profile, and advertisedCtx
  // already prefers omitting the field to inventing a number.
  if (remoteModel && spec.prepareConfig && !libraryModels.some((m) => m.key === remoteModel)) {
    libraryModels.push({ key: remoteModel, name: remoteModel })
  }

  // Everything a per-harness hook needs, resolved once.
  const launchCtx: LaunchContext = {
    base,
    port,
    // A session-scoped token (embedded terminal launches) takes priority over the shared static
    // one, for EVERY harness — not just claude. Before this, the config-file branch below passed
    // the static AUTH_TOKEN unconditionally and dropped `authToken` on the floor, so the gateway
    // could not resolve an opencode/pi session back to its Code session and that session silently
    // lost its thinking-budget override, its reasoning-effort override, its usage attribution and
    // its tool-call timeline (session-auth.ts + gateway.ts).
    authToken: authToken ?? AUTH_TOKEN,
    pinnedModel,
    modelName: model,
    modelCtx: status.model?.ctx,
    parallelSlots,
    models: libraryModels,
    fs: _mcpFs,
  }

  // Config-file tools (opencode/kilo/openclaw/pi/hermes): merge a `turbollm` provider into the
  // tool's own config BEFORE spawning. Deliberately still keyed to the STATIC token: this file is
  // durable, shared, and outlives the launch (a later bare `opencode` must stay wired), so a
  // session-scoped secret must never be written into it. Per-session credentials travel via
  // `spec.env`/`spec.args` instead.
  if (spec.prepareConfig) {
    const prep = await spec.prepareConfig(launchCtx, AUTH_TOKEN)
    if (!prep.ok) {
      process.stderr.write(prep.message + '\n')
      return 1
    }
  }

  // Best-effort: give a launched `pi` its web-search / research tools out of the box so users never
  // have to install them by hand. See ensurePiSearchPackage — a failure here must never break the
  // launch itself. Scoped to pi only: the other harnesses wire tools their own way. The install
  // reuses the SAME injected _spawn as the CLI launch itself (no separate injection point needed),
  // so it gets the identical Windows-safe, no-shell spawn treatment — and tests can assert on it.
  if (target === 'pi') {
    // Route the best-effort install through runWithTimeout so an offline machine can't hang this
    // launch; see that function's doc comment. Still best-effort — a false (timeout/failed) install
    // never fails the launch itself.
    const piSearchRun: RunCommand = (bin, args) =>
      runWithTimeout(_spawn, bin, args, PI_SEARCH_INSTALL_TIMEOUT_MS)
    await ensurePiSearchPackage(piSearchRun, _mcpFs)
  }

  // Per-harness environment. `inheritedEnv` strips parent-agent markers FIRST, so the harness's
  // own settings (which for claude include a CLAUDE_CODE_* flag we DO want) are applied on top and
  // always survive. A harness with no `env` hook gets a clean inherited environment — exactly what
  // the config-file tools already got before this became spec-driven.
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv(process.env, spec.parentEnvMarkers),
    ...(await spec.env?.(launchCtx) ?? {}),
  }

  // Give this launch its routine/agent tools via the daemon's own MCP bridge — see
  // writeClaudeMcpConfig's doc comment for why. Only for a harness with a CONFIRMED flag for it
  // (CliSpec.mcpArgs): opencode instead carries the same bridge inside OPENCODE_CONFIG_CONTENT, and
  // pi reaches the same information through the gateway's own routine guidance. Best-effort — a
  // filesystem hiccup here must not break the launch itself, only the (already-optional) extra
  // tool access.
  let args = spec.args ? [...passthrough, ...spec.args(launchCtx)] : passthrough
  if (spec.mcpArgs) {
    try {
      const mcpConfigPath = await writeClaudeMcpConfig(port, _mcpFs)
      args = [...args, ...spec.mcpArgs(mcpConfigPath)]
    } catch (e) {
      process.stderr.write(`Note: could not set up TurboLLM's routine/agent tools for this session (${e instanceof Error ? e.message : e}).\n`)
    }
  }

  return await spawnWithSessionRecovery(spec, args, {
    stdio: 'inherit',
    // On Windows the CLI is usually a `.cmd`/`.ps1` shim; a shell resolves it via PATHEXT.
    shell: process.platform === 'win32',
    env,
  }, _spawn)
}

/** Swap a session flag for its complement, keeping the id argument in place — e.g.
 *  `--resume <id>` ⇄ `--session-id <id>`. Returns null when args carry neither flag, which is
 *  the normal case for a hand-run `turbollm launch claude`. */
export function swapSessionFlag(args: string[], flags: SessionFlags): string[] | null {
  const i = args.findIndex((a) => a === flags.resume || a === flags.register)
  if (i === -1) return null
  const out = [...args]
  out[i] = out[i] === flags.resume ? flags.register : flags.resume
  return out
}

/** How quickly a launch must die for us to treat it as a session-flag mismatch. Both mismatches
 *  fail during CLI startup (~4 s, measured) before any TUI paints or any model call is made, so
 *  this is generous by an order of magnitude while staying far below any session a user actually
 *  worked in. */
const SESSION_MISMATCH_WINDOW_MS = 30_000

/** Spawn the CLI; if it dies during startup because the session flag didn't match the CLI's
 *  actual state, swap the flag and try once. See CliSpec.sessionFlags for why the daemon can't
 *  just pick the right flag up front.
 *
 *  Deliberately decided on exit code + how fast it died, NOT by reading the CLI's stderr. Piping
 *  stderr to match the CLI's own error text is more precise, and was the first implementation —
 *  but inside a ConPTY (which is how every Code-session terminal runs it, pty-session.ts) that
 *  pipe plus the immediately-following respawn aborts the process natively:
 *  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` — killing the
 *  retry outright. Nothing may come between the CLI and the real terminal handles.
 *
 *  The trade-off: a DIFFERENT startup failure (bad config, missing auth) now also gets retried
 *  once with the other flag, so its error prints twice before surfacing. Accepted — the second
 *  attempt still exits with the real code and shows the real message, and a duplicated error
 *  beats a permanently stranded session. A signal (Ctrl-C) never retries. */
async function spawnWithSessionRecovery(
  spec: CliSpec,
  args: string[],
  opts: Parameters<typeof spawn>[2],
  _spawn: SpawnLike,
): Promise<number> {
  const flags = spec.sessionFlags
  const retryArgs = flags ? swapSessionFlag(args, flags) : null
  if (!flags || !retryArgs) return await waitForChild(_spawn(spec.bin, args, opts), spec)

  const startedAt = Date.now()
  const first = await waitForChildExit(_spawn(spec.bin, args, opts), spec)
  const diedDuringStartup = Date.now() - startedAt < SESSION_MISMATCH_WINDOW_MS
  if (first.code === 0 || first.signal || !diedDuringStartup) return first.code

  // Say which way we're recovering — "starting a fresh one" would be a lie when the id turned
  // out to already exist and we're switching to resuming it.
  process.stdout.write(
    retryArgs.includes(flags.register)
      ? `▸ That ${spec.label} session is gone — starting a fresh one.\n`
      : `▸ That ${spec.label} session already exists — resuming it.\n`,
  )
  return await waitForChild(_spawn(spec.bin, retryArgs, opts), spec)
}

/** Resolve the child's exit code, reporting a friendly install hint on ENOENT. */
async function waitForChild(child: Pick<ReturnType<typeof spawn>, 'on'>, spec: CliSpec): Promise<number> {
  return (await waitForChildExit(child, spec)).code
}

/** As waitForChild, but also reports the terminating signal — session recovery must never treat
 *  a Ctrl-C as a failed launch worth retrying. */
function waitForChildExit(
  child: Pick<ReturnType<typeof spawn>, 'on'>,
  spec: CliSpec,
): Promise<{ code: number; signal: string | null }> {
  return new Promise((resolve) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        process.stderr.write(
          `\n${spec.label} is not installed or not on your PATH.\n` + `Install it:  ${spec.install}\n`,
        )
      } else {
        process.stderr.write(`Failed to launch ${spec.label}: ${e.message}\n`)
      }
      resolve({ code: 127, signal: null })
    })
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null }))
  })
}
