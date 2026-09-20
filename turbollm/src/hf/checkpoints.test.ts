// Discover must offer one row per DOWNLOADABLE checkpoint folder (ADR-434 (h)): OpenJev keeps
// every checkpoint in its own subfolder, so today's root-only file list is empty and the
// Download button does nothing. Fixtures are the plan's F6 trees — no network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { annotateCheckpoint, findCheckpoints, MAX_CHECKPOINT_CONFIG_FETCHES } from './checkpoints'
import type { HfRepoFile, RawTreeEntry } from './hf'
import type { ProvenanceEntry } from '../downloads/downloads'
import type { ModelEntry } from '../models/scanner'

const fileUrl = (path: string) => `https://huggingface.co/AlexWortega/openjev/resolve/main/${path}`

function file(path: string, size?: number, oid?: string): RawTreeEntry {
  return { type: 'file', path, ...(oid ? { lfs: { oid, size } } : { size }) }
}

/** F6 "OpenJev-like": three checkpoint folders, a README, a video and a .py the picker must
 *  never offer, plus the directory entries HF's recursive tree includes. */
const OPENJEV_TREE: RawTreeEntry[] = [
  file('README.md', 5),
  file('.gitattributes', 1),
  file('assets/demo.mp4', 1_000_000),
  file('openjev/infer.py', 900),
  { type: 'directory', path: 'qwen3.5-4b-nli-v2' },
  { type: 'directory', path: 'qwen3.5-4b-nli-v1' },
  { type: 'directory', path: 'qwen3.5-35b-a3b-nli' },
  file('qwen3.5-4b-nli-v2/config.json', 1200),
  file('qwen3.5-4b-nli-v2/model.safetensors', 9_000_000_000, 'sha-v2'),
  file('qwen3.5-4b-nli-v2/tokenizer.json', 7000),
  file('qwen3.5-4b-nli-v2/tokenizer_config.json', 800),
  file('qwen3.5-4b-nli-v2/chat_template.jinja', 300),
  file('qwen3.5-4b-nli-v1/config.json', 1200),
  file('qwen3.5-4b-nli-v1/model.safetensors', 8_000_000_000, 'sha-v1'),
  file('qwen3.5-4b-nli-v1/tokenizer.json', 7000),
  file('qwen3.5-35b-a3b-nli/config.json', 1400),
  file('qwen3.5-35b-a3b-nli/model-00001-of-00002.safetensors', 40_000_000_000, 'sha-35b-1'),
  file('qwen3.5-35b-a3b-nli/model-00002-of-00002.safetensors', 30_000_000_000, 'sha-35b-2'),
  file('qwen3.5-35b-a3b-nli/tokenizer.json', 7000),
]

const SINGLE_ROOT_TREE: RawTreeEntry[] = [
  file('config.json', 1200),
  file('model.safetensors', 5_000_000_000, 'sha-root'),
  file('tokenizer.json', 7000),
  file('chat_template.jinja', 300),
  file('README.md', 5),
]

/** F6 "Diffusers-like": weights in folders that hold no tokenizer, and a root with no
 *  config.json — the library would refuse every one of them, so none may be offered. */
const DIFFUSERS_TREE: RawTreeEntry[] = [
  file('model_index.json', 400),
  file('unet/config.json', 500),
  file('unet/diffusion_pytorch_model.safetensors', 3_000_000_000, 'sha-unet'),
  file('vae/config.json', 500),
  file('vae/diffusion_pytorch_model.safetensors', 300_000_000, 'sha-vae'),
  file('text_encoder/config.json', 500),
  file('text_encoder/model.safetensors', 700_000_000, 'sha-te'),
]

test('an OpenJev-like repo offers one checkpoint per folder, root absent, sorted by dir', () => {
  const cps = findCheckpoints('AlexWortega/openjev', OPENJEV_TREE, fileUrl)

  assert.deepEqual(cps.map((c) => c.dir), ['qwen3.5-35b-a3b-nli', 'qwen3.5-4b-nli-v1', 'qwen3.5-4b-nli-v2'])
  assert.deepEqual(cps.map((c) => c.name), ['qwen3.5-35b-a3b-nli', 'qwen3.5-4b-nli-v1', 'qwen3.5-4b-nli-v2'])
  assert.deepEqual(cps.map((c) => c.sizeBytes), [70_000_000_000, 8_000_000_000, 9_000_000_000])
})

