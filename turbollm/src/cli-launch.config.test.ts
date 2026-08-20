// Part C: prepareConfig merge for config-file launch targets (opencode / kilo / openclaw),
// plus hermes's CLI-driven config (its config is YAML, so it's driven via `hermes config
// set` rather than parsed/written directly). All tests use an in-memory ConfigFs / fake
// RunCommand so neither the real filesystem nor a real hermes process is ever touched
// (mirrors the _spawn/_fetch injection pattern used by the other cli-launch tests).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { prepareOpencode, prepareKilo, prepareOpenclaw, prepareHermes, preparePi, realRunCommand, type ConfigFs, type RunCommand } from './cli-launch.js'

const HOME = '/home/tester'
// Config paths are built with path.join, so they use the host's separator (backslash on
// Windows). Compute expected paths the same way so the tests are cross-platform.
const opencodePath = join(HOME, '.config', 'opencode', 'opencode.json')
const kiloPath = join(HOME, '.config', 'kilo', 'kilo.jsonc')
const openclawPath = join(HOME, '.config', 'openclaw', 'openclaw.json')
const piModelsPath = join(HOME, '.pi', 'agent', 'models.json')
const piSettingsPath = join(HOME, '.pi', 'agent', 'settings.json')

/** In-memory ConfigFs seeded with any pre-existing files. Records writes + mkdirs. */
function memFs(seed: Record<string, string> = {}): ConfigFs & { files: Map<string, string>; mkdirs: string[] } {
  const files = new Map<string, string>(Object.entries(seed))
  const mkdirs: string[] = []
  return {
    files,
    mkdirs,
    home: HOME,
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: async (p: string, data: string) => { files.set(p, data) },
    mkdir: async (p: string) => { mkdirs.push(p) },
  }
}

const BASE = 'http://127.0.0.1:6996'
const TOKEN = 'turbollm-local'

// ── opencode ────────────────────────────────────────────────────────────────────

test('prepareOpencode: writes a turbollm provider on a fresh (absent) config', async () => {
  const fs = memFs()
  const res = await prepareOpencode(BASE, TOKEN, 'qwen3-8b', 'Qwen3 8B', fs)
  assert.deepEqual(res, { ok: true })

  const cfg = JSON.parse(fs.files.get(opencodePath)!)
  // Keyed by the model KEY, with the display name alongside — NOT keyed by the name as this
  // originally was. Two library entries can share a name (the same model at two quantisations),
  // which silently collided into one picker entry, and the key is what the gateway actually routes
  // on (`/v1/models` advertises keys, and resolveModelKey matches an exact key first).
  assert.deepEqual(cfg.provider.turbollm, {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `${BASE}/v1`, apiKey: TOKEN },
    models: { 'qwen3-8b': { id: 'qwen3-8b', name: 'Qwen3 8B' } },
  })
})

test('prepareOpencode: preserves sibling providers already in the config', async () => {
  const fs = memFs({
    [opencodePath]: JSON.stringify({ provider: { openai: { npm: 'x', options: {} } }, model: 'openai/gpt' }),
  })
  const res = await prepareOpencode(BASE, TOKEN, 'k', 'M', fs)
  assert.deepEqual(res, { ok: true })

  const cfg = JSON.parse(fs.files.get(opencodePath)!)
  assert.ok(cfg.provider.openai, 'existing sibling provider must be preserved')
  assert.ok(cfg.provider.turbollm, 'turbollm provider added')
  assert.equal(cfg.model, 'openai/gpt', 'unrelated top-level keys untouched')
})

