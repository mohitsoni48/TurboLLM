// The in-app SDK engine is registered by the Android seed, which alone decides whether it becomes the active engine
// (plan D-8). Registering it must therefore never select it, and the per-process bearer token must never be stored.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { Registry } from './registry'
import { tmpDir } from '../test-support/tmp'
import type { SdkEngineInfo } from './sdk-engines'

const SDK_URL = 'http://sdk.invalid:1'

function registryWithLlamaCpp(): { reg: Registry; store: ConfigStore } {
  const store = ConfigStore.load(join(tmpDir('tllm-sdk-registry-'), 'config.json'))
  const llama: Engine = {
    id: 'llama', name: 'llama.cpp', binPath: '/x/llama-server', kind: 'llama-server', version: '',
    capabilities: { kvTypes: [], flags: [] }, addedAt: '',
  }
  store.update((c) => {
    c.engines = [llama]
    c.activeEngineId = llama.id
  })
  return { reg: new Registry(store), store }
}

function emptyRegistry(): Registry {
  const store = ConfigStore.load(join(tmpDir('tllm-sdk-registry-'), 'config.json'))
  store.update((c) => {
    c.engines = []
    c.activeEngineId = ''
  })
  return new Registry(store)
}

test('addTurbollmSdk registers an in-app engine at its base URL with no binary', () => {
  const { reg } = registryWithLlamaCpp()
  const eng = reg.addTurbollmSdk('TurboLLM SDK', SDK_URL)
  assert.equal(eng.kind, 'turbollm-sdk')
  assert.equal(eng.name, 'TurboLLM SDK')
  assert.equal(eng.baseUrl, SDK_URL)
  assert.equal(eng.binPath, '')
  assert.equal(eng.version, 'in-app')
  assert.deepEqual(reg.get(eng.id)?.baseUrl, SDK_URL)
})

test('addTurbollmSdk leaves the active engine as it was', () => {
  const { reg } = registryWithLlamaCpp()
  reg.addTurbollmSdk('TurboLLM SDK', SDK_URL)
  assert.equal(reg.list().activeEngineId, 'llama')
})

test('addTurbollmSdk does not select itself even when no engine is active', () => {
  const reg = emptyRegistry()
  reg.addTurbollmSdk('TurboLLM SDK', SDK_URL)
  assert.equal(reg.list().activeEngineId, '')
})

test('addTurbollmSdk stores no token in config', () => {
  const { reg, store } = registryWithLlamaCpp()
  const eng = reg.addTurbollmSdk('TurboLLM SDK', SDK_URL)
  const stored = store.snapshot().engines.find((e) => e.id === eng.id)
  assert.deepEqual(
    Object.keys(stored ?? {}).filter((key) => /token|auth|bearer|secret/i.test(key)),
    [],
  )
})

test('addTurbollmSdk again keeps one SDK engine and adopts the new URL', () => {
  const { reg } = registryWithLlamaCpp()
  const first = reg.addTurbollmSdk('TurboLLM SDK', SDK_URL)
  const again = reg.addTurbollmSdk('TurboLLM SDK', 'http://sdk-next.invalid:1')
  assert.equal(again.id, first.id)
  const sdkEngines = reg.list().engines.filter((e) => e.kind === 'turbollm-sdk')
  assert.deepEqual(sdkEngines.map((e) => e.baseUrl), ['http://sdk-next.invalid:1'])
})

// ADR-462: one row per SDK engine, keyed by kind 'turbollm-sdk' + sdkEngine.id (plan D-4). The addTurbollmSdk cases
// above are ported one-for-one below; they go when addTurbollmSdk does (D-7).

const LLAMA_INFO: SdkEngineInfo = {
  id: 'llama.cpp-cpu', name: 'llama.cpp (CPU)', kind: 'llama.cpp', formats: ['gguf'], backends: ['cpu'], available: true,
}
const LITERT_INFO: SdkEngineInfo = {
  id: 'litert-lm', name: 'LiteRT-LM', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'], available: true,
}

function sdkRows(reg: Registry): Engine[] {
  return reg.list().engines.filter((e) => e.kind === 'turbollm-sdk')
}

