import assert from 'node:assert/strict'
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { allTestFiles, requireShardFiles, SHARD_NAMES, shardFiles } from './test-shards'
import { tmpDir } from './tmp'

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

test('requireShardFiles refuses an unknown shard name and says which names exist', () => {
  assert.throws(() => requireShardFiles(ROOT, 'bogus'), /unknown shard "bogus".*engines/)
  assert.throws(() => requireShardFiles(ROOT, undefined), /unknown shard/)
})

test('requireShardFiles refuses an empty shard (an empty list would make `tsx --test` run Node\'s own discovery)', () => {
  const emptyRoot = tmpDir('tllm-shards-')
  mkdirSync(join(emptyRoot, 'src'))
  writeFileSync(join(emptyRoot, 'package.json'), JSON.stringify({ scripts: { test: 'tsx --test "src/**/*.test.ts"' } }))
  assert.throws(() => requireShardFiles(emptyRoot, 'engines'), /shard "engines" has no test files/)
})

test('requireShardFiles returns a real shard\'s files', () => {
  assert.deepEqual(requireShardFiles(ROOT, 'rest'), shardFiles(ROOT, 'rest'))
})

// What Node expands the test script's patterns to is not allTestFiles' own walk; both must agree, and a pattern the
// helper does not understand (another glob, another extension) must fail here rather than be silently dropped.
test('every quoted pattern in the "test" script is src/**/*.test.ts or an existing literal path', () => {
  const script = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>).test
  const patterns = [...script.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  assert.ok(patterns.length > 0)
  for (const p of patterns) {
    if (p === 'src/**/*.test.ts') continue
    assert.ok(!/[*?[\]{}]/.test(p), `"${p}" is a glob the shard helper does not expand`)
    assert.ok(existsSync(join(ROOT, p)), `"${p}" does not exist`)
  }
})

test('allTestFiles agrees with the files Node itself expands src/**/*.test.ts to', () => {
  const expanded = globSync('src/**/*.test.ts', { cwd: ROOT }).map((f) => f.split(sep).join('/')).sort()
  const ours = allTestFiles(ROOT).filter((f) => f.startsWith('src/'))
  assert.deepEqual(ours, expanded)
})
