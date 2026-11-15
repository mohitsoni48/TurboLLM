// Run from turbollm/: npx tsx --test core/scripts/publish.test.ts (rust-core plan T17, arch 2.8 / 5.5).
// npm is never run: every case injects a fake runner and records what would have been asked of it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../src/test-support/tmp'
import { injectOptionalDeps } from './inject-optional-deps.mjs'
import { publishPlatformPackages } from './publish-platform-packages.mjs'
import { NPM_TARGETS } from './targets.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(SCRIPTS_DIR, '..', 'bindings', 'node', 'npm')
const RELEASE = '1.15.1'

type NpmCall = { args: string[]; cwd: string }

/** A fake npm that records each call and answers `npm view` from the given published set. */
function fakeNpm(published: Set<string> = new Set()) {
  const calls: NpmCall[] = []
  const runNpm = (args: string[], cwd: string) => {
    calls.push({ args, cwd })
    if (args[0] !== 'view') return { status: 0, stdout: '' }
    const answered = published.has(args[1] ?? '')
    return answered ? { status: 0, stdout: `${RELEASE}\n` } : { status: 1, stdout: '' }
  }
  return { calls, runNpm }
}

function binaryName(suffix: string): string {
  return `turbollm-core.${suffix}.node`
}

/** An artifacts folder holding a fake binary per target, each carrying the given version marker. */
function artifacts(markerVersion: (suffix: string) => string | null): string {
  const dir = tmpDir('publish-artifacts-')
  for (const { suffix } of NPM_TARGETS) {
    const version = markerVersion(suffix)
    if (version === null) continue
    const bytes = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]),
      Buffer.from(`TURBOLLM_CORE_VERSION=${version}\0`),
      Buffer.from([9, 8, 7]),
    ])
    writeFileSync(join(dir, binaryName(suffix)), bytes)
  }
  return dir
}

function licenseFile(): string {
  const path = join(tmpDir('publish-license-'), 'LICENSE.md')
  writeFileSync(path, 'license text\n')
  return path
}

function publish(artifactsDir: string, npm: ReturnType<typeof fakeNpm>, dryRun = false) {
  const stagingDir = tmpDir('publish-staging-')
  const outcomes = publishPlatformPackages({
    version: RELEASE,
    artifactsDir,
    templatesDir: TEMPLATES_DIR,
    licenseFile: licenseFile(),
    stagingDir,
    dryRun,
    runNpm: npm.runNpm,
  })
  return { outcomes, stagingDir }
}

function publishCalls(calls: NpmCall[]): NpmCall[] {
  return calls.filter((call) => call.args[0] === 'publish')
}

test('a missing binary fails before anything is asked of npm', () => {
  const npm = fakeNpm()
  const dir = artifacts((suffix) => (suffix === 'linux-arm64-musl' ? null : RELEASE))

  assert.throws(() => publish(dir, npm), /turbollm-core\.linux-arm64-musl\.node.*not found/)
  assert.deepEqual(npm.calls, [])
})

test('a binary carrying another version fails before anything is asked of npm', () => {
  const npm = fakeNpm()
  const dir = artifacts((suffix) => (suffix === 'darwin-x64' ? '1.15.0' : RELEASE))

  assert.throws(() => publish(dir, npm), /turbollm-core\.darwin-x64\.node does not carry TURBOLLM_CORE_VERSION=1\.15\.1/)
  assert.deepEqual(npm.calls, [])
})

test('a version that only starts with the release version does not pass the check', () => {
  const npm = fakeNpm()
  const dir = artifacts((suffix) => (suffix === 'win32-x64-msvc' ? '1.15.10' : RELEASE))

  assert.throws(() => publish(dir, npm), /turbollm-core\.win32-x64-msvc\.node does not carry/)
  assert.deepEqual(npm.calls, [])
})

test('every one of the 9 platform packages is published in the target table order, with provenance', () => {
  const npm = fakeNpm()

  const { stagingDir } = publish(artifacts(() => RELEASE), npm)

  const publishes = publishCalls(npm.calls)
  assert.deepEqual(
    publishes.map((call) => call.cwd),
    NPM_TARGETS.map(({ suffix }) => join(stagingDir, suffix)),
  )
  for (const call of publishes) assert.deepEqual(call.args, ['publish', '--provenance', '--access', 'public'])
})

test('each staged package carries the release version, its binary and LICENSE.md', () => {
  const { stagingDir } = publish(artifacts(() => RELEASE), fakeNpm())

  for (const { suffix } of NPM_TARGETS) {
    const packageDir = join(stagingDir, suffix)
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    assert.equal(manifest.name, `@turbollm/core-${suffix}`)
    assert.equal(manifest.version, RELEASE)
    assert.deepEqual(readdirSync(packageDir).sort(), ['LICENSE.md', binaryName(suffix), 'package.json'].sort())
  }
})

test('publishing leaves the committed templates at version 0.0.0', () => {
  publish(artifacts(() => RELEASE), fakeNpm())

  for (const { suffix } of NPM_TARGETS) {
    const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, suffix, 'package.json'), 'utf8'))
    assert.equal(template.version, '0.0.0')
  }
})

