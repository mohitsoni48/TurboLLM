// Route-level coverage for the route half of "keep the working build when a rebuild fails", in the
// async body of POST /api/v1/build/run:
//  - A rebuild that fails, before runBuild parked the previous build (a missing prerequisite) or
//    after it (a compile error), leaves the registered engine's binary where it was. The route's
//    catch used to rmSync the build directory, which threw away the build runBuild had just put back.
//  - A successful rebuild re-registers the engine and deletes the build it replaced, which runBuild
//    left parked beside the build directory. Without that delete every successful rebuild left a
//    multi-GB `.prev` tree behind until the next build of that directory.
//  - A rebuild that compiles but whose binary fails its probe puts the parked build and its
//    registration back. The route used to unregister the engine, fail the probe, then delete the
//    parked build, leaving neither the working build nor its engine.
// runBuild's own park-and-restore is unit-tested in engines/build-runner.test.ts. Here git, cmake,
// nvcc and g++ are shell-script stand-ins on build.toolchainDirs (ahead of PATH), so the whole
// clone → configure → compile → register flow runs with no network and no compiler. POSIX only.
import assert from 'node:assert/strict'
import fs, { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type Engine } from '../config/config'
import { BUILD_INCOMPLETE_MARKER, buildDirName, restoreInterruptedBuilds } from '../engines/build-runner'
import { BuildState } from '../engines/build-state'
import { Registry } from '../engines/registry'
import type { Deps } from '../deps'
import { registerApi } from './routes'
import { tmpDir } from '../test-support/tmp'

const posixOnly = process.platform === 'win32' && 'uses shell-script stand-ins for git, cmake and the built server'
// Never contacted (git is a stand-in), and nothing listens on port 9 should the real git ever run.
const REPO_URL = 'https://127.0.0.1:9/owner/fork.git'
const PREVIOUS_BUILD = '#!/bin/sh\necho "version: 100 (0123abc)"\n'

/** What the stand-in toolchain does: no cmake at all, a compile that fails, a build that works, or one whose
 *  llama-server does not run here (it fails the probe, as a CUDA build on a box without the driver does) — with the
 *  parked previous build gone too, for a put-back that cannot happen. */
type Toolchain = 'no-cmake' | 'compile-error' | 'builds' | 'builds-broken' | 'builds-broken-unparked' | 'cut-short'

/** `cmake --build`'s stand-in for a llama-server that cannot start here. */
const BROKEN_SERVER = String.raw`mkdir -p "$2/bin" && printf '#!/bin/sh\necho "libcuda.so.1: cannot open shared object file" >&2\nexit 127\n' > "$2/bin/llama-server" && chmod 755 "$2/bin/llama-server"`

function script(dir: string, name: string, lines: string[]): void {
  writeFileSync(join(dir, name), ['#!/bin/sh', ...lines, ''].join('\n'))
  chmodSync(join(dir, name), 0o755)
}

/** `git clone` writes a CMakeLists.txt, configure does nothing, and `cmake --build` writes a llama-server that reports
 *  version 200 — or prints a compiler error and fails, like an upstream tip that no longer compiles. 'cut-short': the
 *  link has written part of a llama-server when the daemon dies; what the daemon leaves on disk then is copied to
 *  `<dir>/snapshot/build` (as the engines folder's build/), and the compile fails so the live build cleans up. */
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
      : toolchain === 'builds-broken'
        ? `  --build) ${BROKEN_SERVER} ;;`
        : toolchain === 'builds-broken-unparked'
          // $2 is <buildRoot>/build: the parked build is .<name>-<ms>.prev beside <buildRoot>.
          ? `  --build) ${BROKEN_SERVER} && rm -rf "$2"/../../.*.prev ;;`
          : toolchain === 'cut-short'
            ? `  --build) mkdir -p "$2/bin" "${join(dir, 'snapshot')}" && printf '#!/bin/sh\\necho "vers' > "$2/bin/llama-server" && cp -a "$2/../.." "${join(dir, 'snapshot', 'build')}" && exit 1 ;;`
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
  return { dir, app, store, registry, build, binPath, rebuild, leftBeside }
}

/** Retries `check` until it passes, for up to 5 s: the build a rebuild replaced is deleted in the background. */
async function eventually(check: () => void): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      return check()
    } catch (e) {
      if (Date.now() > deadline) throw e
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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
  await eventually(() => assert.deepEqual(h.leftBeside(), [], 'the parked previous build is deleted'))
})

