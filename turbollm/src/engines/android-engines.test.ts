// The Android engine reconciler (ADR-462, architecture §3.4). planAndroidEngines is pure: it reads the rows, the
// remembered retired rows, which bundled files this APK ships and the SDK's engine list, and returns the actions the
// applier carries out. These cases are table-driven over hand-built inputs, with no I/O.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, defaultConfig, type Config, type Engine, type RetiredEngine } from '../config/config'
import type { Registry } from './registry'
import {
  CPU_FILE, LITERT_INFO, LLAMA_INFO, VK_FILE, appRegistry, bundledRow, engineRow, quietAndroidLog, reconcileWith,
  sdkRowFor, sdkRowsOf, shipNativeLibs, type AndroidTest, type MockedConsole,
} from '../test-support/android-engines'
import { tmpDir } from '../test-support/tmp'
import type { ModelFormat } from './compat'
import type { SdkEngineInfo } from './sdk-engines'
import { LITERT_LM_NATIVE_SERVER } from './litert-lm'
import {
  ANDROID_ENGINE_NAME, ANDROID_LITERT_LM_ENGINE_NAME, ANDROID_VULKAN_ENGINE_NAME,
  planAndroidEngines, reconcileAndroidEngines, type AndroidEngineAction, type AndroidEngineInput,
} from './android-engines'

const NATIVE = '/data/app/com.turbollm/lib/arm64'
const SDK_URL = 'http://sdk.invalid:1'

function sdkRow(id: string, info: SdkEngineInfo): Engine {
  const { formats, backends, kind } = info
  return engineRow(id, info.name, 'turbollm-sdk', { baseUrl: SDK_URL, sdkEngine: { id: info.id, kind, formats, backends } })
}

const CPU_ROW = bundledRow('cpu', ANDROID_ENGINE_NAME, NATIVE, CPU_FILE)
const VK_ROW = bundledRow('vk', ANDROID_VULKAN_ENGINE_NAME, NATIVE, VK_FILE)
const LITERT_SERVER_ROW = bundledRow('lsrv', ANDROID_LITERT_LM_ENGINE_NAME, NATIVE, LITERT_LM_NATIVE_SERVER, 'litert-lm')
const LEGACY_ROW = engineRow('m1', 'TurboLLM SDK', 'turbollm-sdk', { baseUrl: SDK_URL })
const LLAMA_SDK_ROW = sdkRow('sdk-llama', LLAMA_INFO)
const LITERT_SDK_ROW = sdkRow('sdk-litert', LITERT_INFO)

const FORMATS: Record<string, ModelFormat> = { 'qwen|Q4_K_M|1': 'gguf', 'gemma|litertlm|2': 'litertlm' }

function input(over: Partial<AndroidEngineInput> = {}): AndroidEngineInput {
  return {
    engines: [],
    activeEngineId: '',
    lastLoaded: { modelKey: '', engineId: '' },
    retired: {},
    nativeLibFiles: new Set([CPU_FILE]),
    sdk: { baseUrl: SDK_URL, engines: [LLAMA_INFO, LITERT_INFO] },
    formatOf: (key) => FORMATS[key],
    ...over,
  }
}

function retiredEntry(engine: Engine, copiedTo?: string): RetiredEngine {
  return copiedTo === undefined ? { ...engine } : { ...engine, copiedTo }
}

const ofKind = (actions: AndroidEngineAction[], ...kinds: AndroidEngineAction['kind'][]) =>
  actions.filter((a) => kinds.includes(a.kind))

const STRUCTURAL: AndroidEngineAction['kind'][] = ['register-bundled', 'reinstate-bundled', 'retire', 'copy-state']

test('a fresh install with both SDK engines: two upserts (the gguf one adopts) and the CPU file registered', () => {
  assert.deepEqual(planAndroidEngines(input()).filter((a) => a.kind !== 'activate'), [
    { kind: 'upsert-sdk', info: LLAMA_INFO, adoptLegacy: true },
    { kind: 'upsert-sdk', info: LITERT_INFO, adoptLegacy: false },
    { kind: 'register-bundled', name: ANDROID_ENGINE_NAME, file: CPU_FILE },
  ])
})

test('adoptLegacy goes to the first available entry that reads gguf, wherever it sits in the list', () => {
  const unavailableLlama = { ...LLAMA_INFO, available: false, reason: 'no CPU library' }
  const secondGguf = { ...LLAMA_INFO, id: 'llama.cpp-vulkan', name: 'llama.cpp (Vulkan GPU)' }
  const actions = planAndroidEngines(input({ sdk: { baseUrl: SDK_URL, engines: [LITERT_INFO, unavailableLlama, secondGguf] } }))
  assert.deepEqual(ofKind(actions, 'upsert-sdk'), [
    { kind: 'upsert-sdk', info: LITERT_INFO, adoptLegacy: false },
    { kind: 'upsert-sdk', info: secondGguf, adoptLegacy: true },
  ])
})

test('an unreadable SDK list repairs the SDK URL and registers or retires no SDK row', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, CPU_ROW], activeEngineId: LLAMA_SDK_ROW.id, sdk: { baseUrl: SDK_URL, engines: null },
  }))
  assert.deepEqual(actions, [
    { kind: 'repair-sdk-url', baseUrl: SDK_URL },
    { kind: 'repair-bundled', name: ANDROID_ENGINE_NAME, file: CPU_FILE },
  ])
})

test('without the SDK this launch, no SDK action at all', () => {
  const actions = planAndroidEngines(input({ engines: [LLAMA_SDK_ROW, CPU_ROW], activeEngineId: CPU_ROW.id, sdk: null }))
  assert.deepEqual(actions, [{ kind: 'repair-bundled', name: ANDROID_ENGINE_NAME, file: CPU_FILE }])
})

test('the M1 legacy row and both entries: the gguf upsert adopts it and the legacy split copy is planned', () => {
  const actions = planAndroidEngines(input({ engines: [LEGACY_ROW, CPU_ROW], activeEngineId: LEGACY_ROW.id }))
  assert.deepEqual(ofKind(actions, 'upsert-sdk')[0], { kind: 'upsert-sdk', info: LLAMA_INFO, adoptLegacy: true })
  assert.deepEqual(ofKind(actions, 'copy-state'), [{ kind: 'copy-state', from: LEGACY_ROW.id, to: 'litert-lm', format: 'litertlm' }])
})

test('the legacy split copy needs an available LiteRT-LM entry', () => {
  const actions = planAndroidEngines(input({ engines: [LEGACY_ROW], sdk: { baseUrl: SDK_URL, engines: [LLAMA_INFO] } }))
  assert.deepEqual(ofKind(actions, 'copy-state'), [])
})

