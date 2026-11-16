// Run from turbollm/: npx tsx --test core/scripts/build-node.test.ts (rust-core plan T18).
// The cross-compile path itself needs zig and a Linux target, so CI's node-addon job is its real test; these cases pin
// the triple it hands to cargo-zigbuild and the refusal of a target zig is not used for.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crossCompileTriple, GLIBC_FLOOR, NPM_TARGETS } from './targets.mjs'

const BUILD_NODE = join(dirname(fileURLToPath(import.meta.url)), 'build-node.mjs')
const USAGE_EXIT_CODE = 2

function npmTarget(suffix: string) {
  const target = NPM_TARGETS.find((candidate) => candidate.suffix === suffix)
  assert.ok(target, suffix)
  return target
}

test('a glibc target is cross-compiled against the glibc floor', () => {
  assert.equal(GLIBC_FLOOR, '2.28')
  assert.equal(crossCompileTriple(npmTarget('linux-x64-gnu')), 'x86_64-unknown-linux-gnu.2.28')
  assert.equal(crossCompileTriple(npmTarget('linux-arm64-gnu')), 'aarch64-unknown-linux-gnu.2.28')
})

test('a musl target is cross-compiled under its plain triple', () => {
  assert.equal(crossCompileTriple(npmTarget('linux-x64-musl')), 'x86_64-unknown-linux-musl')
  assert.equal(crossCompileTriple(npmTarget('linux-arm64-musl')), 'aarch64-unknown-linux-musl')
})

test('--cross-compile is refused for a target that is not Linux', () => {
  const run = spawnSync(process.execPath, [BUILD_NODE, '--cross-compile', '--target', 'win32-x64-msvc'], {
    encoding: 'utf8',
  })

  assert.equal(run.status, USAGE_EXIT_CODE, run.stderr)
  assert.match(run.stderr, /build-node: --cross-compile is for the linux targets only, not win32-x64-msvc/)
})