test('prepareOpencode: refuses to overwrite an unparseable config', async () => {
  const original = '{ this is not valid json, // with a comment\n}'
  const fs = memFs({ [opencodePath]: original })
  const res = await prepareOpencode(BASE, TOKEN, 'k', 'M', fs)
  assert.equal(res.ok, false)
  assert.match((res as { message: string }).message, /doesn't parse/)
  assert.equal(fs.files.get(opencodePath), original, 'the corrupt file must be left exactly as-is')
})

test('prepareOpencode: refuses (not throws) when an existing key is not an object', async () => {
  // Valid JSON, but `provider` is a string — merging into it would otherwise throw
  // (assigning a property to a primitive in strict mode) instead of failing safely.
  const original = JSON.stringify({ provider: 'not-an-object' })
  const fs = memFs({ [opencodePath]: original })
  const res = await prepareOpencode(BASE, TOKEN, 'k', 'M', fs)
  assert.equal(res.ok, false)
  assert.equal(fs.files.get(opencodePath), original, 'the unusual file must be left exactly as-is')
})

test('prepareOpencode: a commented config already pointed at us succeeds WITHOUT rewriting it', async () => {
  // Comments alone must not block the merge when there's nothing left to do — and the
  // file must never be touched (rewriting would delete the user's comments).
  const original =
    '{\n  // hand-written\n  "provider": { "turbollm": { "options": { "baseURL": "' + BASE + '/v1" } } }\n}'
  const fs = memFs({ [opencodePath]: original })
  const res = await prepareOpencode(BASE, TOKEN, 'k', 'M', fs)
  assert.deepEqual(res, { ok: true })
  assert.equal(fs.files.get(opencodePath), original, 'already-correct commented file must be left byte-for-byte untouched')
})

test('prepareOpencode: a commented config NOT yet pointed at us fails without touching it', async () => {
  const original = '{\n  // hand-written, no turbollm entry yet\n  "provider": { "openai": {} }\n}'
  const fs = memFs({ [opencodePath]: original })
  const res = await prepareOpencode(BASE, TOKEN, 'k', 'M', fs)
  assert.equal(res.ok, false)
  assert.match((res as { message: string }).message, /comments/)
  assert.equal(fs.files.get(opencodePath), original, 'must not rewrite a commented file even on failure')
})

// ── kilo (verified against the live @kilocode/cli install) ────────────────────────

test('prepareKilo: writes opencode-shaped provider + a default model string', async () => {
  const fs = memFs()
  const res = await prepareKilo(BASE, TOKEN, 'qwen3-8b', 'Qwen3 8B', fs)
  assert.deepEqual(res, { ok: true })

  const cfg = JSON.parse(fs.files.get(kiloPath)!)
  // kilo rejects an array-form `models` (empirically: "Expected object") — must be an object map.
  // Keyed by model KEY with the display name alongside, exactly as prepareOpencode does: this test
  // used to pin the NAME as the key, which is the bug. A real library contains name collisions (the
  // same model at four quantisations), and a name-keyed map silently collapsed them into one picker
  // row; the key is also what the gateway routes on. Verified applicable to kilo specifically —
  // its own bundled models-snapshot.json entries carry the same id/name/limit shape as opencode's.
  assert.deepEqual(cfg.provider.turbollm.models, { 'qwen3-8b': { id: 'qwen3-8b', name: 'Qwen3 8B' } })
  assert.equal(cfg.provider.turbollm.npm, '@ai-sdk/openai-compatible')
  assert.equal(cfg.model, 'turbollm/qwen3-8b', 'default model is provider/mapKey — so it must be the KEY')
})

test('prepareKilo: writes the WHOLE library, so its picker is a real picker', async () => {
  // Same fix as opencode: a config-file harness can only offer what we write, and writing one entry
  // left a one-row picker.
  const fs = memFs()
  await prepareKilo(BASE, TOKEN, 'b|Q4|2', 'Model B', fs, 32768, [
    { key: 'a|Q4|1', name: 'Model A', nativeCtx: 262144 },
    { key: 'b|Q4|2', name: 'Model B', nativeCtx: 262144 },
  ])
  const cfg = JSON.parse(fs.files.get(kiloPath)!)
  assert.deepEqual(Object.keys(cfg.provider.turbollm.models), ['a|Q4|1', 'b|Q4|2'])
  assert.equal(cfg.provider.turbollm.models['b|Q4|2'].limit.context, 32768, 'loaded model: real loaded ctx')
  assert.equal(cfg.provider.turbollm.models['a|Q4|1'].limit.context, 262144, 'others: native ctx')
  assert.equal(cfg.model, 'turbollm/b|Q4|2')
})

test('prepareKilo: a real-shaped kilo.jsonc (comments, already wired to us) succeeds without rewriting', async () => {
  // Mirrors the ACTUAL kilo.jsonc found on a live install: section-divider comments, a
  // baseURL pointed at our own gateway, and a URL value containing "//" inside a string
  // (must not be mistaken for the start of a line comment).
  const original =
    '{\n' +
    '  // ── Qwen3.6 35B-A3B ──\n' +
    '  "provider": { "turbollm": { "options": { "baseURL": "' + BASE + '/v1" }, "models": {} } }\n' +
    '}'
  const fs = memFs({ [kiloPath]: original })
  const res = await prepareKilo(BASE, TOKEN, 'k', 'M', fs)
  assert.deepEqual(res, { ok: true })
  assert.equal(fs.files.get(kiloPath), original, 'the real hand-curated file must never be rewritten')
})

test('prepareKilo: refuses corrupt (unparseable even after stripping comments) configs', async () => {
  // Comments AND a trailing comma — still broken JSON even leniently, must not clobber.
  const fs = memFs({ [kiloPath]: '{ "model": "x", // comment\n }' })
  const res = await prepareKilo(BASE, TOKEN, 'k', 'M', fs)
  assert.equal(res.ok, false)
  assert.match((res as { message: string }).message, /Kilo Code/)
})

// ── openclaw ──────────────────────────────────────────────────────────────────────

test('prepareOpenclaw: writes the provider under models.providers + a default primary', async () => {
  const fs = memFs()
  const res = await prepareOpenclaw(BASE, TOKEN, 'qwen3-8b', 'Qwen3 8B', fs)
  assert.deepEqual(res, { ok: true })

  const cfg = JSON.parse(fs.files.get(openclawPath)!)
  assert.deepEqual(cfg.models.providers.turbollm, {
    baseUrl: `${BASE}/v1`,
    apiKey: TOKEN,
    api: 'openai-completions',
    models: [{ id: 'qwen3-8b', name: 'Qwen3 8B' }],
  })
  assert.deepEqual(cfg.agents.defaults.model, { primary: 'turbollm/qwen3-8b' })
})

test('prepareOpenclaw: preserves sibling providers and refuses corrupt configs', async () => {
  const fs = memFs({
    [openclawPath]: JSON.stringify({ models: { providers: { other: { baseUrl: 'y' } } } }),
  })
  const res = await prepareOpenclaw(BASE, TOKEN, 'k', 'M', fs)
  assert.deepEqual(res, { ok: true })
  const cfg = JSON.parse(fs.files.get(openclawPath)!)
  assert.ok(cfg.models.providers.other, 'sibling provider preserved')
  assert.ok(cfg.models.providers.turbollm, 'turbollm provider added')

  const fs2 = memFs({ [openclawPath]: 'not json at all {' })
  const res2 = await prepareOpenclaw(BASE, TOKEN, 'k', 'M', fs2)
  assert.equal(res2.ok, false)
})

test('prepareOpenclaw: refuses (not throws) when models/agents is not an object', async () => {
  const original = JSON.stringify({ models: 'not-an-object', agents: [] })
  const fs = memFs({ [openclawPath]: original })
  const res = await prepareOpenclaw(BASE, TOKEN, 'k', 'M', fs)
  assert.equal(res.ok, false)
  assert.equal(fs.files.get(openclawPath), original, 'the unusual file must be left exactly as-is')
})

// ── pi (schema confirmed from its vendored docs, not yet live-verified — ADR-158 precedent) ──

test('preparePi: writes a turbollm provider in models.json + defaultProvider/defaultModel in settings.json', async () => {
  const fs = memFs()
  const res = await preparePi(BASE, TOKEN, 'qwen3-8b', 'Qwen3 8B', fs)
  assert.deepEqual(res, { ok: true })

  const models = JSON.parse(fs.files.get(piModelsPath)!)
  assert.deepEqual(models.providers.turbollm, {
    baseUrl: `${BASE}/v1`,
    api: 'openai-completions',
    apiKey: TOKEN,
    models: [{ id: 'qwen3-8b', name: 'Qwen3 8B' }],
  })

  const settings = JSON.parse(fs.files.get(piSettingsPath)!)
  assert.equal(settings.defaultProvider, 'turbollm')
  assert.equal(settings.defaultModel, 'qwen3-8b')
})

test('preparePi: preserves sibling providers and existing settings keys', async () => {
  const fs = memFs({
    [piModelsPath]: JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }),
    [piSettingsPath]: JSON.stringify({ theme: 'dark' }),
  })
  const res = await preparePi(BASE, TOKEN, 'k', 'M', fs)
  assert.deepEqual(res, { ok: true })

  const models = JSON.parse(fs.files.get(piModelsPath)!)
  assert.ok(models.providers.ollama, 'sibling provider preserved')
  assert.ok(models.providers.turbollm, 'turbollm provider added')

  const settings = JSON.parse(fs.files.get(piSettingsPath)!)
  assert.equal(settings.theme, 'dark', 'unrelated existing setting untouched')
  assert.equal(settings.defaultProvider, 'turbollm')
})