test('litert-lm-android registered but its file is gone: retired and remembered, and its settings copied once', () => {
  const actions = planAndroidEngines(input({ engines: [CPU_ROW, LITERT_SERVER_ROW] }))
  assert.deepEqual(ofKind(actions, 'retire', 'copy-state'), [
    { kind: 'retire', engineId: LITERT_SERVER_ROW.id, remember: true, key: ANDROID_LITERT_LM_ENGINE_NAME },
    { kind: 'copy-state', from: LITERT_SERVER_ROW.id, to: 'litert-lm', format: 'litertlm' },
  ])
})

test('a retired litert-lm-android not yet copied is copied; one already copied is not copied again', () => {
  const pending = planAndroidEngines(input({ retired: { [ANDROID_LITERT_LM_ENGINE_NAME]: retiredEntry(LITERT_SERVER_ROW) } }))
  assert.deepEqual(ofKind(pending, 'copy-state'), [
    { kind: 'copy-state', from: LITERT_SERVER_ROW.id, to: 'litert-lm', format: 'litertlm' },
  ])
  const done = planAndroidEngines(input({ retired: { [ANDROID_LITERT_LM_ENGINE_NAME]: retiredEntry(LITERT_SERVER_ROW, 'sdk-litert') } }))
  assert.deepEqual(ofKind(done, 'copy-state'), [])
})

test('the litert-lm-android copy waits for an available LiteRT-LM SDK entry', () => {
  const unavailable = { ...LITERT_INFO, available: false }
  const actions = planAndroidEngines(input({
    engines: [CPU_ROW, LITERT_SERVER_ROW], sdk: { baseUrl: SDK_URL, engines: [LLAMA_INFO, unavailable] },
  }))
  assert.deepEqual(ofKind(actions, 'copy-state'), [])
  assert.deepEqual(ofKind(actions, 'retire'), [{ kind: 'retire', engineId: LITERT_SERVER_ROW.id, remember: true, key: ANDROID_LITERT_LM_ENGINE_NAME }])
})

test('a rollback build that ships litert-lm-android again reinstates the remembered row', () => {
  const actions = planAndroidEngines(input({
    engines: [CPU_ROW],
    retired: { [ANDROID_LITERT_LM_ENGINE_NAME]: retiredEntry(LITERT_SERVER_ROW, 'sdk-litert') },
    nativeLibFiles: new Set([CPU_FILE, LITERT_LM_NATIVE_SERVER]),
  }))
  assert.deepEqual(ofKind(actions, 'register-bundled', 'reinstate-bundled'), [
    { kind: 'reinstate-bundled', name: ANDROID_LITERT_LM_ENGINE_NAME, file: LITERT_LM_NATIVE_SERVER },
  ])
})

test('the Vulkan row with its file gone is retired and remembered, with no copy', () => {
  const actions = planAndroidEngines(input({ engines: [CPU_ROW, VK_ROW] }))
  assert.deepEqual(ofKind(actions, 'retire', 'copy-state'), [{ kind: 'retire', engineId: VK_ROW.id, remember: true, key: ANDROID_VULKAN_ENGINE_NAME }])
})

test('D-15: an SDK row whose engine is no longer listed as available is retired and remembered as sdk:<id>', () => {
  const unavailable = { ...LITERT_INFO, available: false, reason: 'Disabled for testing (debug build).' }
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW], sdk: { baseUrl: SDK_URL, engines: [LLAMA_INFO, unavailable] },
  }))
  assert.deepEqual(ofKind(actions, 'retire'), [{ kind: 'retire', engineId: LITERT_SDK_ROW.id, remember: true, key: 'sdk:litert-lm' }])
  assert.deepEqual(ofKind(actions, 'upsert-sdk'), [{ kind: 'upsert-sdk', info: LLAMA_INFO, adoptLegacy: true }])
})

test('a user-added LiteRT-LM engine with another name is never touched', () => {
  const userLitert = engineRow('mine', 'My LiteRT', 'litert-lm', { binPath: `/sdcard/${LITERT_LM_NATIVE_SERVER}` })
  const actions = planAndroidEngines(input({ engines: [CPU_ROW, userLitert] }))
  assert.equal(actions.some((a) => JSON.stringify(a).includes('mine')), false)
})

test('a bundled name on another file is not the app\'s own row', () => {
  const lookalike = engineRow('look', ANDROID_VULKAN_ENGINE_NAME, 'llama-server', { binPath: '/sdcard/llama-server' })
  const actions = planAndroidEngines(input({ engines: [CPU_ROW, lookalike] }))
  assert.deepEqual(ofKind(actions, 'retire'), [])
})

test('planning over its own fresh-install result plans only repairs that change nothing', () => {
  const actions = planAndroidEngines(input({ engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW], activeEngineId: LITERT_SDK_ROW.id }))
  assert.deepEqual(ofKind(actions, ...STRUCTURAL), [])
  assert.deepEqual(actions.map((a) => a.kind), ['upsert-sdk', 'upsert-sdk', 'repair-bundled'])
})

test('planning over an upgraded result (legacy adopted, server row retired and copied) plans no copy again', () => {
  const adopted = sdkRow(LEGACY_ROW.id, LLAMA_INFO)
  const actions = planAndroidEngines(input({
    engines: [adopted, LITERT_SDK_ROW, CPU_ROW],
    retired: { [ANDROID_LITERT_LM_ENGINE_NAME]: retiredEntry(LITERT_SERVER_ROW, LITERT_SDK_ROW.id) },
  }))
  assert.deepEqual(ofKind(actions, ...STRUCTURAL), [])
})

// Rule 4 (plan D-6): an engine is activated only on a fresh install or when nothing usable is active, and then by what
// can read lastLoaded (I-4, I-5). ADR-455 plan R-5 ("the SDK row is activated when first registered") is superseded.

const GGUF_LAST = 'qwen|Q4_K_M|1'
const LITERT_LAST = 'gemma|litertlm|2'

const activations = (actions: AndroidEngineAction[]) => ofKind(actions, 'activate')
const activates = (engineId: string): AndroidEngineAction[] => [{ kind: 'activate', engineId }]
const fallsBackTo = (engineId: string, fallbackFrom: string): AndroidEngineAction[] =>
  [{ kind: 'activate', engineId, fallbackFrom }]

test('a fresh install activates LiteRT-LM', () => {
  assert.deepEqual(activations(planAndroidEngines(input())), activates('litert-lm'))
})

