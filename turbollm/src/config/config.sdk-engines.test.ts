// D-1 (ADR-462): an engine row can say which of the in-app SDK's engines it is (`sdkEngine`), and the config remembers
// the Android app's retired rows by key (`androidRetiredEngines`). Loaded through ConfigStore.load on a real temp
// file, as the daemon reads a user's config.json, so migrate() and normalize() run for real.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigStore, SCHEMA_VERSION, defaultConfig, type RetiredEngine } from './config'
import { tmpDir } from '../test-support/tmp'

function configPath(): string {
  return join(tmpDir('tllm-sdk-engines-cfg-'), 'config.json')
}

function loadRaw(raw: unknown) {
  const path = configPath()
  writeFileSync(path, JSON.stringify(raw), 'utf8')
  return ConfigStore.load(path).snapshot()
}

function sdkRow(sdkEngine: unknown): Record<string, unknown> {
  return {
    id: 'row-1', name: 'LiteRT-LM', binPath: '', kind: 'turbollm-sdk', version: 'in-app',
    capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-11-07T00:00:00.000Z', baseUrl: 'http://127.0.0.1:1', sdkEngine,
  }
}

function withEngines(engines: unknown[], extra: Record<string, unknown> = {}) {
  return { ...defaultConfig(), engines, ...extra }
}

const LITERT_DESCRIPTOR = { id: 'litert-lm', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'] }

test('a valid sdkEngine descriptor round-trips through a load', () => {
  const [row] = loadRaw(withEngines([sdkRow(LITERT_DESCRIPTOR)])).engines
  assert.deepEqual(row.sdkEngine, LITERT_DESCRIPTOR)
})

test('a malformed sdkEngine is dropped and its row kept', () => {
  for (const bad of [{ ...LITERT_DESCRIPTOR, formats: 'gguf' }, { ...LITERT_DESCRIPTOR, id: 3 }, null]) {
    const engines = loadRaw(withEngines([sdkRow(bad)])).engines
    assert.equal(engines.length, 1, `row kept for ${JSON.stringify(bad)}`)
    assert.equal(engines[0].id, 'row-1')
    assert.equal('sdkEngine' in engines[0], false, `descriptor dropped for ${JSON.stringify(bad)}`)
  }
})

test('a row with no sdkEngine stays without one (a legacy row)', () => {
  const { sdkEngine, ...legacy } = sdkRow(undefined)
  void sdkEngine
  const [row] = loadRaw(withEngines([legacy])).engines
  assert.equal('sdkEngine' in row, false)
})

function retiredRow(extra: Record<string, unknown> = {}): RetiredEngine {
  return {
    id: 'old-litert', name: 'litert-lm-android', binPath: '/lib/liblitert_lm_main.so', kind: 'litert-lm', version: '1',
    capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-11-07T00:00:00.000Z', ...extra,
  } as RetiredEngine
}

test('androidRetiredEngines entries survive a save and a load', () => {
  const path = configPath()
  const store = ConfigStore.load(path)
  store.update((c) => {
    c.androidRetiredEngines = { 'litert-lm-android': retiredRow({ copiedTo: 'sdk-row' }) }
  })
  const reloaded = ConfigStore.load(path).snapshot()
  assert.equal(reloaded.androidRetiredEngines?.['litert-lm-android']?.id, 'old-litert')
  assert.equal(reloaded.androidRetiredEngines?.['litert-lm-android']?.copiedTo, 'sdk-row')
})

test('androidRetiredEngines drops unsafe keys and entries lacking a string id, name or kind', () => {
  const unsafe = JSON.stringify(retiredRow())
  const raw = JSON.parse(`{"__proto__": ${unsafe}, "constructor": ${unsafe}}`) as Record<string, unknown>
  raw['no-id'] = retiredRow({ id: 7 })
  raw['no-name'] = retiredRow({ name: undefined })
  raw['no-kind'] = retiredRow({ kind: null })
  raw['not-object'] = 'x'
  raw['llama-server-android'] = retiredRow({ id: 'kept' })
  const retired = loadRaw(withEngines([], { androidRetiredEngines: raw })).androidRetiredEngines ?? {}
  assert.deepEqual(Object.keys(retired), ['llama-server-android'])
  assert.equal(retired['llama-server-android']?.id, 'kept')
  assert.equal(Object.getPrototypeOf(retired), Object.prototype)
})

test('a retired entry whose copiedTo is not a string loses copiedTo and keeps the rest', () => {
  const retired = loadRaw(withEngines([], { androidRetiredEngines: { x: retiredRow({ copiedTo: 5 }) } })).androidRetiredEngines
  assert.equal(retired?.x?.id, 'old-litert')
  assert.equal('copiedTo' in (retired?.x ?? {}), false)
})

test('a malformed androidRetiredEngines value is reset to empty', () => {
  assert.deepEqual(loadRaw(withEngines([], { androidRetiredEngines: 'nope' })).androidRetiredEngines, {})
})

test('a config without androidRetiredEngines loads without one', () => {
  assert.equal(loadRaw(withEngines([])).androidRetiredEngines, undefined)
})

test('the schema version is unchanged by these fields', () => {
  assert.equal(SCHEMA_VERSION, 4)
})

test('D-15: a retired SDK row remembered under sdk:<id> survives a save and a load', () => {
  const path = configPath()
  ConfigStore.load(path).update((c) => {
    c.androidRetiredEngines = { 'sdk:litert-lm': retiredRow({ id: 'sdk-row', name: 'LiteRT-LM', kind: 'turbollm-sdk' }) }
  })
  assert.equal(ConfigStore.load(path).snapshot().androidRetiredEngines?.['sdk:litert-lm']?.id, 'sdk-row')
})
