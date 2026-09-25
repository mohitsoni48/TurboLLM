import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { resolveServerBinary, suggestEngineName, meaningfulFolder, cleanVersionLabel } from './scan'
import { findFile } from './download'
import { tmpDir } from '../test-support/tmp'

const BIN = 'llama-server-test-bin'

function tempTree(): string {
  return tmpDir('tllm-scan-')
}

test('resolveServerBinary: finds the binary nested in a chosen folder', () => {
  const root = tempTree()
  try {
    const buildDir = join(root, 'build', 'bin')
    mkdirSync(buildDir, { recursive: true })
    const bin = join(buildDir, BIN)
    writeFileSync(bin, 'x')
    assert.equal(resolveServerBinary(root, BIN), bin)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveServerBinary: a file path is used directly as the binary', () => {
  const root = tempTree()
  try {
    const bin = join(root, BIN)
    writeFileSync(bin, 'x')
    assert.equal(resolveServerBinary(bin, BIN), bin)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveServerBinary: returns null when the folder has no binary', () => {
  const root = tempTree()
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'readme.txt'), 'x')
    assert.equal(resolveServerBinary(root, BIN), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveServerBinary: returns null for a non-existent path', () => {
  assert.equal(resolveServerBinary(join(tmpDir('tllm-scan-'), 'does-not-exist'), BIN), null)
})

test('findFile: skipDir prunes pruned subtrees (node_modules / dotdirs)', () => {
  const root = tempTree()
  try {
    // Decoy binary hidden inside a skipped dir — must NOT be found.
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', BIN), 'x')
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', BIN), 'x')
    const skip = (n: string) => n === 'node_modules' || n === '.git' || n.startsWith('.')
    assert.equal(findFile(root, BIN, skip), null)
    // Without the predicate the full walk still finds it (existing-caller behavior).
    assert.notEqual(findFile(root, BIN), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('suggestEngineName: folder + version, folder-only when version unknown', () => {
  const bin = join('any', 'turboquant', BIN)
  assert.equal(suggestEngineName(bin, 'b1234'), `${basename('turboquant')} (b1234)`)
  assert.equal(suggestEngineName(bin, 'unknown'), 'turboquant')
  assert.equal(suggestEngineName(bin, ''), 'turboquant')
})

test('meaningfulFolder: skips generic build dirs (bin/build/release/x64)', () => {
  assert.equal(meaningfulFolder(join('x', 'atomic', 'build', 'bin', BIN)), 'atomic')
  assert.equal(meaningfulFolder(join('x', 'ik_llama.cpp', 'build', 'bin', 'Release', BIN)), 'ik_llama.cpp')
  // Every ancestor generic → fall back to the immediate parent rather than crash.
  assert.equal(meaningfulFolder(join('build', 'bin', BIN)), 'bin')
})

test('cleanVersionLabel: prefers build tag, then short hash, then first token', () => {
  assert.equal(cleanVersionLabel('1 (0a635dc)'), '0a635dc') // messy raw version → clean hash
  assert.equal(cleanVersionLabel('version: 1.2.3 (b9608)'), 'b9608') // build tag wins
  assert.equal(cleanVersionLabel('0.31.2'), '0.31.2') // plain version token
  assert.equal(cleanVersionLabel('unknown'), '')
  assert.equal(cleanVersionLabel(''), '')
})

test('suggestEngineName: real-world atomic/build/bin + messy version → clean name', () => {
  assert.equal(
    suggestEngineName(join('D:', 'llama-turbo', 'atomic', 'build', 'bin', BIN), '1 (0a635dc)'),
    'atomic (0a635dc)',
  )
})
