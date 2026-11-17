// Removes dist/native before a publish (rust-core plan T13, arch 2.4): the turbollm tarball never
// carries a `.node`; the binaries ship in the @turbollm/core-<target> platform packages.
//
//   node core/scripts/strip-native.mjs [<package root>]
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const root = process.argv[2] ?? DEFAULT_PACKAGE_ROOT
rmSync(join(root, 'dist', 'native'), { recursive: true, force: true })
