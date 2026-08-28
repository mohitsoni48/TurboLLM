// Regression coverage: EVERY harness must present its session-scoped auth token, not just claude.
//
// ── The bug this pins ───────────────────────────────────────────────────────────────────────────
// `launchCli` has always accepted an `authToken` (minted per Code session by session-auth.ts) and
// used it for claude's ANTHROPIC_AUTH_TOKEN. The config-file branch dropped it on the floor and
// passed the shared static 'turbollm-local' instead, so for opencode/pi/kilo/openclaw the gateway's
// `sessionAuth.resolve(token)` returned null and that session silently lost ALL of:
//   - its thinking-budget override        (TerminalToolbar's slider became a no-op)
//   - its reasoning-effort override
//   - per-session usage attribution       (api_usage.code_session_id stayed null)
//   - its tool-call timeline              (the Code launchpad's filesTouched/diff tiles stayed empty)
//
// ── Why the token must NOT go in the config file ────────────────────────────────────────────────
// The obvious "fix" is to write the session token into the provider entry `prepareConfig` already
// writes. That would be a concurrency bug: those paths are GLOBAL and shared
// (`~/.config/opencode/opencode.json`, `~/.pi/agent/models.json`), so two Code sessions launching
// at once race on one file, last writer wins, and the loser silently presents the winner's identity
// to the gateway — i.e. it would get the other session's thinking budget and bill its usage to the
// wrong session. The per-session token therefore travels by a PER-PROCESS channel: a CLI flag for
// pi (`--api-key`), an env var for opencode (`OPENCODE_CONFIG_CONTENT`). These tests pin both, and
// pin that the shared file keeps the static token.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { buildOpencodeConfigContent, launchCli, prepareOpencode, preparePi, type ConfigFs } from './cli-launch.js'

const HOME = '/home/tester'
const SESSION_TOKEN = 'tllm-cs-deadbeefdeadbeefdeadbeef'
const STATIC_TOKEN = 'turbollm-local'

function memFs(seed: Record<string, string> = {}): ConfigFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    home: HOME,
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: async (p: string, data: string) => { files.set(p, data) },
    mkdir: async () => {},
  }
}

interface Captured { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

/** Unlike the other cli-launch test files' helpers, this one also captures `opts.env` — the env is
 *  exactly what's under test here. */
function makeSpawn(): { calls: Captured[]; fn: Parameters<typeof launchCli>[3] } {
  const calls: Captured[] = []
  const fn: Parameters<typeof launchCli>[3] = (cmd, args, opts) => {
    calls.push({ cmd, args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv })
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    setImmediate(() => ee.emit('exit', 0, null))
    return ee
  }
  return { calls, fn }
}

/** The real pi CLI launch call — NOT the best-effort `pi install` that ensurePiSearchPackage runs
 *  first (which now lands at calls[0]). Distinguished by the --api-key flag the install call never
 *  carries. Every test here asserts on the CLI launch, so they all go through this. */
function piLaunch(calls: Captured[]): Captured {
  const launch = calls.find((c) => c.args.includes('--api-key'))
  const allCalls = JSON.stringify(calls.map((c) => [c.cmd, c.args]))
  assert.ok(launch, `expected the pi CLI launch (with --api-key); got ${allCalls}`)
  return launch
}

/** Swallow only launchCli's own `▸ …` banner lines, exactly as cli-launch.mcp.test.ts does.
 *  A blanket stdout override also eats node:test's OWN reporter output, which silently hides every
 *  result produced while it is installed — measured while writing this file. */
function silenceOutput(): () => void {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  return () => { process.stdout.write = outW; process.stderr.write = errW }
}

function makeFetch(): typeof fetch {
  const fn = async (input: string | URL | globalThis.Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      return {
        ok: true, status: 200,
        json: async () => ({ engine: { state: 'running', parallelSlots: 2 }, model: { key: 'mykey', name: 'MyModel', ctx: 32768 } }),
      } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return fn as unknown as typeof fetch
}

// ── pi: the token is a CLI flag ─────────────────────────────────────────────

test('pi: a session-scoped token is passed as --api-key', async () => {
  const { calls, fn } = makeSpawn()
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, [], fn, undefined, makeFetch(), SESSION_TOKEN, memFs())
  } finally { restore() }
  // Two spawns now: the best-effort `pi install` (ensurePiSearchPackage) runs first, then the CLI.
  assert.ok(calls.length >= 1)
  const i = piLaunch(calls).args.indexOf('--api-key')
  assert.ok(i !== -1, `--api-key missing from ${JSON.stringify(piLaunch(calls).args)}`)
  assert.equal(piLaunch(calls).args[i + 1], SESSION_TOKEN)
})

