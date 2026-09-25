import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { stripMacOsQuarantine } from './download'
import { tmpDir } from '../test-support/tmp'

function xattrList(path: string): string {
  try {
    return execFileSync('xattr', ['-l', path]).toString()
  } catch {
    return ''
  }
}

describe('stripMacOsQuarantine', () => {
  test('is a no-op and does not throw on non-darwin platforms', () => {
    if (process.platform === 'darwin') return
    const tmp = tmpDir('turbollm-quarantine-test-')
    try {
      assert.doesNotThrow(() => stripMacOsQuarantine(tmp))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('removes com.apple.quarantine attribute from directory on macOS', {
    skip: process.platform !== 'darwin' ? 'macOS only' : false,
  }, () => {
    const tmp = tmpDir('turbollm-quarantine-test-')
    try {
      execFileSync('xattr', ['-w', 'com.apple.quarantine', '0083;00000000;test;00000000-0000-0000-0000-000000000000', tmp])
      assert.ok(xattrList(tmp).includes('com.apple.quarantine'), 'precondition: quarantine attribute was not set')

      stripMacOsQuarantine(tmp)

      assert.ok(!xattrList(tmp).includes('com.apple.quarantine'), 'quarantine attribute was not removed')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('does not throw when quarantine attribute is absent on macOS', {
    skip: process.platform !== 'darwin' ? 'macOS only' : false,
  }, () => {
    const tmp = tmpDir('turbollm-quarantine-test-')
    try {
      assert.doesNotThrow(() => stripMacOsQuarantine(tmp))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('strips quarantine recursively from files inside the directory on macOS', {
    skip: process.platform !== 'darwin' ? 'macOS only' : false,
  }, () => {
    const tmp = tmpDir('turbollm-quarantine-test-')
    const nested = join(tmp, 'bin')
    const nestedFile = join(nested, 'llama-server')
    try {
      mkdirSync(nested, { recursive: true })
      writeFileSync(nestedFile, '')
      execFileSync('xattr', ['-w', 'com.apple.quarantine', '0083;00000000;test;00000000-0000-0000-0000-000000000000', nestedFile])

      stripMacOsQuarantine(tmp)

      assert.ok(!xattrList(nestedFile).includes('com.apple.quarantine'), 'quarantine was not stripped from nested file')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
