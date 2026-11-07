// D-2 (ADR-462): migrateEngineId gains a copy mode and a per-model filter. The Android reconciler copies one row's
// `.litertlm` settings onto another and must leave the source intact; the default (move) call, used by an engine
// update (update-apply.ts), must stay exactly as it was.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultConfig, getModelProfile, migrateEngineId, ownEntry, isUnsafeMapKey, type Config, type ModelPreset,
} from './config'

/** The body of migrateEngineId before D-2, pasted verbatim: the default call must still behave exactly like it. */
function moveOracle(cfg: Config, oldId: string, newId: string): void {
  if (oldId === newId || isUnsafeMapKey(newId)) return
  for (const byEngine of Object.values(cfg.modelProfiles)) {
    const entry = ownEntry(byEngine, oldId)
    if (!entry) continue
    if (!ownEntry(byEngine, newId)) byEngine[newId] = entry
    delete byEngine[oldId]
  }
  for (const presets of Object.values(cfg.modelPresets)) {
    for (const p of presets) if (p.engineId === oldId) p.engineId = newId
  }
  if (cfg.lastLoaded.engineId === oldId) cfg.lastLoaded = { ...cfg.lastLoaded, engineId: newId }
}

const GGUF_KEY = 'qwen|Q4_K_M|100'
const LITERT_KEY = 'gemma|litertlm|200'
const OTHER_KEY = 'phi|Q8_0|300'

function profile(tag: string) {
  return { profile: { tag }, updatedAt: '2026-11-07T00:00:00.000Z' }
}

function preset(engineId: string, name: string, id = `${engineId}-${name}`): ModelPreset {
  return { id, name, engineId, profile: { name }, updatedAt: '2026-11-07T00:00:00.000Z', origin: 'manual' }
}

function fixture(): Config {
  const cfg = defaultConfig()
  cfg.modelProfiles = {
    [GGUF_KEY]: { old: profile('gguf-old') },
    [LITERT_KEY]: { old: profile('litert-old'), other: profile('litert-other') },
    [OTHER_KEY]: { other: profile('other') },
  }
  cfg.modelPresets = {
    [GGUF_KEY]: [preset('old', 'fast')],
    [LITERT_KEY]: [preset('old', 'fast'), preset('', 'any')],
  }
  cfg.lastPresetId = { [LITERT_KEY]: 'old-fast' }
  cfg.lastLoaded = { modelKey: LITERT_KEY, engineId: 'old' }
  return cfg
}

function fixtureWithTargetEntries(): Config {
  const cfg = fixture()
  cfg.modelProfiles[GGUF_KEY].new = profile('gguf-new')
  cfg.modelPresets[GGUF_KEY].push(preset('new', 'fast'))
  return cfg
}

function fixtureNotOnOldEngine(): Config {
  const cfg = fixture()
  cfg.lastLoaded = { modelKey: OTHER_KEY, engineId: 'other' }
  return cfg
}

const onlyLitert = (key: string) => key === LITERT_KEY

test('the default call moves exactly as the pre-D-2 body did, over three fixtures', () => {
  for (const make of [fixture, fixtureWithTargetEntries, fixtureNotOnOldEngine]) {
    const actual = make()
    const expected = make()
    migrateEngineId(actual, 'old', 'new')
    moveOracle(expected, 'old', 'new')
    assert.deepEqual(actual, expected, make.name)
  }
})

test('copy with a .litertlm-only filter copies only those keys onto the new id', () => {
  const cfg = fixture()
  migrateEngineId(cfg, 'old', 'new', { copy: true, onlyModel: onlyLitert })
  assert.deepEqual(cfg.modelProfiles[LITERT_KEY].new, profile('litert-old'))
  assert.equal(cfg.modelProfiles[GGUF_KEY].new, undefined)
  const copied = cfg.modelPresets[LITERT_KEY].filter((p) => p.engineId === 'new')
  assert.equal(copied.length, 1)
  assert.equal(copied[0].name, 'fast')
  assert.notEqual(copied[0].id, 'old-fast')
  assert.deepEqual(cfg.modelPresets[GGUF_KEY].map((p) => p.engineId), ['old'])
})

test('a copy is a deep clone: changing it leaves the source untouched', () => {
  const cfg = fixture()
  migrateEngineId(cfg, 'old', 'new', { copy: true })
  ;(cfg.modelProfiles[LITERT_KEY].new.profile as { tag: string }).tag = 'changed'
  ;(cfg.modelPresets[LITERT_KEY].find((p) => p.engineId === 'new')?.profile as { name: string }).name = 'changed'
  assert.deepEqual(cfg.modelProfiles[LITERT_KEY].old, profile('litert-old'))
  assert.deepEqual(cfg.modelPresets[LITERT_KEY][0].profile, { name: 'fast' })
})

