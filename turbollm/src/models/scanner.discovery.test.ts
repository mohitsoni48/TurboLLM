import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { defaultConfig, type Config, type ConfigStore } from '../config/config'
import { Scanner, ScannerError } from './scanner'
import { tmpDir } from '../test-support/tmp'

function gguf(dir: string, name = 'model-ROCMFP4.gguf'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  // Valid minimal GGUF with an unknown quant: discovery must not filter it out.
  const data = Buffer.alloc(1 << 20)
  data.writeUInt32LE(0x46554747, 0)
  data.writeUInt32LE(3, 4)
  writeFileSync(path, data)
  return path
}
function mlx(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), '{}')
  writeFileSync(join(dir, 'tokenizer.json'), '{}')
  writeFileSync(join(dir, 'model.safetensors'), Buffer.alloc(16))
  return dir
}
function fixture(t: TestContext) {
  const root = tmpDir('turbollm-discovery-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const library = join(root, 'library')
  const data = join(root, 'data')
  mkdirSync(library)
  mkdirSync(data)
  return { root, library, scanner: (dirs = [library]) => {
    const cfg: Config = { ...defaultConfig(), modelDirs: dirs }
    return new Scanner({
      dir: () => data,
      snapshot: () => cfg,
      update: (fn: (c: Config) => void) => fn(cfg),
    } as unknown as ConfigStore)
  } }
}
const dirLink = process.platform === 'win32' ? 'junction' : 'dir'
// File symlinks require Windows developer mode / privilege; junction tests do not.
const fileLinks = { skip: process.platform === 'win32' }

test('follows directory links, avoids cycles and aliases, and resets visited paths on rescan', async (t) => {
  const f = fixture(t)
  const target = join(f.root, 'external')
  gguf(target)
  symlinkSync(target, join(f.library, 'linked'), dirLink)
  symlinkSync(f.library, join(target, 'cycle'), dirLink)
  symlinkSync(target, join(f.library, 'alias'), dirLink)
  const s = f.scanner()
  await s.rescan()
  assert.equal(s.list().models.length, 1)
  assert.equal(s.list().models[0].path, join(f.library, 'alias', 'model-ROCMFP4.gguf'))
  assert.equal(s.list().models[0].parseError, null)
  gguf(target, 'second.gguf')
  await s.rescan()
  assert.equal(s.list().models.length, 2)
})

test('explicit root wins over an earlier alias and overlapping roots are deduplicated', async (t) => {
  const f = fixture(t)
  const target = join(f.root, 'real')
  const path = gguf(target)
  symlinkSync(target, join(f.library, 'alias'), dirLink)
  for (const dirs of [[f.library, target, f.library], [target, f.library]]) {
    const s = f.scanner(dirs)
    await s.rescan()
    assert.deepEqual(s.list().models.map((m) => m.path), [path])
  }
})

test('broken links do not prevent discovering other models', async (t) => {
  const f = fixture(t)
  // A junction can have a nonexistent target; stat reports ENOENT as for a symlink.
  symlinkSync(join(f.root, 'missing'), join(f.library, 'broken'), dirLink)
  const path = gguf(f.library)
  const s = f.scanner()
  await s.rescan()
  assert.deepEqual(s.list().models.map((m) => m.path), [path])
})

test('mixed models retain GGUF variants without exposing nested Safetensors checkpoints', async (t) => {
  const f = fixture(t)
  mlx(f.library)
  const sibling = gguf(f.library)
  const nested = gguf(join(f.library, 'quants'), 'model-Q4_0.gguf')
  const checkpoint = mlx(join(f.library, 'checkpoint-500'))
  const s = f.scanner()
  await s.rescan()
  assert.deepEqual(new Set(s.list().models.map((m) => m.path)), new Set([f.library, sibling, nested]))
  const explicit = f.scanner([f.library, checkpoint])
  await explicit.rescan()
  assert.equal(explicit.list().models.filter((m) => m.format === 'mlx').length, 2)
})

test('Safetensors aliases are deduplicated', async (t) => {
  const f = fixture(t)
  const target = mlx(join(f.root, 'external'))
  symlinkSync(target, join(f.library, 'a'), dirLink)
  symlinkSync(target, join(f.library, 'b'), dirLink)
  const s = f.scanner()
  await s.rescan()
  assert.equal(s.list().models.length, 1)
})

test('HF snapshots sharing a blob produce one model and one cache row', fileLinks, async (t) => {
  const f = fixture(t)
  const blob = gguf(join(f.library, 'blobs'), 'hash-without-extension')
  for (const revision of ['a', 'b']) {
    const snapshot = join(f.library, 'snapshots', revision)
    mkdirSync(snapshot, { recursive: true })
    symlinkSync(blob, join(snapshot, 'model.gguf'))
  }
  const s = f.scanner()
  await s.rescan()
  assert.equal(s.list().models.length, 1)
  assert.equal(s.list().models[0].sizeBytes, 1 << 20)
  const cache = JSON.parse(readFileSync(join(f.root, 'data', 'models-cache.json'), 'utf8'))
  assert.equal(Object.keys(cache.entries).length, 1)
})

test('file-link farm and real root produce one entry per file in either root order', fileLinks, async (t) => {
  const f = fixture(t)
  const real = join(f.root, 'real')
  const target = gguf(real)
  symlinkSync(target, join(f.library, 'alias.gguf'))
  for (const dirs of [[real, f.library], [f.library, real]]) {
    const s = f.scanner(dirs)
    await s.rescan()
    assert.equal(s.list().models.length, 1)
  }
})

test('linked GGUF deletion refuses to unlink or delete the target', fileLinks, async (t) => {
  const f = fixture(t)
  const target = gguf(join(f.root, 'external'))
  const link = join(f.library, 'linked.gguf')
  symlinkSync(target, link)
  const s = f.scanner()
  await s.rescan()
  await assert.rejects(s.delete(s.list().models[0].key), (e: unknown) =>
    e instanceof ScannerError && e.code === 'unsafe_model_delete' && e.message.includes('Real target:'))
  assert.ok(existsSync(target))
  assert.ok(existsSync(link))
})

for (const format of ['gguf', 'mlx'] as const) {
  test(`${format} deletion refuses an ancestor junction outside roots`, async (t) => {
    const f = fixture(t)
    // Prefix sibling catches naive startsWith(root) containment checks.
    const target = join(f.root, 'library-external')
    const model = format === 'mlx' ? mlx(join(target, 'model')) : gguf(join(target, 'model'))
    const unrelated = join(target, 'model', 'notes.txt')
    writeFileSync(unrelated, 'keep')
    symlinkSync(target, join(f.library, 'linked'), dirLink)
    const s = f.scanner()
    await s.rescan()
    await assert.rejects(s.delete(s.list().models[0].key), { code: 'unsafe_model_delete' })
    assert.ok(existsSync(model))
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep')
  })
}

test('direct model-directory junction cannot be deleted', async (t) => {
  const f = fixture(t)
  const target = mlx(join(f.root, 'external'))
  symlinkSync(target, join(f.library, 'linked'), dirLink)
  const s = f.scanner()
  await s.rescan()
  await assert.rejects(s.delete(s.list().models[0].key), { code: 'unsafe_model_delete' })
  assert.ok(existsSync(join(target, 'model.safetensors')))
})

test('all split shards are checked before deleting the first one', fileLinks, async (t) => {
  const f = fixture(t)
  const first = gguf(f.library, 'model-00001-of-00002.gguf')
  const target = gguf(join(f.root, 'external'))
  const second = join(f.library, 'model-00002-of-00002.gguf')
  symlinkSync(target, second)
  const s = f.scanner()
  await s.rescan()
  await assert.rejects(s.delete(s.list().models[0].key), { code: 'unsafe_model_delete' })
  for (const path of [first, second, target]) assert.ok(existsSync(path))
})

for (const format of ['gguf', 'mlx'] as const) {
  test(`ordinary ${format} deletion still removes the model and rescans`, async (t) => {
    const f = fixture(t)
    const path = format === 'mlx' ? mlx(join(f.library, 'model')) : gguf(f.library)
    const s = f.scanner()
    await s.rescan()
    assert.deepEqual(await s.delete(s.list().models[0].key), [path])
    assert.equal(existsSync(path), false)
    assert.equal(s.list().models.length, 0)
  })
}

test('deleting a model whose file already vanished from disk raises no_such_model, not a raw ENOENT', async (t) => {
  // A stale scan entry — an external process removed the file, or a race with another
  // delete — must not let realpathSync's raw ENOENT escape as an unhandled error (the API
  // route only recognizes ScannerError; anything else falls through to a bare 500).
  const f = fixture(t)
  const path = gguf(f.library)
  const s = f.scanner()
  await s.rescan()
  const key = s.list().models[0].key
  rmSync(path, { force: true })
  await assert.rejects(s.delete(key), { code: 'no_such_model' })
})

test('deep trees are bounded and scanning yields within one root', async (t) => {
  const f = fixture(t)
  const shallow = gguf(f.library)
  const deep = gguf(join(f.library, ...Array(34).fill('d')))
  let callbacks = 0
  let running = true
  const heartbeat = () => { if (running) { callbacks++; setImmediate(heartbeat) } }
  setImmediate(heartbeat)
  const s = f.scanner()
  try { await s.rescan() } finally { running = false }
  assert.ok(callbacks > 2, 'filesystem traversal must yield within a root')
  assert.deepEqual(s.list().models.map((m) => m.path), [shallow])
  assert.ok(existsSync(deep))
})

test('shared HF shard blobs retain complete groups and identical revisions are deduplicated', fileLinks, async (t) => {
  const f = fixture(t)
  const blobs = join(f.library, 'blobs')
  const shared = gguf(blobs, 'shared')
  const old = gguf(blobs, 'old')
  const fresh = gguf(blobs, 'fresh')
  for (const [revision, last] of [['a', old], ['b', old], ['c', fresh]]) {
    const dir = join(f.library, 'snapshots', revision)
    mkdirSync(dir, { recursive: true })
    symlinkSync(shared, join(dir, 'model-00001-of-00002.gguf'))
    symlinkSync(last, join(dir, 'model-00002-of-00002.gguf'))
  }
  const s = f.scanner()
  await s.rescan()
  assert.equal(s.list().models.length, 2)
  assert.ok(s.list().models.every((m) => !m.incomplete && m.sizeBytes === 2 << 20))
})

test('different models can share a linked mmproj without losing vision metadata', fileLinks, async (t) => {
  const f = fixture(t)
  const projector = gguf(join(f.root, 'blobs'), 'projector')
  for (const variant of ['a', 'b']) {
    const dir = join(f.library, variant)
    gguf(dir, `${variant}.gguf`)
    symlinkSync(projector, join(dir, 'mmproj.gguf'))
  }
  const s = f.scanner()
  await s.rescan()
  assert.equal(s.list().models.length, 2)
  assert.ok(s.list().models.every((m) => m.vision && m.mmprojSizeBytes === 1 << 20))
})

test('ancestor links are refused even when their target is inside a configured root', async (t) => {
  const f = fixture(t)
  const target = join(f.library, 'z-real')
  const path = gguf(target)
  symlinkSync(target, join(f.library, 'a-link'), dirLink)
  const s = f.scanner()
  await s.rescan()
  await assert.rejects(s.delete(s.list().models[0].key), { code: 'unsafe_model_delete' })
  assert.ok(existsSync(path))
})

test('ordinary split deletion removes all shards but preserves the shared projector', async (t) => {
  const f = fixture(t)
  const shards = [gguf(f.library, 'm-00001-of-00002.gguf'), gguf(f.library, 'm-00002-of-00002.gguf')]
  const projector = gguf(f.library, 'mmproj.gguf')
  const s = f.scanner()
  await s.rescan()
  assert.deepEqual(await s.delete(s.list().models[0].key), shards)
  assert.ok(shards.every((p) => !existsSync(p)))
  assert.ok(existsSync(projector))
})
