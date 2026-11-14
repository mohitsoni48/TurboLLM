import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { discardPurgeTrash, sweepPurgeTrash } from './engine-trash'

function trashFolder(parent: string, name: string): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'llama-server.exe'), 'x')
  return dir
}

test('discardPurgeTrash deletes the folder, and a second call while it runs joins that delete', async () => {
  const trash = trashFolder(tmpDir('engine-trash-'), '.build.purge-1')
  const first = discardPurgeTrash(trash)
  assert.equal(discardPurgeTrash(trash), first)
  await first
  assert.equal(existsSync(trash), false)
})

test('sweepPurgeTrash deletes only the renamed-aside purge folders in a parent', async () => {
  const parent = tmpDir('engine-trash-sweep-')
  const trash = trashFolder(parent, '.llama.cpp-b1-cuda.purge-123')
  const kept = trashFolder(parent, 'llama.cpp-b2-cuda')
  sweepPurgeTrash(parent)
  await discardPurgeTrash(trash)
  assert.equal(existsSync(trash), false)
  assert.equal(existsSync(kept), true)
})

test('sweepPurgeTrash ignores a parent that does not exist', () => {
  assert.doesNotThrow(() => sweepPurgeTrash(join(tmpDir('engine-trash-none-'), 'missing')))
})
