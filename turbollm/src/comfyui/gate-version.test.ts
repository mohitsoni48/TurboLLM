// /api/v1/status is polled every couple of seconds and reported the gate node's installed version by reading its
// __init__.py each time. The reader now stats the file and re-reads it only when its path, mtime or size changed
// (which covers install, update and removal alike).
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGateVersionReader } from './gate-version'
import { tmpDir } from '../test-support/tmp'

function gateDir(version: number): string {
  const dir = join(tmpDir('tllm-gate-version-'), 'turbollm_gate')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '__init__.py'), `# gate\nGATE_VERSION = ${version}\n`)
  return dir
}

test('repeated status polls read the gate file once', async () => {
  const dir = gateDir(4)
  const reads: string[] = []
  const reader = createGateVersionReader((file) => {
    reads.push(file)
    return 'GATE_VERSION = 4\n'
  })
  for (let i = 0; i < 5; i++) assert.equal(reader(dir), 4)
  assert.equal(reads.length, 1)
})

test('an update to the file (new mtime/size) is re-read', () => {
  const dir = gateDir(3)
  const reader = createGateVersionReader()
  assert.equal(reader(dir), 3)
  writeFileSync(join(dir, '__init__.py'), '# gate\nGATE_VERSION = 12\n')
  utimesSync(join(dir, '__init__.py'), new Date(), new Date(Date.now() + 5000))
  assert.equal(reader(dir), 12)
})

test('removal gives null, and a reinstall is picked up again', () => {
  const dir = gateDir(4)
  const reader = createGateVersionReader()
  assert.equal(reader(dir), 4)
  assert.equal(reader(join(dir, 'gone')), null)
  assert.equal(reader(dir), 4)
})

test('no path, or a file without a version stamp, is null', () => {
  const reader = createGateVersionReader()
  assert.equal(reader(''), null)
  const dir = gateDir(4)
  writeFileSync(join(dir, '__init__.py'), '# nothing here\n')
  assert.equal(reader(dir), null)
})

test('the cache follows the path: another gate folder is read, not served from the first', () => {
  const a = gateDir(3)
  const b = gateDir(4)
  const reader = createGateVersionReader()
  assert.equal(reader(a), 3)
  assert.equal(reader(b), 4)
})
