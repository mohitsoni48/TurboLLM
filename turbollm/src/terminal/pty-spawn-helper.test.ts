// On macOS node-pty starts every pty's program through its spawn-helper, and node-pty 1.1.0's prebuilt helpers are
// installed without their exec bit, so every pty failed there with "posix_spawnp failed." (pty-spawn-helper.ts).
// These run on any OS: a fake node-pty directory, the platform injected.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensurePtySpawnHelper, ptySpawnHelperPath } from './pty-spawn-helper'
import { tmpDir } from '../test-support/tmp'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const posix = process.platform !== 'win32'
const modeOf = (p: string) => statSync(p).mode & 0o777

/** A node-pty package directory as npm installs 1.1.0 on a Mac: lib/, and both darwin prebuilds with their helper
 *  0644, as in the npm tarball. `extra` adds files (relative path → mode). */
function fakePty(extra: Record<string, number> = {}): string {
  const dir = tmpDir('tllm-pty-helper-')
  const files: Record<string, number> = {
    'lib/unixTerminal.js': 0o644,
    'prebuilds/darwin-arm64/pty.node': 0o644,
    'prebuilds/darwin-arm64/spawn-helper': 0o644,
    'prebuilds/darwin-x64/pty.node': 0o644,
    'prebuilds/darwin-x64/spawn-helper': 0o644,
    ...extra,
  }
  for (const [rel, mode] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), '')
    chmodSync(join(dir, rel), mode)
  }
  return dir
}

function modes(dir: string): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else out[relative(dir, join(d, e.name)).split('\\').join('/')] = modeOf(join(d, e.name))
    }
  }
  walk(dir)
  return out
}

test('on macOS the spawn-helper node-pty will run is made executable, once, and no other file is touched', { skip: !posix && 'POSIX file modes' }, () => {
  const dir = fakePty({ 'prebuilds/darwin-arm64/other': 0o644 })
  const before = modes(dir)
  const logged: string[] = []
  ensurePtySpawnHelper({ platform: 'darwin', arch: 'arm64', ptyDir: dir, log: (l) => logged.push(l) })
  assert.deepEqual(modes(dir), { ...before, 'prebuilds/darwin-arm64/spawn-helper': 0o755 }, 'only the arm64 helper changed, to 0755')
  assert.deepEqual(logged, [])
  // Once: a second spawn does not look again.
  chmodSync(join(dir, 'prebuilds/darwin-arm64/spawn-helper'), 0o644)
  ensurePtySpawnHelper({ platform: 'darwin', arch: 'arm64', ptyDir: dir })
  assert.equal(modeOf(join(dir, 'prebuilds/darwin-arm64/spawn-helper')), 0o644)
})

test('the helper is the one beside the pty.node node-pty loads: a build from source comes first', { skip: !posix && 'POSIX file modes' }, () => {
  const dir = fakePty({ 'build/Release/pty.node': 0o755, 'build/Release/spawn-helper': 0o644 })
  assert.equal(ptySpawnHelperPath(dir, 'darwin', 'arm64'), join(dir, 'build', 'Release', 'spawn-helper'))
  const prebuilt = fakePty()
  assert.equal(ptySpawnHelperPath(prebuilt, 'darwin', 'x64'), join(prebuilt, 'prebuilds', 'darwin-x64', 'spawn-helper'))
  const before = modes(dir)
  ensurePtySpawnHelper({ platform: 'darwin', arch: 'arm64', ptyDir: dir })
  assert.deepEqual(modes(dir), { ...before, 'build/Release/spawn-helper': 0o755 })
  assert.equal(ptySpawnHelperPath(tmpDir('tllm-pty-none-'), 'darwin', 'arm64'), null, 'no pty.node, no helper')
})

test('an executable helper is left alone, and nothing is done off macOS', { skip: !posix && 'POSIX file modes' }, () => {
  const chmods: string[] = []
  const chmod = (p: string) => { chmods.push(p) }
  const ready = fakePty({ 'prebuilds/darwin-arm64/spawn-helper': 0o755 })
  ensurePtySpawnHelper({ platform: 'darwin', arch: 'arm64', ptyDir: ready, chmod })
  for (const platform of ['linux', 'win32', 'android'] as const) ensurePtySpawnHelper({ platform, arch: 'arm64', ptyDir: fakePty(), chmod })
  assert.deepEqual(chmods, [])
})

test('a helper that cannot be made executable (a read-only install) is logged once, not thrown', { skip: !posix && 'POSIX file modes' }, () => {
  const dir = fakePty()
  const logged: string[] = []
  const chmod = () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }) }
  for (let i = 0; i < 3; i++) ensurePtySpawnHelper({ platform: 'darwin', arch: 'x64', ptyDir: dir, chmod, log: (l) => logged.push(l) })
  assert.equal(logged.length, 1, logged.join('\n'))
  assert.match(logged[0], /^\[terminal\] node-pty's spawn-helper is not executable and could not be made so \(EROFS\): terminals cannot start until it is \(chmod \+x '.*darwin-x64\/spawn-helper'\)$/)
  assert.equal(modeOf(join(dir, 'prebuilds/darwin-x64/spawn-helper')), 0o644)
})

// The daemon's ptys all start in PTYSession.doSpawn; a test that drives node-pty itself (cli.keeper.test.ts runs the
// real cli.ts in one) needs the same step, or it fails on macOS before it tests anything.
test('every load of node-pty in src, the tests included, takes the step just before it', () => {
  const LOAD = /\brequire\(\s*['"]node-pty['"]\s*\)|\bawait\s+import\(\s*['"]node-pty['"]\s*\)|^import\s+(?!type\b)[^;\n]*\bfrom\s+['"]node-pty['"]/gm
  const files: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'webdist') walk(join(d, e.name)) }
      else if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(e.name)) files.push(join(d, e.name))
    }
  }
  walk(SRC)
  const loads: string[] = []
  const without: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(LOAD)) {
      const at = `${relative(SRC, file).split('\\').join('/')}:${text.slice(0, m.index).split('\n').length}`
      loads.push(at)
      const lead = text.slice(0, m.index).split('\n').slice(-6).join('\n')
      if (!/\bensurePtySpawnHelper\(\)/.test(lead)) without.push(at)
    }
  }
  assert.ok(loads.length >= 2, `the daemon's load and the keeper test's are seen: ${loads.join(', ')}`)
  assert.deepEqual(without, [], 'call ensurePtySpawnHelper() (terminal/pty-spawn-helper.ts) right before loading node-pty')
})