// Boot recovery took any llama-server in the build directory for a finished build: one a daemon exit cut short while
// the link was writing it (or that a compile outliving the daemon wrote later) stayed, and the parked previous build
// was never put back. Only a build whose binary passed its probe counts now.
test('POST /build/run: a rebuild cut short while its binary was being written gets the previous build back at boot', { skip: posixOnly }, async () => {
  const h = harness('cut-short')
  assert.equal(await h.rebuild(), 'fail')
  assert.equal(readFileSync(h.binPath, 'utf8'), PREVIOUS_BUILD, 'the failed build put the previous one back')
  // What the daemon's death mid-link left: a partial llama-server in the build directory, the previous build parked.
  const snapshot = join(h.dir, 'snapshot')
  const bin = join(snapshot, relative(join(h.store.dir(), 'engines'), h.binPath))
  assert.equal(readFileSync(bin, 'utf8'), '#!/bin/sh\necho "vers')
  restoreInterruptedBuilds(snapshot, [bin], () => {})
  assert.equal(readFileSync(bin, 'utf8'), PREVIOUS_BUILD, 'boot put the previous build back')
})

// The other side: a build that registered is finished, so boot leaves it even with a parked build beside it (its
// background delete failed).
test('POST /build/run: a rebuild that registered is kept at boot over a parked build left beside it', { skip: posixOnly }, async () => {
  const h = harness('builds')
  assert.equal(await h.rebuild(), 'ok')
  await eventually(() => assert.deepEqual(h.leftBeside(), []))
  const buildRoot = dirname(dirname(dirname(h.binPath)))
  const parked = join(dirname(buildRoot), `.${basename(buildRoot)}-1700000000000.prev`, 'build', 'bin')
  mkdirSync(parked, { recursive: true })
  writeFileSync(join(parked, 'llama-server'), PREVIOUS_BUILD)
  restoreInterruptedBuilds(join(h.store.dir(), 'engines'), [h.binPath], () => {})
  assert.match(readFileSync(h.binPath, 'utf8'), /version: 200/, 'the registered build stays')
})

// A build whose own registration failed stays marked unfinished. Enabling it later (POST /engines, which probes it)
// makes it the engine's working build: left marked, a later rebuild the daemon cut short could not put it back.
test('POST /engines: enabling a build left marked unfinished marks it finished', { skip: posixOnly }, async () => {
  const h = harness('builds')
  const add = (name: string, binPath: string) => h.app.request('/api/v1/engines', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, binPath }),
  })
  const tree = (root: string) => {
    const bin = join(root, 'build', 'bin', 'llama-server')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, PREVIOUS_BUILD)
    chmodSync(bin, 0o755)
    writeFileSync(join(root, BUILD_INCOMPLETE_MARKER), '')
    return bin
  }
  const root = join(h.store.dir(), 'engines', 'build', 'owner-other-main')
  const bin = tree(root)
  // A build of the same name under another data dir is not this one: its Add leaves this tree marked.
  const elsewhere = tree(join(h.dir, 'other-data', 'engines', 'build', 'owner-other-main'))
  assert.equal((await add('Elsewhere', elsewhere)).status, 201)
  assert.equal(fs.existsSync(join(root, BUILD_INCOMPLETE_MARKER)), true)
  assert.equal((await add('Other', bin)).status, 201)
  assert.equal(fs.existsSync(join(root, BUILD_INCOMPLETE_MARKER)), false)
})

