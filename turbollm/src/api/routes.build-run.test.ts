// Route-level coverage for the route half of "keep the working build when a rebuild fails", in the
// async body of POST /api/v1/build/run:
//  - A rebuild that fails, before runBuild parked the previous build (a missing prerequisite) or
//    after it (a compile error), leaves the registered engine's binary where it was. The route's
//    catch used to rmSync the build directory, which threw away the build runBuild had just put back.
//  - A successful rebuild re-registers the engine and deletes the build it replaced, which runBuild
//    left parked beside the build directory. Without that delete every successful rebuild left a
//    multi-GB `.prev` tree behind until the next build of that directory.
// runBuild's own park-and-restore is unit-tested in engines/build-runner.test.ts. Here git, cmake,
// nvcc and g++ are shell-script stand-ins on build.toolchainDirs (ahead of PATH), so the whole
// clone → configure → compile → register flow runs with no network and no compiler. POSIX only.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type Engine } from '../config/config'
import { buildDirName } from '../engines/build-runner'
import { BuildState } from '../engines/build-state'
import { Registry } from '../engines/registry'
import type { Deps } from '../deps'
import { registerApi } from './routes'
import { tmpDir } from '../test-support/tmp'

const posixOnly = process.platform === 'win32' && 'uses shell-script stand-ins for git, cmake and the built server'
// Never contacted (git is a stand-in), and nothing listens on port 9 should the real git ever run.
const REPO_URL = 'https://127.0.0.1:9/owner/fork.git'
const PREVIOUS_BUILD = '#!/bin/sh\necho "version: 100 (0123abc)"\n'

/** What the stand-in toolchain does: no cmake at all, a compile that fails, or a build that works. */
type Toolchain = 'no-cmake' | 'compile-error' | 'builds'

function script(dir: string, name: string, lines: string[]): void {
  writeFileSync(join(dir, name), ['#!/bin/sh', ...lines, ''].join('\n'))
  chmodSync(join(dir, name), 0o755)
}

/** `git clone` writes a CMakeLists.txt, configure does nothing, and `cmake --build` writes a llama-server that reports
 *  version 200 — or prints a compiler error and fails, like an upstream tip that no longer compiles. */
function fakeToolchain(dir: string, toolchain: Toolchain): string {
  const bin = join(dir, 'fakebin')
  mkdirSync(bin)
  script(bin, 'git', [
    'case "$1" in',
    '  --version) echo "git version 2.43.0" ;;',
    '  clone) for dest; do :; done; mkdir -p "$dest" && echo "project(fork)" > "$dest/CMakeLists.txt" ;;',
    '  -C) echo 0123456789abcdef0123456789abcdef01234567 ;;',
    '  *) exit 2 ;;',
    'esac',
  ])
  script(bin, 'cmake', [
    'case "$1" in',
    toolchain === 'no-cmake' ? '  --version) exit 127 ;;' : '  --version) echo "cmake version 3.28.3" ;;',
    toolchain === 'compile-error'
      ? '  --build) echo "ggml.c:1:1: error: unknown type name ggml_fork_t" >&2; exit 1 ;;'
      : String.raw`  --build) mkdir -p "$2/bin" && printf '#!/bin/sh\necho "version: 200 (4567def)"\n' > "$2/bin/llama-server" && chmod 755 "$2/bin/llama-server" ;;`,
    'esac',
  ])
  script(bin, 'nvcc', ['echo "Cuda compilation tools, release 12.6, V12.6.20"'])
  script(bin, 'g++', ['echo "g++ (GCC) 13.2.0"'])
  return bin
}

/** A registered, active source build of REPO_URL@main whose binary sits where a rebuild lands, and the route over a
 *  real BuildState. `rebuild` returns once the build has settled and the route's own cleanup after it has run. */
function harness(toolchain: Toolchain) {
  const dir = tmpDir('tllm-build-run-')
  const fakeBin = fakeToolchain(dir, toolchain)
  const store = ConfigStore.load(join(dir, 'config.json'))
  const buildRoot = join(store.dir(), 'engines', 'build', buildDirName(REPO_URL, 'main'))
  const binPath = join(buildRoot, 'build', 'bin', 'llama-server')
  mkdirSync(dirname(binPath), { recursive: true })
  writeFileSync(binPath, PREVIOUS_BUILD)
  chmodSync(binPath, 0o755)
  store.update((c) => {
    c.build.toolchainDirs = [fakeBin]
    const fork: Engine = {
      id: 'fork',
      name: 'Fork',
      binPath,
      kind: 'llama-server',
      version: '100 (0123abc)',
      capabilities: { kvTypes: [], flags: [] },
      addedAt: '',
      sourceRepo: REPO_URL,
      sourceBranch: 'main',
    }
    c.engines.push(fork)
    c.activeEngineId = 'fork'
  })
  const registry = new Registry(store)
  const build = new BuildState()
  const d = {
    version: 'test',
    store,
    registry,
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, stopAndWait: async () => {}, logPath: () => '' },
    provision: { get: () => ({ active: false }) },
    build,
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  const rebuild = async (): Promise<string> => {
    const settled = new Promise<string>((resolve) => { build.onSettled = resolve })
    const res = await app.request('/api/v1/build/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoUrl: REPO_URL, branch: 'main' }),
    })
    assert.equal(res.status, 202)
    const outcome = await settled
    await new Promise((resolve) => setImmediate(resolve)) // the route's finally runs right after the build settles
    return outcome
  }
  /** Everything beside the build directory: a parked `.prev` or moved-aside `.failed` tree. */
  const leftBeside = () => readdirSync(dirname(buildRoot)).filter((n) => n !== basename(buildRoot))
  return { registry, build, binPath, rebuild, leftBeside }
}

test('POST /build/run: a rebuild that fails on a missing prerequisite keeps the registered build', { skip: posixOnly }, async () => {
  const h = harness('no-cmake')
  assert.equal(await h.rebuild(), 'fail')
  assert.match(h.build.get().error ?? '', /Missing build prerequisite\(s\): CMake/)
  assert.equal(readFileSync(h.binPath, 'utf8'), PREVIOUS_BUILD, 'the registered engine still has its binary')
  assert.equal(h.registry.active()?.id, 'fork')
  assert.deepEqual(h.leftBeside(), [])
})

test('POST /build/run: a rebuild whose compile fails after the old build was parked puts it back', { skip: posixOnly }, async () => {
  const h = harness('compile-error')
  assert.equal(await h.rebuild(), 'fail')
  assert.ok(h.build.get().log.some((l) => l.includes('error: unknown type name ggml_fork_t')), 'the build got as far as the compile')
  assert.match(h.build.get().error ?? '', /cmake exited with code 1/)
  assert.equal(readFileSync(h.binPath, 'utf8'), PREVIOUS_BUILD, 'the registered engine still has its binary')
  assert.equal(h.registry.active()?.id, 'fork')
  assert.deepEqual(h.leftBeside(), [], 'nothing is left parked beside the build directory')
})

test('POST /build/run: a successful rebuild replaces the engine and deletes the build it replaced', { skip: posixOnly }, async () => {
  const h = harness('builds')
  assert.equal(await h.rebuild(), 'ok')
  const eng = h.registry.active()
  assert.equal(eng?.binPath, h.binPath)
  assert.equal(eng?.name, 'Fork')
  assert.equal(eng?.version, '200 (4567def)', 'the new build is registered')
  assert.equal(h.registry.list().engines.length, 1, 'it replaced the old registration')
  assert.deepEqual(h.leftBeside(), [], 'the parked previous build is deleted')
})
