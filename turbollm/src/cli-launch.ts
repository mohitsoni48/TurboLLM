// `turbollm launch <cli>` — start a coding CLI already wired to the local TurboLLM
// gateway, so it uses whatever model is loaded here instead of a cloud API (spec 06
// §6). Ships with the npm package.
//
// The daemon must already be running; this command is a thin launcher. If no model is
// loaded, it auto-loads the last-used model (or the first available one). With --model
// it resolves and loads a specific model by key/name before launching.
//
// Two wiring styles: Anthropic-protocol tools (claude) get ANTHROPIC_* env vars at
// spawn time; config-file tools (opencode/kilo/openclaw) get a `turbollm` provider
// merged into their own config file (prepareConfig) before spawning.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { buildShellCommand } from './util/shell-command'
import { requiresShell, resolveExecutable } from './util/resolve-executable'

interface CliSpec {
  bin: string
  label: string
  install: string
  // Anthropic-protocol tools (today: claude) get ANTHROPIC_* env vars set at spawn time.
  // Config-file tools (opencode/kilo/openclaw) instead get this called once before spawn
  // to merge a local-gateway provider entry into the tool's own config file.
  prepareConfig?: (base: string, apiKey: string, modelKey: string, modelName: string) => Promise<PrepareResult>
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
  },
  opencode: { bin: 'opencode', label: 'opencode', install: 'npm install -g opencode-ai', prepareConfig: prepareOpencode },
  kilo: { bin: 'kilo', label: 'Kilo Code', install: 'npm install -g @kilocode/cli', prepareConfig: prepareKilo },
  openclaw: { bin: 'openclaw', label: 'openclaw', install: 'npm install -g openclaw@latest', prepareConfig: prepareOpenclaw },
  hermes: { bin: 'hermes', label: 'Hermes Agent', install: 'npm install -g hermes-agent', prepareConfig: prepareHermes },
  pi: { bin: 'pi', label: 'pi', install: 'npm install -g @earendil-works/pi-coding-agent', prepareConfig: preparePi },
}

interface DaemonStatus {
  engine?: { state?: string; parallelSlots?: number }
  model?: { name?: string; key?: string } | null
  lastLoaded?: { modelKey?: string } | null
}

interface ModelEntry {
  key: string
  name: string
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

/** opencode — merge a `turbollm` provider into ~/.config/opencode/opencode.json,
 *  preserving every sibling provider the user already configured. Shape mirrors
 *  buildConnectSnippets (routes.ts) so both surfaces stay in lockstep. */
export async function prepareOpencode(base: string, apiKey: string, _modelKey: string, modelName: string, fs: ConfigFs = realFs): Promise<PrepareResult> {
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
    models: { [modelName]: { id: modelName } },
  }
  cfg.provider = provider
  await fs.mkdir(dirname(path))
  await fs.writeFile(path, JSON.stringify(cfg, null, 2) + '\n')
  return { ok: true }
}

/** kilo — Kilo Code is built on the opencode stack and uses the SAME provider shape
 *  (verified against the live install: an array-form `models` is rejected with
 *  "Expected object"). Its real config file is `kilo.jsonc` (JSONC — comments allowed),
 *  confirmed against the live install, NOT `kilo.json`. Merge the `turbollm` provider
 *  and set it as the default via the top-level `model` string. */
export async function prepareKilo(base: string, apiKey: string, _modelKey: string, modelName: string, fs: ConfigFs = realFs): Promise<PrepareResult> {
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
    models: { [modelName]: { id: modelName } },
  }
  cfg.provider = provider
  // provider/model key selects the default model kilo boots with (format: provider/mapKey).
  cfg.model = `turbollm/${modelName}`
  await fs.mkdir(dirname(path))
  await fs.writeFile(path, JSON.stringify(cfg, null, 2) + '\n')
  return { ok: true }
}

/** openclaw — merge a `turbollm` provider under models.providers and set it as the
 *  default primary model. Path per its docs (~/.config/openclaw/openclaw.json); the
 *  CLI isn't installed on this box to verify empirically, so the path is assumed.
 *  We write plain JSON (valid JSON5); JSON5-only files are handled on the READ side
 *  by refusing to overwrite an unparseable file. */
