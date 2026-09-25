import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLayaRepo, layaRepoFiles } from './laya-repo'
import type { RawTreeEntry } from './hf'

function file(path: string, size = 10, oid?: string): RawTreeEntry {
  return { type: 'file', path, size, ...(oid ? { lfs: { oid, size } } : {}) } as RawTreeEntry
}

/** convaiinnovations/laya as HF lists it (trimmed): three checkpoints, card assets, eval output and scripts. */
const LAYA_TREE: RawTreeEntry[] = [
  file('.gitattributes'), file('README.md'), file('assets/logo-mark.png'), file('email_utils.py'),
  file('encoder/config.json'), file('eval/results.json'), file('model.safetensors', 808, 'sha-en'),
  file('multilingual/encoder/config.json'), file('multilingual/model.safetensors', 647, 'sha-ml'),
  file('multilingual/rl_agent_config.json'), file('multilingual/tokenizer/tokenizer.json'),
  file('multilingual/tokenizer/tokenizer_config.json'), file('rl_agent_api.py'), file('rl_agent_config.json'),
  file('rl_common.py'), file('tokenizer/tokenizer.json'), file('tokenizer/tokenizer_config.json'),
  file('typed-decisions/encoder/config.json'), file('typed-decisions/model.safetensors', 808, 'sha-td'),
  file('typed-decisions/rl_agent_config.json'), file('typed-decisions/tokenizer/tokenizer.json'),
]

const url = (path: string) => `https://huggingface.co/convaiinnovations/laya/resolve/main/${path}`

test('isLayaRepo: a decision-head config and weights at the root make a Laya repo', () => {
  assert.equal(isLayaRepo(LAYA_TREE), true)
})

test('isLayaRepo: an ordinary safetensors repo is not a Laya repo', () => {
  assert.equal(isLayaRepo([file('config.json'), file('model.safetensors'), file('tokenizer.json')]), false)
})

test('layaRepoFiles: the English and multilingual checkpoints, with their encoder and tokenizer folders', () => {
  assert.deepEqual(layaRepoFiles(LAYA_TREE, url).map((f) => f.name), [
    'encoder/config.json',
    'model.safetensors',
    'multilingual/encoder/config.json',
    'multilingual/model.safetensors',
    'multilingual/rl_agent_config.json',
    'multilingual/tokenizer/tokenizer.json',
    'multilingual/tokenizer/tokenizer_config.json',
    'rl_agent_config.json',
    'tokenizer/tokenizer.json',
    'tokenizer/tokenizer_config.json',
  ])
})

test('layaRepoFiles: never the typed-decisions checkpoint, the card assets, the eval output or the scripts', () => {
  const names = layaRepoFiles(LAYA_TREE, url).map((f) => f.name)
  assert.equal(names.some((n) => n.startsWith('typed-decisions/') || n.startsWith('assets/') || n.startsWith('eval/')), false)
  assert.equal(names.some((n) => n.endsWith('.py') || n === 'README.md'), false)
})

test('layaRepoFiles: each file carries its size, its weight sha256 and its resolve URL', () => {
  const weights = layaRepoFiles(LAYA_TREE, url).find((f) => f.name === 'multilingual/model.safetensors')
  assert.deepEqual(weights, {
    name: 'multilingual/model.safetensors',
    quant: 'mlx',
    sizeBytes: 647,
    parts: 1,
    mmproj: false,
    safetensors: true,
    sha256: 'sha-ml',
    url: url('multilingual/model.safetensors'),
  })
})