test('a fresh install with no available LiteRT-LM entry activates the llama.cpp SDK row', () => {
  const sdk = { baseUrl: SDK_URL, engines: [LLAMA_INFO, { ...LITERT_INFO, available: false }] }
  assert.deepEqual(activations(planAndroidEngines(input({ sdk }))), activates('llama.cpp-cpu'))
})

test('a fresh install with the SDK not started activates the spawned CPU row it registers, as a fallback', () => {
  assert.deepEqual(activations(planAndroidEngines(input({ sdk: null }))), fallsBackTo(ANDROID_ENGINE_NAME, ''))
})

test('R-5 superseded (ADR-462, D-17): a v1.15.0 user on llama-server-android with a GGUF last model stays on it', () => {
  const actions = planAndroidEngines(input({
    engines: [CPU_ROW, LITERT_SERVER_ROW], activeEngineId: CPU_ROW.id, lastLoaded: { modelKey: GGUF_LAST, engineId: CPU_ROW.id },
  }))
  assert.deepEqual(activations(actions), [])
})

test('a v1.15.0 user on litert-lm-android with a .litertlm last model: settings copied, LiteRT-LM SDK row activated', () => {
  const actions = planAndroidEngines(input({
    engines: [CPU_ROW, LITERT_SERVER_ROW],
    activeEngineId: LITERT_SERVER_ROW.id,
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SERVER_ROW.id },
  }))
  assert.deepEqual(ofKind(actions, 'copy-state', 'activate'), [
    { kind: 'copy-state', from: LITERT_SERVER_ROW.id, to: 'litert-lm', format: 'litertlm' },
    { kind: 'activate', engineId: 'litert-lm' },
  ])
})

test('the M1 legacy row with a GGUF last model stays active', () => {
  const actions = planAndroidEngines(input({
    engines: [LEGACY_ROW, CPU_ROW], activeEngineId: LEGACY_ROW.id, lastLoaded: { modelKey: GGUF_LAST, engineId: LEGACY_ROW.id },
  }))
  assert.deepEqual(activations(actions), [])
})

test('the M1 legacy row with a .litertlm last model moves to the LiteRT-LM row, once', () => {
  const actions = planAndroidEngines(input({
    engines: [LEGACY_ROW, CPU_ROW], activeEngineId: LEGACY_ROW.id, lastLoaded: { modelKey: LITERT_LAST, engineId: LEGACY_ROW.id },
  }))
  assert.deepEqual(activations(actions), activates('litert-lm'))
  const adopted = sdkRow(LEGACY_ROW.id, LLAMA_INFO)
  const next = planAndroidEngines(input({
    engines: [adopted, LITERT_SDK_ROW, CPU_ROW], activeEngineId: adopted.id, lastLoaded: { modelKey: LITERT_LAST, engineId: adopted.id },
  }))
  assert.deepEqual(activations(next), [], 'the adopted row is no longer the legacy row, so the user\'s pick stands')
})

test('the active row retired while lastLoaded is GGUF lands on a GGUF row, never LiteRT-LM', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW, VK_ROW],
    activeEngineId: VK_ROW.id,
    lastLoaded: { modelKey: GGUF_LAST, engineId: VK_ROW.id },
  }))
  assert.deepEqual(activations(actions), activates(LLAMA_SDK_ROW.id))
})

test('with the SDK list unreadable and an SDK row active, nothing is activated', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW], activeEngineId: LITERT_SDK_ROW.id, sdk: { baseUrl: SDK_URL, engines: null },
  }))
  assert.deepEqual(activations(actions), [])
})

test('with the SDK not started and an SDK row active, the CPU row takes over; without its file, nothing does', () => {
  const engines = [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW]
  const withCpu = planAndroidEngines(input({ engines, activeEngineId: LITERT_SDK_ROW.id, sdk: null }))
  assert.deepEqual(activations(withCpu), fallsBackTo(CPU_ROW.id, LITERT_SDK_ROW.id))
  const withoutCpu = planAndroidEngines(input({ engines, activeEngineId: LITERT_SDK_ROW.id, sdk: null, nativeLibFiles: new Set() }))
  assert.deepEqual(activations(withoutCpu), [])
})

test('M-1 finding: the M1 legacy row active with a .litertlm last model and the SDK not started: the CPU row takes over', () => {
  const actions = planAndroidEngines(input({
    engines: [LEGACY_ROW, CPU_ROW],
    activeEngineId: LEGACY_ROW.id,
    lastLoaded: { modelKey: LITERT_LAST, engineId: LEGACY_ROW.id },
    sdk: null,
  }))
  assert.deepEqual(activations(actions), fallsBackTo(CPU_ROW.id, LEGACY_ROW.id))
})

// MAJ-1 (stage-6 review, founder Q2, I-5): a fallback to the CPU server while the SDK is down is remembered, and the
// next start whose SDK list is readable restores the earlier pick, unless the user picked an engine meanwhile.

const BOTH_SDK_ENGINES = { baseUrl: SDK_URL, engines: [LLAMA_INFO, LITERT_INFO] }
const forgetsFallback: AndroidEngineAction = { kind: 'forget-fallback' }
const fallbackActions = (actions: AndroidEngineAction[]) => ofKind(actions, 'activate', 'forget-fallback')

test('MAJ-1 1: LiteRT-LM active with a .litertlm last model and the SDK not started: the CPU row, remembered as a fallback', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: LITERT_SDK_ROW.id,
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
    sdk: null,
  }))
  assert.deepEqual(fallbackActions(actions), fallsBackTo(CPU_ROW.id, LITERT_SDK_ROW.id))
})

test('MAJ-1 2: the SDK back with the fallback still active restores LiteRT-LM and forgets the fallback', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: CPU_ROW.id,
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
    sdkFallback: { from: LITERT_SDK_ROW.id, to: CPU_ROW.id },
    sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(actions), [...activates(LITERT_SDK_ROW.id), forgetsFallback])
})

test('MAJ-1 3: the SDK back after the user picked another row: the pick stands and the fallback is forgotten', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: LLAMA_SDK_ROW.id,
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
    sdkFallback: { from: LITERT_SDK_ROW.id, to: CPU_ROW.id },
    sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(actions), [forgetsFallback])
})

