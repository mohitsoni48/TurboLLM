// The after-publish check in npm-publish.yml's verify-published jobs (rust-core plan T20, arch 2.8 step 3): the
// `turbollm` that `npm install -g` just installed must carry this system's platform package, at the release version,
// and its binary must parse a crafted fixture to the golden text.
//
//   node core/scripts/verify-installed-core.mjs --version <v>
//
// Run from a checkout of the release tag (the fixture and golden come from it). The install root is `npm root -g`.
// Binaries are opened with process.dlopen, as src/native/load.ts does (plan P-3).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { hostTarget, platformPackageName } from './targets.mjs'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gguf')
const FIXTURE_ID = 'async-qwen3'
const USAGE = 'usage: node core/scripts/verify-installed-core.mjs --version <v>'

/** Loads the host's platform package from the installed turbollm and checks its version and one golden parse. */
export async function verifyInstalledCore({ version, installRoot, fixture, expectedParse }) {
  const packageName = hostPackageName()
  const core = loadInstalledPackage(installRoot, packageName)
  const reported = core.coreInfo().version
  if (reported !== version) throw new Error(`${packageName} reports version ${reported}, expected ${version}`)
  const parsed = JSON.stringify(await core.parseGguf(fixture))
  if (parsed !== expectedParse) {
    throw new Error(`${packageName} parsed ${basename(fixture)} to ${parsed}, expected ${expectedParse}`)
  }
  return { packageName, version }
}

function hostPackageName() {
  const target = hostTarget()
  if (target === undefined) throw new Error(`no platform package exists for ${process.platform}-${process.arch}`)
  return platformPackageName(target.suffix)
}

function loadInstalledPackage(installRoot, packageName) {
  const turbollmDir = join(installRoot, 'turbollm')
  const requireFromTurbollm = createRequire(join(turbollmDir, 'package.json'))
  let binaryPath
  try {
    binaryPath = requireFromTurbollm.resolve(packageName)
  } catch {
    throw new Error(`${packageName} is not installed under ${turbollmDir}`)
  }
  const nativeModule = { exports: {} }
  process.dlopen(nativeModule, binaryPath)
  return nativeModule.exports
}

function globalInstallRoot() {
  const options = { encoding: 'utf8' }
  const run =
    process.platform === 'win32'
      ? spawnSync('npm root -g', { ...options, shell: true })
      : spawnSync('npm', ['root', '-g'], options)
  if (run.status !== 0) throw new Error(`npm root -g failed (exit ${run.status})`)
  return run.stdout.trim()
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: 'string' } } })
  if (values.version === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  const golden = JSON.parse(readFileSync(join(FIXTURES_DIR, 'golden', `${FIXTURE_ID}.json`), 'utf8'))
  const verified = await verifyInstalledCore({
    version: values.version,
    installRoot: globalInstallRoot(),
    fixture: join(FIXTURES_DIR, 'crafted', `${FIXTURE_ID}.gguf`),
    expectedParse: golden.parse,
  })
  console.log(`${verified.packageName}@${verified.version} loads and parses ${FIXTURE_ID}.gguf to its golden`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
