// rust-core plan T9 (arch 2.3, 5.3, P-3, P-4). Every binary here is a fake handed in through
// resolveCore's LoaderIo, except in the one test that loads the real dev build (plan T10).
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock, type TestContext, test } from 'node:test'
import { tmpDir } from '../test-support/tmp'
import {
  type CoreBinding,
  CoreLoadError,
  installedPackageVersion,
  type LoaderIo,
  loadCore,
  nativeTarget,
  resolveCore,
  SUPPORTED_SYSTEMS,
  SUPPORTED_TARGETS,
} from './load'

interface NpmTarget {
  suffix: string
  os: NodeJS.Platform
  cpu: string
  libc: 'glibc' | 'musl' | null
}

interface TargetTable {
  NPM_TARGETS: ReadonlyArray<NpmTarget>
  hostTarget(): NpmTarget | undefined
}

async function targetTable(): Promise<TargetTable> {
  const tableUrl = new URL('../../core/scripts/targets.mjs', import.meta.url).href
  return (await import(tableUrl)) as TargetTable
}

const BUNDLE_DIR = join('/opt', 'turbollm', 'dist')
const OVERRIDE_PATH = join('/data', 'app', 'libturbollm_core_node.so')
const BUNDLED_PATH = join(BUNDLE_DIR, 'native', 'turbollm-core.linux-x64-gnu.node')
const SOURCE_PATH = join(BUNDLE_DIR, '..', '..', 'core', 'bindings', 'node', 'turbollm-core.linux-x64-gnu.node')
const PACKAGE_MAIN = join('/opt', 'node_modules', '@turbollm', 'core-linux-x64-gnu', 'turbollm-core.linux-x64-gnu.node')

interface FakeSystem {
  io: LoaderIo
  opened: string[]
  warnings: string[]
}

function fakeCore(version: string): CoreBinding {
  return {
    coreInfo: () => ({ version, gitSha: 'abc1234', target: 'linux-x64-gnu', napiLevel: 8 }),
    parseGguf: () => Promise.reject(new Error('a fake core parses nothing')),
    ggufCutShort: () => Promise.resolve(false),
    quantFromName: () => null,
  }
}

function fakeSystem(overrides: Partial<LoaderIo> & { loadable?: Record<string, string> } = {}): FakeSystem {
  const opened: string[] = []
  const warnings: string[] = []
  const { loadable = {}, ...ioOverrides } = overrides
  const io: LoaderIo = {
    env: {},
    platform: 'linux',
    arch: 'x64',
    libc: 'gnu',
    nodeVersion: '22.13.0',
    packageVersion: '1.20.0',
    sourceMode: false,
    bundleDir: BUNDLE_DIR,
    exists: (path) => path in loadable,
    dlopen: (path) => {
      opened.push(path)
      const version = loadable[path]
      if (version === undefined) throw new Error(`cannot open shared object file: ${path}`)
      return fakeCore(version)
    },
    resolvePackage: (name) => {
      if (PACKAGE_MAIN in loadable && name === '@turbollm/core-linux-x64-gnu') return PACKAGE_MAIN
      throw new Error(`Cannot find module '${name}'`)
    },
    warn: (message) => warnings.push(message),
    ...ioOverrides,
  }
  return { io, opened, warnings }
}

function loadFailure(io: LoaderIo): CoreLoadError {
  try {
    resolveCore(io)
  } catch (error) {
    assert.ok(error instanceof CoreLoadError, `expected CoreLoadError, got ${String(error)}`)
    return error
  }
  assert.fail('resolveCore loaded a core where none should load')
}

test('nativeTarget maps every supported platform and arch', () => {
  assert.equal(nativeTarget('win32', 'x64', null), 'win32-x64-msvc')
  assert.equal(nativeTarget('win32', 'arm64', null), 'win32-arm64-msvc')
  assert.equal(nativeTarget('darwin', 'x64', null), 'darwin-x64')
  assert.equal(nativeTarget('darwin', 'arm64', null), 'darwin-arm64')
  assert.equal(nativeTarget('linux', 'x64', 'gnu'), 'linux-x64-gnu')
  assert.equal(nativeTarget('linux', 'arm64', 'gnu'), 'linux-arm64-gnu')
  assert.equal(nativeTarget('linux', 'x64', 'musl'), 'linux-x64-musl')
  assert.equal(nativeTarget('linux', 'arm64', 'musl'), 'linux-arm64-musl')
  assert.equal(nativeTarget('android', 'arm64', null), 'android-arm64')
})

