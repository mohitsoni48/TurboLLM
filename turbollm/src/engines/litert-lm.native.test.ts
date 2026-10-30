// The Android app's bundled LiteRT-LM engine: a native port of `litert-lm serve` shipped in the APK's nativeLibraryDir
// as liblitertlm_server.so (TurboLLM-Android, engines/litert-lm-server). It keeps the CLI's contract, so the litert-lm
// kind applies unchanged — these tests pin down only what differs because it is not Python, plus the registration that
// lets the app use it with no setup once the user selects it.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { autoThreadCount, availableMemBytes, packagedAppGpu, perfCoresFromSpeeds } from '../sysinfo/sysinfo'
import { tmpDir } from '../test-support/tmp'
import { isNativeLitertLm, LITERT_LM_NATIVE_SERVER, LITERT_LM_SERVE_SHIM, litertLmNativeVersion, litertLmProfileToConfig, litertLmServerCommand } from './litert-lm'
import { pyEngineEnv } from './manager'
import { engineForModel, Registry } from './registry'
import { ensureAndroidBundledEngine, ensureAndroidModelsDir } from './seed'
import { planAutoLoad } from './auto-load'
import { engineInUse, servingEngineKind, stopEngineUsers } from './serving'
import { buildStartOpts } from './start-opts'
import { litertlmEntryFor } from '../models/litertlm'
import { resolveUpdateSource } from './update'

/** A stand-in for the native server: answers `--version` exactly as the real one does. */
function fakeNativeServer(dir: string, litertVersion = '0.18.0'): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, LITERT_LM_NATIVE_SERVER)
  writeFileSync(bin, `#!/bin/sh\necho "turbollm-litertlm-server 1.0.0 (LiteRT-LM ${litertVersion})"\n`)
  chmodSync(bin, 0o755)
  return bin
}

function engine(over: Partial<Engine>): Engine {
  return { id: 'x', name: 'x', binPath: '/x', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '', ...over }
}

function registry(engines: Engine[], activeEngineId: string): Registry {
  const store = ConfigStore.load(join(tmpDir('tllm-litert-native-'), 'config.json'))
  store.update((c) => {
    c.engines = engines
    c.activeEngineId = activeEngineId
  })
  return new Registry(store)
}

test('isNativeLitertLm: only the bundled server file is native — a venv python is not', () => {
  assert.equal(isNativeLitertLm('/data/app/~~x/com.turbollm-y/lib/arm64/liblitertlm_server.so'), true)
  assert.equal(isNativeLitertLm('/home/u/.turbollm/engines/litert-lm/venv/bin/python'), false)
  assert.equal(isNativeLitertLm('C:\\t\\engines\\litert-lm\\venv\\Scripts\\python.exe'), false)
})

test('litertLmServerCommand: the native server takes the same serve arguments, without python -m', () => {
  const native = litertLmServerCommand('/lib/liblitertlm_server.so', '/d/config-8081.json', 8081, '127.0.0.1', ['--verbose'])
  assert.deepEqual(native, {
    cmd: '/lib/liblitertlm_server.so',
    args: ['serve', '--config', '/d/config-8081.json', '--host', '127.0.0.1', '--port', '8081', '--verbose'],
  })
  const py = litertLmServerCommand('/venv/bin/python', '/d/config-8081.json', 8081, '127.0.0.1')
  assert.deepEqual(py.args.slice(0, 3), ['-c', LITERT_LM_SERVE_SHIM, 'serve'])
})

test('litertLmNativeVersion: reads the runtime version from --version, in the stored pip-style form', async () => {
  const bin = fakeNativeServer(tmpDir('tllm-litert-native-'))
  assert.equal(await litertLmNativeVersion(bin), 'litert-lm 0.18.0')
})

test('pyEngineEnv: the native server gets the native library path, not a venv environment', () => {
  const dataDir = tmpDir('tllm-litert-native-')
  const native = pyEngineEnv('litert-lm', dataDir, '/app/lib/arm64/liblitertlm_server.so')!
  assert.match(native.LD_LIBRARY_PATH ?? '', /^\/app\/lib\/arm64(:|$)/)
  assert.equal(native.HF_HUB_OFFLINE, undefined)
  const py = pyEngineEnv('litert-lm', dataDir, '/venv/bin/python')!
  assert.equal(py.HF_HUB_OFFLINE, '1')
})

