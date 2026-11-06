import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { allTestFiles, SHARD_NAMES, shardFiles } from './test-shards'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the shards together run every test file `npm test` runs, each exactly once', () => {
  const all = allTestFiles(ROOT)
  const sharded = SHARD_NAMES.flatMap((name) => shardFiles(ROOT, name))
  assert.deepEqual([...sharded].sort(), [...all].sort())
  assert.equal(new Set(sharded).size, sharded.length, 'a file is in two shards')
})

test('no shard is empty', () => {
  for (const name of SHARD_NAMES) assert.ok(shardFiles(ROOT, name).length > 0, `${name} has no test files`)
})

test('allTestFiles finds this file and a web/src/lib file named by the test script', () => {
  const all = allTestFiles(ROOT)
  assert.ok(all.includes('src/test-support/test-shards.test.ts'))
  assert.ok(all.includes('web/src/lib/vram.test.ts'))
})
