import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { defaultConfig, type Config, type ConfigStore } from '../config/config'
import { Scanner } from './scanner'
import { tmpDir } from '../test-support/tmp'

function checkpoint(dir: string, encoder: string): void {
  mkdirSync(join(dir, 'encoder'), { recursive: true })
  mkdirSync(join(dir, 'tokenizer'), { recursive: true })
  writeFileSync(join(dir, 'encoder', 'config.json'), '{}')
  writeFileSync(join(dir, 'tokenizer', 'tokenizer.json'), '{}')
  writeFileSync(join(dir, 'tokenizer', 'tokenizer_config.json'), '{}')
  writeFileSync(join(dir, 'rl_agent_config.json'), JSON.stringify({ encoder, max_len: 512 }))
  writeFileSync(join(dir, 'model.safetensors'), Buffer.alloc(16))
}

function scannerOver(t: TestContext): { library: string; scanner: Scanner } {
  const root = tmpDir('turbollm-laya-scan-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const library = join(root, 'library')
  const data = join(root, 'data')
  mkdirSync(library)
  mkdirSync(data)
  const cfg: Config = { ...defaultConfig(), modelDirs: [library] }
  const store = { dir: () => data, snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) }
  return { library, scanner: new Scanner(store as unknown as ConfigStore) }
}

test('a Laya bundle in the library is one model, not one per checkpoint folder', async (t) => {
  const { library, scanner } = scannerOver(t)
  const bundle = join(library, 'laya')
  checkpoint(bundle, 'answerdotai/ModernBERT-large')
  checkpoint(join(bundle, 'multilingual'), 'jhu-clsp/mmBERT-base')
  await scanner.rescan()
  const models = scanner.list().models
  assert.equal(models.length, 1)
  assert.equal(models[0].path, bundle)
  assert.deepEqual(models[0].laya, { checkpoints: ['english', 'multilingual'] })
})

test('a Laya encoder folder is never mistaken for an HF model of its own', async (t) => {
  const { library, scanner } = scannerOver(t)
  const bundle = join(library, 'laya')
  checkpoint(bundle, 'answerdotai/ModernBERT-large')
  writeFileSync(join(bundle, 'encoder', 'model.safetensors'), Buffer.alloc(16))
  writeFileSync(join(bundle, 'encoder', 'tokenizer.json'), '{}')
  await scanner.rescan()
  assert.deepEqual(scanner.list().models.map((m) => m.path), [bundle])
})
