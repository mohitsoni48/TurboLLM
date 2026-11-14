// M-1 (ADR-462, architecture §1.3 I-3/I-4/I-5, §3.4 rules 2-4): every upgrade path ends with the settings and
// lastLoaded the user had, on a row that can read them. Each case writes a config.json fixture to a temp dir, starts
// the app over it (the real ConfigStore with its normaliser, the real Registry, reconcileAndroidEngines with a fake
// SDK), and asserts on the config file as it is read back from disk afterwards.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ConfigStore, defaultConfig, getModelProfile, type Config, type Engine, type ModelPreset, type ProfileEntry,
} from '../config/config'
import {
  CPU_FILE, LITERT_INFO, LLAMA_INFO, VK_FILE, appRegistry, bundledRow, engineRow, quietAndroidLog, reconcileWith,
  shipNativeLibs, type AndroidTest,
} from '../test-support/android-engines'
import { tmpDir } from '../test-support/tmp'
import type { ModelFormat } from './compat'
import { LITERT_LM_NATIVE_SERVER } from './litert-lm'
import type { SdkEngineInfo } from './sdk-engines'
import { ANDROID_ENGINE_NAME, ANDROID_LITERT_LM_ENGINE_NAME, ANDROID_VULKAN_ENGINE_NAME } from './android-engines'

const SDK_URL = 'http://sdk.invalid:1'
const NEXT_SDK_URL = 'http://sdk-next.invalid:1'
const M1_SDK_URL = 'http://sdk-m1.invalid:1'
const LITERT_UNAVAILABLE: SdkEngineInfo = { ...LITERT_INFO, available: false, reason: 'Disabled for testing (debug build).' }

const GGUF_MODEL = 'qwen|Q4_K_M|1'
const LITERT_MODEL = 'gemma|litertlm|2'
const SECOND_LITERT_MODEL = 'qwen3|litertlm|1'
const MISSING_MODEL = 'deleted|Q4_K_M|1'
const LIBRARY: Record<string, ModelFormat> = {
  [GGUF_MODEL]: 'gguf', [LITERT_MODEL]: 'litertlm', [SECOND_LITERT_MODEL]: 'litertlm',
}

const CPU_ID = 'cpu-row-id'
const VK_ID = 'vk-row-id'
const LITERT_SERVER_ID = 'litert-server-row-id'
const M1_ID = 'm1-sdk-row-id'
const ORPHAN_ID = 'deleted-litert-server-row-id'
const REMOVED_ID = 'removed-row-id'

const SAVED_AT = '2026-10-01T00:00:00.000Z'
const GGUF_TUNE = profileEntry({ ctx: 6144 })
const LITERT_GPU_TUNE = profileEntry({ ctx: 4096, backend: 'gpu' })
const LITERT_SMALL_TUNE = profileEntry({ ctx: 2048 })
const LITERT_CPU_TUNE = profileEntry({ ctx: 4096, backend: 'cpu' })
const LITERT_PINNED_TUNE = profileEntry({ ctx: 8192, backend: 'gpu' })

/** One Android start, as boot.ts runs it: the files the APK ships, and the SDK's engine list when the app started it. */
interface AndroidStart {
  shippedFiles: string[]
  sdkEngines?: SdkEngineInfo[] | null
  sdkUrl?: string
}

const DEFAULT_APK: AndroidStart = { shippedFiles: [CPU_FILE], sdkEngines: [LLAMA_INFO, LITERT_INFO] }
const ROLLBACK_APK: AndroidStart = { ...DEFAULT_APK, shippedFiles: [CPU_FILE, LITERT_LM_NATIVE_SERVER] }
const EVERY_FILE_APK: AndroidStart = { ...DEFAULT_APK, shippedFiles: [CPU_FILE, VK_FILE, LITERT_LM_NATIVE_SERVER] }
const SDK_NOT_STARTED: AndroidStart = { shippedFiles: [CPU_FILE] }
const LITERT_GONE: AndroidStart = { ...DEFAULT_APK, sdkEngines: [LLAMA_INFO, LITERT_UNAVAILABLE] }