test('MAJ-1 4: a fresh install without the SDK falls back to the CPU row; the SDK\'s first readable start applies LiteRT-LM', () => {
  assert.deepEqual(activations(planAndroidEngines(input({ sdk: null }))), fallsBackTo(ANDROID_ENGINE_NAME, ''))
  const next = planAndroidEngines(input({
    engines: [CPU_ROW], activeEngineId: CPU_ROW.id, sdkFallback: { from: '', to: CPU_ROW.id }, sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(next), [...activates('litert-lm'), forgetsFallback])
})

test('MAJ-1 5: the M1 row with a .litertlm last model returns to the LiteRT-LM row, never the adopted llama.cpp row', () => {
  const lastLoaded = { modelKey: LITERT_LAST, engineId: LEGACY_ROW.id }
  const down = planAndroidEngines(input({ engines: [LEGACY_ROW, CPU_ROW], activeEngineId: LEGACY_ROW.id, lastLoaded, sdk: null }))
  assert.deepEqual(activations(down), fallsBackTo(CPU_ROW.id, LEGACY_ROW.id))
  const back = planAndroidEngines(input({
    engines: [LEGACY_ROW, CPU_ROW],
    activeEngineId: CPU_ROW.id,
    lastLoaded,
    sdkFallback: { from: LEGACY_ROW.id, to: CPU_ROW.id },
    sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(back), [...activates('litert-lm'), forgetsFallback])
})

test('MAJ-1 6: the SDK back but its list unreadable: no activation, and the fallback is kept', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: CPU_ROW.id,
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
    sdkFallback: { from: LITERT_SDK_ROW.id, to: CPU_ROW.id },
    sdk: { baseUrl: SDK_URL, engines: null },
  }))
  assert.deepEqual(fallbackActions(actions), [])
})

test('MAJ-1 7: the recorded row unavailable on the return: the row that reads lastLoaded, and the fallback is forgotten', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: CPU_ROW.id,
    lastLoaded: { modelKey: GGUF_LAST, engineId: LLAMA_SDK_ROW.id },
    sdkFallback: { from: LITERT_SDK_ROW.id, to: CPU_ROW.id },
    sdk: { baseUrl: SDK_URL, engines: [LLAMA_INFO, { ...LITERT_INFO, available: false }] },
  }))
  assert.deepEqual(fallbackActions(actions), [...activates(LLAMA_SDK_ROW.id), forgetsFallback])
})

test('MAJ-1 8: llama.cpp (CPU) picked by hand with a .litertlm last model goes back to llama.cpp (CPU) after a fallback', () => {
  const lastLoaded = { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id }
  const engines = [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW]
  const down = planAndroidEngines(input({ engines, activeEngineId: LLAMA_SDK_ROW.id, lastLoaded, sdk: null }))
  assert.deepEqual(activations(down), fallsBackTo(CPU_ROW.id, LLAMA_SDK_ROW.id))
  const back = planAndroidEngines(input({
    engines, activeEngineId: CPU_ROW.id, lastLoaded, sdkFallback: { from: LLAMA_SDK_ROW.id, to: CPU_ROW.id }, sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(back), [...activates(LLAMA_SDK_ROW.id), forgetsFallback])
})

// FD-1 (fix-delta review, founder Q2, I-5): the restore must not strand a model the user loaded on the CPU server
// during the fallback. The earlier row returns only when it reads the current lastLoaded's format, or when the CPU
// server cannot run that model either (MAJ-1 case 8: the user's own pick returns). With no lastLoaded, or one whose
// format is unknown, it returns as before.

const UNSCANNED_LAST = 'gone|Q4_K_M|9'

test('FD-1: a GGUF loaded on the CPU server during the fallback keeps the CPU server active; the fallback is forgotten', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: CPU_ROW.id,
    lastLoaded: { modelKey: GGUF_LAST, engineId: CPU_ROW.id },
    sdkFallback: { from: LITERT_SDK_ROW.id, to: CPU_ROW.id },
    sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(actions), [forgetsFallback])
})

test('FD-1: a lastLoaded of unknown format restores the earlier row as before', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: CPU_ROW.id,
    lastLoaded: { modelKey: UNSCANNED_LAST, engineId: CPU_ROW.id },
    sdkFallback: { from: LITERT_SDK_ROW.id, to: CPU_ROW.id },
    sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(actions), [...activates(LITERT_SDK_ROW.id), forgetsFallback])
})

test('FD-1: a GGUF lastLoaded the earlier llama.cpp (CPU) row reads restores that row', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: CPU_ROW.id,
    lastLoaded: { modelKey: GGUF_LAST, engineId: CPU_ROW.id },
    sdkFallback: { from: LLAMA_SDK_ROW.id, to: CPU_ROW.id },
    sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(actions), [...activates(LLAMA_SDK_ROW.id), forgetsFallback])
})

// FD-2 (fix-delta review): an empty selection is not a pick. With the fallback remembered and nothing active, the
// SDK's return runs rule 4 as it would without the marker, then forgets the fallback.

test('FD-2: the fallback remembered and nothing active: the SDK\'s return activates the row that reads lastLoaded', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW],
    activeEngineId: '',
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
    sdkFallback: { from: LITERT_SDK_ROW.id, to: CPU_ROW.id },
    sdk: BOTH_SDK_ENGINES,
  }))
  assert.deepEqual(fallbackActions(actions), [...activates(LITERT_SDK_ROW.id), forgetsFallback])
})

test('an active SDK engine that becomes unavailable is replaced by the row that reads lastLoaded', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW],
    activeEngineId: LITERT_SDK_ROW.id,
    lastLoaded: { modelKey: GGUF_LAST, engineId: LITERT_SDK_ROW.id },
    sdk: { baseUrl: SDK_URL, engines: [LLAMA_INFO, { ...LITERT_INFO, available: false }] },
  }))
  assert.deepEqual(activations(actions), activates(LLAMA_SDK_ROW.id))
})

test('lastLoaded\'s own row is not chosen when it cannot read the last model\'s format', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW], activeEngineId: '', lastLoaded: { modelKey: LITERT_LAST, engineId: CPU_ROW.id },
  }))
  assert.deepEqual(activations(actions), activates(LITERT_SDK_ROW.id))
})

test('lastLoaded\'s own row is chosen when it is live and reads the format', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW], activeEngineId: '', lastLoaded: { modelKey: GGUF_LAST, engineId: CPU_ROW.id },
  }))
  assert.deepEqual(activations(actions), activates(CPU_ROW.id))
})

test('a user-added engine that is active stays active', () => {
  const userEngine = engineRow('mine', 'My llama.cpp', 'llama-server', { binPath: '/sdcard/llama-server' })
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW, userEngine],
    activeEngineId: userEngine.id,
    lastLoaded: { modelKey: LITERT_LAST, engineId: userEngine.id },
  }))
  assert.deepEqual(activations(actions), [])
})

