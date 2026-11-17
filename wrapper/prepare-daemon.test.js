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
const NON_LINUX_HOST = { suffix: 'test-host', libc: null, binaryName: HOST_BINARY, glibcFloor: '2.28' }
const BUILD_CORE = 'npm run build:core'
const BUILD = 'npm run build'
const BUILD_WEB = 'npm run build:web'
const STAGE_NATIVE = 'node core/scripts/stage-native.mjs'
const NPM_CI = 'npm ci'
const NAPI_CLI = 'node_modules/@napi-rs/cli'

function fakeDaemonTree (present, { binaryAppearsAfter = [], host = NON_LINUX_HOST } = {}) {
  const files = new Set(present)
  const commands = []
  const failures = []
  const steps = {
    host,
    exists: (relativePath) => files.has(relativePath),
    run: (cmd, args, cwd) => {
      const command = [cmd, ...args].join(' ')
      commands.push(cwd === undefined ? command : `${cwd}> ${command}`)
      if (binaryAppearsAfter.includes(command)) files.add(`dist/native/${host.binaryName}`)
    },
    fail: (message) => failures.push(message),
    log: () => {},
  }
  return { steps, commands, failures }
}

const INSTALLED = ['node_modules', NAPI_CLI]
const BUILT_DIST = [...INSTALLED, 'dist/cli.js', 'dist/webdist']

test('a fresh tree builds the core before the daemon', () => {
  const tree = fakeDaemonTree(INSTALLED, { binaryAppearsAfter: [BUILD] })

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
  assert.match(tree.failures[0], new RegExp(`dist/native/${HOST_BINARY.replaceAll('.', '\\.')}`))
  assert.match(tree.failures[0], /npm run build:core && npm run build/)
})

test('a host with no npm target stops the packaging before anything is built', () => {
  const tree = fakeDaemonTree(BUILT_DIST)

  prepareDaemon({ ...tree.steps, host: undefined })

  assert.deepEqual(tree.commands, [])
  assert.equal(tree.failures.length, 1)
  assert.match(tree.failures[0], /no native core target/)
})

test('a node_modules without @napi-rs/cli is reinstalled before the core build', () => {
  const tree = fakeDaemonTree(BUILT_DIST.filter((path) => path !== NAPI_CLI), { binaryAppearsAfter: [BUILD] })

  prepareDaemon(tree.steps)

  assert.equal(tree.commands[0], NPM_CI)
  assert.ok(tree.commands.indexOf(NPM_CI) < tree.commands.indexOf(BUILD_CORE))
})

// The AppImage must keep the glibc 2.28 floor (rust-core arch 2.3): a Linux glibc host cross-builds the core with zig
// pinned to the floor and checks it, as core-build.yml does, before anything stages it into dist/native/.
const LINUX_GNU_BINARY = 'turbollm-core.linux-x64-gnu.node'
const LINUX_GNU_HOST = { suffix: 'linux-x64-gnu', libc: 'glibc', binaryName: LINUX_GNU_BINARY, glibcFloor: '2.28' }
const CROSS_BUILD_CORE = 'npm run build:core -- --target linux-x64-gnu --cross-compile'
const CHECK_GLIBC = `core> cargo xtask check-glibc --max 2.28 bindings/node/${LINUX_GNU_BINARY}`

test('a Linux glibc host cross-builds the core against the floor and checks it before staging it', () => {
  const tree = fakeDaemonTree([...BUILT_DIST, `dist/native/${LINUX_GNU_BINARY}`], { host: LINUX_GNU_HOST })

  prepareDaemon(tree.steps)

  assert.deepEqual(tree.commands, [CROSS_BUILD_CORE, CHECK_GLIBC, STAGE_NATIVE])
  assert.deepEqual(tree.failures, [])
})

test('a Linux glibc host checks the cross-built core before building the daemon', () => {
  const tree = fakeDaemonTree(BUILT_DIST, { host: LINUX_GNU_HOST, binaryAppearsAfter: [BUILD] })

  prepareDaemon(tree.steps)

  assert.deepEqual(tree.commands, [CROSS_BUILD_CORE, CHECK_GLIBC, BUILD_WEB, BUILD])
})

for (const os of ['win32', 'darwin']) {
  test(`a ${os} host builds the core natively and runs no glibc check`, () => {
    const host = { suffix: `${os}-x64`, libc: null, binaryName: `turbollm-core.${os}-x64.node`, glibcFloor: '2.28' }
    const tree = fakeDaemonTree([...BUILT_DIST, `dist/native/${host.binaryName}`], { host })

    prepareDaemon(tree.steps)

    assert.deepEqual(tree.commands, [BUILD_CORE, STAGE_NATIVE])
  })
}