test('pi: --api-key is ALWAYS accompanied by an explicit provider and model', async () => {
  // Measured live, 2026-08-18: passing --api-key alone killed the launch at startup with
  //   "Error: --api-key requires a model to be specified via --model, --provider/--model, or --models"
  // A key with no model is ambiguous to pi — it cannot tell which provider the credential is for,
  // and settings.json's defaultProvider/defaultModel are not consulted for this check.
  const { calls, fn } = makeSpawn()
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, [], fn, undefined, makeFetch(), SESSION_TOKEN, memFs())
  } finally { restore() }
  const args = piLaunch(calls).args
  assert.ok(args.includes('--api-key'), 'precondition: the flag under test is present')
  const p = args.indexOf('--provider')
  const m = args.indexOf('--model')
  assert.ok(p !== -1, `--provider missing from ${JSON.stringify(args)}`)
  assert.ok(m !== -1, `--model missing from ${JSON.stringify(args)}`)
  assert.equal(args[p + 1], 'turbollm')
  assert.equal(args[m + 1], 'mykey', 'the model must be the loaded model KEY, which is what the gateway routes on')
})

test('pi: a model key containing "|" is quoted, not treated as a cmd.exe pipe', async () => {
  // Real keys look like `qwen3.6-35b-a3b|IQ3_XXS|13211155424`, and pi takes the SHELL path on
  // Windows (it resolves to pi.cmd), where `|` is a pipe. Safety here comes from
  // buildShellCommand's strict allow-list, which excludes `|` — this pins that it stays excluded.
  const { quoteWindowsArg } = await import('./util/shell-command.js')
  const key = 'qwen3.6-35b-a3b|IQ3_XXS|13211155424'
  const quoted = quoteWindowsArg(key)
  assert.notEqual(quoted, key, 'a key containing a pipe must not be passed through unquoted')
  assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), quoted)
})

test('pi: a hand-run launch (no session token) still gets the shared static one', async () => {
  const { calls, fn } = makeSpawn()
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, [], fn, undefined, makeFetch(), undefined, memFs())
  } finally { restore() }
  const i = piLaunch(calls).args.indexOf('--api-key')
  assert.equal(piLaunch(calls).args[i + 1], STATIC_TOKEN)
})

test('pi: the SHARED config file keeps the static token, never the session one', async () => {
  // The whole point of the flag: this file is durable and shared between sessions, so a
  // session-scoped secret must never land in it.
  const fs = memFs()
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, [], makeSpawn().fn, undefined, makeFetch(), SESSION_TOKEN, fs)
  } finally { restore() }
  const models = fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!
  assert.ok(models.includes(STATIC_TOKEN))
  assert.ok(!models.includes(SESSION_TOKEN), 'a per-session token must never be written to a shared config file')
})

test('pi: passthrough args are preserved ahead of our own flags', async () => {
  const { calls, fn } = makeSpawn()
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, ['--session-id', 'abc'], fn, undefined, makeFetch(), SESSION_TOKEN, memFs())
  } finally { restore() }
  assert.deepEqual(piLaunch(calls).args.slice(0, 2), ['--session-id', 'abc'])
})

// ── opencode: the token rides an env var ─────────────────────────────────────

