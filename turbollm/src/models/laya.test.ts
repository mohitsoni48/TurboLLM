import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { isLayaModelDir, layaEntryFor } from './laya'

const ENGLISH = { encoder: 'answerdotai/ModernBERT-large', max_len: 512 }
const MULTILINGUAL = { encoder: 'jhu-clsp/mmBERT-base', max_len: 1024 }

function checkpoint(dir: string, config: object, weightBytes: number): void {
  mkdirSync(join(dir, 'encoder'), { recursive: true })
  mkdirSync(join(dir, 'tokenizer'), { recursive: true })
  writeFileSync(join(dir, 'rl_agent_config.json'), JSON.stringify(config))
  writeFileSync(join(dir, 'model.safetensors'), Buffer.alloc(weightBytes))
}

function library(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-laya-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'laya')
}

test('layaEntryFor: the bundle is one model serving every checkpoint it holds, sized by all of their weights', (t) => {
  const dir = library(t)
  checkpoint(dir, ENGLISH, 100)
  checkpoint(join(dir, 'multilingual'), MULTILINGUAL, 60)
  const entry = layaEntryFor(dir)
  assert.deepEqual(entry.laya, { checkpoints: ['english', 'multilingual'] })
  assert.equal(entry.sizeBytes, 160)
  assert.equal(entry.key, 'laya|laya|160')
  assert.equal(entry.name, 'laya')
  assert.equal(entry.path, dir)
  assert.equal(entry.format, 'mlx')
  assert.equal(entry.arch, 'laya')
  assert.equal(entry.nativeCtx, 512)
  assert.equal(entry.embedding, false)
  assert.equal(entry.vision, false)
  assert.equal(entry.parseError, null)
})

test('layaEntryFor: a root checkpoint on mmBERT is the multilingual one', (t) => {
  const dir = library(t)
  checkpoint(dir, MULTILINGUAL, 60)
  assert.deepEqual(layaEntryFor(dir).laya, { checkpoints: ['multilingual'] })
})

test('layaEntryFor: a typed-decisions subfolder is listed too, and a folder without a config is not', (t) => {
  const dir = library(t)
  checkpoint(dir, ENGLISH, 100)
  checkpoint(join(dir, 'typed-decisions'), ENGLISH, 100)
  mkdirSync(join(dir, 'multilingual'))
  assert.deepEqual(layaEntryFor(dir).laya, { checkpoints: ['english', 'typed-decisions'] })
})

test('layaEntryFor: an unreadable decision-head config is a parse error, not a crash', (t) => {
  const dir = library(t)
  checkpoint(dir, ENGLISH, 100)
  writeFileSync(join(dir, 'rl_agent_config.json'), '{not json')
  const entry = layaEntryFor(dir)
  assert.match(entry.parseError ?? '', /rl_agent_config\.json/)
})

test('isLayaModelDir: rl_agent_config.json, model.safetensors, encoder and tokenizer make a Laya checkpoint', () => {
  assert.equal(isLayaModelDir(['encoder', 'model.safetensors', 'README.md', 'rl_agent_config.json', 'tokenizer']), true)
})

test('isLayaModelDir: the names are matched without regard to case', () => {
  assert.equal(isLayaModelDir(['Encoder', 'Model.safetensors', 'RL_Agent_Config.json', 'Tokenizer']), true)
})

test('isLayaModelDir: any one missing piece is not a Laya checkpoint', () => {
  const full = ['encoder', 'model.safetensors', 'rl_agent_config.json', 'tokenizer']
  for (const missing of full) {
    assert.equal(isLayaModelDir(full.filter((name) => name !== missing)), false, `without ${missing}`)
  }
})

test('isLayaModelDir: an ordinary HF safetensors model is not a Laya checkpoint', () => {
  assert.equal(isLayaModelDir(['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json']), false)
})