test('nativeTarget returns null for systems the core does not ship for', () => {
  assert.equal(nativeTarget('linux', 'arm', 'gnu'), null)
  assert.equal(nativeTarget('win32', 'ia32', null), null)
  assert.equal(nativeTarget('freebsd', 'x64', null), null)
  assert.equal(nativeTarget('linux', 'ppc64', 'gnu'), null)
  assert.equal(nativeTarget('android', 'x64', null), null)
})

test('nativeTarget with no arguments describes this machine', async () => {
  const { hostTarget } = await targetTable()
  assert.equal(nativeTarget(), hostTarget()?.suffix ?? null)
})

test('SUPPORTED_TARGETS equals the suffixes in core/scripts/targets.mjs', async () => {
  const { NPM_TARGETS } = await targetTable()
  assert.deepEqual([...SUPPORTED_TARGETS], NPM_TARGETS.map((target) => target.suffix))
})

test('nativeTarget selects every target in core/scripts/targets.mjs on its own system', async () => {
  const { NPM_TARGETS } = await targetTable()
  for (const target of NPM_TARGETS) {
    const libc = target.libc === null ? null : target.libc === 'glibc' ? 'gnu' : 'musl'
    assert.equal(nativeTarget(target.os, target.cpu, libc), target.suffix)
  }
})

const SYSTEM_NAMES: Readonly<Record<string, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  android: 'Android',
}

test('SUPPORTED_SYSTEMS names the system, arch and libc of every supported target', async () => {
  const { NPM_TARGETS } = await targetTable()
  for (const target of NPM_TARGETS) {
    const clause = clauseFor(SYSTEM_NAMES[target.os]!)
    assert.ok(clause.includes(target.cpu), `${target.suffix}: "${clause}" does not name ${target.cpu}`)
    if (target.libc !== null) assert.ok(clause.includes(target.libc), `${target.suffix}: "${clause}" lacks ${target.libc}`)
  }
})

/** The part of SUPPORTED_SYSTEMS from one system's name up to the next system's name. */
function clauseFor(systemName: string): string {
  const start = SUPPORTED_SYSTEMS.indexOf(`${systemName} `)
  assert.ok(start >= 0, `SUPPORTED_SYSTEMS does not name ${systemName}`)
  const nextStarts = Object.values(SYSTEM_NAMES)
    .map((name) => SUPPORTED_SYSTEMS.indexOf(`${name} `, start + 1))
    .filter((index) => index > start)
  return SUPPORTED_SYSTEMS.slice(start, Math.min(SUPPORTED_SYSTEMS.length, ...nextStarts))
}

test('the version comes from the nearest manifest with one, skipping the nameless dist/package.json', () => {
  const root = installTree({ type: 'module', version: '1.15.1' })
  assert.equal(installedPackageVersion(join(root, 'dist')), '1.15.1')
})

test('the version comes from the turbollm manifest above dist/', () => {
  const root = installTree({ name: 'turbollm', version: '1.15.1', type: 'module' })
  assert.equal(installedPackageVersion(join(root, 'dist')), '1.15.1')
})

test('no versioned manifest above the bundle is a core_unavailable CoreLoadError', () => {
  const bundleDir = join(tmpDir('load-noversion-'), 'dist')
  mkdirSync(bundleDir)
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ type: 'module' }))
  assertUnavailable(() => installedPackageVersion(bundleDir))
})

test('an unreadable manifest above the bundle is a core_unavailable CoreLoadError', () => {
  const root = installTree({ version: '1.15.1' })
  writeFileSync(join(root, 'package.json'), '{ "version": ')
  assertUnavailable(() => installedPackageVersion(join(root, 'dist')))
})

/** <root>/package.json = rootManifest, <root>/dist/package.json = {"type":"module"}, as the build and the
 *  Android app's staging both lay it out. */
