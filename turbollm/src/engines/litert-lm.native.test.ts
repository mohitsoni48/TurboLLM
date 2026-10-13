// The Android app's bundled LiteRT-LM engine: a native port of `litert-lm serve` shipped in the APK's nativeLibraryDir
// as liblitertlm_server.so (TurboLLM-Android, engines/litert-lm-server). It keeps the CLI's contract, so the litert-lm
// kind applies unchanged — these tests pin down only what differs because it is not Python, plus the registration and
// routing that let the app use it with no setup.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { autoThreadCount, availableMemBytes, packagedAppGpu, perfCoresFromSpeeds } from '../sysinfo/sysinfo'
import { tmpDir } from '../test-support/tmp'
import { isNativeLitertLm, LITERT_LM_NATIVE_SERVER, litertLmNativeVersion, litertLmProfileToConfig, litertLmServerCommand, parseLitertLmNativeVersion } from './litert-lm'
import { pyEngineEnv } from './manager'
import { engineForModel, Registry } from './registry'
import { ensureAndroidBundledEngine, ensureAndroidModelsDir } from './seed'
import { planAutoLoad } from './auto-load'
import { engineInUse, servingEngineKind, stopEngineUsers } from './serving'
import { buildStartOpts } from './start-opts'
import { litertlmEntryFor } from '../models/litertlm'
import { resolveUpdateSource } from './update'

/** A POSIX-only stand-in for the native server: answers `--version` exactly as the real one does. It is a `#!` script
 *  named liblitertlm_server.so — the name the shipped server has in the APK — so Windows cannot execute it (spawn
 *  EFTYPE); every test using it therefore splits, rather than drops, what it can still prove there. */
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
  assert.deepEqual(py.args.slice(0, 3), ['-m', 'litert_lm_cli.main', 'serve'])
})

test('litertLmNativeVersion: reads the runtime version from --version, in the stored pip-style form', async () => {
  // The format is pinned through the parser, which needs no child process and so holds on every platform: the banner
  // names two versions and only the parenthesised runtime one may become the stored "litert-lm 0.18.0".
  assert.equal(parseLitertLmNativeVersion('turbollm-litertlm-server 1.0.0 (LiteRT-LM 0.18.0)\n'), 'litert-lm 0.18.0')
  assert.equal(parseLitertLmNativeVersion('litert-lm 0.17.0\n'), 'litert-lm litert-lm 0.17.0', 'banner with no runtime token keeps its own text')
  assert.equal(parseLitertLmNativeVersion('  \n'), 'litert-lm unknown', 'silent server: a version is still recorded')

  const bin = fakeNativeServer(tmpDir('tllm-litert-native-'))
  // The spawn half is what the fixture's platform limit forbids: Windows has no `#!` loader, so execFile of the stub
  // fails with EFTYPE and the version can only come from seed.ts's fallback there. Asserted, not skipped, so a
  // Windows regression in how the failure surfaces still shows up here.
  if (process.platform === 'win32') {
    await assert.rejects(() => litertLmNativeVersion(bin), { code: 'EFTYPE' })
    return
  }
  assert.equal(await litertLmNativeVersion(bin), 'litert-lm 0.18.0')
})

test('pyEngineEnv: the native server gets the native library path, not a venv environment', () => {
  const dataDir = tmpDir('tllm-litert-native-')
  const bin = '/app/lib/arm64/liblitertlm_server.so'
  // The native library path is a POSIX-only contract: pyEngineEnv returns undefined for a native engine on Windows on
  // purpose (manager.ts), because Windows' loader already searches the executable's own directory for a bundled DLL,
  // so the engine inherits the daemon environment unchanged. Both branches assert the real contract of that platform.
  if (process.platform === 'win32') {
    assert.equal(pyEngineEnv('litert-lm', dataDir, bin), undefined)
  } else {
    const native = pyEngineEnv('litert-lm', dataDir, bin)!
    assert.match(native.LD_LIBRARY_PATH ?? '', /^\/app\/lib\/arm64(:|$)/)
    assert.equal(native.HF_HUB_OFFLINE, undefined)
  }
  // The Python half of the same kind is platform-independent: a venv install still gets the offline HuggingFace env.
  const py = pyEngineEnv('litert-lm', dataDir, '/venv/bin/python')!
  assert.equal(py.HF_HUB_OFFLINE, '1')
})

