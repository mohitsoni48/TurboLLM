// prepare-daemon.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')

const { makePtySpawnHelpersExecutable, prepareDaemon } = require('./prepare-daemon')

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

// rust-core plan T23, QA PG-7: the installer copies daemon/dist/native/ (electron-builder.config.cjs), so a
// wrapper build must rebuild the native core every time and must never package a dist without the host binary.
const HOST_BINARY = 'turbollm-core.test-host.node'
const BUILD_CORE = 'npm run build:core'
const BUILD = 'npm run build'
const BUILD_WEB = 'npm run build:web'
const STAGE_NATIVE = 'node core/scripts/stage-native.mjs'

function fakeDaemonTree (present, { binaryAppearsAfter = [] } = {}) {
  const files = new Set(present)
  const commands = []
  const failures = []
  const steps = {
    hostBinaryName: HOST_BINARY,
    exists: (relativePath) => files.has(relativePath),
    run: (cmd, args) => {
      const command = [cmd, ...args].join(' ')
      commands.push(command)
      if (binaryAppearsAfter.includes(command)) files.add(`dist/native/${HOST_BINARY}`)
    },
    fail: (message) => failures.push(message),
    log: () => {},
  }
  return { steps, commands, failures }
}

const BUILT_DIST = ['node_modules', 'dist/cli.js', 'dist/webdist']

test('a fresh tree builds the core before the daemon', () => {
  const tree = fakeDaemonTree(['node_modules'], { binaryAppearsAfter: [BUILD] })

  prepareDaemon(tree.steps)

  assert.ok(tree.commands.indexOf(BUILD_CORE) >= 0, 'build:core ran')
  assert.ok(tree.commands.indexOf(BUILD_CORE) < tree.commands.indexOf(BUILD), 'build:core ran before build')
  assert.deepEqual(tree.failures, [])
})

test('a built dist without native/ counts as not built: the core is built and the daemon rebuilt', () => {
  const tree = fakeDaemonTree(BUILT_DIST, { binaryAppearsAfter: [BUILD] })

  prepareDaemon(tree.steps)

  assert.deepEqual(tree.commands, [BUILD_CORE, BUILD_WEB, BUILD])
  assert.deepEqual(tree.failures, [])
})

test('a fully built tree still rebuilds the core and stages the fresh binary', () => {
  const tree = fakeDaemonTree([...BUILT_DIST, `dist/native/${HOST_BINARY}`])

  prepareDaemon(tree.steps)

  assert.deepEqual(tree.commands, [BUILD_CORE, STAGE_NATIVE])
  assert.deepEqual(tree.failures, [])
})

test('a binary still missing after the build stops the packaging with the build:core hint', () => {
  const tree = fakeDaemonTree(BUILT_DIST)

  prepareDaemon(tree.steps)

  assert.equal(tree.failures.length, 1)
  assert.match(tree.failures[0], new RegExp(`dist/native/${HOST_BINARY.replaceAll('.', '\.')}`))
  assert.match(tree.failures[0], /npm run build:core && npm run build/)
})

test('a host with no npm target stops the packaging before anything is built', () => {
  const tree = fakeDaemonTree(BUILT_DIST)

  prepareDaemon({ ...tree.steps, hostBinaryName: undefined })

  assert.deepEqual(tree.commands, [])
  assert.equal(tree.failures.length, 1)
  assert.match(tree.failures[0], /no native core target/)
})
