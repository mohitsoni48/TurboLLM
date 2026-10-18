// openOwnerOnlyLog: restart.log and update.log carry the API key a daemon started with
// --print-token or --tunnel prints on every start, so they are owner-only like config.json.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { OWNER_ONLY_LOG_MODE, openOwnerOnlyLog } from './owner-only-log'

const skip = process.platform === 'win32' ? 'Windows keeps only the write bit of a mode' : false

/** Runs `fn` under the usual umask 022, which gives a default-mode file 0644. */
function underUmask022(fn: () => void): void {
  const prev = process.umask(0o022)
  try {
    fn()
  } finally {
    process.umask(prev)
  }
}

test('openOwnerOnlyLog creates a missing log owner-only, under a umask that gives 0644 otherwise', { skip }, () => {
  underUmask022(() => {
    const dir = tmpDir('tllm-owner-log-')
    const path = join(dir, 'restart.log')
    const fd = openOwnerOnlyLog(path)
    writeSync(fd, '  Token:   tllm-printed\n')
    closeSync(fd)
    assert.equal(statSync(path).mode & 0o777, OWNER_ONLY_LOG_MODE)
    assert.equal(OWNER_ONLY_LOG_MODE, 0o600)
    // The default-mode open it replaces, for comparison.
    const plain = join(dir, 'plain.log')
    closeSync(openSync(plain, 'a'))
    assert.equal(statSync(plain).mode & 0o777, 0o644)
  })
})

test("openOwnerOnlyLog makes an existing 0644 log owner-only and appends to it", { skip }, () => {
  underUmask022(() => {
    const path = join(tmpDir('tllm-owner-log-'), 'update.log')
    writeFileSync(path, '  Token:   tllm-from-an-older-version\n', { mode: 0o644 })
    const fd = openOwnerOnlyLog(path)
    writeSync(fd, 'next\n')
    closeSync(fd)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(readFileSync(path, 'utf8'), '  Token:   tllm-from-an-older-version\nnext\n')
  })
})

// cli.ts prepares restart.log this way at boot and leaves spawnReplacement's own default-mode
// open as shipped (ADR-442): an append open keeps the mode the file already has.
test('a default-mode append to a log openOwnerOnlyLog prepared keeps it owner-only', { skip }, () => {
  underUmask022(() => {
    const path = join(tmpDir('tllm-owner-log-'), 'restart.log')
    closeSync(openOwnerOnlyLog(path))
    const fd = openSync(path, 'a')
    writeSync(fd, '  Token:   tllm-replacement\n')
    closeSync(fd)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })
})