test('resolveUpdateSource: the bundled server updates with the app, never from PyPI', () => {
  assert.equal(resolveUpdateSource(engine({ kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so', version: 'litert-lm 0.18.0' })), null)
  assert.equal(resolveUpdateSource(engine({ kind: 'litert-lm', binPath: '/venv/bin/python', version: 'litert-lm 0.18.0' }))?.source, 'pip')
})

test('engineForModel: a .litertlm model goes to the LiteRT-LM engine while another kind is active', () => {
  const llama = engine({ id: 'llama', kind: 'llama-server' })
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so' })
  const reg = registry([llama, litert], 'llama')
  assert.equal(engineForModel(reg, { format: 'litertlm' })?.id, 'litert')
  assert.equal(engineForModel(reg, { format: 'gguf' })?.id, 'llama')
  // No LiteRT-LM engine registered: the active one is still returned, and compat reports the mismatch as before.
  assert.equal(engineForModel(registry([llama], 'llama'), { format: 'litertlm' })?.id, 'llama')
  // An active LiteRT-LM engine is used as-is.
  assert.equal(engineForModel(registry([llama, litert], 'litert'), { format: 'litertlm' })?.id, 'litert')
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

  // The version probe runs the stub above, so its result is platform-dependent: Windows can't execute the `#!` file
  // and seed.ts then stores its documented 'litert-lm (bundled)' placeholder instead of losing the engine over a
  // --version that cannot run there. Name, id and binPath stay asserted identically on both platforms.
  const versionOf = (stub: string) => (process.platform === 'win32' ? 'litert-lm (bundled)' : `litert-lm ${stub}`)

  const first = join(tmpDir('tllm-litert-native-'), 'lib')
  fakeNativeServer(first)
  process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR = first
  await ensureAndroidBundledEngine(reg)
  let mine = reg.list().engines.filter((e) => e.kind === 'litert-lm')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].name, 'litert-lm-android')
  assert.equal(mine[0].binPath, join(first, LITERT_LM_NATIVE_SERVER))
  assert.equal(mine[0].version, versionOf('0.18.0'))
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
  assert.equal(mine[0].version, versionOf('0.19.0'))
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
  assert.equal(litertLmProfileToConfig({ ctx: 0, ngl: 0, threads: 0 }, false, 4).default.cpu_thread_count, 4)
  assert.equal(litertLmProfileToConfig({ ctx: 0, ngl: 0, threads: 2 }, false, 4).default.cpu_thread_count, 2)
  assert.equal(litertLmProfileToConfig({ ctx: 0, ngl: 0, threads: 0 }, false).default.cpu_thread_count, undefined)
})

test('pyEngineEnv: the native LiteRT-LM server gets a writable cache directory for read-only model folders', () => {
  const dataDir = tmpDir('tllm-litert-native-')
  // Same Windows split as the LD_LIBRARY_PATH test, and for the same reason: pyEngineEnv returns no env at all for a
  // native engine there, so the cache dir is unset by design rather than by omission. Optional chaining makes the
  // assertion run on both platforms and still fail if POSIX ever stops setting the dir (undefined !== the path).
  const native = pyEngineEnv('litert-lm', dataDir, '/app/lib/arm64/liblitertlm_server.so')
  assert.equal(native?.TURBOLLM_LITERT_CACHE_DIR, process.platform === 'win32' ? undefined : join(dataDir, 'cache', 'litert-lm'))
  // A llama.cpp engine never gets it on either platform: undefined here means "not a litert-lm native server".
  assert.equal(pyEngineEnv('llama-server', dataDir, '/app/lib/arm64/libllama-server.so')?.TURBOLLM_LITERT_CACHE_DIR, undefined)
})

test('availableMemBytes: reads MemAvailable, which counts the page cache Android keeps full', () => {
  const meminfo = 'MemTotal:        7812345 kB\nMemFree:          212000 kB\nMemAvailable:    3500000 kB\n'
  assert.equal(availableMemBytes(meminfo), 3500000 * 1024)
})

test('planAutoLoad: a last-used .litertlm model resumes on the LiteRT-LM engine while llama.cpp is active', () => {
  const llama = engine({ id: 'llama', kind: 'llama-server' })
  const litert = engine({ id: 'litert', kind: 'litert-lm', binPath: '/lib/liblitertlm_server.so' })
  const store = ConfigStore.load(join(tmpDir('tllm-litert-native-'), 'config.json'))
  store.update((c) => { c.autoLoadOnStart = true; c.lastLoaded = { ...c.lastLoaded, modelKey: 'lfm|INT8|1' } })
  const entry = litertlmEntryFor('/m/lfm_int8.litertlm', '/m', 1, 0)
  const plan = planAutoLoad({ cfg: store.snapshot(), engine: llama, litertLmEngine: litert, comfyBlocked: false, findModel: () => entry })
  assert.equal(plan.kind, 'load-model')
  assert.equal(plan.kind === 'load-model' && plan.engine.id, 'litert')
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
  // os.homedir() reads HOME on POSIX but USERPROFILE on Windows (HOMEDRIVE+HOMEPATH only when it is unset or empty),
  // so the fake home has to be published under both names or this asserts against the runner's real profile. Both
  // variables are restored — or removed again when they were not set — so no later test sees a home that never existed.
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
  })
  const store = ConfigStore.load(join(tmpDir('tllm-litert-native-'), 'config.json'))
  ensureAndroidModelsDir(store, {}) // Termux / desktop: untouched
  assert.deepEqual(store.snapshot().modelDirs, [])
  ensureAndroidModelsDir(store, { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/app/lib' })
  ensureAndroidModelsDir(store, { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/app/lib' })
  assert.deepEqual(store.snapshot().modelDirs, [join(home, 'models')], 'added once, and the folder exists')
  assert.ok(existsSync(join(home, 'models')))
})