test('planning over the activated fresh install activates nothing again', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW], activeEngineId: LITERT_SDK_ROW.id,
  }))
  assert.deepEqual(ofKind(actions, ...STRUCTURAL, 'activate'), [])
})

// The applier (plan D-7): reconcileAndroidEngines reads the SDK's list and the boot scan, plans, and applies the plan
// to a real Registry over a temp config.json (test-support/android-engines.ts). It never throws, and on
// desktop it does nothing at all.

const mentions = (spy: MockedConsole, ...words: RegExp[]) =>
  spy.mock.calls.some((c) => words.every((w) => w.test(String(c.arguments[0]))))

/** An APK's nativeLibraryDir holding `files`. */
function nativeLibDir(files: string[]): string {
  const lib = join(tmpDir('tllm-android-engines-'), 'lib')
  shipNativeLibs(lib, files)
  return lib
}

function configWith(engines: Engine[], activeEngineId: string, extra: Partial<Config> = {}): string {
  const path = join(tmpDir('tllm-android-engines-'), 'config.json')
  writeFileSync(path, JSON.stringify({ ...defaultConfig(), engines, activeEngineId, ...extra }))
  return path
}

/** The app over the config.json at `path`. */
function appAt(t: AndroidTest, path: string, onAdd?: (registry: Registry) => void) {
  return appRegistry(t, ConfigStore.load(path), onAdd)
}

interface BootOptions {
  lib: string
  sdkUrl?: string
  sdkEngines?: SdkEngineInfo[] | null | 'throws'
}

/** One Android start's engine reconcile, with the SDK answering `sdkEngines` (both engines by default). */
async function reconcile(app: { store: ConfigStore; registry: Registry }, opts: BootOptions): Promise<void> {
  await reconcileWith(app, { nativeLibDir: opts.lib, sdkUrl: opts.sdkUrl, sdkEngines: opts.sdkEngines, library: FORMATS })
}

const NEXT_SDK_URL = 'http://sdk-next.invalid:1'

test('applier: a fresh install ends with three rows and LiteRT-LM active', async (t) => {
  quietAndroidLog(t)
  const app = appAt(t, configWith([], ''))
  await reconcile(app, { lib: nativeLibDir([CPU_FILE]), sdkUrl: SDK_URL })
  const names = app.registry.list().engines.map((e) => e.name)
  assert.deepEqual(names, ['llama.cpp (CPU)', 'LiteRT-LM', ANDROID_ENGINE_NAME])
  assert.equal(app.registry.active()?.sdkEngine?.id, 'litert-lm')
})

test('applier: registration never selects a row by itself', async (t) => {
  quietAndroidLog(t)
  const app = appAt(t, configWith([], ''))
  await reconcile(app, { lib: nativeLibDir([CPU_FILE]), sdkUrl: SDK_URL })
  assert.deepEqual(app.addOpts, [{ fillEmptySelection: false }])
  const litertOnly = appAt(t, configWith([], ''))
  await reconcile(litertOnly, { lib: nativeLibDir([LITERT_LM_NATIVE_SERVER]) })
  assert.deepEqual(litertOnly.registry.list().engines.map((e) => e.name), [ANDROID_LITERT_LM_ENGINE_NAME])
  assert.equal(litertOnly.registry.list().activeEngineId, '', 'the bundled LiteRT-LM server is registered, not selected')
})

test('applier: a user\'s pick made while the reconcile runs wins over its activation', async (t) => {
  const { logs } = quietAndroidLog(t)
  const userPicksLlama = (registry: Registry) => {
    const llama = sdkRowFor(registry, 'llama.cpp-cpu')
    if (llama) registry.activate(llama.id)
  }
  const app = appAt(t, configWith([], ''), userPicksLlama)
  await reconcile(app, { lib: nativeLibDir([CPU_FILE]), sdkUrl: SDK_URL })
  assert.equal(app.registry.active()?.sdkEngine?.id, 'llama.cpp-cpu')
  assert.ok(mentions(logs, /android:/, /skip/i), 'one line says the activation was skipped')
})

test('applier: on desktop it reads neither the SDK nor the scan, and changes nothing', async (t) => {
  quietAndroidLog(t)
  const app = appAt(t, configWith([CPU_ROW], CPU_ROW.id))
  const calls = { readSdk: 0, formatOf: 0 }
  await reconcileAndroidEngines({
    registry: app.registry,
    store: app.store,
    env: {},
    readSdk: async () => {
      calls.readSdk++
      return []
    },
    formatOf: async () => {
      calls.formatOf++
      return () => undefined
    },
  })
  assert.deepEqual(calls, { readSdk: 0, formatOf: 0 })
  assert.deepEqual(app.registry.list().engines.map((e) => e.id), [CPU_ROW.id])
})

test('applier: an SDK read that throws is logged and the start goes on, repairing only the SDK URL', async (t) => {
  const { warns } = quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const app = appAt(t, configWith([LLAMA_SDK_ROW, cpuEngineIn(lib)], LLAMA_SDK_ROW.id))
  await assert.doesNotReject(reconcile(app, { lib, sdkUrl: NEXT_SDK_URL, sdkEngines: 'throws' }))
  assert.ok(mentions(warns, /android:/, /sdk exploded/))
  assert.deepEqual(sdkRowsOf(app.registry).map((e) => [e.id, e.baseUrl]), [[LLAMA_SDK_ROW.id, NEXT_SDK_URL]])
  assert.equal(app.registry.active()?.id, LLAMA_SDK_ROW.id)
})

test('applier: the scan lookup is never called synchronously (boot.ts declares the scanner after the call)', async (t) => {
  quietAndroidLog(t)
  for (const sdkUrl of [SDK_URL, undefined]) {
    const app = appAt(t, configWith([], ''))
    let formatOfCalls = 0
    const env: NodeJS.ProcessEnv = { TURBOLLM_ANDROID_NATIVE_LIB_DIR: nativeLibDir([]) }
    if (sdkUrl) env.TURBOLLM_ANDROID_SDK_URL = sdkUrl
    const done = reconcileAndroidEngines({
      registry: app.registry,
      store: app.store,
      env,
      readSdk: async () => [],
      formatOf: async () => {
        formatOfCalls++
        return () => undefined
      },
    })
    assert.equal(formatOfCalls, 0, `not synchronously (SDK ${sdkUrl ? 'started' : 'not started'})`)
    await done
    assert.equal(formatOfCalls, 1)
  }
})