test('upsertSdkEngine registers an in-app row at its base URL with no binary, carrying the descriptor', () => {
  const { reg } = registryWithLlamaCpp()
  const eng = reg.upsertSdkEngine(LITERT_INFO, SDK_URL)
  assert.equal(eng.kind, 'turbollm-sdk')
  assert.equal(eng.name, 'LiteRT-LM')
  assert.equal(eng.baseUrl, SDK_URL)
  assert.equal(eng.binPath, '')
  assert.equal(eng.version, 'in-app')
  assert.deepEqual(eng.capabilities, { kvTypes: [], flags: [] })
  assert.deepEqual(reg.get(eng.id)?.sdkEngine, { id: 'litert-lm', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'] })
})

test('upsertSdkEngine leaves the active engine as it was', () => {
  const { reg } = registryWithLlamaCpp()
  reg.upsertSdkEngine(LITERT_INFO, SDK_URL)
  assert.equal(reg.list().activeEngineId, 'llama')
})

test('upsertSdkEngine does not select itself even when no engine is active', () => {
  const reg = emptyRegistry()
  reg.upsertSdkEngine(LLAMA_INFO, SDK_URL)
  assert.equal(reg.list().activeEngineId, '')
})

test('upsertSdkEngine stores no token in config', () => {
  const { reg, store } = registryWithLlamaCpp()
  const eng = reg.upsertSdkEngine(LLAMA_INFO, SDK_URL)
  const stored = store.snapshot().engines.find((e) => e.id === eng.id)
  assert.deepEqual(
    Object.keys(stored ?? {}).filter((key) => /token|auth|bearer|secret/i.test(key)),
    [],
  )
})

test('two SDK engines make two rows with distinct ids, and neither is active', () => {
  const reg = emptyRegistry()
  const llama = reg.upsertSdkEngine(LLAMA_INFO, SDK_URL)
  const litert = reg.upsertSdkEngine(LITERT_INFO, SDK_URL)
  assert.notEqual(llama.id, litert.id)
  assert.deepEqual(reg.sdkEngines().map((e) => e.sdkEngine?.id), ['llama.cpp-cpu', 'litert-lm'])
  assert.equal(reg.list().activeEngineId, '')
})

test('upsertSdkEngine again keeps one row per SDK engine id and repairs its URL', () => {
  const reg = emptyRegistry()
  const llama = reg.upsertSdkEngine(LLAMA_INFO, SDK_URL)
  const litert = reg.upsertSdkEngine(LITERT_INFO, SDK_URL)
  const next = 'http://sdk-next.invalid:1'
  assert.equal(reg.upsertSdkEngine(LLAMA_INFO, next).id, llama.id)
  assert.equal(reg.upsertSdkEngine({ ...LITERT_INFO, name: 'LiteRT-LM 2' }, next).id, litert.id)
  assert.deepEqual(sdkRows(reg).map((e) => [e.id, e.name, e.baseUrl]), [
    [llama.id, 'llama.cpp (CPU)', next],
    [litert.id, 'LiteRT-LM 2', next],
  ])
})

test('a legacy SDK row is adopted under its id when adoptLegacy is set', () => {
  const reg = emptyRegistry()
  const legacy = reg.addTurbollmSdk('TurboLLM SDK', SDK_URL)
  const adopted = reg.upsertSdkEngine(LLAMA_INFO, 'http://sdk-next.invalid:1', { adoptLegacy: true })
  assert.equal(adopted.id, legacy.id)
  assert.deepEqual(sdkRows(reg).map((e) => [e.id, e.name, e.sdkEngine?.id, e.baseUrl]), [
    [legacy.id, 'llama.cpp (CPU)', 'llama.cpp-cpu', 'http://sdk-next.invalid:1'],
  ])
})

test('without adoptLegacy a legacy SDK row is left alone and a new row is made', () => {
  const reg = emptyRegistry()
  const legacy = reg.addTurbollmSdk('TurboLLM SDK', SDK_URL)
  const fresh = reg.upsertSdkEngine(LITERT_INFO, SDK_URL)
  assert.notEqual(fresh.id, legacy.id)
  const legacyNow = reg.get(legacy.id)
  assert.equal(legacyNow?.name, 'TurboLLM SDK')
  assert.equal(legacyNow?.sdkEngine, undefined)
})

test('addLitertLm with fillEmptySelection false registers without selecting; without opts it still selects', () => {
  const quiet = emptyRegistry()
  quiet.addLitertLm('litert-lm-android', '/lib/liblitert_lm_main.so', '1', { fillEmptySelection: false })
  assert.equal(quiet.list().activeEngineId, '')
  const loud = emptyRegistry()
  const eng = loud.addLitertLm('litert-lm-android', '/lib/liblitert_lm_main.so', '1')
  assert.equal(loud.list().activeEngineId, eng.id)
})
