// models-cache.json must not keep a row for every file it ever saw: a deleted model's row is
// dropped on the next scan, but only when its root was actually walked. A model folder that is
// unmounted for one scan keeps its rows, so the remount does not re-parse every header.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import type { ConfigStore } from '../config/config'
import { Scanner } from './scanner'
import { ggufFile } from '../test-support/gguf-file'
import { tmpDir } from '../test-support/tmp'

function cachedPaths(dataDir: string): string[] {
  const raw = JSON.parse(readFileSync(join(dataDir, 'models-cache.json'), 'utf8')) as { entries: Record<string, unknown> }
  return Object.keys(raw.entries)
}

function setup() {
  const base = tmpDir('turbollm-cache-prune-')
  const dataDir = join(base, 'data')
  const rootA = join(base, 'a')
  const rootB = join(base, 'b')
  for (const d of [dataDir, rootA, rootB]) mkdirSync(d)
  const bytes = ggufFile([{ name: 'token_embd.weight', dims: [393_216], type: 0 }], [['general.architecture', 'llama']])
  const store = {
    dir: () => dataDir,
    snapshot: () => ({ modelDirs: [rootA, rootB] }),
    read: () => ({ modelDirs: [rootA, rootB] }),
  } as unknown as ConfigStore
  return { base, dataDir, rootA, rootB, bytes, scanner: new Scanner(store) }
}

test('a deleted model file is dropped from the scan cache on the next scan', async () => {
  const { dataDir, rootA, bytes, scanner } = setup()
  writeFileSync(join(rootA, 'keep-Q8_0.gguf'), bytes)
  writeFileSync(join(rootA, 'gone-Q8_0.gguf'), bytes)
  await scanner.rescan()
  assert.equal(cachedPaths(dataDir).length, 2)
  rmSync(join(rootA, 'gone-Q8_0.gguf'))
  await scanner.rescan()
  assert.deepEqual(cachedPaths(dataDir).map((p) => basename(p)), ['keep-Q8_0.gguf'])
})

test('rows of a model folder that is missing for one scan are kept', async () => {
  const { base, dataDir, rootA, rootB, bytes, scanner } = setup()
  writeFileSync(join(rootA, 'a-Q8_0.gguf'), bytes)
  writeFileSync(join(rootB, 'b-Q8_0.gguf'), bytes)
  await scanner.rescan()
  renameSync(rootB, join(base, 'b-unmounted'))
  await scanner.rescan()
  assert.deepEqual(cachedPaths(dataDir).map((p) => basename(p)).sort(), ['a-Q8_0.gguf', 'b-Q8_0.gguf'])
})
