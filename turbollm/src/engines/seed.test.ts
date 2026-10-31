// The first-run seed (seedDefaultEngines) installs and selects the default llama.cpp build once. It ran on every start
// that found no engine registered, so a user who had removed every engine (Disabled or Deleted the only one, or deleted
// a managed build's folder by hand, which the start unregisters) got the default build registered and selected again
// at the next start: the one left on disk, or a fresh download of several hundred MB. The next automatic load then ran
// on an engine the user never selected.
// The seed here runs for real (TURBOLLM_SEED_BACKEND=cpu), against a llama.cpp folder already provisioned on disk whose
// llama-server is a shell-script stand-in, so nothing is downloaded. POSIX only.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { ConfigStore, defaultConfig, type Engine } from '../config/config'
import { LLAMA_BUILD, fallbackChain } from './download'
import { ProvisionState } from './provision-state'
import { Registry } from './registry'
import { ensureAndroidBundledEngine, ensureAndroidSdkEngine, seedDefaultEngines } from './seed'
import { tmpDir } from '../test-support/tmp'

const posixOnly = process.platform === 'win32' && 'uses a shell-script stand-in for llama-server'
const WORKS = '#!/bin/sh\necho "version: 9608 (0123abc)"\n'
const FAILS = '#!/bin/sh\necho "libcuda.so.1: cannot open shared object file" >&2\nexit 127\n'

let savedBackend: string | undefined
beforeEach(() => {
  savedBackend = process.env.TURBOLLM_SEED_BACKEND
  process.env.TURBOLLM_SEED_BACKEND = 'cpu'
})
afterEach(() => {
  if (savedBackend === undefined) delete process.env.TURBOLLM_SEED_BACKEND
  else process.env.TURBOLLM_SEED_BACKEND = savedBackend
})

/** Every backend the cpu seed tries, provisioned on disk with `server` as its llama-server: the seed takes such a
 *  folder as it is (provisionBackend), so no download is attempted. */
