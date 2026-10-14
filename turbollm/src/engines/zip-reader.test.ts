// zip-reader.ts is the leaf the zip and release flows share. Parser behaviour is covered by
// zip-install.test.ts (via the re-exports); this file covers what only the leaf owns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'
import { extractZipAll, ZipError } from './zip-reader'

test('extractZipAll: a backslash-separated traversal name is refused like a slash one', () => {
  const parent = tmpDir('zip-reader-')
  const dest = join(parent, 'out')
  const archive = buildZipArchive([{ name: String.raw`..\evil.txt`, data: Buffer.from('x') }])
  assert.throws(
    () => extractZipAll(archive, dest),
    (e: unknown) => e instanceof ZipError && e.code === 'bad_zip',
  )
  assert.deepEqual(readdirSync(parent).filter((n) => n !== 'out'), [])
  assert.equal(existsSync(join(dest, 'evil.txt')), false)
})