test('opencode: the session token rides OPENCODE_CONFIG_CONTENT, not the config file', async () => {
  const fs = memFs()
  const { calls, fn } = makeSpawn()
  const restore = silenceOutput()
  try {
    await launchCli('opencode', 6996, [], fn, undefined, makeFetch(), SESSION_TOKEN, fs)
  } finally { restore() }
  const content = calls[0].env.OPENCODE_CONFIG_CONTENT
  assert.ok(content, 'OPENCODE_CONFIG_CONTENT must be set')
  const parsed = JSON.parse(content)
  assert.equal(parsed.provider.turbollm.options.apiKey, SESSION_TOKEN)
  assert.equal(parsed.provider.turbollm.options.baseURL, 'http://127.0.0.1:6996/v1')

  const onDisk = fs.files.get(join(HOME, '.config', 'opencode', 'opencode.json'))!
  assert.ok(onDisk.includes(STATIC_TOKEN))
  assert.ok(!onDisk.includes(SESSION_TOKEN), 'a per-session token must never be written to a shared config file')
})

test('opencode: none of claude\'s own wiring is applied to a non-Anthropic harness', async () => {
  // Asserts what WE set, not what the env happens to contain: `inheritedEnv` deliberately passes
  // the daemon's own environment through, so a developer whose shell already exports
  // ANTHROPIC_BASE_URL (measured: this machine does) would fail a blanket prefix check for a
  // reason that has nothing to do with opencode. The keys below are the ones claudeEnv sets.
  const { calls, fn } = makeSpawn()
  const restore = silenceOutput()
  try {
    await launchCli('opencode', 6996, [], fn, undefined, makeFetch(), SESSION_TOKEN, memFs())
  } finally { restore() }
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_TIMEOUT',
    'ANTHROPIC_MAX_RETRIES',
    'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  ]) {
    assert.equal(calls[0].env[key], undefined, `${key} is claude-only and must not be set for opencode`)
  }
  // And the session token must never be smuggled in under an Anthropic name either.
  assert.notEqual(calls[0].env.ANTHROPIC_AUTH_TOKEN, SESSION_TOKEN)
})

test('launchCli: a config-file harness writes ONLY through the injected fs, never the real one', async () => {
  // This is the regression guard for a real incident: `launchCli` used to call `spec.prepareConfig`
  // without threading its own injected `ConfigFs`, so the implementations fell back to their
  // `realFs` default and a unit test rewrote this machine's actual ~/.pi and ~/.config/opencode
  // files. Every write must land in the in-memory map.
  const fs = memFs()
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, [], makeSpawn().fn, undefined, makeFetch(), SESSION_TOKEN, fs)
    await launchCli('opencode', 6996, [], makeSpawn().fn, undefined, makeFetch(), SESSION_TOKEN, fs)
  } finally { restore() }
  const written = [...fs.files.keys()]
  assert.ok(written.some((p) => p.includes(join('.pi', 'agent', 'models.json'))), `pi config not written to the injected fs: ${written}`)
  assert.ok(written.some((p) => p.includes(join('.config', 'opencode', 'opencode.json'))), `opencode config not written to the injected fs: ${written}`)
  // Every path must be under the FAKE home, which is what proves nothing escaped to the real one.
  // Separator-normalised: `join` emits `\` on Windows while HOME is written with `/`.
  const underFakeHome = (p: string) => p.replace(/\\/g, '/').startsWith(HOME)
  for (const p of written) assert.ok(underFakeHome(p), `${p} is outside the injected home`)
})

// ── buildOpencodeConfigContent ──────────────────────────────────────────────

test('buildOpencodeConfigContent: preserves the user\'s own providers, agents and mcp servers', async () => {
  // An inline config REPLACES the file for that process, so building it from scratch would silently
  // drop everything the user configured. It must be a merge onto their real config.
  const fs = memFs({
    [join(HOME, '.config', 'opencode', 'opencode.json')]: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: { anthropic: { options: { apiKey: 'theirs' } } },
      agent: { reviewer: { prompt: 'be picky' } },
      mcp: { theirs: { type: 'local', command: ['their-server'] } },
    }),
  })
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', 6996, fs)
  const parsed = JSON.parse(content!)
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json')
  assert.deepEqual(parsed.provider.anthropic, { options: { apiKey: 'theirs' } })
  assert.deepEqual(parsed.agent, { reviewer: { prompt: 'be picky' } })
  assert.deepEqual(parsed.mcp.theirs, { type: 'local', command: ['their-server'] })
  // and ours is added alongside
  assert.equal(parsed.provider.turbollm.options.apiKey, SESSION_TOKEN)
  assert.deepEqual(parsed.mcp.turbollm.command, ['npx', 'turbollm', 'mcp-server', '--port', '6996'])
})

