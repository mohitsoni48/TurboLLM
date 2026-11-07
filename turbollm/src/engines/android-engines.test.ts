// The Android engine reconciler (ADR-462, architecture §3.4). planAndroidEngines is pure: it reads the rows, the
// remembered retired rows, which bundled files this APK ships and the SDK's engine list, and returns the actions the
// applier carries out. These cases are table-driven over hand-built inputs, with no I/O.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Engine, RetiredEngine } from '../config/config'
import type { ModelFormat } from './compat'
import type { SdkEngineInfo } from './sdk-engines'
import { LITERT_LM_NATIVE_SERVER } from './litert-lm'
import {
  ANDROID_ENGINE_NAME, ANDROID_LITERT_LM_ENGINE_NAME, ANDROID_VULKAN_ENGINE_NAME,
  planAndroidEngines, type AndroidEngineAction, type AndroidEngineInput,
} from './android-engines'

const NATIVE = '/data/app/com.turbollm/lib/arm64'
const SDK_URL = 'http://127.0.0.1:41000'
const CPU_FILE = 'libllama_server.so'
const VK_FILE = 'libllama_server_vk.so'

const LLAMA_INFO: SdkEngineInfo = {
  id: 'llama.cpp-cpu', name: 'llama.cpp (CPU)', kind: 'llama.cpp', formats: ['gguf'], backends: ['cpu'], available: true,
}
const LITERT_INFO: SdkEngineInfo = {
  id: 'litert-lm', name: 'LiteRT-LM', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'], available: true,
}

function row(id: string, name: string, kind: string, extra: Partial<Engine> = {}): Engine {
  return { id, name, binPath: '', kind, version: '1', capabilities: { kvTypes: [], flags: [] }, addedAt: '', ...extra }
}

function bundledRow(id: string, name: string, file: string, kind = 'llama-server'): Engine {
  return row(id, name, kind, { binPath: `${NATIVE}/${file}` })
}

function sdkRow(id: string, info: SdkEngineInfo): Engine {
  const { formats, backends, kind } = info
  return row(id, info.name, 'turbollm-sdk', { baseUrl: SDK_URL, sdkEngine: { id: info.id, kind, formats, backends } })
}

const CPU_ROW = bundledRow('cpu', ANDROID_ENGINE_NAME, CPU_FILE)
const VK_ROW = bundledRow('vk', ANDROID_VULKAN_ENGINE_NAME, VK_FILE)
const LITERT_SERVER_ROW = bundledRow('lsrv', ANDROID_LITERT_LM_ENGINE_NAME, LITERT_LM_NATIVE_SERVER, 'litert-lm')
const LEGACY_ROW = row('m1', 'TurboLLM SDK', 'turbollm-sdk', { baseUrl: SDK_URL })
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
    { kind: 'retire', engineId: LITERT_SERVER_ROW.id, remember: true },
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
  assert.deepEqual(ofKind(actions, 'retire'), [{ kind: 'retire', engineId: LITERT_SERVER_ROW.id, remember: true }])
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
  assert.deepEqual(ofKind(actions, 'retire', 'copy-state'), [{ kind: 'retire', engineId: VK_ROW.id, remember: true }])
})

test('an SDK row whose engine is no longer listed as available is retired, not remembered', () => {
  const unavailable = { ...LITERT_INFO, available: false, reason: 'Disabled for testing (debug build).' }
  const actions = planAndroidEngines(input({
    engines: [LLAMA_SDK_ROW, LITERT_SDK_ROW, CPU_ROW], sdk: { baseUrl: SDK_URL, engines: [LLAMA_INFO, unavailable] },
  }))
  assert.deepEqual(ofKind(actions, 'retire'), [{ kind: 'retire', engineId: LITERT_SDK_ROW.id, remember: false }])
  assert.deepEqual(ofKind(actions, 'upsert-sdk'), [{ kind: 'upsert-sdk', info: LLAMA_INFO, adoptLegacy: true }])
})

test('a user-added LiteRT-LM engine with another name is never touched', () => {
  const userLitert = row('mine', 'My LiteRT', 'litert-lm', { binPath: `/sdcard/${LITERT_LM_NATIVE_SERVER}` })
  const actions = planAndroidEngines(input({ engines: [CPU_ROW, userLitert] }))
  assert.equal(actions.some((a) => JSON.stringify(a).includes('mine')), false)
})

test('a bundled name on another file is not the app\'s own row', () => {
  const lookalike = row('look', ANDROID_VULKAN_ENGINE_NAME, 'llama-server', { binPath: '/sdcard/llama-server' })
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

test('a fresh install activates LiteRT-LM', () => {
  assert.deepEqual(activations(planAndroidEngines(input())), activates('litert-lm'))
})

test('a fresh install with no available LiteRT-LM entry activates the llama.cpp SDK row', () => {
  const sdk = { baseUrl: SDK_URL, engines: [LLAMA_INFO, { ...LITERT_INFO, available: false }] }
  assert.deepEqual(activations(planAndroidEngines(input({ sdk }))), activates('llama.cpp-cpu'))
})

test('a fresh install with the SDK not started activates the spawned CPU row it registers', () => {
  assert.deepEqual(activations(planAndroidEngines(input({ sdk: null }))), activates(ANDROID_ENGINE_NAME))
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
  assert.deepEqual(activations(withCpu), activates(CPU_ROW.id))
  const withoutCpu = planAndroidEngines(input({ engines, activeEngineId: LITERT_SDK_ROW.id, sdk: null, nativeLibFiles: new Set() }))
  assert.deepEqual(activations(withoutCpu), [])
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
  const userEngine = row('mine', 'My llama.cpp', 'llama-server', { binPath: '/sdcard/llama-server' })
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
