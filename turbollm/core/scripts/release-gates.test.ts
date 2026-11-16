// Run from turbollm/: npx tsx --test core/scripts/release-gates.test.ts (rust-core plan T20, arch 2.8).
// The two checks npm-publish.yml runs around the `turbollm` publish: every platform package must be on the registry
// before it, and the installed package must load its platform binary after it. npm is never run here.
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../src/test-support/tmp'
import { awaitPlatformPackages } from './await-platform-packages.mjs'
import { binaryFileName, hostTarget, NPM_TARGETS, platformPackageName } from './targets.mjs'
import { verifyInstalledCore } from './verify-installed-core.mjs'

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = '1.15.1'
const HOST_BINARY = join(CORE_DIR, 'bindings', 'node', binaryFileName(hostTarget()?.suffix ?? 'none'))
const FIXTURE = join(CORE_DIR, 'fixtures', 'gguf', 'crafted', 'async-qwen3.gguf')
const GOLDEN = join(CORE_DIR, 'fixtures', 'gguf', 'golden', 'async-qwen3.json')

/** A fake registry: each package answers `npm view` with RELEASE from the given attempt on (1-based), or never. */
function fakeRegistry(visibleFromAttempt: (packageName: string) => number) {
  const asked: string[] = []
  const runNpm = (args: string[]) => {
    const packageName = (args[1] ?? '').replace(/@[^@]+$/, '')
    asked.push(packageName)
    const attempt = asked.filter((name) => name === packageName).length
    return attempt >= visibleFromAttempt(packageName) ? { status: 0, stdout: `${RELEASE}\n` } : { status: 1, stdout: '' }
  }
  return { asked, runNpm }
}

function waitFor(registry: ReturnType<typeof fakeRegistry>, attempts = 3) {
  let pauses = 0
  const pause = async () => {
    pauses += 1
  }
  const done = awaitPlatformPackages({ version: RELEASE, runNpm: registry.runNpm, pause, attempts })
  return { done, pauses: () => pauses }
}

test('every platform package on the registry passes at the first check', async () => {
  const registry = fakeRegistry(() => 1)
  const wait = waitFor(registry)

  await wait.done

  assert.deepEqual(registry.asked, NPM_TARGETS.map(({ suffix }) => platformPackageName(suffix)))
  assert.equal(wait.pauses(), 0)
})

test('a package the registry shows late is asked about again until it answers', async () => {
  const late = platformPackageName('linux-arm64-musl')
  const registry = fakeRegistry((name) => (name === late ? 3 : 1))
  const wait = waitFor(registry)

  await wait.done

  assert.equal(wait.pauses(), 2)
  assert.deepEqual(registry.asked.slice(NPM_TARGETS.length), [late, late])
})

test('a package that never appears stops the release, naming it', async () => {
  const missing = platformPackageName('darwin-x64')
  const registry = fakeRegistry((name) => (name === missing ? Number.POSITIVE_INFINITY : 1))
  const wait = waitFor(registry)

  await assert.rejects(wait.done, (error: Error) => {
    assert.match(error.message, /refusing to publish turbollm/)
    assert.match(error.message, new RegExp(`${missing}@${RELEASE.replaceAll('.', '\\.')}`))
    assert.doesNotMatch(error.message, /darwin-arm64/)
    return true
  })
  assert.equal(registry.asked.filter((name) => name === missing).length, 3)
})

test('a package that answers another version does not count as published', async () => {
  const runNpm = () => ({ status: 0, stdout: '1.15.0\n' })

  await assert.rejects(
    awaitPlatformPackages({ version: RELEASE, runNpm, pause: async () => {}, attempts: 1 }),
    /refusing to publish turbollm/,
  )
})

const NO_HOST_BINARY = !existsSync(HOST_BINARY) && 'no host binary: run `npm run build:core` first'

/** A global npm root as `npm install -g turbollm` leaves it, with the host's platform package nested inside. */
function installRoot(binary: string | null): string {
  const root = tmpDir('installed-core-')
  const turbollm = join(root, 'turbollm')
  mkdirSync(turbollm, { recursive: true })
  writeFileSync(join(turbollm, 'package.json'), '{ "name": "turbollm" }\n')
  if (binary === null) return root
  const suffix = hostTarget()?.suffix ?? 'none'
  const packageDir = join(turbollm, 'node_modules', ...platformPackageName(suffix).split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: platformPackageName(suffix), main: binaryFileName(suffix) }))
  copyFileSync(binary, join(packageDir, binaryFileName(suffix)))
  return root
}

function expectedParse(): string {
  return (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { parse: string }).parse
}

test('the installed platform package loads and parses the crafted fixture', { skip: NO_HOST_BINARY }, async () => {
  const verified = await verifyInstalledCore({
    version: RELEASE,
    installRoot: installRoot(HOST_BINARY),
    fixture: FIXTURE,
    expectedParse: expectedParse(),
  })

  assert.deepEqual(verified, { packageName: platformPackageName(hostTarget()?.suffix ?? 'none'), version: RELEASE })
})

test('an install without the platform package fails, naming the package', async () => {
  const check = verifyInstalledCore({
    version: RELEASE,
    installRoot: installRoot(null),
    fixture: FIXTURE,
    expectedParse: expectedParse(),
  })

  await assert.rejects(check, new RegExp(`${platformPackageName(hostTarget()?.suffix ?? 'none')} is not installed`))
})

test('a platform package of another version fails', { skip: NO_HOST_BINARY }, async () => {
  const check = verifyInstalledCore({
    version: '9.9.9',
    installRoot: installRoot(HOST_BINARY),
    fixture: FIXTURE,
    expectedParse: expectedParse(),
  })

  await assert.rejects(check, /reports version 1\.15\.1, expected 9\.9\.9/)
})

test('a parse that differs from the golden fails', { skip: NO_HOST_BINARY }, async () => {
  const check = verifyInstalledCore({
    version: RELEASE,
    installRoot: installRoot(HOST_BINARY),
    fixture: FIXTURE,
    expectedParse: '{"arch":"llama"}',
  })

  await assert.rejects(check, /parsed async-qwen3\.gguf to [^]*expected \{"arch":"llama"\}/)
})
