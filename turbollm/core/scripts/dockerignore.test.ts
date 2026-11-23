// Run from turbollm/: npx tsx --test core/scripts/dockerignore.test.ts (rust-core plan T23c, QA PG-5, E-61).
// Dockerfile.nvidia and Dockerfile.amd `COPY turbollm/ ./`, so whatever .dockerignore lets through reaches their build
// stage: a multi-GB core/target (a Windows one, on the founder's box) and host-built `.node` files among it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DOCKERIGNORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.dockerignore')
const RUST_BUILD_TREE = [
  'turbollm/core/target',
  'turbollm/core/fixtures/gguf/.corpus-cache',
  'turbollm/core/bindings/android/**/build',
  'turbollm/core/bindings/android/**/.cxx',
  'turbollm/core/bindings/android/.gradle',
  'turbollm/core/bindings/node/*.node',
]
const DIST_REINCLUDE = '!turbollm/dist/**'

const patterns = readFileSync(DOCKERIGNORE, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())

test('the Rust, Gradle and corpus build trees stay out of every image context', () => {
  for (const pattern of RUST_BUILD_TREE) {
    assert.ok(patterns.includes(pattern), `.dockerignore does not exclude ${pattern}`)
  }
})

test('the host dist is re-included after them, so a staged dist/native/*.node still reaches the test images', () => {
  const reinclude = patterns.indexOf(DIST_REINCLUDE)

  assert.ok(reinclude >= 0, `.dockerignore no longer has ${DIST_REINCLUDE}`)
  for (const pattern of RUST_BUILD_TREE) {
    const index = patterns.indexOf(pattern)
    assert.ok(index >= 0 && index < reinclude, `${pattern} is missing or comes after ${DIST_REINCLUDE}`)
  }
})
