// Puts the host's native core beside the bundle: core/bindings/node/turbollm-core.<target>.node ->
// dist/native/ (rust-core plan T13, arch 2.4). `npm run build` runs it last.
//
//   node core/scripts/stage-native.mjs [<package root>] [--target <suffix>]
//
// No host binary is not an error: CI jobs and contributors without Rust still run `build`. It is
// loud, though (PG-6): a daemon started from that dist cannot load the core and exits 69.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { binaryFileName, hostTarget } from './targets.mjs'

const DEFAULT_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const { root, target } = parseRequest(process.argv.slice(2))
if (target === undefined) warnNoTargetForThisSystem()
else stageHostBinary(root, target)

function parseRequest(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { target: { type: 'string' } },
    allowPositionals: true,
  })
  return { root: positionals[0] ?? DEFAULT_PACKAGE_ROOT, target: values.target ?? hostTarget()?.suffix }
}

function stageHostBinary(root, target) {
  const fileName = binaryFileName(target)
  const builtBinary = join(root, 'core', 'bindings', 'node', fileName)
  if (!existsSync(builtBinary)) {
    warnDaemonWillStop(`dist/native/${fileName} was not staged: core/bindings/node/${fileName} does not exist.`)
    return
  }
  mkdirSync(join(root, 'dist', 'native'), { recursive: true })
  copyFileSync(builtBinary, join(root, 'dist', 'native', fileName))
  console.log(`staged dist/native/${fileName}`)
}

function warnNoTargetForThisSystem() {
  warnDaemonWillStop(`no native core was staged: no npm target matches ${process.platform}-${process.arch}.`)
}

function warnDaemonWillStop(reason) {
  console.error(
    [
      `WARNING: ${reason}`,
      'A daemon started from this dist (npm link, the desktop wrapper, a Docker image) will stop with exit 69.',
      'Run: npm run build:core && npm run build',
    ].join('\n'),
  )
}
