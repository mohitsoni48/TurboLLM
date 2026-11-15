// Publishes the 9 @turbollm/core-<target> packages in the release job (arch 2.8 step 2b, plan T17).
//
//   node core/scripts/publish-platform-packages.mjs --version <v> --artifacts <dir> [--dry-run]
//
// <dir> holds every turbollm-core.<target>.node side by side (download-artifact with merge-multiple).
// Every binary is checked for the release version before npm is asked anything, so a bad artifact
// set publishes nothing. Packages are staged in core/target/npm/<target>/; the committed templates
// in core/bindings/node/npm/ stay at version 0.0.0. --dry-run stages and runs `npm pack --dry-run`
// only: no registry call, nothing published.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { binaryFileName, NPM_TARGETS, platformPackageName } from './targets.mjs'

const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: node core/scripts/publish-platform-packages.mjs --version <v> --artifacts <dir> [--dry-run]'

/**
 * Verifies all 9 binaries, then stages and publishes each platform package in table order.
 * Returns one `{ suffix, outcome }` per target: 'published', 'already published' or 'packed'.
 */
export function publishPlatformPackages(release) {
  assertEveryBinaryCarriesTheVersion(release.artifactsDir, release.version)
  return NPM_TARGETS.map(({ suffix }) => {
    const packageDir = stagePackage(release, suffix)
    return { suffix, outcome: releasePackage(release, suffix, packageDir) }
  })
}

function assertEveryBinaryCarriesTheVersion(artifactsDir, version) {
  const problems = NPM_TARGETS.map(({ suffix }) => binaryProblem(join(artifactsDir, binaryFileName(suffix)), version))
    .filter((problem) => problem !== null)
  if (problems.length > 0) {
    throw new Error(`refusing to publish any platform package:\n  ${problems.join('\n  ')}`)
  }
}

function binaryProblem(binaryPath, version) {
  if (!existsSync(binaryPath)) return `${binaryPath}: not found`
  const marker = Buffer.from(`TURBOLLM_CORE_VERSION=${version}\0`)
  if (readFileSync(binaryPath).includes(marker)) return null
  return `${binaryPath} does not carry TURBOLLM_CORE_VERSION=${version}`
}

function stagePackage({ version, artifactsDir, templatesDir, licenseFile, stagingDir }, suffix) {
  const packageDir = join(stagingDir, suffix)
  rmSync(packageDir, { recursive: true, force: true })
  mkdirSync(packageDir, { recursive: true })
  const template = JSON.parse(readFileSync(join(templatesDir, suffix, 'package.json'), 'utf8'))
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({ ...template, version }, null, 2)}\n`)
  copyFileSync(join(artifactsDir, binaryFileName(suffix)), join(packageDir, binaryFileName(suffix)))
  copyFileSync(licenseFile, join(packageDir, 'LICENSE.md'))
  return packageDir
}

function releasePackage({ version, dryRun, runNpm }, suffix, packageDir) {
  if (dryRun) {
    runNpmOrThrow(runNpm, ['pack', '--dry-run'], packageDir)
    return 'packed'
  }
  if (isAlreadyPublished(runNpm, `${platformPackageName(suffix)}@${version}`, version, packageDir)) {
    return 'already published'
  }
  runNpmOrThrow(runNpm, ['publish', '--provenance', '--access', 'public'], packageDir)
  return 'published'
}

function isAlreadyPublished(runNpm, packageSpec, version, cwd) {
  const view = runNpm(['view', packageSpec, 'version'], cwd)
  return view.status === 0 && view.stdout.trim() === version
}

function runNpmOrThrow(runNpm, args, cwd) {
  const run = runNpm(args, cwd)
  if (run.status !== 0) throw new Error(`npm ${args.join(' ')} failed in ${cwd} (exit ${run.status})`)
}

/** The real npm, inheriting stderr so a failed publish shows npm's own reason in the job log. */
function spawnNpm(args, cwd) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  const run =
    process.platform === 'win32'
      ? spawnSync(`npm ${args.join(' ')}`, { ...options, shell: true })
      : spawnSync('npm', args, options)
  return { status: run.status, stdout: run.stdout ?? '' }
}

function main() {
  const { values } = parseArgs({
    options: { version: { type: 'string' }, artifacts: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  })
  if (values.version === undefined || values.artifacts === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  const outcomes = publishPlatformPackages({
    version: values.version,
    artifactsDir: resolve(values.artifacts),
    templatesDir: join(CORE_DIR, 'bindings', 'node', 'npm'),
    licenseFile: join(CORE_DIR, '..', 'LICENSE.md'),
    stagingDir: join(CORE_DIR, 'target', 'npm'),
    dryRun: values['dry-run'] === true,
    runNpm: spawnNpm,
  })
  for (const { suffix, outcome } of outcomes) console.log(`${platformPackageName(suffix)}@${values.version}: ${outcome}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