test('M-1 case 1: v1.15.0 on llama-server-android stays there, same id, settings byte-equal (R-5 superseded)', async (t) => {
  const phone = androidPhone(t, v1150OnLlamaServer)
  const before = phone.config()

  const after = await phone.start(DEFAULT_APK)

  assert.equal(after.activeEngineId, CPU_ID)
  assert.equal(rowNamed(after, ANDROID_ENGINE_NAME).id, CPU_ID)
  assert.deepEqual(sdkRowsOf(after).map((e) => e.sdkEngine?.id), ['llama.cpp-cpu', 'litert-lm'])
  assertUserSettingsByteEqual(after, before)
})

test('M-1 case 2: v1.15.0 on litert-lm-android: retired and remembered, .litertlm settings copied, LiteRT-LM active', async (t) => {
  const phone = androidPhone(t, v1150OnLitertServer)
  const before = phone.config()

  const after = await phone.start(DEFAULT_APK)
  const litertId = sdkRowId(after, 'litert-lm')

  assert.equal(after.engines.some((e) => e.id === LITERT_SERVER_ID), false, 'the server row is no longer an engine')
  assert.equal(after.androidRetiredEngines?.[ANDROID_LITERT_LM_ENGINE_NAME]?.id, LITERT_SERVER_ID)
  assert.equal(after.androidRetiredEngines?.[ANDROID_LITERT_LM_ENGINE_NAME]?.copiedTo, litertId)
  assert.deepEqual(after.modelProfiles[LITERT_MODEL][litertId], LITERT_GPU_TUNE)
  assert.deepEqual(after.modelProfiles[SECOND_LITERT_MODEL][litertId], LITERT_SMALL_TUNE)
  assert.equal(after.modelProfiles[GGUF_MODEL][litertId], undefined, 'a GGUF entry is not copied')
  assert.deepEqual(presetsOn(after, LITERT_MODEL, litertId).map((p) => p.name), ['Fast GPU'])
  assert.deepEqual(presetsOn(after, GGUF_MODEL, litertId), [])
  assert.notEqual(presetsOn(after, LITERT_MODEL, litertId)[0].id, presetsOn(before, LITERT_MODEL, LITERT_SERVER_ID)[0].id)
  assertOriginalsKept(after, before, LITERT_SERVER_ID)
  assert.deepEqual(after.lastLoaded, before.lastLoaded)
  assert.equal(after.activeEngineId, litertId)
})

test('M-1 case 2 (m-2): the preset pinned on litert-lm-android applies on the LiteRT-LM SDK row after the upgrade', async (t) => {
  const phone = androidPhone(t, v1150OnLitertServer)

  const after = await phone.start(DEFAULT_APK)
  const litertId = sdkRowId(after, 'litert-lm')

  assert.deepEqual(getModelProfile(after, LITERT_MODEL, litertId), LITERT_PINNED_TUNE.profile)
  assert.equal(after.lastPresetId[LITERT_MODEL], presetsOn(after, LITERT_MODEL, litertId)[0].id)
  assert.deepEqual(presetsOn(after, LITERT_MODEL, LITERT_SERVER_ID).map((p) => p.name), ['Fast GPU'], 'the original stays')
})

test('M-1 case 3: a rollback build reinstates litert-lm-android under the same id and copies nothing again', async (t) => {
  const phone = androidPhone(t, v1150OnLitertServer)
  const upgraded = await phone.start(DEFAULT_APK)

  const rolledBack = await phone.start(ROLLBACK_APK)

  assert.equal(rowNamed(rolledBack, ANDROID_LITERT_LM_ENGINE_NAME).id, LITERT_SERVER_ID)
  assert.equal(rolledBack.androidRetiredEngines?.[ANDROID_LITERT_LM_ENGINE_NAME], undefined)
  assert.deepEqual(rolledBack.modelProfiles, upgraded.modelProfiles, 'the originals and the SDK row\'s copies, untouched')
  assert.deepEqual(rolledBack.modelPresets, upgraded.modelPresets, 'no second copy')
  assert.equal(rolledBack.activeEngineId, upgraded.activeEngineId, 'the reinstated row is not activated')

  const forwardAgain = await phone.start(DEFAULT_APK)
  assert.deepEqual(forwardAgain.modelProfiles, upgraded.modelProfiles)
  assert.deepEqual(forwardAgain.modelPresets, upgraded.modelPresets, 'retiring it a second time adds no preset copy')
})

