// Adds the 9 @turbollm/core-<target> packages to turbollm's optionalDependencies at exactly <v>
// (arch 2.8 step 2c, plan T17). Run only in the publish job's working tree: the committed
// package.json never lists them (B-12).
//
//   node core/scripts/inject-optional-deps.mjs <v>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NPM_TARGETS, platformPackageName } from './targets.mjs'

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Pins every platform package at `version`, keeping the existing optional dependencies (node-pty). */
export function injectOptionalDeps(packageJsonPath, version) {
  if (!RELEASE_VERSION.test(version)) throw new Error(`${version} is not a release version (x.y.z)`)
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  manifest.optionalDependencies = { ...manifest.optionalDependencies, ...platformPackagesAt(version) }
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function platformPackagesAt(version) {
  return Object.fromEntries(NPM_TARGETS.map(({ suffix }) => [platformPackageName(suffix), version]))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const version = process.argv[2]
  if (version === undefined) {
    console.error('usage: node core/scripts/inject-optional-deps.mjs <v>')
    process.exit(2)
  }
  try {
    injectOptionalDeps(PACKAGE_JSON, version)
    console.log(`optionalDependencies: ${NPM_TARGETS.length} platform packages at ${version}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