test('preparePi: refuses to overwrite an unparseable models.json or settings.json', async () => {
  const badModels = memFs({ [piModelsPath]: 'not json {' })
  const res1 = await preparePi(BASE, TOKEN, 'k', 'M', badModels)
  assert.equal(res1.ok, false)
  assert.equal(badModels.files.get(piModelsPath), 'not json {')

  const badSettings = memFs({ [piSettingsPath]: 'not json {' })
  const res2 = await preparePi(BASE, TOKEN, 'k', 'M', badSettings)
  assert.equal(res2.ok, false)
})

test('preparePi: a commented models.json already pointed at us succeeds without rewriting; settings.json still gets written', async () => {
  const original =
    '{\n  // hand-written\n  "providers": { "turbollm": { "baseUrl": "' + BASE + '/v1" } }\n}'
  const fs = memFs({ [piModelsPath]: original })
  const res = await preparePi(BASE, TOKEN, 'k', 'M', fs)
  assert.deepEqual(res, { ok: true })
  assert.equal(fs.files.get(piModelsPath), original, 'already-correct commented file must be left byte-for-byte untouched')
  const settings = JSON.parse(fs.files.get(piSettingsPath)!)
  assert.equal(settings.defaultProvider, 'turbollm')
})

test('preparePi: a commented models.json NOT yet pointed at us fails without touching it', async () => {
  const original = '{\n  // hand-written, no turbollm entry yet\n  "providers": { "ollama": {} }\n}'
  const fs = memFs({ [piModelsPath]: original })
  const res = await preparePi(BASE, TOKEN, 'k', 'M', fs)
  assert.equal(res.ok, false)
  assert.equal(fs.files.get(piModelsPath), original, 'must not rewrite a commented file even on failure')
})

