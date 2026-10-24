// zip-reader.ts is the leaf the zip and release flows share. Parser behaviour is covered by
// zip-install.test.ts (via the re-exports); this file covers what only the leaf owns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'
import { extractZipAll, ZipError } from './zip-reader'

test('extractZipAll: a backslash-separated traversal name is refused like a slash one', async () => {
  const parent = tmpDir('zip-reader-')
  const dest = join(parent, 'out')
  const archive = buildZipArchive([{ name: String.raw`..\evil.txt`, data: Buffer.from('x') }])
  await assert.rejects(
    extractZipAll(archive, dest),
    (e: unknown) => e instanceof ZipError && e.code === 'bad_zip',
  )
  assert.deepEqual(readdirSync(parent).filter((n) => n !== 'out'), [])
  assert.equal(existsSync(join(dest, 'evil.txt')), false)
})

test('extractZipAll: does not hold the event loop while it extracts', async () => {
  // A release zip can expand to gigabytes on the Linux/Android path: a synchronous extraction
  // froze the daemon (UI polling, SSE, the gateway's token stream) until it finished.
  const dest = join(tmpDir('zip-reader-'), 'out')
  const archive = buildZipArchive([
    { name: 'lib/libggml.so', data: Buffer.alloc(4 * 1024 * 1024, 7) },
    { name: 'bin/llama-server', data: Buffer.alloc(1024 * 1024, 1) },
  ])
  let turns = 0
  let done = false
  const spin = (): void => {
    if (done) return
    turns++
    setImmediate(spin)
  }
  setImmediate(spin)
  let turnsDuringExtraction: number
  try {
    await extractZipAll(archive, dest)
    turnsDuringExtraction = turns
  } finally {
    done = true
  }
  assert.ok(turnsDuringExtraction > 0, 'other callbacks must run while the archive extracts')
  assert.equal(readFileSync(join(dest, 'lib', 'libggml.so')).length, 4 * 1024 * 1024)
})

test('extractZipAll: never inflates a member with the synchronous inflate', async (t) => {
  // The turn count above also passes with the sync inflate, since the writes are awaited anyway.
  // Only symlink link text may use inflateRawSync; zip-reader reads it off the namespace, so
  // syncBuiltinESMExports carries the spy to that binding.
  const dest = join(tmpDir('zip-reader-'), 'out')
  const archive = buildZipArchive([{ name: 'lib/libggml.so', data: Buffer.alloc(1024 * 1024, 7) }])
  const syncInflate = t.mock.method(zlib, 'inflateRawSync')
  syncBuiltinESMExports()
  t.after(() => {
    syncInflate.mock.restore()
    syncBuiltinESMExports()
  })
  await extractZipAll(archive, dest)
  assert.equal(syncInflate.mock.callCount(), 0)
  assert.equal(readFileSync(join(dest, 'lib', 'libggml.so')).length, 1024 * 1024)
})

test('extractZipAll: a corrupt member still fails with a ZipError on the async path', async () => {
  const dest = join(tmpDir('zip-reader-'), 'out')
  await assert.rejects(
    extractZipAll(buildZipArchive([{ name: 'big.bin', data: Buffer.alloc(64 * 1024), lieSize: 10 }]), dest),
    (e: unknown) => e instanceof ZipError && e.code === 'zip_too_large' && /expands past its declared size/.test(e.message),
  )
  await assert.rejects(
    extractZipAll(buildZipArchive([{ name: 'bad.bin', data: Buffer.from('x'.repeat(1000)), crc: 0xdeadbeef }]), dest),
    (e: unknown) => e instanceof ZipError && e.code === 'zip_crc_mismatch',
  )
})