test('a target already on the registry at the release version is skipped, so a re-run is idempotent', () => {
  const npm = fakeNpm(new Set([`@turbollm/core-darwin-arm64@${RELEASE}`]))

  const { outcomes, stagingDir } = publish(artifacts(() => RELEASE), npm)

  assert.equal(publishCalls(npm.calls).length, 8)
  assert.equal(publishCalls(npm.calls).some((call) => call.cwd === join(stagingDir, 'darwin-arm64')), false)
  assert.deepEqual(outcomes.find((outcome) => outcome.suffix === 'darwin-arm64'), {
    suffix: 'darwin-arm64',
    outcome: 'already published',
  })
})

test('the registry is asked for each exact package version before publishing it', () => {
  const npm = fakeNpm()

  publish(artifacts(() => RELEASE), npm)

  const views = npm.calls.filter((call) => call.args[0] === 'view')
  assert.deepEqual(
    views.map((call) => call.args),
    NPM_TARGETS.map(({ suffix }) => ['view', `@turbollm/core-${suffix}@${RELEASE}`, 'version']),
  )
})

test('a dry run publishes nothing and asks no registry, it only packs each staged package', () => {
  const npm = fakeNpm()

  const { outcomes } = publish(artifacts(() => RELEASE), npm, true)

  assert.deepEqual(npm.calls.map((call) => call.args[0]), NPM_TARGETS.map(() => 'pack'))
  for (const call of npm.calls) assert.deepEqual(call.args, ['pack', '--dry-run'])
  assert.ok(outcomes.every((outcome) => outcome.outcome === 'packed'))
})

test('the publish script without --version and --artifacts exits 2 with its usage', () => {
  const run = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'publish-platform-packages.mjs')], { encoding: 'utf8' })

  assert.equal(run.status, 2)
  assert.match(run.stderr, /usage: node core\/scripts\/publish-platform-packages\.mjs --version <v> --artifacts <dir>/)
})

function packageJsonWithNodePty(): string {
  const path = join(tmpDir('inject-'), 'package.json')
  const manifest = { name: 'turbollm', version: RELEASE, optionalDependencies: { 'node-pty': '^1.1.0' } }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

test('inject adds the 9 platform packages at exactly the release version and keeps node-pty', () => {
  const path = packageJsonWithNodePty()

  injectOptionalDeps(path, RELEASE)

  const expected: Record<string, string> = { 'node-pty': '^1.1.0' }
  for (const { suffix } of NPM_TARGETS) expected[`@turbollm/core-${suffix}`] = RELEASE
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).optionalDependencies, expected)
})

test('inject keeps the file in the repo format: 2-space indent and a final newline', () => {
  const path = packageJsonWithNodePty()

  injectOptionalDeps(path, RELEASE)

  const text = readFileSync(path, 'utf8')
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`)
})

test('inject refuses a version that is not a plain semver', () => {
  const path = packageJsonWithNodePty()
  const before = readFileSync(path, 'utf8')

  assert.throws(() => injectOptionalDeps(path, '^1.15.1'), /not a release version/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('the committed package.json never lists a platform package (they are injected in the publish job only)', () => {
  const manifest = JSON.parse(readFileSync(join(SCRIPTS_DIR, '..', '..', 'package.json'), 'utf8'))

  const names = Object.keys(manifest.optionalDependencies ?? {})
  assert.deepEqual(names.filter((name) => name.startsWith('@turbollm/core-')), [])
})

test('there is exactly one template per target in the table', () => {
  const dirs = readdirSync(TEMPLATES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())

  assert.deepEqual(dirs.map((entry) => entry.name).sort(), NPM_TARGETS.map(({ suffix }) => suffix).sort())
})

test('each template matches its target: name, os, cpu, libc, main, files and the arch 5.5 fields', () => {
  for (const { suffix, os, cpu, libc } of NPM_TARGETS) {
    const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, suffix, 'package.json'), 'utf8'))
    const expected: Record<string, unknown> = {
      name: `@turbollm/core-${suffix}`,
      version: '0.0.0',
      description: `TurboLLM native core for ${suffix}`,
      license: 'FSL-1.1-ALv2',
      repository: {
        type: 'git',
        url: 'git+https://github.com/mohitsoni48/TurboLLM.git',
        directory: `turbollm/core/bindings/node/npm/${suffix}`,
      },
      os: [os],
      cpu: [cpu],
      ...(libc === null ? {} : { libc: [libc] }),
      main: binaryName(suffix),
      files: [binaryName(suffix), 'LICENSE.md'],
      engines: { node: '>=18.20' },
    }
    assert.deepEqual(template, expected, suffix)
  }
})

test('the templates hold no binary or license, only the package.json', () => {
  for (const { suffix } of NPM_TARGETS) {
    assert.deepEqual(readdirSync(join(TEMPLATES_DIR, suffix)), ['package.json'], suffix)
  }
})