test('applier: a v1.15.0 LiteRT-LM user gets their .litertlm settings copied onto the LiteRT-LM row, which is active', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const server = bundledRow('lsrv', ANDROID_LITERT_LM_ENGINE_NAME, lib, LITERT_LM_NATIVE_SERVER, 'litert-lm')
  const profile = { profile: { ctx: 4096 }, updatedAt: '2026-11-01T00:00:00.000Z' }
  const app = appAt(t, configWith([server], server.id, {
    modelProfiles: { [LITERT_LAST]: { [server.id]: profile }, [GGUF_LAST]: { [server.id]: profile } },
    lastLoaded: { modelKey: LITERT_LAST, engineId: server.id },
  }))
  await reconcile(app, { lib, sdkUrl: SDK_URL })
  const litertId = sdkRowFor(app.registry, 'litert-lm')?.id ?? 'missing'
  const cfg = app.store.snapshot()
  assert.equal(app.registry.active()?.id, litertId)
  assert.deepEqual(cfg.modelProfiles[LITERT_LAST][litertId], profile)
  assert.equal(cfg.modelProfiles[GGUF_LAST][litertId], undefined, 'only .litertlm models are copied')
  assert.deepEqual(cfg.modelProfiles[LITERT_LAST][server.id], profile, 'the source keeps its own')
  assert.equal(cfg.androidRetiredEngines?.[ANDROID_LITERT_LM_ENGINE_NAME]?.id, server.id)
  assert.equal(cfg.androidRetiredEngines?.[ANDROID_LITERT_LM_ENGINE_NAME]?.copiedTo, litertId)
  assert.deepEqual(cfg.lastLoaded, { modelKey: LITERT_LAST, engineId: server.id }, 'lastLoaded is not moved')
})

test('applier MAJ-1: a boot without the SDK records the fallback in config.json, and the SDK\'s return clears it', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const path = configWith([LLAMA_SDK_ROW, LITERT_SDK_ROW, cpuEngineIn(lib)], LITERT_SDK_ROW.id, {
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
  })
  await reconcile(appAt(t, path), { lib })
  const down = ConfigStore.load(path).snapshot()
  assert.equal(down.activeEngineId, 'cpu')
  assert.deepEqual(down.androidSdkFallback, { from: LITERT_SDK_ROW.id, to: 'cpu' })

  await reconcile(appAt(t, path), { lib, sdkUrl: SDK_URL })
  const back = ConfigStore.load(path).snapshot()
  assert.equal(back.activeEngineId, LITERT_SDK_ROW.id)
  assert.equal(back.androidSdkFallback, undefined)
})

test('applier MAJ-1: no fallback is recorded when a pick made meanwhile skips the activation', async (t) => {
  quietAndroidLog(t)
  const userPicksLlama = (registry: Registry) => registry.activate(LLAMA_SDK_ROW.id)
  const path = configWith([LLAMA_SDK_ROW, LITERT_SDK_ROW], LITERT_SDK_ROW.id)
  await reconcile(appAt(t, path, userPicksLlama), { lib: nativeLibDir([CPU_FILE]) })
  const cfg = ConfigStore.load(path).snapshot()
  assert.equal(cfg.activeEngineId, LLAMA_SDK_ROW.id)
  assert.equal(cfg.androidSdkFallback, undefined)
})

test('applier FD-1: a GGUF loaded on the CPU server while the SDK was down stays runnable when the SDK returns', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const path = configWith([LLAMA_SDK_ROW, LITERT_SDK_ROW, cpuEngineIn(lib)], LITERT_SDK_ROW.id, {
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
  })
  await reconcile(appAt(t, path), { lib })
  ConfigStore.load(path).update((c) => {
    c.lastLoaded = { modelKey: GGUF_LAST, engineId: 'cpu' }
  })

  await reconcile(appAt(t, path), { lib, sdkUrl: SDK_URL })

  const back = ConfigStore.load(path).snapshot()
  assert.equal(back.activeEngineId, 'cpu', 'the row that runs the GGUF lastLoaded')
  assert.equal(back.androidSdkFallback, undefined)
  assert.deepEqual(back.lastLoaded, { modelKey: GGUF_LAST, engineId: 'cpu' })
})

/** LiteRT-LM active with a .litertlm last model, then one start without the SDK: the CPU row stands in for it. */
async function afterOneSdkDownBoot(t: AndroidTest) {
  const lib = nativeLibDir([CPU_FILE])
  const path = configWith([LLAMA_SDK_ROW, LITERT_SDK_ROW, cpuEngineIn(lib)], LITERT_SDK_ROW.id, {
    lastLoaded: { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id },
  })
  await reconcile(appAt(t, path), { lib })
  assert.deepEqual(ConfigStore.load(path).snapshot().androidSdkFallback, { from: LITERT_SDK_ROW.id, to: 'cpu' })
  return { lib, path }
}

test('applier FD-2: the CPU file missing on a second start without the SDK: the SDK\'s return recovers LiteRT-LM, no false warning', async (t) => {
  const { warns } = quietAndroidLog(t)
  const { lib, path } = await afterOneSdkDownBoot(t)
  await reconcile(appAt(t, path), { lib: nativeLibDir([]) })
  assert.equal(ConfigStore.load(path).snapshot().activeEngineId, '', 'the CPU row is retired with its file')

  await reconcile(appAt(t, path), { lib, sdkUrl: SDK_URL })

  const back = ConfigStore.load(path).snapshot()
  assert.equal(back.activeEngineId, LITERT_SDK_ROW.id)
  assert.equal(back.androidSdkFallback, undefined)
  assert.equal(mentions(warns, /no engine is active/), false)
})

test('applier FD-2: the CPU row removed by the user while the SDK was down: the SDK\'s return recovers LiteRT-LM', async (t) => {
  const { warns } = quietAndroidLog(t)
  const { lib, path } = await afterOneSdkDownBoot(t)
  appAt(t, path).registry.remove('cpu')

  await reconcile(appAt(t, path), { lib, sdkUrl: SDK_URL })

  const back = ConfigStore.load(path).snapshot()
  assert.equal(back.activeEngineId, LITERT_SDK_ROW.id)
  assert.equal(back.androidSdkFallback, undefined)
  assert.equal(mentions(warns, /no engine is active/), false)
})

test('applier m-3: LiteRT-LM unavailable with a .litertlm last model leaves no engine active, said in one warning', async (t) => {
  const { warns } = quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const lastLoaded = { modelKey: LITERT_LAST, engineId: LITERT_SDK_ROW.id }
  const app = appAt(t, configWith([LLAMA_SDK_ROW, LITERT_SDK_ROW, cpuEngineIn(lib)], LITERT_SDK_ROW.id, { lastLoaded }))
  await reconcile(app, { lib, sdkUrl: SDK_URL, sdkEngines: [LLAMA_INFO, { ...LITERT_INFO, available: false }] })
  assert.equal(app.registry.list().activeEngineId, '')
  assert.equal(warns.mock.calls.filter((c) => /no engine is active/.test(String(c.arguments[0]))).length, 1)
  assert.ok(mentions(warns, /^android: /, /pick one in Engines/))
})