test('a checkpoint carries only its OWN component files, never a sibling, README, video or .py', () => {
  const v2 = findCheckpoints('AlexWortega/openjev', OPENJEV_TREE, fileUrl).find((c) => c.dir === 'qwen3.5-4b-nli-v2')

  assert.deepEqual(v2?.files.map((f) => f.name), [
    'qwen3.5-4b-nli-v2/config.json',
    'qwen3.5-4b-nli-v2/model.safetensors',
    'qwen3.5-4b-nli-v2/tokenizer.json',
    'qwen3.5-4b-nli-v2/tokenizer_config.json',
    'qwen3.5-4b-nli-v2/chat_template.jinja',
  ])
})

test('a checkpoint file maps exactly like the root file list does today', () => {
  const v2 = findCheckpoints('AlexWortega/openjev', OPENJEV_TREE, fileUrl).find((c) => c.dir === 'qwen3.5-4b-nli-v2')

  assert.deepEqual(v2?.files.find((f) => f.name.endsWith('model.safetensors')), {
    name: 'qwen3.5-4b-nli-v2/model.safetensors',
    quant: 'mlx',
    sizeBytes: 9_000_000_000,
    parts: 1,
    mmproj: false,
    safetensors: true,
    sha256: 'sha-v2',
    url: 'https://huggingface.co/AlexWortega/openjev/resolve/main/qwen3.5-4b-nli-v2/model.safetensors',
  })
})

test('a single-root repo is one checkpoint named after the repo, at the root', () => {
  const cps = findCheckpoints('leonsarmiento/Qwen3.6-27B-3bit-mlx', SINGLE_ROOT_TREE, fileUrl)

  assert.equal(cps.length, 1)
  assert.equal(cps[0].dir, '')
  assert.equal(cps[0].name, 'Qwen3.6-27B-3bit-mlx')
  assert.equal(cps[0].sizeBytes, 5_000_000_000)
  assert.deepEqual(cps[0].files.map((f) => f.name), ['config.json', 'model.safetensors', 'tokenizer.json', 'chat_template.jinja'])
})

test('a diffusers-style repo offers nothing: no root config, and no tokenizer beside the parts', () => {
  assert.deepEqual(findCheckpoints('some/diffusion-model', DIFFUSERS_TREE, fileUrl), [])
})

test('a nested folder with a config and weights but no tokenizer is not a checkpoint', () => {
  const tree = [file('ckpt/config.json', 100), file('ckpt/model.safetensors', 10, 'x')]

  assert.deepEqual(findCheckpoints('a/b', tree, fileUrl), [])
})

test('the repo root needs no tokenizer — config plus weights is enough', () => {
  const tree = [file('config.json', 100), file('model.safetensors', 10, 'x')]

  assert.deepEqual(findCheckpoints('a/b', tree, fileUrl).map((c) => c.dir), [''])
})

test('a folder with a config but no weights, or weights but no config, is not a checkpoint', () => {
  const noWeights = [file('a/config.json', 1), file('a/tokenizer.json', 1)]
  const noConfig = [file('b/model.safetensors', 1, 'x'), file('b/tokenizer.json', 1)]

  assert.deepEqual(findCheckpoints('a/b', [...noWeights, ...noConfig], fileUrl), [])
})

test('directory entries are never mistaken for files', () => {
  const tree: RawTreeEntry[] = [
    { type: 'directory', path: 'ckpt/config.json' },
    { type: 'directory', path: 'ckpt/model.safetensors' },
    { type: 'directory', path: 'ckpt/tokenizer.json' },
  ]

  assert.deepEqual(findCheckpoints('a/b', tree, fileUrl), [])
})

test('a deeper checkpoint keeps its full POSIX dir and is named by its last segment', () => {
  const tree = [
    file('runs/exp1/config.json', 100),
    file('runs/exp1/model.safetensors', 10, 'x'),
    file('runs/exp1/tokenizer.model', 5),
  ]

  const [cp] = findCheckpoints('a/b', tree, fileUrl)
  assert.equal(cp.dir, 'runs/exp1')
  assert.equal(cp.name, 'exp1')
})

test('the config-fetch cap is 16', () => {
  assert.equal(MAX_CHECKPOINT_CONFIG_FETCHES, 16)
})

// ── annotateCheckpoint: is this checkpoint already on disk, and which local model is it? ──────
// Provenance `filename` is a basename (downloads.ts:512), so the existing (repo, filename) file
// match cannot tell two checkpoints' identical `model.safetensors` apart. The checkpoint match
// therefore goes by sha256, or by the download's full destination path.

const PRIMARY = join('D:', 'models')

