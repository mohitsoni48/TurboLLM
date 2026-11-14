import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../test-support/tmp'
import { writeFileAtomicSync } from './atomic-write'

test('writes a new file and replaces an existing one, leaving no temp file', () => {
  const dir = tmpDir('turbollm-atomic-')
  const file = join(dir, 'state.json')
  writeFileAtomicSync(file, '{"a":1}')
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}')
  writeFileAtomicSync(file, '{"a":2}')
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}')
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('a failed write step leaves the previous file intact and no temp file behind', () => {
  const dir = tmpDir('turbollm-atomic-')
  const file = join(dir, 'state.json')
  writeFileSync(file, '{"keep":true}')
  assert.throws(() => writeFileAtomicSync(file, { not: 'writable' } as unknown as string))
  assert.equal(readFileSync(file, 'utf8'), '{"keep":true}')
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('a failed rename leaves the target as it was and removes the temp file', () => {
  const dir = tmpDir('turbollm-atomic-')
  const target = join(dir, 'is-a-directory')
  mkdirSync(target)
  assert.throws(() => writeFileAtomicSync(target, 'x'))
  assert.deepEqual(readdirSync(dir), ['is-a-directory'])
})