function installTree(rootManifest: Record<string, string>): string {
  const root = tmpDir('load-install-')
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'package.json'), JSON.stringify(rootManifest))
  writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'module' }))
  return root
}

function assertUnavailable(lookup: () => string): void {
  assert.throws(lookup, (error: unknown) => error instanceof CoreLoadError && error.code === 'core_unavailable')
}

test('a failing TURBOLLM_CORE_PATH stops the search with one attempt', () => {
  const system = fakeSystem({
    env: { TURBOLLM_CORE_PATH: OVERRIDE_PATH },
    loadable: { [BUNDLED_PATH]: '1.20.0' },
  })
  const error = loadFailure(system.io)
  assert.equal(error.code, 'core_unavailable')
  assert.equal(error.attempts.length, 1)
  assert.match(error.attempts[0]!.source, /TURBOLLM_CORE_PATH/)
  assert.deepEqual(system.opened, [OVERRIDE_PATH])
})

test('a working TURBOLLM_CORE_PATH wins over every other source', () => {
  const system = fakeSystem({
    env: { TURBOLLM_CORE_PATH: OVERRIDE_PATH },
    loadable: { [OVERRIDE_PATH]: '1.20.0', [BUNDLED_PATH]: '1.20.0' },
  })
  assert.equal(resolveCore(system.io).coreInfo().version, '1.20.0')
  assert.deepEqual(system.opened, [OVERRIDE_PATH])
})

test('the bundled binary beside dist is tried first', () => {
  const system = fakeSystem({ loadable: { [BUNDLED_PATH]: '1.20.0', [PACKAGE_MAIN]: '1.20.0' } })
  resolveCore(system.io)
  assert.deepEqual(system.opened, [BUNDLED_PATH])
})

test('the platform package is opened by its resolved main file when nothing is bundled', () => {
  const system = fakeSystem({ loadable: { [PACKAGE_MAIN]: '1.20.0' } })
  resolveCore(system.io)
  assert.deepEqual(system.opened, [PACKAGE_MAIN])
})

test('source mode falls through bundle and package to the source build', () => {
  const system = fakeSystem({ sourceMode: true, loadable: { [SOURCE_PATH]: '1.20.0' } })
  resolveCore(system.io)
  assert.deepEqual(system.opened, [SOURCE_PATH])
})

test('every failed source is recorded in search order', () => {
  const error = loadFailure(fakeSystem({ sourceMode: true }).io)
  assert.deepEqual(
    error.attempts.map((attempt) => attempt.source),
    [`bundled ${BUNDLED_PATH}`, 'package @turbollm/core-linux-x64-gnu', `source build ${SOURCE_PATH}`],
  )
})

test('the source build is never tried from a built bundle', () => {
  const system = fakeSystem({ loadable: { [SOURCE_PATH]: '1.20.0' } })
  const error = loadFailure(system.io)
  assert.equal(error.attempts.length, 2)
  assert.deepEqual(system.opened, [])
})

test('a supported system with nothing installed gets the exact contract text', () => {
  const error = loadFailure(fakeSystem().io)
  assert.equal(error.code, 'core_unavailable')
  assert.equal(
    error.message,
    [
      "TurboLLM's native core is not available for this system (linux-x64-gnu, Node 22.13.0).",
      `It ships for: ${SUPPORTED_SYSTEMS}.`,
      '- If your system is in that list, the platform package was not installed. Reinstall with',
      '  `npm install -g turbollm` and without --omit=optional or --no-optional.',
      '- Otherwise, please open an issue at https://github.com/mohitsoni48/TurboLLM/issues and include this message.',
      'Tried:',
      `  bundled ${BUNDLED_PATH}: not found`,
      "  package @turbollm/core-linux-x64-gnu: Cannot find module '@turbollm/core-linux-x64-gnu'",
    ].join('\n'),
  )
})

