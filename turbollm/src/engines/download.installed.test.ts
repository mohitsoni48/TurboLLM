import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedBackendBuild, deleteAllBackendBuilds } from './download'

const serverBin = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tllm-dl-'))
}

/** Create a FULLY (marker included) extracted backend build dir `llama.cpp-<tag>-<id>/`
 *  with a server binary — a real, complete install. */
function seedBuild(root: string, tag: string, id: string): string {
  const dir = join(root, `llama.cpp-${tag}-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverBin), '')
  writeFileSync(join(dir, '.turbollm-provisioned'), '{}')
  return dir
}

/** Create a PARTIAL build dir — has the server binary but no completion marker, e.g. a
 *  multi-asset backend (CUDA) whose second asset (cudart) was never fetched. Regression
 *  fixture for the real bug this covers: such a dir used to be reported as "installed"
 *  and the CUDA backend would silently fall back to CPU. */
function seedPartialBuild(root: string, tag: string, id: string): string {
  const dir = join(root, `llama.cpp-${tag}-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverBin), '')
  return dir
}

/** Create a build dir that's actually complete but predates the completion marker
 *  (installed by an older TurboLLM version) — server binary + cudart DLL for CUDA,
 *  server binary alone for anything else, no marker file. */
function seedLegacyBuild(root: string, tag: string, id: string): string {
  const dir = join(root, `llama.cpp-${tag}-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverBin), '')
  if (id === 'cuda') writeFileSync(join(dir, 'cudart64_13.dll'), '')
  return dir
}

test('installedBackendBuild is tag-agnostic — finds a build de-pinned off LLAMA_BUILD', () => {
  const root = tmpRoot()
  // Only a b9754 build exists (no pinned b9608) — the old pinned check would miss it.
  seedBuild(root, 'b9754', 'cuda')
  const found = installedBackendBuild(root, 'cuda')
  assert.ok(found, 'should find the de-pinned build')
  assert.equal(found!.tag, 'b9754')
  assert.ok(found!.bin.endsWith(serverBin))
})

test('installedBackendBuild picks the NEWEST build when several are present', () => {
  const root = tmpRoot()
  seedBuild(root, 'b9744', 'cuda')
  seedBuild(root, 'b9754', 'cuda')
  seedBuild(root, 'b9700', 'cuda')
  assert.equal(installedBackendBuild(root, 'cuda')!.tag, 'b9754')
})

test('installedBackendBuild does not cross backends', () => {
  const root = tmpRoot()
  seedBuild(root, 'b9754', 'cuda')
  assert.equal(installedBackendBuild(root, 'rocm'), null)
  assert.equal(installedBackendBuild(root, 'cuda')!.tag, 'b9754')
})

test('installedBackendBuild ignores a build dir with no server binary', () => {
  const root = tmpRoot()
  mkdirSync(join(root, 'llama.cpp-b9754-cuda'), { recursive: true }) // empty, no binary
  assert.equal(installedBackendBuild(root, 'cuda'), null)
})

// Regression: a CUDA build with the server binary present but its cudart runtime asset
// never extracted (no completion marker) used to be reported as a working install — the
// CUDA backend then silently falls back to CPU (ggml-cuda.dll can't find cudart64_*/
// cublas64_*/cublasLt64_* at runtime, with no error logged).
test('installedBackendBuild ignores a build dir with a binary but no completion marker (partial multi-asset install)', () => {
  const root = tmpRoot()
  seedPartialBuild(root, 'b9754', 'cuda')
  assert.equal(installedBackendBuild(root, 'cuda'), null)
})

test('installedBackendBuild prefers a fully-provisioned older build over a partial newer one', () => {
  const root = tmpRoot()
  seedBuild(root, 'b9700', 'cuda')
  seedPartialBuild(root, 'b9754', 'cuda') // newer tag, but incomplete
  assert.equal(installedBackendBuild(root, 'cuda')!.tag, 'b9700')
})

// Backward compat: a build installed by a TurboLLM version older than the completion
// marker has no marker file even though it's genuinely complete — must not be treated
// as broken (that would force every existing user to re-download their working engines).
test('installedBackendBuild recognizes a legacy (pre-marker) CUDA build that actually has the cudart DLLs', () => {
  const root = tmpRoot()
  const dir = seedLegacyBuild(root, 'b9608', 'cuda')
  const found = installedBackendBuild(root, 'cuda')
  assert.ok(found, 'a genuinely-complete legacy build must still be recognized')
  assert.equal(found!.tag, 'b9608')
  assert.ok(existsSync(join(dir, '.turbollm-provisioned')), 'the marker is backfilled so this only needs deriving once')
})

test('installedBackendBuild does NOT backfill a legacy CUDA build that is missing the cudart DLLs', () => {
  const root = tmpRoot()
  seedPartialBuild(root, 'b9736', 'cuda') // binary only — the exact real-world broken case
  assert.equal(installedBackendBuild(root, 'cuda'), null)
})

test('installedBackendBuild recognizes a legacy non-CUDA build with no marker (single-asset backends never needed one)', () => {
  const root = tmpRoot()
  seedLegacyBuild(root, 'b9754', 'rocm')
  const found = installedBackendBuild(root, 'rocm')
  assert.ok(found, 'a single-asset backend is complete as soon as its one binary exists')
  assert.equal(found!.tag, 'b9754')
})

test('installedBackendBuild returns null for a missing engines root', () => {
  assert.equal(installedBackendBuild(join(tmpdir(), 'tllm-does-not-exist-xyz'), 'cuda'), null)
})

test('deleteAllBackendBuilds removes every build of a backend, leaving others intact', () => {
  const root = tmpRoot()
  seedBuild(root, 'b9744', 'cuda')
  seedBuild(root, 'b9754', 'cuda')
  seedBuild(root, 'b9754', 'rocm')
  const removed = deleteAllBackendBuilds(root, 'cuda')
  assert.equal(removed, 2)
  assert.ok(!existsSync(join(root, 'llama.cpp-b9744-cuda')))
  assert.ok(!existsSync(join(root, 'llama.cpp-b9754-cuda')))
  assert.ok(existsSync(join(root, 'llama.cpp-b9754-rocm')), 'rocm build is untouched')
  assert.deepEqual(readdirSync(root), ['llama.cpp-b9754-rocm'])
})