test('M-1 case 4: the M1 row with a GGUF lastLoaded is adopted as llama.cpp (CPU), stays active, its .litertlm settings copied', async (t) => {
  const phone = androidPhone(t, m1LegacyRow(GGUF_MODEL))
  const before = phone.config()

  const after = await phone.start(DEFAULT_APK)
  const litertId = sdkRowId(after, 'litert-lm')

  assert.equal(sdkRowId(after, 'llama.cpp-cpu'), M1_ID)
  assert.equal(rowWithId(after, M1_ID).name, 'llama.cpp (CPU)')
  assert.equal(after.activeEngineId, M1_ID)
  assert.deepEqual(after.modelProfiles[LITERT_MODEL][litertId], LITERT_CPU_TUNE)
  assert.deepEqual(presetsOn(after, LITERT_MODEL, litertId).map((p) => p.name), ['CPU'])
  assert.equal(after.modelProfiles[GGUF_MODEL][litertId], undefined)
  assertOriginalsKept(after, before, M1_ID)
  assert.deepEqual(after.lastLoaded, before.lastLoaded)
})

test('M-1 case 5: the M1 row with a .litertlm lastLoaded: LiteRT-LM active, the M1 row keeps the originals', async (t) => {
  const phone = androidPhone(t, m1LegacyRow(LITERT_MODEL))
  const before = phone.config()

  const after = await phone.start(DEFAULT_APK)
  const litertId = sdkRowId(after, 'litert-lm')

  assert.equal(after.activeEngineId, litertId)
  assert.deepEqual(after.modelProfiles[LITERT_MODEL][litertId], LITERT_CPU_TUNE)
  assertOriginalsKept(after, before, M1_ID)
  assert.deepEqual(after.lastLoaded, before.lastLoaded)
})

test('M-1 case 6: a fresh install: three rows, LiteRT-LM active, nothing remembered as retired', async (t) => {
  const phone = androidPhone(t, freshInstall)

  const after = await phone.start(DEFAULT_APK)

  assert.deepEqual(after.engines.map((e) => e.name), ['llama.cpp (CPU)', 'LiteRT-LM', ANDROID_ENGINE_NAME])
  assert.equal(after.activeEngineId, sdkRowId(after, 'litert-lm'))
  assert.deepEqual(after.androidRetiredEngines ?? {}, {})
})

const OUTPUTS_TO_START_AGAIN: { name: string; fixture: Fixture; starts: AndroidStart[] }[] = [
  { name: 'case 1', fixture: v1150OnLlamaServer, starts: [DEFAULT_APK] },
  { name: 'case 2', fixture: v1150OnLitertServer, starts: [DEFAULT_APK] },
  { name: 'case 3', fixture: v1150OnLitertServer, starts: [DEFAULT_APK, ROLLBACK_APK] },
  { name: 'case 4', fixture: m1LegacyRow(GGUF_MODEL), starts: [DEFAULT_APK] },
  { name: 'case 5', fixture: m1LegacyRow(LITERT_MODEL), starts: [DEFAULT_APK] },
  { name: 'case 6', fixture: freshInstall, starts: [DEFAULT_APK] },
  { name: 'case 8', fixture: m1LegacyRow(LITERT_MODEL), starts: [SDK_NOT_STARTED] },
  { name: 'case 10', fixture: freshInstall, starts: [DEFAULT_APK, LITERT_GONE, DEFAULT_APK] },
]

// The next start's own config load fills defaults into rows this start created (updatePolicy, ADR-085) and sets
// defaultEngineSeeded once an engine exists: those are the normaliser's, on every platform and kind, not the
// reconciler's. Each output is compared as that load leaves it.
test('M-1 case 7: starting again over every output changes nothing in config.json but the SDK URL', async (t) => {
  for (const { name, fixture, starts } of OUTPUTS_TO_START_AGAIN) {
    const phone = androidPhone(t, fixture)
    for (const start of starts) await phone.start(start)
    const output = phone.config()
    const last = starts[starts.length - 1]

    const again = await phone.start({ ...last, sdkUrl: NEXT_SDK_URL })

    assert.deepEqual(withoutSdkUrls(again), withoutSdkUrls(output), `${name}: only the SDK URL may change`)
    if (last.sdkEngines) assert.ok(sdkRowsOf(again).every((e) => e.baseUrl === NEXT_SDK_URL), `${name}: the new URL`)
  }
})

