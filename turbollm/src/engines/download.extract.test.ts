// extractArchive dispatches on the archive's format, not just the platform: a Linux .zip
// (GNU tar cannot read zip) and a Windows .tar.gz (Expand-Archive cannot read tar) both
// have to extract, while every pre-existing caller keeps the exact tool it used before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, win32 } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { archiveExtractor, extractArchive } from './download'

const DEST = 'dest-dir'
const everythingExists = () => true
const nothingExists = () => false
const noEnv = {}

const plan = (archive: string, platform: NodeJS.Platform, env: { SystemRoot?: string } = noEnv, exists: (path: string) => boolean = everythingExists) =>
  archiveExtractor(archive, DEST, platform, env, exists)

test('archiveExtractor: .zip per platform', () => {
  assert.deepEqual(plan('a.zip', 'win32'), { kind: 'powershell' })
  assert.deepEqual(plan('a.zip', 'darwin'), { kind: 'tar', cmd: 'tar', args: ['-xf', 'a.zip', '-C', DEST] })
  assert.deepEqual(plan('a.zip', 'linux'), { kind: 'node-zip' })
  assert.deepEqual(plan('a.zip', 'android'), { kind: 'node-zip' })
})

test('archiveExtractor: .tar.gz and .tgz use tar -xzf off Windows', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    for (const name of ['a.tar.gz', 'a.tgz', 'A.TAR.GZ']) {
      assert.equal(plan(name, platform).kind, 'tar', `${name} on ${platform}`)
    }
  }
})

test('archiveExtractor: Windows .tar.gz uses System32 tar.exe under SystemRoot', () => {
  const systemRoot = String.raw`D:\Win`
  const found = plan('a.tar.gz', 'win32', { SystemRoot: systemRoot })
  assert.deepEqual(found, { kind: 'tar', cmd: win32.join(systemRoot, 'System32', 'tar.exe'), args: ['-xzf', 'a.tar.gz', '-C', DEST] })
})

test('archiveExtractor: Windows .tar.gz falls back to C:\\Windows when SystemRoot is unset', () => {
  const seen: string[] = []
  plan('a.tgz', 'win32', noEnv, (p) => (seen.push(p), true))
  assert.deepEqual(seen, [win32.join(String.raw`C:\Windows`, 'System32', 'tar.exe')])
})

test('archiveExtractor: Windows .tar.gz without tar.exe is unsupported', () => {
  const none = plan('a.tar.gz', 'win32', noEnv, nothingExists)
  assert.equal(none.kind, 'unsupported')
})

test('archiveExtractor: other formats are unsupported', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.equal(plan('a.7z', platform).kind, 'unsupported')
  }
})

// Every pre-existing extractArchive caller must keep the tool it used before this change.
// (cloudflared on Windows/Linux is a raw executable and never calls extractArchive.)
const EXISTING_CALLERS: Array<[string, NodeJS.Platform, string]> = [
  ['ngrok-v3-stable-windows-amd64.zip', 'win32', 'powershell'],
  ['ngrok-v3-stable-linux-amd64.tgz', 'linux', 'tar'],
  ['ngrok-v3-stable-darwin-arm64.tgz', 'darwin', 'tar'],
  ['cloudflared-darwin-arm64.tgz', 'darwin', 'tar'],
  ['cloudflared-darwin-amd64.tgz', 'darwin', 'tar'],
  ['uv-aarch64-apple-darwin.tar.gz', 'darwin', 'tar'],
  ['uv-x86_64-pc-windows-msvc.zip', 'win32', 'powershell'],
  ['uv-x86_64-unknown-linux-gnu.tar.gz', 'linux', 'tar'],
  ['cuda_nvcc.zip', 'win32', 'powershell'], // cuda-provision is Windows-only (it asserts bin/nvcc.exe)
  ['llama-b9608-bin-win-cuda-13.3-x64.zip', 'win32', 'powershell'],
  ['llama-b9608-bin-ubuntu-vulkan-x64.tar.gz', 'linux', 'tar'],
  ['llama-b9608-bin-macos-arm64.tar.gz', 'darwin', 'tar'],
  ['llama-turboquant-macos-arm64.tar.gz', 'darwin', 'tar'],
  ['llama-turboquant-linux-x64-vulkan.tar.gz', 'linux', 'tar'],
]

test('existing callers keep their extractor', () => {
  for (const [archive, platform, expected] of EXISTING_CALLERS) {
    const p = plan(archive, platform)
    assert.equal(p.kind, expected, archive + ' on ' + platform)
    if (expected === 'tar') assert.deepEqual(p, { kind: 'tar', cmd: 'tar', args: ['-xzf', archive, '-C', DEST] })
  }
})

test('extractArchive: a corrupt archive fails with code extract_failed naming the file', async () => {
  const dir = tmpDir('extract-')
  const archive = join(dir, 'x.tar.gz')
  writeFileSync(archive, randomBytes(64))
  await assert.rejects(extractArchive(archive, dir), (e: unknown) => {
    const err = e as NodeJS.ErrnoException
    assert.equal(err.code, 'extract_failed')
    assert.match(err.message, /x\.tar\.gz/)
    assert.ok(err.cause, 'keeps the original error as cause')
    return true
  })
})
