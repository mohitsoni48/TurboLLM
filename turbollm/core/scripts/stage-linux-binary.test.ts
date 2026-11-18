// Run from turbollm/: npx tsx --test core/scripts/stage-linux-binary.test.ts (rust-core plan T23b, QA PG-4, P-12).
// Every case runs the real script against a tmpDir() package root with synthetic binaries: a few header bytes and
// the version marker, never a real build or download.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../src/test-support/tmp'

const STAGE_LINUX = join(dirname(fileURLToPath(import.meta.url)), 'stage-linux-binary.mjs')
const BINARY = 'turbollm-core.linux-x64-gnu.node'
const VERSION = '9.8.7'
const ELF_SHARED_OBJECT = 3
const ELF_EXECUTABLE = 2
const MACHINE_X86_64 = 62
const MACHINE_AARCH64 = 183

function stageLinuxBinary(args: string[]) {
  const run = spawnSync(process.execPath, [STAGE_LINUX, ...args], { encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr }
}

function packageRoot(): string {
  const root = tmpDir('stage-linux-')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'turbollm', version: VERSION }))
  return root
}

function artifactDir(binary: Buffer): string {
  const dir = tmpDir('core-artifact-')
  writeFileSync(join(dir, BINARY), binary)
  return dir
}

function elf64(options: { type?: number; machine?: number; version?: string } = {}): Buffer {
  const header = Buffer.alloc(64)
  header.write('\x7fELF', 0, 'latin1')
  header[4] = 2
  header[5] = 1
  header.writeUInt16LE(options.type ?? ELF_SHARED_OBJECT, 16)
  header.writeUInt16LE(options.machine ?? MACHINE_X86_64, 18)
  return Buffer.concat([header, versionMarker(options.version ?? VERSION)])
}

function portableExecutable(): Buffer {
  return Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62), versionMarker(VERSION)])
}

function versionMarker(version: string): Buffer {
  return Buffer.from(`code before\0TURBOLLM_CORE_VERSION=${version}\0code after`)
}

function stagedBinary(root: string): string {
  return join(root, 'dist', 'native', BINARY)
}

test('an x86-64 ELF shared object with this version is staged into dist/native', () => {
  const root = packageRoot()
  const binary = elf64()

  const run = stageLinuxBinary([root, '--from-artifact', artifactDir(binary)])

  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(readFileSync(stagedBinary(root)), binary)
})

test('a Windows PE file is refused and nothing is staged', () => {
  const root = packageRoot()

  const run = stageLinuxBinary([root, '--from-artifact', artifactDir(portableExecutable())])

  assert.equal(run.status, 1)
  assert.match(run.stderr, /not an ELF file/)
  assert.equal(existsSync(stagedBinary(root)), false)
})

test('an ELF file that is not an x86-64 shared object is refused', () => {
  for (const binary of [elf64({ machine: MACHINE_AARCH64 }), elf64({ type: ELF_EXECUTABLE })]) {
    const root = packageRoot()

    const run = stageLinuxBinary([root, '--from-artifact', artifactDir(binary)])

    assert.equal(run.status, 1)
    assert.match(run.stderr, /not an x86-64 ELF shared object/)
    assert.equal(existsSync(stagedBinary(root)), false)
  }
})

test('a binary built for another version is refused', () => {
  const root = packageRoot()

  const run = stageLinuxBinary([root, '--from-artifact', artifactDir(elf64({ version: '9.8.6' }))])

  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`no TURBOLLM_CORE_VERSION=${VERSION.replaceAll('.', '\\.')} marker`))
  assert.equal(existsSync(stagedBinary(root)), false)
})

test('an artifact dir without the binary exits 1 with the gh run download hint', () => {
  const root = packageRoot()
  const emptyArtifact = tmpDir('core-artifact-')

  const run = stageLinuxBinary([root, '--from-artifact', emptyArtifact])

  assert.equal(run.status, 1)
  assert.match(run.stderr, /gh run download <run-id> -n core-node-linux-x64-gnu -D <dir>/)
  assert.equal(existsSync(stagedBinary(root)), false)
})

test('without a source to stage from, it prints the usage and exits 2', () => {
  const run = stageLinuxBinary([packageRoot()])

  assert.equal(run.status, 2)
  assert.match(run.stderr, /--from-artifact <dir>\|--from-build/)
})

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const LINUX_BINARY_GUARD =
  `RUN test -f dist/native/${BINARY} || (echo "run core/scripts/stage-linux-binary.mjs first" >&2; exit 1)`

for (const image of ['Dockerfile.test', 'Dockerfile.test.gpu', 'Dockerfile.test-port']) {
  test(`${image} fails its build right after the dist COPY when the Linux binary was not staged`, () => {
    const lines = readFileSync(join(REPO_ROOT, image), 'utf8').split(/\r?\n/)
    const distCopy = lines.indexOf('COPY turbollm/dist ./dist')

    assert.ok(distCopy >= 0, `${image} no longer copies the host dist`)
    assert.equal(lines[distCopy + 1], LINUX_BINARY_GUARD)
    assert.equal(lines.filter((line) => line.includes(BINARY)).length, 1)
  })
}
