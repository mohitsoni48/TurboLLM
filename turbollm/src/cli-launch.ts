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
  /** Lowercased stderr substrings meaning "wrong flag for this id". */
  mismatch: string[]
}

type PrepareResult = { ok: true } | { ok: false; message: string }

const AUTH_TOKEN = 'turbollm-local'

const SUPPORTED: Record<string, CliSpec> = {
  claude: {
    bin: 'claude',
    label: 'Claude Code',
    install: 'npm install -g @anthropic-ai/claude-code',
    // Measured against the real CLI: both mismatches exit 1 with nothing on stdout and one of
    // these lines on stderr, before any TUI paints or any model call is made.
    //   --session-id <existing> -> "Error: Session ID <uuid> is already in use."
    //   --resume     <unknown>  -> "No conversation found with session ID: <uuid>"
    sessionFlags: {
      register: '--session-id',
      resume: '--resume',
      mismatch: ['no conversation found with session id', 'is already in use'],
    },
  },
  opencode: { bin: 'opencode', label: 'opencode', install: 'npm install -g opencode-ai', prepareConfig: prepareOpencode },
  kilo: { bin: 'kilo', label: 'Kilo Code', install: 'npm install -g @kilocode/cli', prepareConfig: prepareKilo },
  openclaw: { bin: 'openclaw', label: 'openclaw', install: 'npm install -g openclaw@latest', prepareConfig: prepareOpenclaw },
  hermes: { bin: 'hermes', label: 'Hermes Agent', install: 'npm install -g hermes-agent', prepareConfig: prepareHermes },
  pi: { bin: 'pi', label: 'pi', install: 'npm install -g @earendil-works/pi-coding-agent', prepareConfig: preparePi },
}

interface DaemonStatus {
  engine?: { state?: string }
  model?: { name?: string; key?: string } | null
  lastLoaded?: { modelKey?: string } | null
}

interface ModelEntry {
  key: string
  name: string
}

// Type-safe subset of spawn's return value that launchCli actually uses. `stderr` is optional
// because test fakes hand back a bare EventEmitter — session recovery degrades to "no retry"
// rather than throwing when it isn't there.
type SpawnedChild = Pick<ReturnType<typeof spawn>, 'on'> & Partial<Pick<ReturnType<typeof spawn>, 'stderr'>>
type SpawnLike = (cmd: string, args: string[], opts: Parameters<typeof spawn>[2]) => SpawnedChild

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
  _spawn: SpawnLike = spawn,
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
      env: process.env,
    }, _spawn)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
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

/** Spawn the CLI; if it dies immediately because the session flag didn't match the CLI's actual
 *  state, swap the flag and try once. Only that specific, self-identified failure retries — any
 *  other non-zero exit is passed straight through, so a genuine error is never masked or run
 *  twice. See CliSpec.sessionFlags for why the daemon can't just pick the right flag up front. */
async function spawnWithSessionRecovery(
  spec: CliSpec,
  args: string[],
  opts: Parameters<typeof spawn>[2],
  _spawn: SpawnLike,
): Promise<number> {
  const flags = spec.sessionFlags
  const retryArgs = flags ? swapSessionFlag(args, flags) : null
  // No session flag in play — spawn normally so the CLI keeps the real stderr handle.
  if (!flags || !retryArgs) return await waitForChild(_spawn(spec.bin, args, opts), spec)

  const child = _spawn(spec.bin, args, { ...opts, stdio: ['inherit', 'inherit', 'pipe'] })
  let captured = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    // Forward verbatim and immediately — the CLI's own output must reach the user unchanged.
    process.stderr.write(chunk)
    if (captured.length < 4096) captured += String(chunk)
  })

  const code = await waitForChild(child, spec)
  const lower = captured.toLowerCase()
  if (code === 0 || !flags.mismatch.some((m) => lower.includes(m))) return code

  // Say which way we're recovering — "starting a fresh one" would be a lie when the id turned
  // out to already exist and we're switching to resuming it.
  const startingFresh = retryArgs.includes(flags.register)
  process.stdout.write(
    startingFresh
      ? `▸ That ${spec.label} session is gone — starting a fresh one.\n`
      : `▸ That ${spec.label} session already exists — resuming it.\n`,
  )
  return await waitForChild(_spawn(spec.bin, retryArgs, opts), spec)
}

/** Resolve the child's exit code, reporting a friendly install hint on ENOENT. */
function waitForChild(child: Pick<ReturnType<typeof spawn>, 'on'>, spec: CliSpec): Promise<number> {
  return new Promise<number>((resolve) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        process.stderr.write(
          `\n${spec.label} is not installed or not on your PATH.\n` + `Install it:  ${spec.install}\n`,
        )
      } else {
        process.stderr.write(`Failed to launch ${spec.label}: ${e.message}\n`)
      }
      resolve(127)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}