test('an unsupported system gets the exact contract text naming its platform', () => {
  const error = loadFailure(fakeSystem({ arch: 'arm' }).io)
  assert.equal(error.code, 'core_unavailable')
  assert.equal(
    error.message,
    [
      "TurboLLM's native core is not available for this system (linux-arm-gnu, Node 22.13.0).",
      `It ships for: ${SUPPORTED_SYSTEMS}.`,
      '- If your system is in that list, the platform package was not installed. Reinstall with',
      '  `npm install -g turbollm` and without --omit=optional or --no-optional.',
      '- Otherwise, please open an issue at https://github.com/mohitsoni48/TurboLLM/issues and include this message.',
      'Tried:',
      '  native target: no TurboLLM native core is built for linux-arm-gnu',
    ].join('\n'),
  )
})

test('the system label leaves out libc off Linux', () => {
  const error = loadFailure(fakeSystem({ platform: 'freebsd', libc: null }).io)
  assert.match(error.message, /\(freebsd-x64, Node 22\.13\.0\)/)
})

test('TURBOLLM_CORE_PATH still loads on a system with no native target', () => {
  const system = fakeSystem({
    arch: 'arm',
    env: { TURBOLLM_CORE_PATH: OVERRIDE_PATH },
    loadable: { [OVERRIDE_PATH]: '1.20.0' },
  })
  assert.equal(resolveCore(system.io).coreInfo().version, '1.20.0')
})

test('a built bundle refuses a core of another version', () => {
  const system = fakeSystem({ loadable: { [BUNDLED_PATH]: '1.19.0', [PACKAGE_MAIN]: '1.20.0' } })
  const error = loadFailure(system.io)
  assert.equal(error.code, 'core_version_mismatch')
  assert.match(error.message, /1\.19\.0/)
  assert.match(error.message, /1\.20\.0/)
  assert.deepEqual(error.attempts, [{ source: `bundled ${BUNDLED_PATH}`, error: 'version 1.19.0, expected 1.20.0' }])
})

test('source mode loads a core of another version and warns to rebuild it', () => {
  const system = fakeSystem({ sourceMode: true, loadable: { [SOURCE_PATH]: '1.19.0' } })
  assert.equal(resolveCore(system.io).coreInfo().version, '1.19.0')
  assert.equal(system.warnings.length, 1)
  assert.match(system.warnings[0]!, /npm run build:core/)
})

test('a matching core loads without a warning', () => {
  const system = fakeSystem({ sourceMode: true, loadable: { [SOURCE_PATH]: '1.20.0' } })
  resolveCore(system.io)
  assert.deepEqual(system.warnings, [])
})

test('loads the dev build in source mode and reports the package version', (context) => {
  overrideCorePath(context, undefined)

  const info = loadCore().coreInfo()

  assert.equal(info.version, turbollmPackageVersion())
  assert.equal(info.target, nativeTarget())
  assert.equal(info.napiLevel, 8)
  assert.match(info.gitSha, /^(unknown|[0-9a-f]{7,})$/)
})

test('loadCore opens the native core once and reuses it', async (context) => {
  overrideCorePath(context, OVERRIDE_PATH)
  const dlopen = mock.method(process, 'dlopen', (module: { exports: unknown }) => {
    module.exports = fakeCore(turbollmPackageVersion())
  })
  context.after(() => dlopen.mock.restore())
  const { loadCore: freshLoadCore } = await freshLoaderModule()

  const first = freshLoadCore()
  const second = freshLoadCore()

  assert.equal(second, first)
  assert.equal(dlopen.mock.callCount(), 1)
  assert.equal(dlopen.mock.calls[0]!.arguments[1], OVERRIDE_PATH)
})

function turbollmPackageVersion(): string {
  const manifest = readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')
  return (JSON.parse(manifest) as { version: string }).version
}

function overrideCorePath(context: TestContext, value: string | undefined): void {
  const previous = process.env.TURBOLLM_CORE_PATH
  setCorePath(value)
  context.after(() => setCorePath(previous))
}

function setCorePath(value: string | undefined): void {
  if (value === undefined) delete process.env.TURBOLLM_CORE_PATH
  else process.env.TURBOLLM_CORE_PATH = value
}

/** A second instance of load.ts, so a memoised fake never leaks into the real-load test (or back). */
async function freshLoaderModule(): Promise<typeof import('./load')> {
  const specifier = './load.ts?fresh'
  return (await import(specifier)) as typeof import('./load')
}
