// A single GGUF whose tensors' data runs past the end of the file (a download that stopped early
// with no length to check it against) is flagged incomplete, as a split with a missing part is,
// so the Library shows it and nothing loads it. It listed as complete and failed only at load
// with llama.cpp's "tensor '…' data is not within the file bounds, model is corrupted or
// incomplete".
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ConfigStore } from '../config/config'
import { Scanner } from './scanner'
import { ggufFile, ggufVocabOnly } from '../test-support/gguf-file'
import { tmpDir } from '../test-support/tmp'

function stubStore(root: string): ConfigStore {
  return { dir: () => root, snapshot: () => ({ modelDirs: [root] }) } as unknown as ConfigStore
}

test('a GGUF cut short is listed incomplete; the whole file is not', async () => {
  const root = tmpDir('turbollm-cut-short-')
  try {
    // 1.5 MiB of F32 weights: still past walk()'s 1 MiB floor once cut to 1.25 MiB.
    const whole = ggufFile([{ name: 'token_embd.weight', dims: [393_216], type: 0 }], [['general.architecture', 'llama']])
    writeFileSync(join(root, 'whole-Q8_0.gguf'), whole)
    writeFileSync(join(root, 'short-Q8_0.gguf'), whole.subarray(0, 1_310_720))
    const scanner = new Scanner(stubStore(root))
    await scanner.rescan()
    const byFile = Object.fromEntries(scanner.list().models.map((m) => [m.path.split(/[\\/]/).pop(), m]))
    assert.equal(byFile['whole-Q8_0.gguf']?.incomplete, false)
    assert.equal(byFile['short-Q8_0.gguf']?.incomplete, true, 'cut short: not offered for loading')
    assert.equal(byFile['short-Q8_0.gguf']?.parseError, null, 'its header is whole and still read')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a vocab-only GGUF (no tensors, no padding after its header) is not listed incomplete', async () => {
  // llama.cpp's models/ggml-vocab-*.gguf are such files and it loads them; their padded data offset
  // lies a few bytes past their end, which listed them incomplete with Load off.
  const root = tmpDir('turbollm-cut-short-')
  try {
    // A 1.2 MB vocabulary string: past walk()'s 1 MiB floor, as the real files (1.7 to 7.8 MB) are.
    const vocab = ggufVocabOnly([['general.architecture', 'llama'], ['tokenizer.ggml.merges', 'x'.repeat(1_200_001)]])
    writeFileSync(join(root, 'ggml-vocab-llama.gguf'), vocab)
    const scanner = new Scanner(stubStore(root))
    await scanner.rescan()
    const [model] = scanner.list().models
    assert.equal(model?.parseError, null)
    assert.equal(model?.incomplete, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a GGUF cut short while it was in the cache of an older build is re-checked', async () => {
  const root = tmpDir('turbollm-cut-short-')
  try {
    const whole = ggufFile([{ name: 'token_embd.weight', dims: [393_216], type: 0 }], [['general.architecture', 'llama']])
    const path = join(root, 'short-Q8_0.gguf')
    writeFileSync(path, whole.subarray(0, 1_310_720))
    // A cache row written by the previous build (version 6) for this file as it is now: its meta
    // has no dataEnd, and replayed it would list the file as complete.
    const first = new Scanner(stubStore(root))
    await first.rescan()
    const cachePath = join(root, 'models-cache.json')
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      version: number
      entries: Record<string, { meta: Record<string, unknown> }>
    }
    cache.version = 6
    delete cache.entries[path].meta.dataEnd
    writeFileSync(cachePath, JSON.stringify(cache))
    const scanner = new Scanner(stubStore(root))
    await scanner.rescan()
    assert.equal(scanner.list().models[0]?.incomplete, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
