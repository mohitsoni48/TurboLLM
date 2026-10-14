// extractZipAll (whole-archive, pure-Node zip extraction) and walkArchiveMembers (turn an
// extracted tree into ArchiveMember[] for pickInstallFiles). Containment matters here:
// both end in executing a binary the archive chose.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive, type ZipMember } from '../test-support/zip-archive'
import { extractZipAll, walkArchiveMembers, ZipError } from './zip-install'

function member(name: string, data = `content of ${name}`): ZipMember {
  return { name, data: Buffer.from(data) }
}

function writeTree(root: string, relPath: string, content: string): void {
  const full = join(root, ...relPath.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** Windows without Developer Mode cannot create symlinks — skip the test there. */
function tryLink(target: string, linkPath: string, t: TestContext): boolean {
  try {
    symlinkSync(target, linkPath)
    return true
  } catch (e) {
    t.skip(`cannot create symlinks here: ${(e as NodeJS.ErrnoException).code}`)
    return false
  }
}

function everythingUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map((p) => String(p).split(/[\\/]/).join('/'))
}

test('extractZipAll: writes nested members to their relative paths', () => {
  const dest = join(tmpDir('zip-all-'), 'out')
  extractZipAll(buildZipArchive([member('a/b/llama-server', 'bin'), member('a/lib.so', 'lib'), member('top.txt', 'top')]), dest)
  assert.equal(readFileSync(join(dest, 'a', 'b', 'llama-server'), 'utf8'), 'bin')
  assert.equal(readFileSync(join(dest, 'a', 'lib.so'), 'utf8'), 'lib')
  assert.equal(readFileSync(join(dest, 'top.txt'), 'utf8'), 'top')
})

for (const hostile of ['../evil.txt', 'a/../../evil.txt', '/abs.txt', 'C:/abs.txt', '..']) {
  test(`extractZipAll: refuses the member name ${hostile} and writes nothing outside destDir`, () => {
    const parent = tmpDir('zip-all-')
    const dest = join(parent, 'out')
    assert.throws(
      () => extractZipAll(buildZipArchive([member(hostile)]), dest),
      (e: unknown) => e instanceof ZipError && e.code === 'bad_zip',
    )
    assert.deepEqual(readdirSync(parent).filter((n) => n !== 'out'), [])
    assert.equal(existsSync(join(dest, 'evil.txt')), false)
  })
}

test('extractZipAll: directory members become directories, not files', () => {
  const dest = join(tmpDir('zip-all-'), 'out')
  extractZipAll(buildZipArchive([{ name: 'empty/', data: Buffer.alloc(0) }, member('x/f.txt')]), dest)
  assert.ok(lstatSync(join(dest, 'empty')).isDirectory())
  assert.ok(lstatSync(join(dest, 'x', 'f.txt')).isFile())
})

function link(name: string, target: string): ZipMember {
  return { name, data: Buffer.from(target), symlink: true }
}

test('extractZipAll: an in-root symlink member is materialised as a copy of its target bytes', () => {
  const dest = join(tmpDir('zip-all-'), 'out')
  extractZipAll(buildZipArchive([member('lib/libllama.so.0.0.1', 'bytes'), link('lib/libllama.so.0', 'libllama.so.0.0.1')]), dest)
  assert.deepEqual(everythingUnder(dest).sort(), ['lib', 'lib/libllama.so.0', 'lib/libllama.so.0.0.1'])
  assert.ok(lstatSync(join(dest, 'lib', 'libllama.so.0')).isFile(), 'a regular file, not a link')
  assert.equal(readFileSync(join(dest, 'lib', 'libllama.so.0'), 'utf8'), 'bytes')
})

test('extractZipAll: a chain of in-root symlinks resolves to the final file', () => {
  const dest = join(tmpDir('zip-all-'), 'out')
  extractZipAll(buildZipArchive([link('a.so.0', 'a.so.0.1'), link('a.so.0.1', 'a.so.0.1.2'), member('a.so.0.1.2', 'real')]), dest)
  assert.equal(readFileSync(join(dest, 'a.so.0'), 'utf8'), 'real')
})

for (const hostile of ['../secret', '/etc/passwd', 'C:/secret', 'missing.so', 'loop.so']) {
  test('extractZipAll: a symlink member pointing at ' + hostile + ' is dropped and nothing escapes', () => {
    const parent = tmpDir('zip-all-')
    const dest = join(parent, 'out')
    extractZipAll(buildZipArchive([member('real.so', 'bytes'), link('link.so', hostile), link('loop.so', 'loop.so')]), dest)
    assert.deepEqual(everythingUnder(dest), ['real.so'])
    assert.deepEqual(readdirSync(parent), ['out'])
  })
}

test('extractZipAll: never writes a release or zip install marker, whoever supplied it', () => {
  const dest = join(tmpDir('zip-all-'), 'out')
  extractZipAll(buildZipArchive([member('real.so', 'bytes'), member('.turbollm-release-install', '{}'), member('sub/.turbollm-zip-install', 'x')]), dest)
  assert.deepEqual(everythingUnder(dest).filter((p) => !p.endsWith('sub')), ['real.so'])
})

test('walkArchiveMembers: reports posix-relative file names and skips directories', () => {
  const root = tmpDir('walk-')
  writeTree(root, 'sub/llama-server', 'bin')
  writeTree(root, 'sub/deeper/libx.so', 'lib')
  const members = walkArchiveMembers(root)
  assert.deepEqual(members.map((m) => m.name).sort(), ['sub/deeper/libx.so', 'sub/llama-server'])
  assert.ok(members.every((m) => !m.isDir && !m.symlink))
})

test('walkArchiveMembers: a symlink to a sibling regular file is an ordinary member', (t) => {
  const root = tmpDir('walk-')
  writeTree(root, 'pkg/libllama.0.4.7.dylib', 'real')
  if (!tryLink('libllama.0.4.7.dylib', join(root, 'pkg', 'libllama.0.dylib'), t)) return
  const link = walkArchiveMembers(root).find((m) => m.name === 'pkg/libllama.0.dylib')
  assert.ok(link, 'the in-root link is reported')
  assert.equal(link.symlink, false)
})

test('walkArchiveMembers: a symlink pointing outside the root is not reported', (t) => {
  const root = tmpDir('walk-')
  const outside = tmpDir('walk-outside-')
  writeTree(outside, 'id_rsa', 'secret')
  writeTree(root, 'llama-server', 'bin')
  if (!tryLink(join(outside, 'id_rsa'), join(root, 'stolen'), t)) return
  assert.deepEqual(walkArchiveMembers(root).map((m) => m.name), ['llama-server'])
})

test('walkArchiveMembers: a dangling symlink is not reported', (t) => {
  const root = tmpDir('walk-')
  writeTree(root, 'llama-server', 'bin')
  if (!tryLink('missing-target', join(root, 'dangling'), t)) return
  assert.deepEqual(walkArchiveMembers(root).map((m) => m.name), ['llama-server'])
})