function provision(enginesRoot: string, server: string): void {
  for (const backend of fallbackChain('cpu')) {
    const dir = join(enginesRoot, `llama.cpp-${LLAMA_BUILD}-${backend.id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'llama-server'), server)
    chmodSync(join(dir, 'llama-server'), 0o755)
    writeFileSync(join(dir, '.turbollm-provisioned'), '{}')
  }
}

/** A daemon start: the config loaded from disk, and the seed run against it (cli.ts). */
async function boot(path: string): Promise<{ store: ConfigStore; registry: Registry }> {
  const store = ConfigStore.load(path)
  const registry = new Registry(store)
  await seedDefaultEngines(registry, join(store.dir(), 'engines'), new ProvisionState(), store)
  return { store, registry }
}

const SEEDED = `llama.cpp ${LLAMA_BUILD} (cpu)`

test('after the user removes every engine, the next start does not install the default build again', { skip: posixOnly }, async () => {
  const path = join(tmpDir('tllm-seed-'), 'config.json')
  provision(join(path, '..', 'engines'), WORKS)
  const first = await boot(path)
  const seeded = first.registry.active()
  assert.equal(seeded?.name, SEEDED, 'a first run installs and selects the default build, as before')

  first.registry.remove(seeded!.id) // the user Disables it
  const next = await boot(path)
  assert.deepEqual(next.registry.list().engines, [], 'nothing is registered for the user')
  assert.equal(next.registry.active(), undefined, 'and nothing is selected')
})

test('a config that already has an engine or a custom engine source is never seeded again once it has none', { skip: posixOnly }, async () => {
  for (const setUp of ['engine', 'custom source'] as const) {
    const path = join(tmpDir('tllm-seed-'), 'config.json')
    provision(join(path, '..', 'engines'), WORKS)
    // A config.json from before the seed was recorded: KoboldCpp registered and selected (or only a Disabled custom
    // build remembered), nothing on record about the seed.
    const cfg = defaultConfig() as unknown as Record<string, unknown>
    delete cfg.defaultEngineSeeded
    const kobold: Engine = {
      id: 'kobold', name: 'KoboldCpp', binPath: '/opt/koboldcpp/koboldcpp', kind: 'koboldcpp', version: '1.0',
      capabilities: { kvTypes: [], flags: [] }, addedAt: '',
    }
    if (setUp === 'engine') Object.assign(cfg, { engines: [kobold], activeEngineId: 'kobold' })
    else cfg.customEngineSources = [{ name: 'Fork', binPath: '/opt/fork/llama-server', kind: 'llama-server', addedAt: '' }]
    writeFileSync(path, JSON.stringify(cfg))

    const upgraded = await boot(path)
    assert.deepEqual(upgraded.registry.list().engines.map((e) => e.id), setUp === 'engine' ? ['kobold'] : [], setUp)
    if (setUp === 'engine') upgraded.registry.remove('kobold')
    const next = await boot(path)
    assert.deepEqual(next.registry.list().engines, [], `${setUp}: no default build is installed for the user`)
    assert.equal(next.registry.active(), undefined, setUp)
  }
})

test('a first run whose seed fails tries again at the next start', { skip: posixOnly }, async () => {
  const path = join(tmpDir('tllm-seed-'), 'config.json')
  const enginesRoot = join(path, '..', 'engines')
  provision(enginesRoot, FAILS) // offline, or no build that runs here
  const first = await boot(path)
  assert.deepEqual(first.registry.list().engines, [])

  provision(enginesRoot, WORKS)
  const next = await boot(path)
  assert.equal(next.registry.active()?.name, SEEDED, 'the next start seeds the default build')
})

// The Android app's in-app engine (the TurboLLM SDK, kind 'turbollm-sdk') is registered or repaired from the app's
// environment at every start, and is the default engine (Option B): the bundled CPU llama-server stays as a fallback
// the user may pick. A bundled optional engine whose file the APK no longer ships is unregistered, so no row is
// offered that cannot run (ADR-239). These run on every platform: the bundled engines are registered in config.json
// beforehand, so nothing is probed or executed.

const SDK_URL = 'http://127.0.0.1:6997'
const CPU_FILE = 'libllama_server.so'
const LITERT_FILE = 'liblitertlm_server.so'
const VULKAN_FILE = 'libllama_server_vk.so'

type MockedConsole = { mock: { callCount(): number; calls: { arguments: unknown[] }[] } }
type AndroidTest = { after: (fn: () => void) => void; mock: { method: (o: object, m: string, f: () => void) => unknown } }

/** The app's environment for one start; both variables are put back after the test. */
function androidEnv(t: AndroidTest, lib: string, sdkUrl?: string): void {
  const saved = { lib: process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR, sdk: process.env.TURBOLLM_ANDROID_SDK_URL }
  t.after(() => {
    setEnv('TURBOLLM_ANDROID_NATIVE_LIB_DIR', saved.lib)
    setEnv('TURBOLLM_ANDROID_SDK_URL', saved.sdk)
  })
  setEnv('TURBOLLM_ANDROID_NATIVE_LIB_DIR', lib)
  setEnv('TURBOLLM_ANDROID_SDK_URL', sdkUrl)
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** Silences the seed's log lines; returns the console.log and console.warn mocks. */
function quiet(t: AndroidTest): { logs: MockedConsole; warns: MockedConsole } {
  const logs = t.mock.method(console, 'log', () => {}) as MockedConsole
  const warns = t.mock.method(console, 'warn', () => {}) as MockedConsole
  return { logs, warns }
}

/** An APK's nativeLibraryDir holding `files`. */
function nativeLibDir(files: string[]): string {
  const lib = join(tmpDir('tllm-android-seed-'), 'lib')
  mkdirSync(lib, { recursive: true })
  for (const file of files) writeFileSync(join(lib, file), '')
  return lib
}

function registeredEngine(id: string, name: string, binPath: string, kind = 'llama-server'): Engine {
  return { id, name, binPath, kind, version: 'b1', capabilities: { kvTypes: [], flags: [] }, addedAt: '' }
}

const cpuEngine = (lib: string) => registeredEngine('cpu', 'llama-server-android', join(lib, CPU_FILE))

/** A config.json holding `engines`, with `activeEngineId` selected. */
function configWith(engines: Engine[], activeEngineId: string): string {
  const path = join(tmpDir('tllm-android-seed-'), 'config.json')
  writeFileSync(path, JSON.stringify({ ...defaultConfig(), engines, activeEngineId }))
  return path
}

/** A daemon start on Android: the bundled engines, then the SDK engine (cli.ts). */
async function androidBoot(path: string): Promise<Registry> {
  const registry = new Registry(ConfigStore.load(path))
  await ensureAndroidBundledEngine(registry)
  ensureAndroidSdkEngine(registry)
  return registry
}

const sdkEngineOf = (registry: Registry) => registry.list().engines.find((e) => e.kind === 'turbollm-sdk')

const mentions = (spy: MockedConsole, ...words: RegExp[]) =>
  spy.mock.calls.some((c) => words.every((w) => w.test(String(c.arguments[0]))))

test('android first boot with the SDK: it is registered and made active, though llama-server was active', async (t) => {
  quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib, SDK_URL)

  const registry = await androidBoot(configWith([cpuEngine(lib)], 'cpu'))

  const sdk = sdkEngineOf(registry)
  assert.equal(sdk?.name, 'TurboLLM SDK')
  assert.equal(sdk?.baseUrl, SDK_URL)
  assert.equal(sdk?.binPath, '')
  assert.equal(registry.active()?.id, sdk?.id)
  assert.equal(registry.get('cpu')?.name, 'llama-server-android', 'the CPU engine stays as the fallback')
})

test('android second boot: the SDK engine keeps its id and takes the new URL', async (t) => {
  quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib, SDK_URL)
  const path = configWith([cpuEngine(lib)], 'cpu')
  const firstId = sdkEngineOf(await androidBoot(path))?.id

  const nextUrl = 'http://localhost:6997'
  setEnv('TURBOLLM_ANDROID_SDK_URL', nextUrl)
  const registry = await androidBoot(path)

  const sdkEngines = registry.list().engines.filter((e) => e.kind === 'turbollm-sdk')
  assert.deepEqual(sdkEngines.map((e) => [e.id, e.baseUrl]), [[firstId, nextUrl]])
})

test('android: a user who switched to llama-server keeps it after a reboot', async (t) => {
  quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib, SDK_URL)
  const path = configWith([cpuEngine(lib)], 'cpu')
  ;(await androidBoot(path)).activate('cpu')

  const registry = await androidBoot(path)

  assert.equal(registry.active()?.id, 'cpu')
})

test('android without the SDK URL: no SDK engine is registered', async (t) => {
  quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib)

  const registry = await androidBoot(configWith([cpuEngine(lib)], 'cpu'))

  assert.equal(sdkEngineOf(registry), undefined)
  assert.equal(registry.active()?.id, 'cpu')
})

test('android without the SDK URL: the SDK engine stays, and the bundled CPU engine becomes active, said in the log', async (t) => {
  const { logs } = quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib, SDK_URL)
  const path = configWith([cpuEngine(lib)], 'cpu')
  const sdkId = sdkEngineOf(await androidBoot(path))?.id
  setEnv('TURBOLLM_ANDROID_SDK_URL', undefined) // the app could not start the SDK this launch

  const registry = await androidBoot(path)

  assert.equal(sdkEngineOf(registry)?.id, sdkId, 'never deleted')
  assert.equal(registry.active()?.id, 'cpu')
  assert.ok(mentions(logs, /TurboLLM SDK/, /llama-server-android/), 'the log says why the engine changed')
})

test('android with the SDK URL and no libllama_server.so: no CPU engine and no warning', async (t) => {
  const { warns } = quiet(t)
  androidEnv(t, nativeLibDir([]), SDK_URL)

  const registry = await androidBoot(configWith([], ''))

  assert.deepEqual(registry.list().engines.map((e) => e.kind), ['turbollm-sdk'])
  assert.equal(registry.active()?.kind, 'turbollm-sdk')
  assert.equal(warns.mock.callCount(), 0)
})

test('android without the SDK URL and no libllama_server.so: the CPU engine is still required, as before', async (t) => {
  const { warns } = quiet(t)
  androidEnv(t, nativeLibDir([]))

  const registry = await androidBoot(configWith([], ''))

  assert.deepEqual(registry.list().engines, [])
  assert.ok(mentions(warns, /llama-server-android/))
})

test('G-7: an active bundled LiteRT-LM engine whose file is gone is unregistered, and the SDK engine becomes active', async (t) => {
  const { logs } = quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib, SDK_URL)
  const litert = registeredEngine('litert', 'litert-lm-android', join(lib, LITERT_FILE), 'litert-lm')

  const registry = await androidBoot(configWith([cpuEngine(lib), litert], 'litert'))

  assert.equal(registry.get('litert'), undefined)
  assert.equal(registry.active()?.kind, 'turbollm-sdk')
  assert.ok(mentions(logs, /litert-lm-android/), 'one line names it')
})

test('G-7: an earlier install\'s bundled LiteRT-LM row is unregistered too, and without the SDK the CPU engine is active', async (t) => {
  quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib)
  // A reinstall moves nativeLibraryDir, so the row still names the old one.
  const stale = registeredEngine('litert', 'litert-lm-android', join('/data/app/old/lib/arm64', LITERT_FILE), 'litert-lm')

  const registry = await androidBoot(configWith([cpuEngine(lib), stale], 'litert'))

  assert.equal(registry.get('litert'), undefined)
  assert.equal(registry.active()?.id, 'cpu')
})

test('G-7: a bundled Vulkan engine whose file is gone is unregistered; the active engine is kept', async (t) => {
  quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib)
  const vulkan = registeredEngine('vk', 'llama-server-android-vulkan', join(lib, VULKAN_FILE))

  const registry = await androidBoot(configWith([cpuEngine(lib), vulkan], 'cpu'))

  assert.deepEqual(registry.list().engines.map((e) => e.id), ['cpu'])
  assert.equal(registry.active()?.id, 'cpu')
})

test('G-7: a user-added LiteRT-LM engine is never unregistered', async (t) => {
  quiet(t)
  const lib = nativeLibDir([CPU_FILE])
  androidEnv(t, lib, SDK_URL)
  const userBin = join(tmpDir('tllm-android-seed-'), 'venv', 'python')
  const mine = registeredEngine('mine', 'LiteRT-LM', userBin, 'litert-lm')
  const sameName = registeredEngine('named', 'litert-lm-android', userBin, 'litert-lm')

  const registry = await androidBoot(configWith([cpuEngine(lib), mine, sameName], 'mine'))

  assert.equal(registry.get('mine')?.binPath, userBin)
  assert.equal(registry.get('named')?.binPath, userBin, 'a bundled name on a binary the APK never ships is the user\'s')
})

test('android: the SDK engine takes over from an active bundled engine whose file is gone', async (t) => {
  quiet(t)
  const lib = nativeLibDir([])
  androidEnv(t, lib, SDK_URL)
  const path = configWith([cpuEngine(lib)], 'cpu')
  const registry = new Registry(ConfigStore.load(path))
  registry.addTurbollmSdk('TurboLLM SDK', SDK_URL) // registered on an earlier start, then the user picked the CPU engine

  ensureAndroidSdkEngine(registry)

  assert.equal(registry.active()?.kind, 'turbollm-sdk')
})
