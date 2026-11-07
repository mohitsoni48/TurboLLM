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
  assert.deepEqual(planAndroidEngines(input()), [
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
  const actions = planAndroidEngines(input({ engines: [LLAMA_SDK_ROW, CPU_ROW], sdk: { baseUrl: SDK_URL, engines: null } }))
  assert.deepEqual(actions, [
    { kind: 'repair-sdk-url', baseUrl: SDK_URL },
    { kind: 'repair-bundled', name: ANDROID_ENGINE_NAME, file: CPU_FILE },
  ])
})

test('without the SDK this launch, no SDK action at all', () => {
  const actions = planAndroidEngines(input({ engines: [LLAMA_SDK_ROW, CPU_ROW], sdk: null }))
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