test('resolveUpdateSource: the bundled server updates with the app, never from PyPI', () => {
  assert.equal(resolveUpdateSource(engine({ kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so', version: 'litert-lm 0.18.0' })), null)
  assert.equal(resolveUpdateSource(engine({ kind: 'litert-lm', binPath: '/venv/bin/python', version: 'litert-lm 0.18.0' }))?.source, 'pip')
})

// A model loads only on the engine the user selected: a .litertlm one went to the registered LiteRT-LM engine whenever
// another kind was active, so a Load under KoboldCpp or llama.cpp started LiteRT-LM on its own.
test('engineForModel: a .litertlm model gets the active engine, never the LiteRT-LM one while another kind is active', () => {
  const llama = engine({ id: 'llama', kind: 'llama-server' })
  const kobold = engine({ id: 'kobold', kind: 'koboldcpp' })
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so' })
  const bundle = litertlmEntryFor('/m/lfm_int8.litertlm', '/m', 1, 0)
  assert.equal(engineForModel(registry([llama, litert], 'llama'), bundle)?.id, 'llama')
  assert.equal(engineForModel(registry([kobold, litert], 'kobold'), bundle)?.id, 'kobold')
  // Selected, LiteRT-LM is the one it loads on.
  assert.equal(engineForModel(registry([llama, litert], 'litert'), bundle)?.id, 'litert')
})

test('repairBinPath: a non-llama engine is re-pointed without a llama-server probe', async () => {
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/old/liblitertlm_server.so', version: 'litert-lm 0.17.0' })
  const reg = registry([litert], 'litert')
  const out = await reg.repairBinPath('litert', '/new/liblitertlm_server.so', 'litert-lm 0.18.0')
  assert.equal(out.binPath, '/new/liblitertlm_server.so')
  assert.equal(out.version, 'litert-lm 0.18.0')
  assert.deepEqual(out.capabilities, { kvTypes: [], flags: [] })
})

test('ensureAndroidBundledEngine: registers the bundled LiteRT-LM server, then follows the APK to a new path', async (t) => {
  const prev = process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
  t.after(() => {
    if (prev === undefined) delete process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
    else process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = prev
  })
  t.mock.method(console, 'warn', () => {}) // the (absent) llama.cpp engine fails its probe; not under test here
  t.mock.method(console, 'log', () => {})
  const reg = registry([], '')

  const first = join(tmpDir('tllm-litert-native-'), 'lib')
  fakeNativeServer(first)
  process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = first
  await ensureAndroidBundledEngine(reg)
  let mine = reg.list().engines.filter((e) => e.kind === 'litert-lm')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].name, 'litert-lm-android')
  assert.equal(mine[0].binPath, join(first, LITERT_LM_NATIVE_SERVER))
  assert.equal(mine[0].version, 'litert-lm 0.18.0')
  const id = mine[0].id

  // A reinstall moves nativeLibraryDir and may ship a newer runtime: same engine, new path and version.
  const second = join(tmpDir('tllm-litert-native-'), 'lib')
  fakeNativeServer(second, '0.19.0')
  process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = second
  await ensureAndroidBundledEngine(reg)
  mine = reg.list().engines.filter((e) => e.kind === 'litert-lm')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].id, id)
  assert.equal(mine[0].binPath, join(second, LITERT_LM_NATIVE_SERVER))
  assert.equal(mine[0].version, 'litert-lm 0.19.0')
})

test('ensureAndroidBundledEngine: an APK built without LiteRT-LM registers no LiteRT-LM engine', async (t) => {
  const prev = process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
  t.after(() => {
    if (prev === undefined) delete process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
    else process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = prev
  })
  t.mock.method(console, 'warn', () => {})
  const reg = registry([], '')
  const dir = join(tmpDir('tllm-litert-native-'), 'lib')
  mkdirSync(dir, { recursive: true })
  process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = dir
  await ensureAndroidBundledEngine(reg)
  assert.equal(reg.list().engines.filter((e) => e.kind === 'litert-lm').length, 0)
})