test('buildOpencodeConfigContent: a COMMENTED config is fine here — it is only ever read', async () => {
  // prepareOpencode has to refuse a commented config because REWRITING it would delete the
  // comments. This path never writes, so the same file is usable.
  const fs = memFs({
    [join(HOME, '.config', 'opencode', 'opencode.json')]: `{
      // my notes
      "provider": { "anthropic": { "options": { "apiKey": "theirs" } } }
    }`,
  })
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', 6996, fs)
  assert.ok(content, 'a commented config must still yield an inline config')
  const parsed = JSON.parse(content!)
  assert.equal(parsed.provider.turbollm.options.apiKey, SESSION_TOKEN)
  assert.deepEqual(parsed.provider.anthropic, { options: { apiKey: 'theirs' } })
  // The file itself is untouched — comments intact.
  assert.ok(fs.files.get(join(HOME, '.config', 'opencode', 'opencode.json'))!.includes('// my notes'))
})

test('buildOpencodeConfigContent: an unparseable config yields null, not a wrecked config', async () => {
  const fs = memFs({ [join(HOME, '.config', 'opencode', 'opencode.json')]: '{{{ not json' })
  assert.equal(await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'k', 'M', 6996, fs), null)
})

test('buildOpencodeConfigContent: mcpPort null adds no mcp entry at all', async () => {
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'k', 'M', null, memFs())
  assert.equal(JSON.parse(content!).mcp, undefined)
})

// ── claude is unchanged ─────────────────────────────────────────────────────

test('claude: still gets the session token as ANTHROPIC_AUTH_TOKEN (unchanged behaviour)', async () => {
  const { calls, fn } = makeSpawn()
  const restore = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, makeFetch(), SESSION_TOKEN, memFs())
  } finally { restore() }
  assert.equal(calls[0].env.ANTHROPIC_AUTH_TOKEN, SESSION_TOKEN)
  assert.equal(calls[0].env.ANTHROPIC_MODEL, 'mykey')
  // ctx 32768 is below the CLI's documented 100_000 floor, so it clamps up to the floor.
  assert.equal(calls[0].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '100000')
  assert.equal(calls[0].env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '2')
  assert.ok(calls[0].args.includes('--mcp-config'))
})

// ── The REAL context window must reach the harness ─────────────────────────────────────────────
// Founder-reported live, 2026-08-18: a model loaded with a 200K window showed "128K" inside pi.
// 128000 is pi's OWN documented default (docs/models.md) — we simply never told it otherwise. This
// is not cosmetic: pi's auto-compaction triggers on `contextTokens > contextWindow - reserveTokens`
// (docs/compaction.md), so a wrong window compacts far too early on a big model, and on a small one
// never compacts at all and overflows the real engine instead. It is the same class of bug ADR-341
// fixed for claude via CLAUDE_CODE_AUTO_COMPACT_WINDOW.

test('pi: the loaded model\'s REAL context window is written to models.json', async () => {
  const fs = memFs()
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, [], makeSpawn().fn, undefined, makeFetch(), SESSION_TOKEN, fs)
  } finally { restore() }
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!)
  // makeFetch reports ctx 32768 — pi must be told that, not left on its 128000 default.
  assert.equal(models.providers.turbollm.models[0].contextWindow, 32768)
})

test('opencode: the real context window rides the inline config as limit.context', async () => {
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', 6996, memFs(), 200000)
  const entry = JSON.parse(content!).provider.turbollm.models.mykey
  assert.equal(entry.limit.context, 200000)
  // opencode's schema REQUIRES output alongside context, so it must be present and positive.
  assert.ok(typeof entry.limit.output === 'number' && entry.limit.output > 0, JSON.stringify(entry))
})

