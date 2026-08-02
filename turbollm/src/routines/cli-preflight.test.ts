import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isClaudeCliAvailable } from './cli-preflight'

test('reports available when the probe command exits 0', async () => {
  const fakeRun = async (bin: string, args: string[]) => {
    assert.equal(bin, 'claude')
    assert.deepEqual(args, ['--version'])
    return true
  }
  assert.equal(await isClaudeCliAvailable(fakeRun), true)
})

test('reports unavailable when the probe command fails (not installed / ENOENT)', async () => {
  const fakeRun = async () => false
  assert.equal(await isClaudeCliAvailable(fakeRun), false)
})