export async function prepareOpenclaw(base: string, apiKey: string, modelKey: string, modelName: string, fs: ConfigFs = realFs): Promise<PrepareResult> {
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
  defaults.model = { primary: `turbollm/${modelKey}` }
  agents.defaults = defaults
  cfg.agents = agents
  await fs.mkdir(dirname(path))
  await fs.writeFile(path, JSON.stringify(cfg, null, 2) + '\n')
  return { ok: true }
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
export async function preparePi(base: string, apiKey: string, modelKey: string, modelName: string, fs: ConfigFs = realFs): Promise<PrepareResult> {
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
      models: [{ id: modelKey, name: modelName }],
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
  settingsCfg.defaultProvider = 'turbollm'
  settingsCfg.defaultModel = modelKey
  await fs.mkdir(dirname(settingsPath))
  await fs.writeFile(settingsPath, JSON.stringify(settingsCfg, null, 2) + '\n')
  return { ok: true }
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
    const child = spawn(bin, args, { stdio: 'ignore' })
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
  'ANTHROPIC_API_KEY',
]

/** The environment a launched CLI should inherit: everything this process has, minus any marker
 *  identifying the agent session that started the daemon. Exported for tests. */
export function inheritedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of PARENT_AGENT_ENV_MARKERS) delete env[key]
  return env
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
export async function launchCli(
  target: string,
  port: number,
  passthrough: string[],
  _spawn: SpawnLike = realSpawn,
  modelKey?: string,
  _fetch: typeof fetch = fetch,
  authToken?: string,
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

  if (modelKey) {
    // --model given: resolve against the library, then load if not already loaded.
    const models = await fetchModels(base, _fetch)
    const resolvedKey = resolveModelKey(models, modelKey)
    if (!resolvedKey) {
      const list = models.map((m) => `  ${m.key}  (${m.name})`).join('\n')
      process.stderr.write(
        `Model not found: "${modelKey}"\n` +
          (list ? `Available models:\n${list}\n` : `No models in library — add one via the TurboLLM UI.\n`),
      )
      return 1
    }
    // Already loaded with the same key — skip the load.
    if (alreadyRunning && status?.model?.key === resolvedKey) {
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

  // At this point we expect a model to be loaded.
  if (status?.engine?.state !== 'running' || !status?.model?.name) {
    process.stderr.write(
      `TurboLLM is running, but no model is loaded.\n` +
        `Open ${base} → Models → Load a model, then run this again.\n`,
    )
    return 1
  }
  const model = status.model.name
  // Prefer the stable key over the display name — it's what the gateway routes on.
  const pinnedModel = status.model.key ?? model
  // Absent when the engine advertises no slot count (vLLM/mlx-lm do their own batching) — in that
  // case no cap is set and the CLI keeps its own default, rather than inventing a limit of 1.
  const parallelSlots = status.engine?.parallelSlots

  const modelNote = modelKey ? `model: ${model}` : `using loaded model: ${model}`
  process.stdout.write(`▸ Launching ${spec.label} → TurboLLM  (${modelNote}, ${base})\n`)

  // Config-file tools (opencode/kilo/openclaw): merge a `turbollm` provider into the
  // tool's own config BEFORE spawning, then spawn with a clean env (no ANTHROPIC_* —
  // those are meaningless to non-Anthropic-protocol tools).
  if (spec.prepareConfig) {
    const prep = await spec.prepareConfig(base, AUTH_TOKEN, pinnedModel, model)
    if (!prep.ok) {
      process.stderr.write(prep.message + '\n')
      return 1
    }
    return await spawnWithSessionRecovery(spec, passthrough, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: inheritedEnv(),
    }, _spawn)
  }

  const env: NodeJS.ProcessEnv = {
    // Parent-agent markers stripped first, so TurboLLM's own settings below (which include a
    // CLAUDE_CODE_* flag we DO want) are applied on top and always survive.
    ...inheritedEnv(),
    ANTHROPIC_BASE_URL: base,
    // No auth is enforced on the local gateway; the CLI just needs a non-empty token. A
    // session-scoped token (embedded terminal launches) takes priority over the shared static
    // one so the gateway can attribute this session's requests correctly (session-auth.ts).
    ANTHROPIC_AUTH_TOKEN: authToken ?? AUTH_TOKEN,
    // Local LLMs are 30–120 s per response — raise Claude Code's request timeout so it
    // doesn't abort mid-generation. 300 s (5 min) covers even the slowest local model.
    // Zero retries: retrying a slow local model cold-starts it again and makes things worse.
    ANTHROPIC_TIMEOUT: '300000',
    ANTHROPIC_MAX_RETRIES: '0',
    // Always pin the loaded model's id (key preferred). Claude Code uses the model string
    // for real client-side bookkeeping even behind a custom base URL — the status line,
    // `/status`, and context-window / auto-compact sizing all read it — and never validates
    // it against a cloud catalog when ANTHROPIC_BASE_URL is custom. Pinning to whatever's
    // actually loaded is therefore safe and fixes those surfaces from silently assuming a
    // wrong cloud default.
    ANTHROPIC_MODEL: pinnedModel,
    // Opt into gateway model discovery: Claude Code queries our /v1/models at startup and
    // populates the /model picker with the local library (gateway synthesises the entries).
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    // Cap background-agent fan-out at what the engine can actually run concurrently.
    //
    // Claude Code spawns subagents in parallel, and each is a full, independent request to the
    // gateway. Against a `--parallel 1` llama-server they don't merely queue — they evict each
    // other's cached prompt prefix, so every one re-prefills from scratch, and each sits on a
    // held-open connection counting against ANTHROPIC_TIMEOUT above. Telling the CLI the real
    // number lets IT queue the rest, which is far better than having them all pile into the
    // gateway and block there.
    //
    // The gateway enforces the same limit independently (gateway.ts acquires d.gate), so a CLI
    // that ignores this — or one a user launched by hand — still cannot exceed the engine. This
    // is the cooperative half: it makes the excess queue politely client-side instead of being
    // held at the HTTP layer.
    ...(parallelSlots ? { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(parallelSlots) } : {}),
  }

  return await spawnWithSessionRecovery(spec, passthrough, {
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
