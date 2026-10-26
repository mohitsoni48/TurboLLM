// prepare-daemon.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')

const { makePtySpawnHelpersExecutable } = require('./prepare-daemon')

const modeOf = (p) => statSync(p).mode & 0o777

// node-pty 1.1.0's npm tarball has its macOS spawn-helpers 0644, and the app's
// daemon/node_modules is copied with each file's mode as it is: every Code terminal
// of the macOS app failed with "posix_spawnp failed." until the helper had its bit.
test('the macOS spawn-helpers of the daemon\'s node-pty are made executable before packaging, and nothing else', { skip: process.platform === 'win32' && 'POSIX file modes' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tllm-prepare-daemon-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'node-pty/prebuilds/darwin-arm64/spawn-helper': 0o644,
    'node-pty/prebuilds/darwin-arm64/pty.node': 0o644,
    'node-pty/prebuilds/darwin-x64/spawn-helper': 0o755,
    'node-pty/prebuilds/win32-x64/pty.node': 0o644,
    'node-pty/lib/index.js': 0o644,
  }
  for (const [rel, mode] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), '')
    chmodSync(join(root, rel), mode)
  }

  assert.deepEqual(makePtySpawnHelpersExecutable(root), [join(root, 'node-pty/prebuilds/darwin-arm64/spawn-helper')])
  for (const [rel, mode] of Object.entries(files)) {
    assert.equal(modeOf(join(root, rel)), rel === 'node-pty/prebuilds/darwin-arm64/spawn-helper' ? 0o755 : mode, rel)
  }
  assert.deepEqual(makePtySpawnHelpersExecutable(root), [], 'a second run changes nothing')
  assert.deepEqual(makePtySpawnHelpersExecutable(join(root, 'missing')), [], 'no node-pty: nothing to do')
})