// The new build compiled, so runBuild handed back the parked previous build for the route to delete. The route then
// unregistered the engine to register the new binary under its name, the probe failed, and the finally deleted the
// parked build: the user had neither the working build nor its engine, only a binary that does not run.
test('POST /build/run: a rebuild whose new binary fails its probe puts the previous build and its engine back', { skip: posixOnly }, async () => {
  const h = harness('builds-broken')
  h.registry.setUpdatePolicy('fork', 'off')
  h.store.update((c) => {
    c.engines.push({ id: 'other', name: 'Other', binPath: '/opt/other/llama-server', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' })
  })
  assert.equal(await h.rebuild(), 'fail')
  assert.match(h.build.get().error ?? '', /couldn't register the engine, so the previous build was kept: Could not run the binary/)
  assert.equal(readFileSync(h.binPath, 'utf8'), PREVIOUS_BUILD, 'the previous build is back where the engine runs it from')
  const eng = h.registry.active()
  assert.equal(eng?.id, 'fork', 'the same registration is back, and still active')
  assert.equal(eng?.version, '100 (0123abc)')
  assert.equal(eng?.updatePolicy, 'off')
  assert.deepEqual(h.registry.list().engines.map((e) => e.id), ['fork', 'other'], 'back at its place in the list')
  await eventually(() => assert.deepEqual(h.leftBeside(), [], 'the new build is removed and nothing is left parked'))
})

// When the parked build cannot be moved back the log says where it is, and the failure must not claim it was kept.
// The registration still goes back: the next start's restoreInterruptedBuilds puts a registered engine's parked build
// back when its directory has no binary.
test('POST /build/run: a failed registration whose previous build cannot be put back does not report it as kept', { skip: posixOnly }, async () => {
  const h = harness('builds-broken-unparked')
  assert.equal(await h.rebuild(), 'fail')
  const error = h.build.get().error ?? ''
  assert.doesNotMatch(error, /previous build was kept/)
  assert.match(error, /couldn't register the engine \(the previous build could not be moved back: the log says where it is kept\): Could not run the binary/)
  assert.ok(h.build.get().log.some((l) => l.startsWith('Could not put the previous build back')), 'the log says where it is')
  assert.equal(h.registry.active()?.id, 'fork', 'the registration is back')
})

// The user switched engines while the new binary was being probed: putting the old registration back made it active
// again over that switch.
test('POST /build/run: a failed rebuild puts the engine back without undoing a switch made during the probe', { skip: posixOnly }, async () => {
  const h = harness('builds-broken')
  h.store.update((c) => {
    for (const id of ['other', 'third']) {
      c.engines.push({ id, name: id, binPath: `/opt/${id}/llama-server`, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' })
    }
  })
  const add = h.registry.add.bind(h.registry)
  h.registry.add = async (...args: Parameters<Registry['add']>) => {
    h.registry.activate('third') // remove() made 'other' active in the old engine's place: the user picks 'third'
    return add(...args)
  }
  assert.equal(await h.rebuild(), 'fail')
  assert.match(h.build.get().error ?? '', /so the previous build was kept/)
  assert.ok(h.registry.get('fork'), 'the registration is back')
  assert.equal(h.registry.active()?.id, 'third', "the user's switch stands")
})

// The engine's build directory was deleted by hand, so the rebuild had nothing to park: the old registration would
// have come back pointing at the new binary that does not run, under the old version, with the failure claiming the
// previous build was kept.
test('POST /build/run: a failed rebuild of a deleted build directory does not put its engine back', { skip: posixOnly }, async () => {
  const h = harness('builds-broken')
  fs.rmSync(dirname(dirname(dirname(h.binPath))), { recursive: true, force: true })
  assert.equal(await h.rebuild(), 'fail')
  const error = h.build.get().error ?? ''
  assert.doesNotMatch(error, /previous build/)
  assert.match(error, /couldn't register the engine: Could not run the binary/)
  assert.equal(h.registry.get('fork'), undefined, 'no registration for a build that is gone')
})

// The route deleted the parked build with a recursive rmSync, on the daemon's only thread: for a multi-GB CUDA build
// (seconds with Windows Defender scanning) every request, /status poll and token stream stalled until it ended.
// syncBuiltinESMExports carries the spies to the modules that import rm and rmSync by name.
test('POST /build/run: a successful rebuild deletes the build it replaced off the event loop', { skip: posixOnly }, async (t) => {
  const h = harness('builds')
  const deletedAsync = t.mock.method(fsp, 'rm')
  const deletedSync = t.mock.method(fs, 'rmSync')
  syncBuiltinESMExports()
  try {
    assert.equal(await h.rebuild(), 'ok')
  } finally {
    deletedAsync.mock.restore()
    deletedSync.mock.restore()
    syncBuiltinESMExports()
  }
  const isParked = (c: { arguments: unknown[] }) => /\.prev$/.test(String(c.arguments[0]))
  const deletes = deletedAsync.mock.calls.filter(isParked)
  assert.equal(deletes.length, 1, 'the parked build is deleted with fs/promises rm')
  assert.ok((deletes[0].arguments[1] as fs.RmOptions | undefined)?.maxRetries, 'the delete retries, as a Windows lock is brief')
  assert.equal(deletedSync.mock.calls.filter(isParked).length, 0, 'and not with rmSync')
  await deletes[0].result
  assert.deepEqual(h.leftBeside(), [])
})
