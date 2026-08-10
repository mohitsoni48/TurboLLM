import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { hfHubCacheDir, resolveDefaultModelDir } from './hf-cache'

const HOME = join('/tmp', 'fakehome')

test('HUGGINGFACE_HUB_CACHE is used directly when set', () => {
  const dir = hfHubCacheDir({ HUGGINGFACE_HUB_CACHE: '/explicit/hub', HF_HOME: '/hf' }, HOME)
  assert.equal(dir, '/explicit/hub')
})

test('HF_HOME resolves to join(HF_HOME, "hub") when hub-cache is unset', () => {
  const dir = hfHubCacheDir({ HF_HOME: join('/data', 'hf') }, HOME)
  assert.equal(dir, join('/data', 'hf', 'hub'))
})

test('falls back to ~/.cache/huggingface/hub with no env', () => {
  const dir = hfHubCacheDir({}, HOME)
  assert.equal(dir, join(HOME, '.cache', 'huggingface', 'hub'))
})

test('blank env values are ignored (treated as unset)', () => {
  const dir = hfHubCacheDir({ HUGGINGFACE_HUB_CACHE: '   ', HF_HOME: '' }, HOME)
  assert.equal(dir, join(HOME, '.cache', 'huggingface', 'hub'))
})

test('blank HUGGINGFACE_HUB_CACHE falls through to HF_HOME', () => {
  const dir = hfHubCacheDir({ HUGGINGFACE_HUB_CACHE: '  ', HF_HOME: '/hf' }, HOME)
  assert.equal(dir, join('/hf', 'hub'))
})

test('resolveDefaultModelDir: adopts the HF cache when it exists', () => {
  const out = resolveDefaultModelDir(true, '/existing/hf/cache', '/data')
  assert.equal(out.dir, '/existing/hf/cache')
  assert.equal(out.reason, 'hf-cache')
})

test('resolveDefaultModelDir: falls back to <dataDir>/models on a genuinely fresh install', () => {
  // The bug found live: a brand-new machine has no HF cache to adopt either,
  // so ADR-092's original logic left modelDirs empty forever and the first
  // download attempt failed with "Add a model folder in Settings..." on a
  // screen with no Settings link.
  const out = resolveDefaultModelDir(false, '/would/be/hf/cache', '/data')
  assert.equal(out.dir, join('/data', 'models'))
  assert.equal(out.reason, 'fresh-install')
})

test('resolveDefaultModelDir: the fallback never depends on the HF cache path value', () => {
  const a = resolveDefaultModelDir(false, '/one/path', '/data')
  const b = resolveDefaultModelDir(false, '/totally/different/path', '/data')
  assert.equal(a.dir, b.dir)
})
