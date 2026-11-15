// The gate before `npm publish` of turbollm in npm-publish.yml (rust-core plan T20, arch 2.8): turbollm lists the 9
// @turbollm/core-<target> packages as optional dependencies, and npm skips an optional dependency it cannot find
// without failing the install, so publishing turbollm before every one of them resolves ships installs with no core.
//
//   node core/scripts/await-platform-packages.mjs --version <v>
//
// A package publish can take a short while to show in `npm view`, so a missing package is asked about again
// (ATTEMPTS checks, PAUSE_MS apart) before the job fails.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { NPM_TARGETS, platformPackageName } from './targets.mjs'

const ATTEMPTS = 15
const PAUSE_MS = 20_000
const USAGE = 'usage: node core/scripts/await-platform-packages.mjs --version <v>'

/** Resolves once `npm view` answers `version` for every platform package; rejects naming the ones that never did. */
export async function awaitPlatformPackages({ version, runNpm, pause, attempts }) {
  let missing = NPM_TARGETS.map(({ suffix }) => `${platformPackageName(suffix)}@${version}`)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    missing = missing.filter((packageSpec) => !answersVersion(runNpm, packageSpec, version))
    if (missing.length === 0) return
    if (attempt < attempts) await pause()
  }
  throw new Error(
    `refusing to publish turbollm: not on the registry after ${attempts} checks:\n  ${missing.join('\n  ')}`,
  )
}

function answersVersion(runNpm, packageSpec, version) {
  const view = runNpm(['view', packageSpec, 'version'])
  return view.status === 0 && view.stdout.trim() === version
}

function spawnNpm(args) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  const run =
    process.platform === 'win32'
      ? spawnSync(`npm ${args.join(' ')}`, { ...options, shell: true })
      : spawnSync('npm', args, options)
  return { status: run.status, stdout: run.stdout ?? '' }
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: 'string' } } })
  if (values.version === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  const pause = () => new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
  await awaitPlatformPackages({ version: values.version, runNpm: spawnNpm, pause, attempts: ATTEMPTS })
  console.log(`all ${NPM_TARGETS.length} platform packages answer ${values.version} on the registry`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