test('applier m-3: a boot that leaves an engine active says nothing about it', async (t) => {
  const { warns } = quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const app = appAt(t, configWith([LLAMA_SDK_ROW, LITERT_SDK_ROW, cpuEngineIn(lib)], LITERT_SDK_ROW.id))
  await reconcile(app, { lib, sdkUrl: SDK_URL })
  assert.equal(app.registry.list().activeEngineId, LITERT_SDK_ROW.id)
  assert.equal(mentions(warns, /no engine is active/), false)
})

test('applier G-9: with the SDK not started and no CPU file, one warning says no engine can run this launch', async (t) => {
  const { warns } = quietAndroidLog(t)
  const app = appAt(t, configWith([], ''))
  await reconcile(app, { lib: nativeLibDir([]) })
  assert.deepEqual(app.registry.list().engines, [])
  assert.equal(warns.mock.callCount(), 1)
  assert.ok(mentions(warns, /android:/, /no engine/i, /libllama_server\.so is not in this build/), 'it names the CPU file')
})

// Moved from seed.test.ts (plan §0.7): the Android start's cases, re-expressed against reconcileAndroidEngines.

function cpuEngineIn(lib: string): Engine {
  return bundledRow('cpu', ANDROID_ENGINE_NAME, lib, CPU_FILE)
}

test('R-5 superseded (ADR-462, D-17): a first start with the SDK keeps llama-server active and adds the SDK rows', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const app = appAt(t, configWith([cpuEngineIn(lib)], 'cpu'))
  await reconcile(app, { lib, sdkUrl: SDK_URL })
  assert.deepEqual(sdkRowsOf(app.registry).map((e) => [e.name, e.baseUrl, e.binPath]), [
    ['llama.cpp (CPU)', SDK_URL, ''],
    ['LiteRT-LM', SDK_URL, ''],
  ])
  assert.equal(app.registry.active()?.id, 'cpu')
  assert.equal(app.registry.get('cpu')?.name, ANDROID_ENGINE_NAME, 'the CPU engine stays')
})

test('android second start: the SDK rows keep their ids and take the new URL', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const path = configWith([cpuEngineIn(lib)], 'cpu')
  const first = appAt(t, path)
  await reconcile(first, { lib, sdkUrl: SDK_URL })
  const firstIds = sdkRowsOf(first.registry).map((e) => e.id)
  const app = appAt(t, path)
  await reconcile(app, { lib, sdkUrl: NEXT_SDK_URL })
  assert.deepEqual(sdkRowsOf(app.registry).map((e) => [e.id, e.baseUrl]), firstIds.map((id) => [id, NEXT_SDK_URL]))
})

test('android: a user who switched to llama-server keeps it after a restart', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const path = configWith([], '')
  const first = appAt(t, path)
  await reconcile(first, { lib, sdkUrl: SDK_URL })
  const cpu = first.registry.list().engines.find((e) => e.name === ANDROID_ENGINE_NAME)
  first.registry.activate(cpu?.id ?? 'missing')
  const app = appAt(t, path)
  await reconcile(app, { lib, sdkUrl: SDK_URL })
  assert.equal(app.registry.active()?.id, cpu?.id)
})

test('android without the SDK this launch: no SDK row is registered', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const app = appAt(t, configWith([cpuEngineIn(lib)], 'cpu'))
  await reconcile(app, { lib })
  assert.deepEqual(sdkRowsOf(app.registry), [])
  assert.equal(app.registry.active()?.id, 'cpu')
})

test('android without the SDK this launch: the SDK rows stay, the CPU engine becomes active, said in the log', async (t) => {
  const { logs } = quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const path = configWith([cpuEngineIn(lib)], 'cpu')
  const first = appAt(t, path)
  await reconcile(first, { lib, sdkUrl: SDK_URL })
  const sdkIds = sdkRowsOf(first.registry).map((e) => e.id)
  first.registry.activate(sdkIds[1])
  const app = appAt(t, path)
  await reconcile(app, { lib })
  assert.deepEqual(sdkRowsOf(app.registry).map((e) => e.id), sdkIds, 'never deleted')
  assert.equal(app.registry.active()?.id, 'cpu')
  assert.ok(mentions(logs, /android:/, new RegExp(ANDROID_ENGINE_NAME)), 'the log says which engine is active now')
})

test('android with the SDK and no libllama_server.so: only the SDK rows, LiteRT-LM active, and no warning', async (t) => {
  const { warns } = quietAndroidLog(t)
  const app = appAt(t, configWith([], ''))
  await reconcile(app, { lib: nativeLibDir([]), sdkUrl: SDK_URL })
  assert.deepEqual(app.registry.list().engines.map((e) => e.kind), ['turbollm-sdk', 'turbollm-sdk'])
  assert.equal(app.registry.active()?.sdkEngine?.id, 'litert-lm')
  assert.equal(warns.mock.callCount(), 0)
})

test('G-7: an active bundled LiteRT-LM server whose file is gone is retired, and the LiteRT-LM SDK row becomes active', async (t) => {
  const { logs } = quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const litert = bundledRow('litert', ANDROID_LITERT_LM_ENGINE_NAME, lib, LITERT_LM_NATIVE_SERVER, 'litert-lm')
  const app = appAt(t, configWith([cpuEngineIn(lib), litert], 'litert'))
  await reconcile(app, { lib, sdkUrl: SDK_URL })
  assert.equal(app.registry.get('litert'), undefined)
  assert.equal(app.registry.active()?.sdkEngine?.id, 'litert-lm')
  assert.ok(mentions(logs, new RegExp(ANDROID_LITERT_LM_ENGINE_NAME)), 'one line names it')
})

test('G-7: an earlier install\'s LiteRT-LM server row is retired too, and without the SDK the CPU engine is active', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const oldLib = '/data/app/old/lib/arm64'
  const stale = bundledRow('litert', ANDROID_LITERT_LM_ENGINE_NAME, oldLib, LITERT_LM_NATIVE_SERVER, 'litert-lm')
  const app = appAt(t, configWith([cpuEngineIn(lib), stale], 'litert'))
  await reconcile(app, { lib })
  assert.equal(app.registry.get('litert'), undefined)
  assert.equal(app.registry.active()?.id, 'cpu')
})

