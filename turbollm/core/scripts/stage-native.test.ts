// Run from turbollm/: npx tsx --test core/scripts/stage-native.test.ts (rust-core plan T13, PG-6).
// Every case runs the real script against a tmpDir() package root, never this checkout's dist/.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { nativeTarget } from '../../src/native/load'
import { tmpDir } from '../../src/test-support/tmp'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const STAGE = join(SCRIPTS_DIR, 'stage-native.mjs')
const STRIP = join(SCRIPTS_DIR, 'strip-native.mjs')
const TARGET = 'linux-x64-gnu'
const BINARY = `turbollm-core.${TARGET}.node`

function runScript(script: string, args: string[]) {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** A package root with a built dist/ and, when asked, a host binary in core/bindings/node. */
function packageRoot(options: { binary?: string } = {}): string {
  const root = tmpDir('stage-native-')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'cli.js'), '// bundle\n')
  if (options.binary !== undefined) {
    mkdirSync(join(root, 'core', 'bindings', 'node'), { recursive: true })
    writeFileSync(join(root, 'core', 'bindings', 'node', options.binary), 'native bytes')
  }
  return root
}

test('stage copies the host binary into dist/native when it was built', () => {
  const root = packageRoot({ binary: BINARY })

  const run = runScript(STAGE, [root, '--target', TARGET])

  assert.equal(run.status, 0, run.stderr)
  assert.equal(readFileSync(join(root, 'dist', 'native', BINARY), 'utf8'), 'native bytes')
  assert.equal(run.stderr, '')
})

test('stage without a host binary exits 0 and warns loudly that the daemon will stop with exit 69 (PG-6)', () => {
  const root = packageRoot()

  const run = runScript(STAGE, [root, '--target', TARGET])

  assert.equal(run.status, 0)
  assert.equal(existsSync(join(root, 'dist', 'native')), false)
  const lines = run.stderr.split(/\r?\n/)
  assert.ok(
    lines.includes(
      `WARNING: dist/native/${BINARY} was not staged: core/bindings/node/${BINARY} does not exist.`,
    ),
    run.stderr,
  )
  assert.ok(
    lines.includes('A daemon started from this dist (npm link, the desktop wrapper, a Docker image) will stop with exit 69.'),
    run.stderr,
  )
  assert.ok(lines.includes('Run: npm run build:core && npm run build'), run.stderr)
})

test('stage defaults to the target the loader looks for on this machine', () => {
  const hostTarget = nativeTarget()
  if (hostTarget === null) return
  const hostBinary = `turbollm-core.${hostTarget}.node`
  const root = packageRoot({ binary: hostBinary })

  const run = runScript(STAGE, [root])

  assert.equal(run.status, 0, run.stderr)
  assert.equal(existsSync(join(root, 'dist', 'native', hostBinary)), true)
})

test('strip removes dist/native and keeps the rest of dist', () => {
  const root = packageRoot({ binary: BINARY })
  runScript(STAGE, [root, '--target', TARGET])

  const run = runScript(STRIP, [root])

  assert.equal(run.status, 0, run.stderr)
  assert.equal(existsSync(join(root, 'dist', 'native')), false)
  assert.equal(existsSync(join(root, 'dist', 'cli.js')), true)
})

test('strip is a no-op when dist/native is absent', () => {
  const root = packageRoot()

  const run = runScript(STRIP, [root])

  assert.equal(run.status, 0, run.stderr)
  assert.equal(existsSync(join(root, 'dist', 'cli.js')), true)
})
