// The in-app SDK engine is registered by the Android seed, which alone decides whether it becomes the active engine
// (plan D-8). Registering it must therefore never select it, and the per-process bearer token must never be stored.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { Registry } from './registry'
import { tmpDir } from '../test-support/tmp'

const SDK_URL = 'http://127.0.0.1:6997'

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
  const again = reg.addTurbollmSdk('TurboLLM SDK', 'http://localhost:6997')
  assert.equal(again.id, first.id)
  const sdkEngines = reg.list().engines.filter((e) => e.kind === 'turbollm-sdk')
  assert.deepEqual(sdkEngines.map((e) => e.baseUrl), ['http://localhost:6997'])
})
