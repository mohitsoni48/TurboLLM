// Regression guard for GitHub #226 — `npm i -g turbollm@latest` failed on Windows with
// "'patch-package' is not recognized as an internal or external command".
//
// Cause: package.json declared `"postinstall": "patch-package"`. npm runs `postinstall`
// for a consumer installing the published tarball, but does NOT install devDependencies
// for them — and patch-package lives in devDependencies, so the binary was never there.
// Every global install hard-failed (shipped in v1.12.5, a7a85c2).
//
// The patch itself (patches/typebox+1.1.38.patch) is a build-time concern only: it is not
// in `files`, so it is never even published, and it exists purely so nodejs-mobile's Node
// 18 can parse typebox's `\p{...}` literals — the Android bundle inlines the patched copy
// at build time (tsup.android.config.ts, noExternal), while the desktop bundle keeps
// typebox external and desktop Node 22 parses that syntax natively.
//
// Fix: `prepare` instead. It runs on a local `npm install`/`npm ci` in this repo and on
// git-URL installs (both of which DO install devDependencies), but never for a registry
// tarball install. This test fails if `postinstall` is ever reintroduced.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './test-support/tmp'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts?: Record<string, string>; files?: string[] }

test('#226: package.json declares no postinstall script (it runs without devDependencies)', () => {
  assert.equal(
    manifest.scripts?.postinstall,
    undefined,
    'postinstall runs on a consumer `npm i -g turbollm` but devDependencies are not installed ' +
      'there — a devDependency binary here breaks every install. Use `prepare` instead.',
  )
})

test('#226: patch-package is wired through `prepare`, so the dev repo still gets patched', () => {
  assert.equal(manifest.scripts?.prepare, 'patch-package')
})

// `"start": "tsx src/cli.ts"` put tsx's own process between npm and the daemon. tsx relays a signal to its child,
// waits about 30 ms twice for an acknowledgement over IPC, then SIGKILLs it: measured with a daemon busy 400 ms in
// every 500 ms, Ctrl+C never ran the graceful shutdown (0 of 3), and engines were left to the reapers. `node
// --import tsx` runs the daemon itself in npm's process tree, with tsx as a loader only (3 of 3 graceful). Node
// supports `--import` on every version cli.ts accepts (>= 22.13). A Settings restart's keeper passes execArgv on, so
// `--import tsx` reaches the replacement (cli.ts becomeKeeper).
test('`npm start` runs the daemon as node itself, with tsx as a loader: no relaying process to SIGKILL it at Ctrl+C', () => {
  assert.equal(manifest.scripts?.start, 'node --import tsx src/cli.ts')
})

// Rust core (rust-core plan T13, arch 2.4): `build` stages the host binary into dist/native for a local daemon, and
// the published tarball never carries a `.node`: the platform packages (@turbollm/core-<target>) ship the binaries.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const STRIP_SCRIPT = join(PACKAGE_ROOT, 'core', 'scripts', 'strip-native.mjs')

test('`build` ends by staging the host native core into dist/native', () => {
  assert.ok(manifest.scripts?.build?.endsWith(' && node core/scripts/stage-native.mjs'), manifest.scripts?.build)
})

test('`prepublishOnly` builds and then strips dist/native, so the tarball carries no .node', () => {
  assert.equal(
    manifest.scripts?.prepublishOnly,
    'npm run build:web && npm run build && node core/scripts/strip-native.mjs',
  )
})

test('the published files are still only bin and dist (core/ is never published)', () => {
  assert.deepEqual(manifest.files, ['bin', 'dist'])
})

test('after the strip step `npm pack --dry-run` lists dist files but no .node', () => {
  const root = tmpDir('pack-no-native-')
  copyFileSync(join(PACKAGE_ROOT, 'package.json'), join(root, 'package.json'))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'turbollm.js'), '// bin\n')
  mkdirSync(join(root, 'dist', 'native'), { recursive: true })
  writeFileSync(join(root, 'dist', 'cli.js'), '// bundle\n')
  writeFileSync(join(root, 'dist', 'native', 'x.node'), 'native bytes')

  const strip = spawnSync(process.execPath, [STRIP_SCRIPT, root], { encoding: 'utf8' })
  assert.equal(strip.status, 0, strip.stderr)
  const pack = spawnSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, shell: true, encoding: 'utf8' })
  assert.equal(pack.status, 0, pack.stderr)

  const packed = (JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path)
  assert.ok(packed.includes('dist/cli.js'), packed.join(', '))
  assert.deepEqual(packed.filter((path) => path.endsWith('.node')), [])
})