test('a copy never overwrites an entry the target already has', () => {
  const cfg = fixtureWithTargetEntries()
  migrateEngineId(cfg, 'old', 'new', { copy: true })
  assert.deepEqual(cfg.modelProfiles[GGUF_KEY].new, profile('gguf-new'))
  assert.equal(cfg.modelPresets[GGUF_KEY].filter((p) => p.engineId === 'new' && p.name === 'fast').length, 1)
})

test('a second identical copy adds nothing', () => {
  const cfg = fixture()
  migrateEngineId(cfg, 'old', 'new', { copy: true, onlyModel: onlyLitert })
  const once = structuredClone(cfg)
  migrateEngineId(cfg, 'old', 'new', { copy: true, onlyModel: onlyLitert })
  assert.deepEqual(cfg, once)
})

test('a copy leaves every source entry and lastLoaded as they were', () => {
  const cfg = fixture()
  const before = fixture()
  migrateEngineId(cfg, 'old', 'new', { copy: true })
  for (const key of Object.keys(before.modelProfiles)) {
    for (const [engineId, entry] of Object.entries(before.modelProfiles[key])) {
      assert.deepEqual(cfg.modelProfiles[key][engineId], entry)
    }
  }
  for (const key of Object.keys(before.modelPresets)) {
    assert.deepEqual(cfg.modelPresets[key].filter((p) => p.engineId !== 'new'), before.modelPresets[key])
  }
  assert.deepEqual(cfg.lastLoaded, before.lastLoaded)
})

// m-2 (stage-6 review): there is one pin per model, and getModelProfile honours it only on the pinned preset's engine.
// A copy that left the pin on the source made a pinned preset stop applying on the row the user now runs.

const clonedOnNew = (cfg: Config, key: string) => cfg.modelPresets[key].find((p) => p.engineId === 'new' && p.name === 'fast')

test('m-2: a pin naming a copied preset moves to its clone, which getModelProfile then applies on the new row', () => {
  const cfg = fixture()
  migrateEngineId(cfg, 'old', 'new', { copy: true, onlyModel: onlyLitert })
  const clone = clonedOnNew(cfg, LITERT_KEY)
  assert.ok(clone)
  assert.equal(cfg.lastPresetId[LITERT_KEY], clone.id)
  assert.deepEqual(getModelProfile(cfg, LITERT_KEY, 'new'), { name: 'fast' })
  assert.ok(cfg.modelPresets[LITERT_KEY].some((p) => p.id === 'old-fast' && p.engineId === 'old'), 'the original is kept')
})

test('m-2: a model the filter rejects keeps its pin', () => {
  const cfg = fixture()
  cfg.lastPresetId[GGUF_KEY] = 'old-fast'
  migrateEngineId(cfg, 'old', 'new', { copy: true, onlyModel: onlyLitert })
  assert.equal(cfg.lastPresetId[GGUF_KEY], 'old-fast')
})

test('m-2: when the new row already has a preset of that name, the pin moves to that preset', () => {
  const cfg = fixture()
  cfg.modelPresets[LITERT_KEY].push(preset('new', 'fast'))
  migrateEngineId(cfg, 'old', 'new', { copy: true, onlyModel: onlyLitert })
  assert.equal(cfg.lastPresetId[LITERT_KEY], 'new-fast')
})

test('m-2: a pin naming a preset of another engine stays where it is', () => {
  const cfg = fixture()
  cfg.lastPresetId[LITERT_KEY] = '-any'
  migrateEngineId(cfg, 'old', 'new', { copy: true })
  assert.equal(cfg.lastPresetId[LITERT_KEY], '-any')
})

test('a move with a filter moves only matching keys, and lastLoaded only when its model matches', () => {
  const cfg = fixture()
  migrateEngineId(cfg, 'old', 'new', { onlyModel: (key) => key === GGUF_KEY })
  assert.deepEqual(cfg.modelProfiles[GGUF_KEY], { new: profile('gguf-old') })
  assert.deepEqual(Object.keys(cfg.modelProfiles[LITERT_KEY]), ['old', 'other'])
  assert.deepEqual(cfg.modelPresets[GGUF_KEY].map((p) => p.engineId), ['new'])
  assert.deepEqual(cfg.modelPresets[LITERT_KEY].map((p) => p.engineId), ['old', ''])
  assert.deepEqual(cfg.lastLoaded, { modelKey: LITERT_KEY, engineId: 'old' })
  migrateEngineId(cfg, 'old', 'new', { onlyModel: onlyLitert })
  assert.deepEqual(cfg.lastLoaded, { modelKey: LITERT_KEY, engineId: 'new' })
})