test('packagedAppGpu: the app-reported GPU is a unified-memory device, and only inside the packaged app', () => {
  const app = { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/data/app/x/lib/arm64', TURBOLLM_ANDROID_GPU: 'Mali-G715' }
  const gpu = packagedAppGpu('android', app)
  assert.equal(gpu?.name, 'Mali-G715')
  assert.equal(gpu?.vendor, 'arm')
  assert.equal(gpu?.unified, true)
  assert.ok((gpu?.vramMb ?? 0) > 0)
  assert.equal(packagedAppGpu('android', { TURBOLLM_ANDROID_GPU: 'Mali-G715' }), null) // Termux: vulkaninfo decides
  assert.equal(packagedAppGpu('linux', app), null)
  assert.equal(packagedAppGpu('android', { ...app, TURBOLLM_ANDROID_GPU: '  ' }), null)
})

test('perfCoresFromSpeeds: counts the cores within half the fastest, only on a big.LITTLE CPU', () => {
  // Tensor G4 cpu_capacity: 4 × A520, 3 × A720, 1 × X4.
  assert.equal(perfCoresFromSpeeds([160, 160, 160, 160, 768, 768, 768, 1024]), 4)
  assert.equal(perfCoresFromSpeeds([1024, 1024, 1024, 1024]), null, 'homogeneous: keep the default')
  assert.equal(perfCoresFromSpeeds([NaN, NaN]), null, 'unreadable sysfs')
  assert.equal(autoThreadCount({ cores: 8, perfCores: 4 }), 4)
  assert.equal(autoThreadCount({ cores: 8 }), 4)
  assert.equal(autoThreadCount({ cores: 12 }), 6)
})

test('litertLmProfileToConfig: auto threads become the performance-core count; an explicit count still wins', () => {
  assert.equal(litertLmProfileToConfig({ ctx: 0, threads: 0 }, 4).default.cpu_thread_count, 4)
  assert.equal(litertLmProfileToConfig({ ctx: 0, threads: 2 }, 4).default.cpu_thread_count, 2)
  assert.equal(litertLmProfileToConfig({ ctx: 0, threads: 0 }).default.cpu_thread_count, undefined)
})

test('pyEngineEnv: the native LiteRT-LM server gets a writable cache directory for read-only model folders', () => {
  const dataDir = tmpDir('tllm-litert-native-')
  assert.equal(pyEngineEnv('litert-lm', dataDir, '/app/lib/arm64/liblitertlm_server.so')!.TURBOLLM_LITERT_CACHE_DIR, join(dataDir, 'cache', 'litert-lm'))
  assert.equal(pyEngineEnv('llama-server', dataDir, '/app/lib/arm64/libllama-server.so')!.TURBOLLM_LITERT_CACHE_DIR, undefined)
})

test('availableMemBytes: reads MemAvailable, which counts the page cache Android keeps full', () => {
  const meminfo = 'MemTotal:        7812345 kB\nMemFree:          212000 kB\nMemAvailable:    3500000 kB\n'
  assert.equal(availableMemBytes(meminfo), 3500000 * 1024)
})

test('planAutoLoad: a last-used .litertlm model is not resumed while llama.cpp is the active engine', () => {
  const llama = engine({ id: 'llama', name: 'llama.cpp', kind: 'llama-server' })
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so' })
  const store = ConfigStore.load(join(tmpDir('tllm-litert-native-'), 'config.json'))
  store.update((c) => { c.autoLoadOnStart = true; c.lastLoaded = { ...c.lastLoaded, modelKey: 'lfm|INT8|1' } })
  const entry = litertlmEntryFor('/m/lfm_int8.litertlm', '/m', 1, 0)
  const plan = planAutoLoad({ cfg: store.snapshot(), engine: llama, comfyBlocked: false, findModel: () => entry })
  assert.deepEqual(plan, {
    kind: 'skip',
    reason: { code: 'engine-incompatible', modelKey: 'lfm|INT8|1', engineName: 'llama.cpp', engineKind: 'llama-server', detail: 'format litertlm' },
  })
  // With LiteRT-LM selected it resumes there.
  const selected = planAutoLoad({ cfg: store.snapshot(), engine: litert, comfyBlocked: false, findModel: () => entry })
  assert.equal(selected.kind === 'load-model' && selected.engine.id, 'litert')
})

test('servingEngineKind: the engine the loaded model runs on, not the active one', () => {
  const litert = engine({ id: 'litert', kind: 'litert-lm' })
  const llama = engine({ id: 'llama', kind: 'llama-server' })
  const d = { registry: { active: () => llama }, manager: { currentOpts: () => ({ engine: litert }) } }
  assert.equal(servingEngineKind(d as never), 'litert-lm')
  const idle = { registry: { active: () => llama }, manager: { currentOpts: () => null } }
  assert.equal(servingEngineKind(idle as never), 'llama-server')
})

test('buildStartOpts: a Context above the bundle\'s KV-cache size is clamped to it; below it is kept', () => {
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so' })
  const entry = { ...litertlmEntryFor('/m/lfm_int8.litertlm', '/m', 1, 0, 4096) }
  const cfg = ConfigStore.load(join(tmpDir('tllm-litert-native-'), 'config.json')).snapshot()
  const sys = { os: 'android/arm64', cpu: '', cores: 8, ramMB: 8000, gpus: [] }
  const big = buildStartOpts({ entry, engine: litert, cfg, sys, overrides: { ctx: 128512 }, trigger: 'manual' } as never)
  assert.equal(big.litertLmConfig?.default.max_num_tokens, 4096)
  assert.equal(big.model.ctx, 4096)
  const small = buildStartOpts({ entry, engine: litert, cfg, sys, overrides: { ctx: 2048 }, trigger: 'manual' } as never)
  assert.equal(small.litertLmConfig?.default.max_num_tokens, 2048)
})

test('engineInUse: the active engine and the one serving the loaded model both count', () => {
  const d = (activeId: string, servingId: string | null) => ({
    registry: { active: () => ({ id: activeId }) },
    manager: { currentOpts: () => (servingId ? { engine: { id: servingId } } : null) },
  }) as never
  assert.equal(engineInUse(d('llama', 'litert'), 'litert'), true)
  assert.equal(engineInUse(d('llama', 'litert'), 'llama'), true)
  assert.equal(engineInUse(d('llama', null), 'litert'), false)
})

test('engineInUse / stopEngineUsers: an extra pool slot on the engine counts, and is stopped', async () => {
  const stopped: string[] = []
  const d = {
    registry: { active: () => ({ id: 'llama' }) },
    manager: { currentOpts: () => ({ engine: { id: 'llama' } }), stopAndWait: async () => { stopped.push('primary') } },
    modelRouter: {
      poolEngineIds: () => new Set(['litert']),
      stopPoolSlotsOnEngine: async (id: string) => { stopped.push(`pool:${id}`) },
    },
  }
  assert.equal(engineInUse(d as never, 'litert'), true)
  await stopEngineUsers(d as never, 'litert')
  assert.deepEqual(stopped, ['pool:litert'], 'the llama.cpp primary is left alone')
})

test('ensureAndroidModelsDir: the app\'s imported-models folder is always a model folder there, and only there', (t) => {
  const home = tmpDir('tllm-android-home-')
  const prevHome = process.env.HOME
  process.env.HOME = home
  t.after(() => { process.env.HOME = prevHome })
  const store = ConfigStore.load(join(tmpDir('tllm-litert-native-'), 'config.json'))
  ensureAndroidModelsDir(store, {}) // Termux / desktop: untouched
  assert.deepEqual(store.snapshot().modelDirs, [])
  ensureAndroidModelsDir(store, { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/app/lib' })
  ensureAndroidModelsDir(store, { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/app/lib' })
  assert.deepEqual(store.snapshot().modelDirs, [join(home, 'models')], 'added once, and the folder exists')
  assert.ok(existsSync(join(home, 'models')))
})