test('M-1 case 8: the SDK not started over case 1 changes nothing', async (t) => {
  const phone = androidPhone(t, v1150OnLlamaServer)
  const before = phone.config()

  const after = await phone.start(SDK_NOT_STARTED)

  assert.deepEqual(after, before)
})

test('M-1 case 8: the SDK not started over case 5 activates the CPU server; the SDK\'s return switches back to the LiteRT-LM row', async (t) => {
  const phone = androidPhone(t, m1LegacyRow(LITERT_MODEL))
  const before = phone.config()

  const withoutSdk = await phone.start(SDK_NOT_STARTED)
  assert.equal(withoutSdk.activeEngineId, CPU_ID)
  assert.ok(withoutSdk.engines.some((e) => e.id === M1_ID), 'the SDK row is kept: not started is not unavailable')
  assertUserSettingsByteEqual(withoutSdk, before)

  const sdkBack = await phone.start(DEFAULT_APK)
  assert.equal(sdkBack.activeEngineId, sdkRowId(sdkBack, 'litert-lm'), 'the row that reads the .litertlm lastLoaded')
  assert.equal(sdkBack.androidSdkFallback, undefined, 'the fallback is forgotten once undone')
  assert.deepEqual(sdkBack.lastLoaded, before.lastLoaded)
})

test('M-1 case 9: a lastLoaded model gone from the library, under a live pick: nothing activated, nothing copied for it', async (t) => {
  const phone = androidPhone(t, m1LegacyRow(MISSING_MODEL))
  const before = phone.config()

  const after = await phone.start(DEFAULT_APK)

  assert.equal(after.activeEngineId, M1_ID)
  assert.deepEqual(after.lastLoaded, before.lastLoaded)
  assert.deepEqual(Object.keys(after.modelProfiles[MISSING_MODEL]), [M1_ID], 'its format is unknown, so it is not copied')
})

test('M-1 case 9: a lastLoaded model gone from the library, nothing usable active: lastLoaded\'s own live row', async (t) => {
  const phone = androidPhone(t, nothingUsableActive(MISSING_MODEL, CPU_ID))

  const after = await phone.start(DEFAULT_APK)

  assert.equal(after.activeEngineId, CPU_ID)
  assert.deepEqual(after.lastLoaded, { modelKey: MISSING_MODEL, engineId: CPU_ID })
})

test('M-1 case 9: a lastLoaded model and its row both gone, nothing usable active: the default chain (LiteRT-LM)', async (t) => {
  const phone = androidPhone(t, nothingUsableActive(MISSING_MODEL, REMOVED_ID))

  const after = await phone.start(DEFAULT_APK)

  assert.equal(after.activeEngineId, sdkRowId(after, 'litert-lm'))
  assert.deepEqual(after.lastLoaded, { modelKey: MISSING_MODEL, engineId: REMOVED_ID })
})

test('M-1 (E-04): nothing usable active with a GGUF lastLoaded lands on a GGUF row, never LiteRT-LM', async (t) => {
  const phone = androidPhone(t, nothingUsableActive(GGUF_MODEL, REMOVED_ID))

  const after = await phone.start(DEFAULT_APK)

  assert.equal(after.activeEngineId, sdkRowId(after, 'llama.cpp-cpu'))
})

test('M-1 (E-06): nothing usable active, lastLoaded\'s live row cannot read its .litertlm model: the row that can', async (t) => {
  const phone = androidPhone(t, nothingUsableActive(LITERT_MODEL, CPU_ID))

  const after = await phone.start(DEFAULT_APK)

  assert.equal(after.activeEngineId, sdkRowId(after, 'litert-lm'))
  assert.deepEqual(after.lastLoaded, { modelKey: LITERT_MODEL, engineId: CPU_ID })
})

