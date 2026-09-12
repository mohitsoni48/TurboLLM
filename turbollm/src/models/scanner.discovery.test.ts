import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import type { ConfigStore } from '../config/config'
import { Scanner } from './scanner'

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
function scanner(root: string, dirs: string[]): Scanner {
  return new Scanner({ dir: () => root, snapshot: () => ({ modelDirs: dirs }) } as unknown as ConfigStore)
}
const dirLink = process.platform === 'win32' ? 'junction' : 'dir'

test('follows directory links, avoids cycles and overlapping roots, and rescans', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const library = join(root, 'library')
  const target = join(root, 'external')
  mkdirSync(library)
  gguf(target)
  symlinkSync(target, join(library, 'linked'), dirLink)
  symlinkSync(library, join(target, 'cycle'), dirLink)
  symlinkSync(target, join(library, 'alias'), dirLink)
  const s = scanner(root, [library, target, library])
  await s.rescan()
  assert.equal(s.list().models.length, 1)
  assert.ok(s.list().models[0].path.startsWith(library + sep), 'model must be reached through the directory link')
  assert.equal(s.list().models[0].parseError, null)
  gguf(target, 'second.gguf')
  await s.rescan()
  assert.equal(s.list().models.length, 2)
})

test('broken links do not prevent discovering other models', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  symlinkSync(join(root, 'missing'), join(root, 'broken'), dirLink)
  const path = gguf(root)
  const s = scanner(root, [root])
  await s.rescan()
  assert.deepEqual(s.list().models.map((m) => m.path), [path])
})

test('Safetensors directories do not hide sibling GGUFs or nested quant variants', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'config.json'), '{}')
  writeFileSync(join(root, 'tokenizer.json'), '{}')
  writeFileSync(join(root, 'model.safetensors'), Buffer.alloc(16))
  const sibling = gguf(root)
  const nested = gguf(join(root, 'quants'), 'model-Q4_0.gguf')
  const s = scanner(root, [root])
  await s.rescan()
  assert.deepEqual(new Set(s.list().models.map((m) => m.path)), new Set([root, sibling, nested]))
})

test('discovers linked GGUF files using target size', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = gguf(join(root, 'external'))
  const library = join(root, 'library')
  mkdirSync(library)
  const link = join(library, 'linked.gguf')
  symlinkSync(target, link)
  const s = scanner(root, [library])
  await s.rescan()
  assert.equal(s.list().models[0]?.path, link)
  assert.equal(s.list().models[0]?.sizeBytes, 1 << 20)
})