test('an UNKNOWN ctx is omitted rather than guessed, for both harnesses', async () => {
  // A daemon that reports no ctx means "don't know". Each harness's own default is a better answer
  // than a number we invented — the same rule clampAutoCompactWindow follows for claude.
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', null, memFs(), undefined)
  assert.equal(JSON.parse(content!).provider.turbollm.models.mykey.limit, undefined)

  const fs = memFs()
  const noCtxFetch = (async (input: string | URL | globalThis.Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      return { ok: true, status: 200, json: async () => ({ engine: { state: 'running' }, model: { key: 'k', name: 'n' } }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  const restore = silenceOutput()
  try {
    await launchCli('pi', 6996, [], makeSpawn().fn, undefined, noCtxFetch, SESSION_TOKEN, fs)
  } finally { restore() }
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!)
  assert.equal(models.providers.turbollm.models[0].contextWindow, undefined)
})

// ── The whole LIBRARY must reach a config-file harness, not just the loaded model ───────────────
// Founder-reported: "I can't see turbollm models" in pi's `/model` picker. claude gets a real picker
// for free — the gateway advertises every model on /v1/models and CLAUDE_CODE_ENABLE_GATEWAY_MODEL_
// DISCOVERY tells it to read them. A config-file harness has no discovery channel: it can only offer
// what we WRITE. We wrote exactly one entry (the loaded model), so its picker had one row.

const LIBRARY = [
  { key: 'a|Q4|1', name: 'Model A', nativeCtx: 262144 },
  { key: 'mykey', name: 'MyModel', nativeCtx: 262144 },
  { key: 'c|Q8|3', name: 'Model C' },
]

test('pi: every library model is written, not just the loaded one', async () => {
  const fs = memFs()
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', fs, 32768, LIBRARY)
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!).providers.turbollm.models
  assert.equal(models.length, 3)
  assert.deepEqual(models.map((m: { id: string }) => m.id), ['a|Q4|1', 'mykey', 'c|Q8|3'])
})

test('pi: the LOADED model carries its real loaded ctx; the others carry nativeCtx', async () => {
  // A load profile routinely caps ctx far below native (262144-native loaded at 32768), so the
  // loaded model's true window is the daemon's figure — the rest can only be estimated from
  // metadata, and each is corrected the moment it becomes the loaded one.
  const fs = memFs()
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', fs, 32768, LIBRARY)
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!).providers.turbollm.models
  const by = (id: string) => models.find((m: { id: string }) => m.id === id)
  assert.equal(by('mykey').contextWindow, 32768, 'loaded model uses the REAL loaded ctx, not native')
  assert.equal(by('a|Q4|1').contextWindow, 262144, 'an unloaded model uses its native max')
  assert.equal(by('c|Q8|3').contextWindow, undefined, 'no native ctx known -> omitted, never guessed')
})

test('pi: an empty library degrades to the loaded model alone, never an empty picker', async () => {
  const fs = memFs()
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', fs, 32768, [])
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!).providers.turbollm.models
  assert.deepEqual(models, [{ id: 'mykey', name: 'MyModel', contextWindow: 32768 }])
})

test('opencode: the whole library is written, keyed by model KEY not display name', async () => {
  // Two library entries can share a display name (same model, two quantisations); keying by name
  // silently collapses them into one picker row, and the key is what the gateway routes on.
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', 6996, memFs(), 32768, LIBRARY)
  const models = JSON.parse(content!).provider.turbollm.models
  assert.deepEqual(Object.keys(models), ['a|Q4|1', 'mykey', 'c|Q8|3'])
  assert.equal(models['mykey'].limit.context, 32768, 'loaded model uses the real loaded ctx')
  assert.equal(models['a|Q4|1'].limit.context, 262144)
  assert.equal(models['c|Q8|3'].limit, undefined, 'unknown ctx -> no limit block at all')
  assert.equal(models['a|Q4|1'].name, 'Model A', 'the human-readable label is preserved alongside the key')
})

// ── Every model advertises its CONFIGURED window, not just the loaded one ───────────────────────
// Founder's design point: "this is highly unlikely that someone would change ctx of a model config
// in mid of code" — so the picker should be right for ALL models up front rather than depending on
// a load-time sync firing. `configuredCtx` (the model's saved profile for the active engine) is
// what it WOULD load with; `nativeCtx` is only the metadata ceiling and was previously advertised
// for every model except the loaded one.