test('M-1 case 10 (D-15): an SDK engine gone for one start comes back as the same row, its settings apply, the pick stands', async (t) => {
  const phone = androidPhone(t, freshInstall)
  const installed = await phone.start(DEFAULT_APK)
  const litertId = sdkRowId(installed, 'litert-lm')
  const llamaId = sdkRowId(installed, 'llama.cpp-cpu')
  phone.edit((c) => {
    c.modelProfiles[LITERT_MODEL] = { [litertId]: LITERT_SMALL_TUNE }
    c.modelPresets[LITERT_MODEL] = [preset('Small', litertId, LITERT_SMALL_TUNE)]
    c.lastLoaded = { modelKey: LITERT_MODEL, engineId: litertId }
    c.activeEngineId = llamaId
  })
  const saved = phone.config()

  const without = await phone.start(LITERT_GONE)
  assert.equal(without.engines.some((e) => e.id === litertId), false, 'no row while it is unavailable (ADR-239)')
  assert.equal(without.androidRetiredEngines?.['sdk:litert-lm']?.id, litertId)
  assertUserSettingsByteEqual(without, saved)
  assert.equal(without.activeEngineId, llamaId)

  const back = await phone.start(DEFAULT_APK)
  assert.equal(sdkRowId(back, 'litert-lm'), litertId)
  assert.equal(back.androidRetiredEngines?.['sdk:litert-lm'], undefined)
  assertUserSettingsByteEqual(back, saved)
  assert.equal(back.activeEngineId, llamaId, 'its return does not activate it')
})

test('M-1 case 10 (D-15): LiteRT-LM active when it goes away is not replaced by a row that cannot read the .litertlm lastLoaded', async (t) => {
  const phone = androidPhone(t, freshInstall)
  const installed = await phone.start(DEFAULT_APK)
  const litertId = sdkRowId(installed, 'litert-lm')
  phone.edit((c) => {
    c.lastLoaded = { modelKey: LITERT_MODEL, engineId: litertId }
  })

  const without = await phone.start(LITERT_GONE)
  const ggufRowIds = without.engines.map((e) => e.id)
  assert.equal(ggufRowIds.includes(without.activeEngineId), false, 'every row left reads GGUF only')

  const back = await phone.start(DEFAULT_APK)
  assert.equal(sdkRowId(back, 'litert-lm'), litertId)
  assert.deepEqual(back.lastLoaded, { modelKey: LITERT_MODEL, engineId: litertId })
})

test('M-1 (E-19, G-6): settings keyed on an id no row or retired entry has are kept as they are, and not copied', async (t) => {
  const phone = androidPhone(t, m1RowWithOrphanedLitertSettings)
  const before = phone.config()

  const after = await phone.start(DEFAULT_APK)

  assert.deepEqual(after.modelProfiles[SECOND_LITERT_MODEL], before.modelProfiles[SECOND_LITERT_MODEL])
  assert.deepEqual(after.modelPresets[SECOND_LITERT_MODEL], before.modelPresets[SECOND_LITERT_MODEL])
})

test('M-1 (E-18): ten starts alternating with and without the bundled files keep one id per bundled row', async (t) => {
  const phone = androidPhone(t, v1150WithEveryBundledRow)
  const idsSeen = new Map([[ANDROID_VULKAN_ENGINE_NAME, new Set<string>()], [ANDROID_LITERT_LM_ENGINE_NAME, new Set<string>()]])

  for (let start = 0; start < 10; start++) {
    const after = await phone.start(start % 2 === 0 ? DEFAULT_APK : EVERY_FILE_APK)
    const retired = after.androidRetiredEngines ?? {}
    assert.deepEqual(Object.keys(retired).filter((key) => !idsSeen.has(key)), [], `start ${start}: only bundled names`)
    for (const [name, ids] of idsSeen) {
      const live = after.engines.find((e) => e.name === name)
      assert.ok(!live !== !retired[name], `start ${start}: ${name} is either a row or remembered, never both`)
      ids.add(live?.id ?? retired[name].id)
    }
  }
  assert.deepEqual([...idsSeen.values()].map((ids) => [...ids]), [[VK_ID], [LITERT_SERVER_ID]])
})

type Fixture = (nativeLibDir: string) => Config

/** A phone whose config.json is written from `fixture`. Every start loads that file, and returns it as read back. */
function androidPhone(t: AndroidTest, fixture: Fixture) {
  quietAndroidLog(t)
  const home = tmpDir('tllm-android-migration-')
  const configPath = join(home, 'config.json')
  const nativeLibDir = join(home, 'lib')
  writeFileSync(configPath, JSON.stringify(fixture(nativeLibDir), null, 2))
  return {
    config: () => {
      ConfigStore.load(configPath)
      return configOnDisk(configPath)
    },
    edit: (change: (c: Config) => void) => ConfigStore.load(configPath).update(change),
    start: async (start: AndroidStart) => {
      shipNativeLibs(nativeLibDir, start.shippedFiles)
      await startApp(t, configPath, { nativeLibDir, start })
      return configOnDisk(configPath)
    },
  }
}

