// The Laya engine serves only Laya models, which load on it whatever engine is active — so registering it must
// never make it the active engine, or every chat model would stop loading.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { engineForModel, Registry } from './registry'
import { tmpDir } from '../test-support/tmp'

function emptyRegistry(): Registry {
  const store = ConfigStore.load(join(tmpDir('tllm-laya-registry-'), 'config.json'))
  store.update((c) => {
    c.engines = []
    c.activeEngineId = ''
  })
  return new Registry(store)
}

/** A registry whose only engine is an active llama.cpp one. */
function registryWithLlamaCpp(): { reg: Registry; llama: Engine } {
  const store = ConfigStore.load(join(tmpDir('tllm-laya-registry-'), 'config.json'))
  const llama: Engine = {
    id: 'llama', name: 'llama.cpp', binPath: '/x/llama-server', kind: 'llama-server', version: '',
    capabilities: { kvTypes: [], flags: [] }, addedAt: '',
  }
  store.update((c) => {
    c.engines = [llama]
    c.activeEngineId = llama.id
  })
  return { reg: new Registry(store), llama }
}

test('addLaya registers a laya engine at the venv python with its version', () => {
  const reg = emptyRegistry()
  const eng = reg.addLaya('Laya (laya 0.3.20)', '/venv/bin/python', 'laya 0.3.20')
  assert.equal(eng.kind, 'laya')
  assert.equal(eng.binPath, '/venv/bin/python')
  assert.equal(eng.version, 'laya 0.3.20')
  assert.deepEqual(reg.list().engines.map((e) => e.id), [eng.id])
})

test('addLaya never makes the Laya engine the active engine, even when it is the only one', () => {
  const reg = emptyRegistry()
  reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.20')
  assert.equal(reg.list().activeEngineId, '')
})

test('addLaya at the same path updates the existing engine instead of adding a second one', () => {
  const reg = emptyRegistry()
  const first = reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.20')
  const second = reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.21')
  assert.equal(second.id, first.id)
  assert.equal(reg.list().engines.length, 1)
  assert.equal(reg.list().engines[0].version, 'laya 0.3.21')
})

test('layaEngine finds the registered Laya engine, and nothing when none is installed', () => {
  const reg = emptyRegistry()
  assert.equal(reg.layaEngine(), undefined)
  const eng = reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.20')
  assert.equal(reg.layaEngine()?.id, eng.id)
})

test('engineForModel: a Laya model loads on the Laya engine, whatever engine is active', () => {
  const { reg, llama } = registryWithLlamaCpp()
  const laya = reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.20')
  assert.equal(reg.active()?.id, llama.id)
  assert.equal(engineForModel(reg, { laya: { checkpoints: ['english'] } })?.id, laya.id)
})

test('engineForModel: every other model loads on the active engine, even with Laya installed', () => {
  const { reg, llama } = registryWithLlamaCpp()
  reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.20')
  assert.equal(engineForModel(reg, {})?.id, llama.id)
})

test('engineForModel: a Laya model with no Laya engine installed falls back to the active one, which refuses it', () => {
  const { reg, llama } = registryWithLlamaCpp()
  assert.equal(engineForModel(reg, { laya: { checkpoints: ['english'] } })?.id, llama.id)
})

test('activate refuses the Laya engine and leaves the active engine as it was', () => {
  const { reg, llama } = registryWithLlamaCpp()
  const laya = reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.20')
  assert.throws(() => reg.activate(laya.id), (e: Error) => e.name === 'ValueError' && /never the active engine/.test(e.message))
  assert.equal(reg.active()?.id, llama.id)
})

// The Opus review of v1.14.1: two fallbacks made the first engine active without going through activate(), so the
// Laya engine could become active by removing the engine before it.
test('removing the active engine never makes the Laya engine active', () => {
  const store = ConfigStore.load(join(tmpDir('tllm-laya-registry-'), 'config.json'))
  const llama: Engine = {
    id: 'llama', name: 'llama.cpp', binPath: '/x/llama-server', kind: 'llama-server', version: '',
    capabilities: { kvTypes: [], flags: [] }, addedAt: '',
  }
  const other: Engine = { ...llama, id: 'other', name: 'other llama.cpp', binPath: '/y/llama-server' }
  store.update((c) => {
    c.engines = [llama]
    c.activeEngineId = llama.id
  })
  const reg = new Registry(store)
  const laya = reg.addLaya('Laya', '/venv/bin/python', 'laya 0.3.20')
  store.update((c) => { c.engines.push(other) })
  assert.deepEqual(reg.list().engines.map((e) => e.kind), ['llama-server', 'laya', 'llama-server'])
  reg.remove(llama.id)
  assert.equal(reg.list().activeEngineId, other.id, 'the next engine that can be active, not the Laya one')
  reg.remove(other.id)
  assert.equal(reg.list().activeEngineId, '', 'with only the Laya engine left there is no active engine')
  assert.equal(reg.layaEngine()?.id, laya.id)
})

test('a config whose active engine id is empty does not load with the Laya engine active', () => {
  const dir = tmpDir('tllm-laya-config-')
  const path = join(dir, 'config.json')
  const store = ConfigStore.load(path)
  store.update((c) => {
    c.engines = [
      { id: 'laya', name: 'Laya', binPath: '/venv/bin/python', kind: 'laya', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
      { id: 'llama', name: 'llama.cpp', binPath: '/x/llama-server', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    ] as Engine[]
    c.activeEngineId = ''
  })
  assert.equal(ConfigStore.load(path).snapshot().activeEngineId, 'llama')
})