function checkpointOf(dir: string, sha: string): { dir: string; files: HfRepoFile[] } {
  const prefix = dir ? `${dir}/` : ''
  const component = (name: string, sha256?: string): HfRepoFile => ({
    name: `${prefix}${name}`, quant: 'mlx', sizeBytes: 1, parts: 1, mmproj: false, safetensors: true, sha256,
    url: fileUrl(`${prefix}${name}`),
  })
  return { dir, files: [component('config.json'), component('model.safetensors', sha), component('tokenizer.json')] }
}

function provenanceFor(repo: string, dest: string, sha256?: string): ProvenanceEntry {
  return { repo, filename: 'model.safetensors', dest, at: '2026-09-19T00:00:00.000Z', ...(sha256 ? { sha256 } : {}) }
}

function scanned(path: string, key: string): ModelEntry {
  return { key, name: key, path } as unknown as ModelEntry
}

const REPO = 'AlexWortega/openjev'
const V2 = checkpointOf('qwen3.5-4b-nli-v2', 'sha-v2')
const V1 = checkpointOf('qwen3.5-4b-nli-v1', 'sha-v1')
const V2_DIR = join(PRIMARY, 'openjev', 'qwen3.5-4b-nli-v2')
const V2_DEST = join(V2_DIR, 'model.safetensors')

test('a downloaded checkpoint is matched by its weight sha, and its sibling is not', () => {
  const prov = [provenanceFor(REPO, V2_DEST, 'sha-v2')]
  const models = [scanned(V2_DIR, 'qwen3.5 4b nli v2|mlx-fp16|9012345678')]

  assert.deepEqual(annotateCheckpoint(REPO, V2, prov, models), { downloaded: true, localKey: 'qwen3.5 4b nli v2|mlx-fp16|9012345678' })
  assert.deepEqual(annotateCheckpoint(REPO, V1, prov, models), { downloaded: false, localKey: null })
})

test('with no sha recorded, the download destination path decides — still only that checkpoint', () => {
  const prov = [provenanceFor(REPO, V2_DEST)]
  const models = [scanned(V2_DIR, 'v2-key')]

  assert.deepEqual(annotateCheckpoint(REPO, V2, prov, models), { downloaded: true, localKey: 'v2-key' })
  assert.deepEqual(annotateCheckpoint(REPO, V1, prov, models), { downloaded: false, localKey: null })
})

test('a subfolder download never marks the ROOT checkpoint as downloaded', () => {
  const root = checkpointOf('', 'sha-root')
  const prov = [provenanceFor(REPO, V2_DEST)]
  const models = [scanned(V2_DIR, 'v2-key')]

  assert.deepEqual(annotateCheckpoint(REPO, root, prov, models), { downloaded: false, localKey: null })
})

test('a provenance entry from a DIFFERENT repo does not match by path', () => {
  const prov = [provenanceFor('someone/else', V2_DEST)]
  const models = [scanned(V2_DIR, 'v2-key')]

  assert.deepEqual(annotateCheckpoint(REPO, V2, prov, models), { downloaded: false, localKey: null })
})

test('a matching download with no scanned model yet is not downloaded', () => {
  const prov = [provenanceFor(REPO, V2_DEST, 'sha-v2')]

  assert.deepEqual(annotateCheckpoint(REPO, V2, prov, []), { downloaded: false, localKey: null })
})

test('a download whose folder is not in the library yet is not downloaded, even with other models scanned', () => {
  const prov = [provenanceFor(REPO, V2_DEST, 'sha-v2')]
  const unrelated = [scanned(join(PRIMARY, 'gemma-4-e4b'), 'gemma-key')]

  assert.deepEqual(annotateCheckpoint(REPO, V2, prov, unrelated), { downloaded: false, localKey: null })
})

test('a checkpoint nobody downloaded is not downloaded', () => {
  assert.deepEqual(annotateCheckpoint(REPO, V2, [], [scanned(V2_DIR, 'v2-key')]), { downloaded: false, localKey: null })
})

// Only on Windows: a backslash destination is what this platform's own downloads write, and the
// local-model lookup uses node:path `dirname`, which splits backslashes only here.
test('a Windows-style destination with backslashes matches the same checkpoint', { skip: process.platform !== 'win32' }, () => {
  const prov = [provenanceFor(REPO, 'D:\\models\\openjev\\qwen3.5-4b-nli-v2\\model.safetensors')]
  const models = [scanned('D:\\models\\openjev\\qwen3.5-4b-nli-v2', 'v2-key')]

  assert.deepEqual(annotateCheckpoint(REPO, V2, prov, models), { downloaded: true, localKey: 'v2-key' })
})