async function startApp(t: AndroidTest, configPath: string, launch: { nativeLibDir: string; start: AndroidStart }) {
  const { nativeLibDir, start } = launch
  const sdkStarted = start.sdkEngines !== undefined
  await reconcileWith(appRegistry(t, ConfigStore.load(configPath)), {
    nativeLibDir,
    sdkUrl: sdkStarted ? (start.sdkUrl ?? SDK_URL) : undefined,
    sdkEngines: start.sdkEngines,
    library: LIBRARY,
  })
}

function configOnDisk(configPath: string): Config {
  return JSON.parse(readFileSync(configPath, 'utf8')) as Config
}

function freshInstall(): Config {
  return defaultConfig()
}

function v1150OnLlamaServer(nativeLibDir: string): Config {
  return {
    ...defaultConfig(),
    engines: [bundledRow(CPU_ID, ANDROID_ENGINE_NAME, nativeLibDir, CPU_FILE)],
    activeEngineId: CPU_ID,
    lastLoaded: { modelKey: GGUF_MODEL, engineId: CPU_ID },
    modelProfiles: { [GGUF_MODEL]: { [CPU_ID]: GGUF_TUNE } },
    modelPresets: { [GGUF_MODEL]: [preset('Long context', CPU_ID, GGUF_TUNE)] },
  }
}

function v1150OnLitertServer(nativeLibDir: string): Config {
  const fastGpu = preset('Fast GPU', LITERT_SERVER_ID, LITERT_PINNED_TUNE)
  return {
    ...defaultConfig(),
    engines: [
      bundledRow(CPU_ID, ANDROID_ENGINE_NAME, nativeLibDir, CPU_FILE),
      bundledRow(LITERT_SERVER_ID, ANDROID_LITERT_LM_ENGINE_NAME, nativeLibDir, LITERT_LM_NATIVE_SERVER, 'litert-lm'),
    ],
    activeEngineId: LITERT_SERVER_ID,
    lastLoaded: { modelKey: LITERT_MODEL, engineId: LITERT_SERVER_ID },
    modelProfiles: {
      [LITERT_MODEL]: { [LITERT_SERVER_ID]: LITERT_GPU_TUNE },
      [SECOND_LITERT_MODEL]: { [LITERT_SERVER_ID]: LITERT_SMALL_TUNE },
      [GGUF_MODEL]: { [LITERT_SERVER_ID]: GGUF_TUNE, [CPU_ID]: GGUF_TUNE },
    },
    modelPresets: {
      [LITERT_MODEL]: [fastGpu],
      [SECOND_LITERT_MODEL]: [preset('Small', LITERT_SERVER_ID, LITERT_SMALL_TUNE)],
      [GGUF_MODEL]: [preset('Long context', CPU_ID, GGUF_TUNE)],
    },
    lastPresetId: { [LITERT_MODEL]: fastGpu.id },
  }
}

function v1150WithEveryBundledRow(nativeLibDir: string): Config {
  const config = v1150OnLitertServer(nativeLibDir)
  config.engines.push(bundledRow(VK_ID, ANDROID_VULKAN_ENGINE_NAME, nativeLibDir, VK_FILE))
  config.activeEngineId = CPU_ID
  return config
}

function m1LegacyRow(lastModel: string): Fixture {
  return (nativeLibDir) => ({
    ...defaultConfig(),
    engines: [
      engineRow(M1_ID, 'TurboLLM SDK', 'turbollm-sdk', { baseUrl: M1_SDK_URL, version: 'in-app' }),
      bundledRow(CPU_ID, ANDROID_ENGINE_NAME, nativeLibDir, CPU_FILE),
    ],
    activeEngineId: M1_ID,
    lastLoaded: { modelKey: lastModel, engineId: M1_ID },
    modelProfiles: {
      [GGUF_MODEL]: { [M1_ID]: GGUF_TUNE },
      [LITERT_MODEL]: { [M1_ID]: LITERT_CPU_TUNE },
      [MISSING_MODEL]: { [M1_ID]: GGUF_TUNE },
    },
    modelPresets: {
      [GGUF_MODEL]: [preset('Long context', M1_ID, GGUF_TUNE)],
      [LITERT_MODEL]: [preset('CPU', M1_ID, LITERT_CPU_TUNE)],
      [MISSING_MODEL]: [preset('Saved', M1_ID, GGUF_TUNE)],
    },
  })
}