// ── hermes (config driven via its own `config set`, verified against a live install) ──

/** Fake RunCommand that records every invocation and can be told which ones to fail. */
function fakeRun(failOn?: string): { calls: Array<[string, string[]]>; run: RunCommand } {
  const calls: Array<[string, string[]]> = []
  const run: RunCommand = async (bin, args) => {
    calls.push([bin, args])
    return !(failOn && args.includes(failOn))
  }
  return { calls, run }
}

test('prepareHermes: sets provider, base_url, and default via hermes config set', async () => {
  const { calls, run } = fakeRun()
  const res = await prepareHermes(BASE, TOKEN, 'qwen3-8b', 'Qwen3 8B', run)
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(calls, [
    ['hermes', ['config', 'set', 'model.provider', 'custom']],
    ['hermes', ['config', 'set', 'model.base_url', `${BASE}/v1`]],
    ['hermes', ['config', 'set', 'model.default', 'qwen3-8b']],
  ])
})

test('prepareHermes: surfaces a manual-instructions message when a config set call fails', async () => {
  const { run } = fakeRun(`${BASE}/v1`) // fail the base_url step
  const res = await prepareHermes(BASE, TOKEN, 'qwen3-8b', 'Qwen3 8B', run)
  assert.equal(res.ok, false)
  assert.match((res as { message: string }).message, /hermes config set model\.base_url/)
})

test('realRunCommand: an argument containing "|" (a real turbollm model key shape) survives intact', async () => {
  // Regression for a real bug: spawning with `shell: true` on Windows makes cmd.exe treat
  // "|" as its pipe operator (args are concatenated, not escaped), silently mangling any
  // model key like "qwen3.6-27b|IQ2_XXS|9388779744". Verified against a real `node`
  // subprocess (always available in this test environment) rather than a fake.
  const arg = 'qwen3.6-27b|IQ2_XXS|9388779744'
  const ok = await realRunCommand('node', ['-e', `process.exit(process.argv[1] === ${JSON.stringify(arg)} ? 0 : 1)`, arg])
  assert.equal(ok, true, 'the "|" must reach the child process as a literal argument character, not a shell pipe')
})