const LIB_CFG = [
  // configured well below native — the case that used to advertise 262144
  { key: 'a|Q4|1', name: 'Model A', nativeCtx: 262144, configuredCtx: 163328 },
  // the loaded one, whose ACTUAL loaded window differs from BOTH
  { key: 'mykey', name: 'MyModel', nativeCtx: 262144, configuredCtx: 200000 },
  // no saved profile -> native is the honest remaining answer
  { key: 'c|Q8|3', name: 'Model C', nativeCtx: 131072 },
  // nothing known at all -> omit rather than invent
  { key: 'd|Q8|4', name: 'Model D' },
]

test('pi: an UNLOADED model advertises its configured window, not its native ceiling', async () => {
  const fs = memFs()
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', fs, 32768, LIB_CFG)
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!).providers.turbollm.models
  const by = (id: string) => models.find((m: { id: string }) => m.id === id)
  assert.equal(by('a|Q4|1').contextWindow, 163328, 'configured wins over native for an unloaded model')
  assert.equal(by('c|Q8|3').contextWindow, 131072, 'no profile -> native')
  assert.equal(by('d|Q8|4').contextWindow, undefined, 'nothing known -> omitted, never invented')
})

test('pi: the LOADED model still wins with its actual loaded ctx, over configured AND native', async () => {
  // Auto-tune or a VRAM fallback can land somewhere the saved profile did not ask for, so the live
  // reading must outrank the configured one for the model actually in memory.
  const fs = memFs()
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', fs, 32768, LIB_CFG)
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!).providers.turbollm.models
  const loaded = models.find((m: { id: string }) => m.id === 'mykey')
  assert.equal(loaded.contextWindow, 32768, 'live loaded ctx beats configured 200000 and native 262144')
})

test('opencode: same precedence, through limit.context', async () => {
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', 6996, memFs(), 32768, LIB_CFG)
  const models = JSON.parse(content!).provider.turbollm.models
  assert.equal(models['a|Q4|1'].limit.context, 163328, 'unloaded -> configured')
  assert.equal(models['mykey'].limit.context, 32768, 'loaded -> live')
  assert.equal(models['c|Q8|3'].limit.context, 131072, 'no profile -> native')
  assert.equal(models['d|Q8|4'].limit, undefined, 'nothing known -> no limit block')
})

// ── A TurboLLM-launched opencode session offers ONLY TurboLLM's models ─────────────────────────
// Founder-reported: `/models` opened onto opencode's own hosted providers ("OpenCode Zen": Nemotron,
// DeepSeek V4, Laguna, Hy3, MiMo…) plus Google, with the 26 local models below them — so selecting
// the obvious first entry switched to a CLOUD model and TurboLLM appeared not to change anything.
// Distinct from the pi credential leak: OpenCode Zen is opencode's OWN free service and needs none
// of the user's keys, so stripping OPENAI_API_KEY/GEMINI_API_KEY cannot remove it.

test('opencode: the inline config allowlists ONLY the turbollm provider', async () => {
  const content = await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', 6996, memFs(), 32768, LIBRARY)
  const parsed = JSON.parse(content!)
  // An ALLOWLIST, not a blocklist: a provider opencode ships in a later release cannot reappear.
  assert.deepEqual(parsed.enabled_providers, ['turbollm'])
})

test('opencode: the allowlist is NEVER written to the user\'s durable config', async () => {
  // The durable file is the user's own — a hand-run `opencode` must keep every provider they
  // configured. Only a session launched THROUGH TurboLLM is declared local-only.
  const fs = memFs()
  await prepareOpencode('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', fs, 32768, LIBRARY)
  const onDisk = JSON.parse(fs.files.get(join(HOME, '.config', 'opencode', 'opencode.json'))!)
  assert.equal(onDisk.enabled_providers, undefined)
  assert.equal(onDisk.model, undefined, 'nor may it hijack their default model')
})