test('G-7: a bundled Vulkan engine whose file is gone is retired; the active engine is kept', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const vulkan = bundledRow('vk', ANDROID_VULKAN_ENGINE_NAME, lib, VK_FILE)
  const app = appAt(t, configWith([cpuEngineIn(lib), vulkan], 'cpu'))
  await reconcile(app, { lib })
  assert.deepEqual(app.registry.list().engines.map((e) => e.id), ['cpu'])
  assert.equal(app.registry.active()?.id, 'cpu')
})

test('G-7: a user-added LiteRT-LM engine is never retired', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([CPU_FILE])
  const userBin = join(tmpDir('tllm-android-engines-'), 'venv', 'python')
  const mine = engineRow('mine', 'LiteRT-LM', 'litert-lm', { binPath: userBin })
  const sameName = engineRow('named', ANDROID_LITERT_LM_ENGINE_NAME, 'litert-lm', { binPath: userBin })
  const app = appAt(t, configWith([cpuEngineIn(lib), mine, sameName], 'mine'))
  await reconcile(app, { lib, sdkUrl: SDK_URL })
  assert.equal(app.registry.get('mine')?.binPath, userBin)
  assert.equal(app.registry.get('named')?.binPath, userBin, 'a bundled name on a binary the APK never ships is the user\'s')
  assert.equal(app.registry.active()?.id, 'mine')
})

test('android: the LiteRT-LM SDK row takes over from an active bundled engine whose file is gone', async (t) => {
  quietAndroidLog(t)
  const lib = nativeLibDir([])
  const app = appAt(t, configWith([cpuEngineIn(lib), LEGACY_ROW], 'cpu'))
  await reconcile(app, { lib, sdkUrl: SDK_URL })
  assert.equal(app.registry.active()?.sdkEngine?.id, 'litert-lm')
  assert.equal(sdkRowFor(app.registry, 'llama.cpp-cpu')?.id, LEGACY_ROW.id, 'the M1 row is adopted under its id')
})

// D-15 (G-13, plan revision 2a): an SDK engine that becomes unavailable and later returns comes back as the same row,
// so the settings saved on it apply again (I-3). The row is still removed while it is unavailable (ADR-239).

test('D-15: an SDK engine available again with its row remembered is reinstated, not upserted under a new id', () => {
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, CPU_ROW],
    activeEngineId: LLAMA_SDK_ROW.id,
    retired: { 'sdk:litert-lm': retiredEntry(LITERT_SDK_ROW) },
  }))
  assert.deepEqual(ofKind(actions, 'upsert-sdk', 'reinstate-sdk'), [
    { kind: 'upsert-sdk', info: LLAMA_INFO, adoptLegacy: true },
    { kind: 'reinstate-sdk', info: LITERT_INFO },
  ])
  assert.deepEqual(activations(actions), [], 'the reinstated row is not activated by itself (I-4)')
})

/** Three Android starts over one config: both engines, then LiteRT-LM unavailable, then both again. */
async function unavailableForOneBoot(t: AndroidTest, opts: { litertActiveAtBoot2: boolean }) {
  const lib = nativeLibDir([CPU_FILE])
  const path = configWith([], '')
  const boot = async (engines: SdkEngineInfo[]) => {
    const app = appAt(t, path)
    await reconcile(app, { lib, sdkUrl: SDK_URL, sdkEngines: engines })
    return app
  }
  const first = await boot([LLAMA_INFO, LITERT_INFO])
  const litertId = sdkRowFor(first.registry, 'litert-lm')?.id ?? 'missing'
  const profile = { profile: { ctx: 2048 }, updatedAt: '2026-11-07T00:00:00.000Z' }
  first.store.update((c) => {
    c.modelProfiles[LITERT_LAST] = { [litertId]: profile }
    c.lastLoaded = { modelKey: GGUF_LAST, engineId: litertId }
    if (!opts.litertActiveAtBoot2) c.activeEngineId = sdkRowFor(first.registry, 'llama.cpp-cpu')?.id ?? ''
  })
  const second = await boot([LLAMA_INFO, { ...LITERT_INFO, available: false, reason: 'Disabled for testing (debug build).' }])
  const third = await boot([LLAMA_INFO, LITERT_INFO])
  return { litertId, profile, second, third, boot }
}

test('D-15 applier: a profile saved on the LiteRT-LM row survives a boot without it and applies again under the same id', async (t) => {
  quietAndroidLog(t)
  const { litertId, profile, second, third } = await unavailableForOneBoot(t, { litertActiveAtBoot2: false })

  assert.equal(sdkRowFor(second.registry, 'litert-lm'), undefined, 'no row while the engine is unavailable (ADR-239)')
  assert.deepEqual(second.store.snapshot().modelProfiles[LITERT_LAST], { [litertId]: profile })
  assert.equal(second.store.snapshot().androidRetiredEngines?.['sdk:litert-lm']?.id, litertId)

  assert.equal(sdkRowFor(third.registry, 'litert-lm')?.id, litertId)
  assert.deepEqual(third.store.snapshot().modelProfiles[LITERT_LAST][litertId], profile)
  assert.equal(third.store.snapshot().androidRetiredEngines?.['sdk:litert-lm'], undefined)
})

test('D-15 rule 4: LiteRT-LM active when it went away → the row reading lastLoaded; back again, the user\'s pick stands', async (t) => {
  quietAndroidLog(t)
  const { litertId, second, third } = await unavailableForOneBoot(t, { litertActiveAtBoot2: true })

  const llamaId = sdkRowFor(second.registry, 'llama.cpp-cpu')?.id
  assert.equal(second.registry.active()?.id, llamaId, 'boot 2: the GGUF lastLoaded picks the llama.cpp row')
  assert.equal(third.registry.active()?.id, llamaId, 'boot 3: the reinstated LiteRT-LM row is not activated by itself')
  assert.equal(sdkRowFor(third.registry, 'litert-lm')?.id, litertId)
})

test('D-15: a fourth boot after the return plans nothing new', async (t) => {
  quietAndroidLog(t)
  const { third } = await unavailableForOneBoot(t, { litertActiveAtBoot2: false })
  const cfg = third.store.snapshot()
  const actions = planAndroidEngines(input({
    engines: cfg.engines,
    activeEngineId: cfg.activeEngineId,
    lastLoaded: cfg.lastLoaded,
    retired: cfg.androidRetiredEngines ?? {},
  }))
  assert.deepEqual(ofKind(actions, ...STRUCTURAL, 'reinstate-sdk', 'activate'), [])
})