/** The M1 build on the founder's phone (E-19, G-6): settings left on a litert-lm-android row an earlier build deleted. */
function m1RowWithOrphanedLitertSettings(nativeLibDir: string): Config {
  const config = m1LegacyRow(GGUF_MODEL)(nativeLibDir)
  config.modelProfiles[SECOND_LITERT_MODEL] = { [ORPHAN_ID]: LITERT_GPU_TUNE }
  config.modelPresets[SECOND_LITERT_MODEL] = [preset('Orphaned', ORPHAN_ID, LITERT_GPU_TUNE)]
  return config
}

/** v1.15.0 on llama-server-android, but the active id names no row any more. */
function nothingUsableActive(lastModel: string, lastEngineId: string): Fixture {
  return (nativeLibDir) => ({
    ...v1150OnLlamaServer(nativeLibDir),
    activeEngineId: REMOVED_ID,
    lastLoaded: { modelKey: lastModel, engineId: lastEngineId },
  })
}

function profileEntry(profile: Record<string, unknown>): ProfileEntry {
  return { profile, updatedAt: SAVED_AT }
}

function preset(name: string, engineId: string, entry: ProfileEntry): ModelPreset {
  return { id: randomUUID(), name, engineId, profile: entry.profile, updatedAt: SAVED_AT, origin: 'manual' }
}

function sdkRowsOf(config: Config): Engine[] {
  return config.engines.filter((e) => e.kind === 'turbollm-sdk')
}

function sdkRowId(config: Config, sdkEngineId: string): string {
  const row = sdkRowsOf(config).find((e) => e.sdkEngine?.id === sdkEngineId)
  assert.ok(row, `an SDK row for ${sdkEngineId}`)
  return row.id
}

function rowNamed(config: Config, name: string): Engine {
  const row = config.engines.find((e) => e.name === name)
  assert.ok(row, `a row named ${name}`)
  return row
}

function rowWithId(config: Config, id: string): Engine {
  const row = config.engines.find((e) => e.id === id)
  assert.ok(row, `a row with id ${id}`)
  return row
}

function presetsOn(config: Config, modelKey: string, engineId: string): ModelPreset[] {
  return (config.modelPresets[modelKey] ?? []).filter((p) => p.engineId === engineId)
}

/** Profiles, presets, pinned presets and lastLoaded exactly as they were, byte for byte. */
function assertUserSettingsByteEqual(after: Config, before: Config): void {
  assert.equal(JSON.stringify(after.modelProfiles), JSON.stringify(before.modelProfiles))
  assert.equal(JSON.stringify(after.modelPresets), JSON.stringify(before.modelPresets))
  assert.equal(JSON.stringify(after.lastPresetId), JSON.stringify(before.lastPresetId))
  assert.equal(JSON.stringify(after.lastLoaded), JSON.stringify(before.lastLoaded))
}

/** Every profile and preset `engineId` had before is still there, unchanged. */
function assertOriginalsKept(after: Config, before: Config, engineId: string): void {
  for (const [modelKey, byEngine] of Object.entries(before.modelProfiles)) {
    if (byEngine[engineId]) assert.deepEqual(after.modelProfiles[modelKey][engineId], byEngine[engineId], modelKey)
  }
  for (const modelKey of Object.keys(before.modelPresets)) {
    assert.deepEqual(presetsOn(after, modelKey, engineId), presetsOn(before, modelKey, engineId), modelKey)
  }
}

/** The config with the SDK rows' baseUrl left out: the SDK listens on a new port every launch. */
function withoutSdkUrls(config: Config): Config {
  return { ...config, engines: config.engines.map((e) => (e.kind === 'turbollm-sdk' ? { ...e, baseUrl: undefined } : e)) }
}