test('opencode: a user\'s OWN providers survive in the inline config, just not in the picker', async () => {
  // The allowlist filters what is OFFERED; it must not delete their configuration.
  const fs = memFs({
    [join(HOME, '.config', 'opencode', 'opencode.json')]: JSON.stringify({
      provider: { anthropic: { options: { apiKey: 'theirs' } } },
    }),
  })
  const parsed = JSON.parse((await buildOpencodeConfigContent('http://127.0.0.1:6996', SESSION_TOKEN, 'mykey', 'MyModel', 6996, fs, 32768, LIBRARY))!)
  assert.deepEqual(parsed.provider.anthropic, { options: { apiKey: 'theirs' } })
  assert.deepEqual(parsed.enabled_providers, ['turbollm'])
})

// ── Pre-release review fixes (PR #176) ─────────────────────────────────────────────────────────

test('a prototype-chain key is NOT a launch target', async () => {
  // SUPPORTED is a plain object literal, so `SUPPORTED['constructor']` resolved up the chain to a
  // truthy value: cliSpecInfo returned `{bin: undefined, …}` instead of null, and the caller then
  // threw a TypeError out of `spec.install.split(…)` — an HTTP 500 from a security-adjacent route.
  const { cliSpecInfo, cliBin } = await import('./cli-launch.js')
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(cliSpecInfo(key), null, `cliSpecInfo("${key}") must be null`)
    assert.equal(cliBin(key), null, `cliBin("${key}") must be null`)
  }
  // ...and a real target still resolves.
  assert.equal(cliBin('claude'), 'claude')
})

test('a SYNC never rewrites the user\'s own default provider/model; a LAUNCH still does', async () => {
  // A model load in the TurboLLM UI must not flip the defaults of a `pi` the user runs by hand
  // against their own account. Only an explicit `turbollm launch` may pin.
  const launched = memFs()
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', launched, 32768, LIBRARY, true)
  const afterLaunch = JSON.parse(launched.files.get(join(HOME, '.pi', 'agent', 'settings.json'))!)
  assert.equal(afterLaunch.defaultProvider, 'turbollm', 'an explicit launch DOES pin')
  assert.equal(afterLaunch.defaultModel, 'mykey')

  const synced = memFs({
    [join(HOME, '.pi', 'agent', 'settings.json')]: JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'theirs' }),
  })
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'mykey', 'MyModel', synced, 32768, LIBRARY, false)
  const afterSync = JSON.parse(synced.files.get(join(HOME, '.pi', 'agent', 'settings.json'))!)
  assert.equal(afterSync.defaultProvider, 'anthropic', 'a sync must leave their provider alone')
  assert.equal(afterSync.defaultModel, 'theirs')
})

test('a SYNC skips a harness the user has never wired to TurboLLM', async () => {
  // Without this the post-load sync CREATED config files for all five config-file harnesses,
  // including ones never installed — and hermes' variant spawns a process to do it.
  const { syncHarnessModelConfig } = await import('./cli-launch.js')
  const fs = memFs()   // empty home: nothing has ever been launched
  const res = await syncHarnessModelConfig('pi', {
    port: 6996, pinnedModel: 'mykey', modelName: 'MyModel', modelCtx: 32768, models: LIBRARY,
  }, fs)
  assert.deepEqual(res, { ok: true })
  assert.equal(fs.files.size, 0, `a sync must not invent config files: wrote ${[...fs.files.keys()]}`)
})

test('a SYNC DOES refresh a harness that was previously launched', async () => {
  const fs = memFs()
  // Simulate one real launch, which is what puts a `turbollm` provider on disk...
  await preparePi('http://127.0.0.1:6996', STATIC_TOKEN, 'old', 'Old', fs, 1000, [], true)
  const { syncHarnessModelConfig } = await import('./cli-launch.js')
  await syncHarnessModelConfig('pi', {
    port: 6996, pinnedModel: 'mykey', modelName: 'MyModel', modelCtx: 32768, models: LIBRARY,
  }, fs)
  const models = JSON.parse(fs.files.get(join(HOME, '.pi', 'agent', 'models.json'))!).providers.turbollm.models
  assert.ok(models.length > 1, 'the refreshed config carries the whole library')
  assert.equal(models.find((m: { id: string }) => m.id === 'mykey').contextWindow, 32768)
})
