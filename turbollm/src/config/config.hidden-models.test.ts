// Models hidden by hand (Models → Library, a model's "Hide"): the daemon keeps them in config.hiddenModels, keyed like
// modelProfiles, so the choice holds on every page and device. Loaded through ConfigStore.load on a real temp file, as
// the daemon reads a user's config.json, so migrate() and normalize() run for real.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigStore, HIDDEN_MODELS_CAP, defaultConfig, isModelHidden, migrateModelKey, setModelHidden } from './config'
import { tmpDir } from '../test-support/tmp'

function loadRaw(raw: unknown) {
  const path = join(tmpDir('tllm-hidden-cfg-'), 'config.json')
  writeFileSync(path, JSON.stringify(raw), 'utf8')
  return ConfigStore.load(path).snapshot()
}

test('a config written before hidden models existed loads with none hidden', () => {
  const { hiddenModels, ...older } = defaultConfig()
  void hiddenModels
  assert.deepEqual(loadRaw(older).hiddenModels, [])
})

test('a hand-edited list keeps each non-empty key once, in order, and drops the rest', () => {
  assert.deepEqual(loadRaw({ hiddenModels: ['a|q4|1', '', 7, null, 'b|q8|2', 'a|q4|1'] }).hiddenModels, ['a|q4|1', 'b|q8|2'])
  assert.deepEqual(loadRaw({ hiddenModels: 'a|q4|1' }).hiddenModels, [])
})

test('normalize keeps only the newest keys past the cap', () => {
  const keys = Array.from({ length: HIDDEN_MODELS_CAP + 3 }, (_, i) => `m${i}|q4|1`)
  const kept = loadRaw({ hiddenModels: keys }).hiddenModels
  assert.equal(kept.length, HIDDEN_MODELS_CAP)
  assert.equal(kept[0], 'm3|q4|1')
  assert.equal(kept.at(-1), keys.at(-1))
})

test('setModelHidden hides once, puts a newly hidden key last, and unhides', () => {
  const cfg = defaultConfig()
  setModelHidden(cfg, 'a', true)
  setModelHidden(cfg, 'b', true)
  setModelHidden(cfg, 'a', true)
  assert.deepEqual(cfg.hiddenModels, ['a', 'b'])
  assert.equal(isModelHidden(cfg, 'b'), true)
  setModelHidden(cfg, 'a', false)
  setModelHidden(cfg, 'never-hidden', false)
  assert.deepEqual(cfg.hiddenModels, ['b'])
  assert.equal(isModelHidden(cfg, 'a'), false)
})

test('at the cap, hiding one more model shows the one hidden longest ago', () => {
  const cfg = defaultConfig()
  cfg.hiddenModels = Array.from({ length: HIDDEN_MODELS_CAP }, (_, i) => `m${i}`)
  setModelHidden(cfg, 'newest', true)
  assert.equal(cfg.hiddenModels.length, HIDDEN_MODELS_CAP)
  assert.equal(isModelHidden(cfg, 'm0'), false)
  assert.equal(cfg.hiddenModels.at(-1), 'newest')
})

// A corrected quant label changes the model's key (migrateModelKey): a model the user hid must stay hidden.
test('migrateModelKey keeps a hidden model hidden under its new key', () => {
  const cfg = defaultConfig()
  cfg.hiddenModels = ['other', 'q|Q4_K_S|10']
  assert.equal(migrateModelKey(cfg, 'q|Q4_K_S|10', 'q|IQ2_M|10'), true)
  assert.deepEqual(cfg.hiddenModels, ['other', 'q|IQ2_M|10'])
  // Already hidden under the new key: the old one just goes.
  cfg.hiddenModels = ['q|Q4_K_S|10', 'q|IQ2_M|10']
  migrateModelKey(cfg, 'q|Q4_K_S|10', 'q|IQ2_M|10')
  assert.deepEqual(cfg.hiddenModels, ['q|IQ2_M|10'])
})
