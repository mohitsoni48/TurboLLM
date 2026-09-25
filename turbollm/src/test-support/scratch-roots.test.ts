import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ABANDONED_AFTER_MS, createScratchRoot, removeScratchRoot, sweepAbandonedRoots } from './scratch-roots'

// This file tests the layer `tmpDir` is built on, so it uses the raw temp APIs on purpose.

const NOW = 1_800_000_000_000
const clock = () => NOW

function isolatedBase(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), 'scratch-roots-test-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return base
}

function plantRoot(base: string, name: string): string {
  const root = join(base, name)
  mkdirSync(join(root, 'nested'), { recursive: true })
  writeFileSync(join(root, 'nested', 'file.txt'), 'x')
  return root
}

test('createScratchRoot: makes a directory named for the owning process, creating the base if needed', (t) => {
  const base = join(isolatedBase(t), 'not-created-yet')

  const root = createScratchRoot(base)

  assert.ok(statSync(root).isDirectory())
  assert.equal(dirname(root), base)
  assert.match(basename(root), new RegExp(`^${process.pid}-\\d+-`))
})

test('createScratchRoot: two roots from the same process never collide', (t) => {
  const base = isolatedBase(t)

  assert.notEqual(createScratchRoot(base), createScratchRoot(base))
})

test('removeScratchRoot: deletes the whole tree, read-only files included', (t) => {
  const root = plantRoot(isolatedBase(t), 'root')
  chmodSync(join(root, 'nested', 'file.txt'), 0o444)

  const removed = removeScratchRoot(root)

  assert.equal(removed, true)
  assert.equal(existsSync(root), false)
})

test('removeScratchRoot: a root that is already gone counts as removed', (t) => {
  assert.equal(removeScratchRoot(join(isolatedBase(t), 'never-existed')), true)
})

test('removeScratchRoot: reports but does not throw when the tree cannot be removed', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})

  const removed = removeScratchRoot('a\0path-that-rmSync-rejects')

  assert.equal(removed, false)
  assert.equal(warn.mock.callCount(), 1)
})

test('removeScratchRoot: names the owner in the warning, so the leaking test file can be found', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})

  removeScratchRoot('a\0path-that-rmSync-rejects', 'src/some/leaky.test.ts')

  assert.match(String(warn.mock.calls[0]!.arguments[0]), /src\/some\/leaky\.test\.ts/)
})

test('sweepAbandonedRoots: removes a root whose owning process is gone', (t) => {
  const base = isolatedBase(t)
  const orphan = plantRoot(base, `4242-${NOW - 1000}-abcdef`)

  const swept = sweepAbandonedRoots(base, { isAlive: () => false, now: clock })

  assert.deepEqual(swept, [orphan])
  assert.equal(existsSync(orphan), false)
})

test('sweepAbandonedRoots: keeps a root whose owning process is still running', (t) => {
  const base = isolatedBase(t)
  const live = plantRoot(base, `4242-${NOW - 1000}-abcdef`)

  const swept = sweepAbandonedRoots(base, { isAlive: (pid) => pid === 4242, now: clock })

  assert.deepEqual(swept, [])
  assert.ok(existsSync(live))
})

test('sweepAbandonedRoots: removes a root past the abandonment age even when its pid looks alive (pid reuse)', (t) => {
  const base = isolatedBase(t)
  const stale = plantRoot(base, `4242-${NOW - ABANDONED_AFTER_MS - 1}-abcdef`)

  const swept = sweepAbandonedRoots(base, { isAlive: () => true, now: clock })

  assert.deepEqual(swept, [stale])
})

test('sweepAbandonedRoots: leaves anything it did not create alone', (t) => {
  const base = isolatedBase(t)
  const foreignDir = plantRoot(base, 'somebody-elses-dir')
  const foreignFile = join(base, '4242-not-a-root.txt')
  writeFileSync(foreignFile, 'x')

  sweepAbandonedRoots(base, { isAlive: () => false, now: clock })

  assert.ok(existsSync(foreignDir))
  assert.ok(existsSync(foreignFile))
})

test('sweepAbandonedRoots: a base directory that does not exist yet is not an error', (t) => {
  const missing = join(isolatedBase(t), 'missing')

  assert.deepEqual(sweepAbandonedRoots(missing, { isAlive: () => false }), [])
})
