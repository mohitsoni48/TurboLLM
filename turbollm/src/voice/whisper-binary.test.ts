import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../test-support/tmp'
import {
  ANDROID_WHISPER_SERVER, ANDROID_WHISPER_SERVER_GPU, WHISPER_BUILD, installHint, installWhisperServer, managedWhisperServer, removeWhisperServer, resolveWhisperServer,
  whisperDir, whisperModelsDir, whisperReleaseAsset, whisperReleaseUrl, whisperServerDir, whisperServerEnv, type InstallDeps,
} from './whisper-binary'

const POSIX = process.platform !== 'win32'

/** Stand-ins for the network and the unpacker: the "archive" is a dummy file, and extraction lays out what whisper.cpp's
 *  tarball does (a folder holding the server and a library beside it). */
function fakeInstallDeps(over: Partial<InstallDeps> = {}): InstallDeps & { downloads: { url: string; dest: string; sha256?: string }[] } {
  const downloads: { url: string; dest: string; sha256?: string }[] = []
  return {
    platform: 'linux',
    arch: 'x64',
    downloads,
    download: async (url, dest, _progress, _signal, _fetch, opts) => {
      downloads.push({ url, dest, sha256: opts?.expectedSha256 })
      writeFileSync(dest, 'archive')
    },
    extract: async (_archive, destDir) => {
      mkdirSync(join(destDir, 'sub'), { recursive: true })
      writeFileSync(join(destDir, 'sub', 'whisper-server'), '#!/bin/sh\n')
      writeFileSync(join(destDir, 'sub', 'libwhisper.so'), 'lib')
    },
    ...over,
  }
}

const NO_ENV = { PATH: '' }

test('whisperReleaseAsset has an archive for linux and windows on x64 and arm64 and none elsewhere', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
    const asset = whisperReleaseAsset(platform, arch)
    assert.ok(asset, `${platform}-${arch}`)
    assert.match(asset.sha256, /^[0-9a-f]{64}$/)
  }
  assert.equal(whisperReleaseAsset('darwin', 'arm64'), null)
  assert.equal(whisperReleaseAsset('linux', 'ia32'), null)
  assert.equal(whisperReleaseAsset('android', 'arm64'), null)
})

test('every release archive has its own name and hash', () => {
  const assets = [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']].map(([p, a]) => whisperReleaseAsset(p as NodeJS.Platform, a)!)
  assert.equal(new Set(assets.map((a) => a.name)).size, 4)
  assert.equal(new Set(assets.map((a) => a.sha256)).size, 4)
})

test('whisperReleaseUrl points at the pinned tag of whisper.cpp on GitHub', () => {
  const asset = whisperReleaseAsset('linux', 'x64')!
  assert.equal(whisperReleaseUrl(asset), `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}/${asset.name}`)
})

test('installHint sends the packaged Android app to its bundle even on an arch that has a release archive', () => {
  assert.equal(installHint('android', 'x64', { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/data/app/lib' }), 'android')
  assert.equal(installHint('android', 'arm64', { TURBOLLM_ANDROID_NATIVE_LIB_DIR: '/data/app/lib' }), 'android')
})

test('installHint: macOS says Homebrew, a supported desktop says nothing, anything else says build', () => {
  assert.equal(installHint('darwin', 'arm64', {}), 'homebrew')
  assert.equal(installHint('linux', 'x64', {}), null)
  assert.equal(installHint('win32', 'arm64', {}), null)
  assert.equal(installHint('freebsd', 'x64', {}), 'build')
  assert.equal(installHint('linux', 'ia32', {}), 'build')
  // Android outside the packaged app (e.g. Termux) has no env var and no archive: nothing for it to install.
  assert.equal(installHint('android', 'arm64', {}), 'build')
})

test('the managed paths all sit under <dataDir>/whisper', () => {
  assert.equal(whisperDir('/d'), join('/d', 'whisper'))
  assert.equal(whisperModelsDir('/d'), join('/d', 'whisper', 'models'))
  assert.equal(whisperServerDir('/d'), join('/d', 'whisper', 'server'))
})

test('a custom path that is a file wins over a managed install and one on the PATH', async () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  await installWhisperServer(dir, undefined, undefined, fakeInstallDeps())
  const onPath = join(dir, 'bin')
  mkdirSync(onPath)
  writeFileSync(join(onPath, 'whisper-server'), '')
  chmodSync(join(onPath, 'whisper-server'), 0o755)
  const custom = join(dir, 'my-whisper')
  writeFileSync(custom, '')

  const r = resolveWhisperServer({ dataDir: dir, customPath: `  ${custom} `, platform: 'linux', env: { PATH: onPath } })
  assert.deepEqual(r, { ok: true, path: custom, source: 'custom', version: '' })
})

test('a custom path with no file is custom_missing and does not fall through to the PATH', () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  const onPath = join(dir, 'bin')
  mkdirSync(onPath)
  writeFileSync(join(onPath, 'whisper-server'), '')
  chmodSync(join(onPath, 'whisper-server'), 0o755)

  // A typo in Settings must not be hidden by quietly running another binary.
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: join(dir, 'typo'), platform: 'linux', env: { PATH: onPath } }), { ok: false, reason: 'custom_missing' })
  // A directory is not a binary either.
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: onPath, platform: 'linux', env: { PATH: onPath } }), { ok: false, reason: 'custom_missing' })
})

test('on Android the bundled libwhisper_server.so is found in the native lib dir, ahead of a managed install', async () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  const lib = join(dir, 'nativelib')
  mkdirSync(lib)
  const env = { PATH: '', TURBOLLM_ANDROID_NATIVE_LIB_DIR: lib }
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'android', env }), { ok: false, reason: 'none' })

  writeFileSync(join(lib, ANDROID_WHISPER_SERVER), '')
  await installWhisperServer(dir, undefined, undefined, fakeInstallDeps())
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'android', env }), {
    ok: true, path: join(lib, ANDROID_WHISPER_SERVER), source: 'bundled', version: '',
  })
})

test('the Android GPU build is reported as gpuPath only when it sits beside the CPU build', () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  const lib = join(dir, 'nativelib')
  mkdirSync(lib)
  const env = { PATH: '', TURBOLLM_ANDROID_NATIVE_LIB_DIR: lib }
  const resolve = (platform: NodeJS.Platform = 'android') => resolveWhisperServer({ dataDir: dir, customPath: '', platform, env })

  // The GPU file alone is not a server to run: the CPU build is what the pair falls back to.
  writeFileSync(join(lib, ANDROID_WHISPER_SERVER_GPU), '')
  assert.deepEqual(resolve(), { ok: false, reason: 'none' })

  writeFileSync(join(lib, ANDROID_WHISPER_SERVER), '')
  assert.deepEqual(resolve(), {
    ok: true, path: join(lib, ANDROID_WHISPER_SERVER), source: 'bundled', version: '', gpuPath: join(lib, ANDROID_WHISPER_SERVER_GPU),
  })
  // Other platforms never see the bundle, so never a gpuPath.
  assert.deepEqual(resolve('linux'), { ok: false, reason: 'none' })
})

test('the Android CPU build alone resolves as bundled with no gpuPath key', () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  const lib = join(dir, 'nativelib')
  mkdirSync(lib)
  writeFileSync(join(lib, ANDROID_WHISPER_SERVER), '')
  const r = resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'android', env: { PATH: '', TURBOLLM_ANDROID_NATIVE_LIB_DIR: lib } })
  assert.deepEqual(r, { ok: true, path: join(lib, ANDROID_WHISPER_SERVER), source: 'bundled', version: '' })
  assert.equal('gpuPath' in r, false)
})

test('the Android bundle is ignored on other platforms', () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  writeFileSync(join(dir, ANDROID_WHISPER_SERVER), '')
  const r = resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'freebsd', env: { PATH: '', TURBOLLM_ANDROID_NATIVE_LIB_DIR: dir } })
  assert.deepEqual(r, { ok: false, reason: 'none' })
})

test('a managed install is found with its release tag, and only once the marker file is there', async () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  assert.equal(managedWhisperServer(dir, 'linux'), null)

  const installed = await installWhisperServer(dir, undefined, undefined, fakeInstallDeps())
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'linux', env: NO_ENV }), {
    ok: true, path: installed.path, source: 'managed', version: WHISPER_BUILD,
  })

  // An install that did not finish has the binary but no marker.
  const half = tmpDir('tllm-whisper-half-')
  mkdirSync(whisperServerDir(half), { recursive: true })
  writeFileSync(join(whisperServerDir(half), 'whisper-server'), '')
  assert.equal(managedWhisperServer(half, 'linux'), null)
  assert.deepEqual(resolveWhisperServer({ dataDir: half, customPath: '', platform: 'freebsd', env: NO_ENV }), { ok: false, reason: 'none' })
})

test('a binary on the PATH is found when it is executable, and a non-executable one is skipped', { skip: !POSIX && 'POSIX permission bits' }, () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  const plain = join(dir, 'plain')
  const exec = join(dir, 'exec')
  mkdirSync(plain)
  mkdirSync(exec)
  writeFileSync(join(plain, 'whisper-server'), '')
  chmodSync(join(plain, 'whisper-server'), 0o644)
  writeFileSync(join(exec, 'whisper-server'), '')
  chmodSync(join(exec, 'whisper-server'), 0o755)

  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'freebsd', env: { PATH: plain } }), { ok: false, reason: 'none' })
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'freebsd', env: { PATH: [plain, exec].join(':') } }), {
    ok: true, path: join(exec, 'whisper-server'), source: 'system', version: '',
  })
})

test('nothing anywhere resolves to reason none, with or without a PATH', () => {
  const dir = tmpDir('tllm-whisper-resolve-')
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'freebsd', env: { PATH: join(dir, 'empty') } }), { ok: false, reason: 'none' })
  assert.deepEqual(resolveWhisperServer({ dataDir: dir, customPath: '', platform: 'freebsd', env: {} }), { ok: false, reason: 'none' })
})

test('installWhisperServer installs the binary and its libraries, reports the pinned build, and cleans up after itself', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  const deps = fakeInstallDeps()
  const progress: string[] = []
  const result = await installWhisperServer(dir, (p) => progress.push(p.phase), undefined, deps)

  assert.equal(result.version, WHISPER_BUILD)
  assert.equal(result.path, join(whisperServerDir(dir), 'sub', 'whisper-server'))
  assert.ok(existsSync(join(whisperServerDir(dir), 'sub', 'libwhisper.so')))
  if (POSIX) assert.equal(statSync(result.path).mode & 0o777, 0o755)
  assert.equal(readFileSync(join(whisperServerDir(dir), '.turbollm-provisioned'), 'utf8').trim(), WHISPER_BUILD)
  assert.deepEqual(progress, ['downloading', 'extracting'])

  const asset = whisperReleaseAsset('linux', 'x64')!
  assert.equal(deps.downloads.length, 1)
  assert.equal(deps.downloads[0].url, whisperReleaseUrl(asset))
  assert.equal(deps.downloads[0].sha256, asset.sha256)

  // The archive was staged inside the folder that was then swapped in; neither it nor any staging dir remains.
  assert.equal(existsSync(join(whisperServerDir(dir), asset.name)), false)
  assert.deepEqual(readdirSync(whisperDir(dir)), ['server'])
})

test('installWhisperServer pins the hash of the archive for the platform it installs for', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  const deps = fakeInstallDeps({ platform: 'linux', arch: 'arm64' })
  await installWhisperServer(dir, undefined, undefined, deps)
  assert.equal(deps.downloads[0].sha256, whisperReleaseAsset('linux', 'arm64')!.sha256)
  assert.notEqual(deps.downloads[0].sha256, whisperReleaseAsset('linux', 'x64')!.sha256)
})

test('a download that fails leaves the previous install untouched and no staging folder behind', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  const first = await installWhisperServer(dir, undefined, undefined, fakeInstallDeps())
  writeFileSync(join(whisperServerDir(dir), 'sub', 'keep-me'), 'x')

  await assert.rejects(
    installWhisperServer(dir, undefined, undefined, fakeInstallDeps({ download: async () => { throw new Error('connection reset') } })),
    /connection reset/,
  )

  assert.deepEqual(managedWhisperServer(dir, 'linux'), { path: first.path, version: WHISPER_BUILD })
  assert.ok(existsSync(join(whisperServerDir(dir), 'sub', 'keep-me')))
  assert.deepEqual(readdirSync(whisperDir(dir)).filter((n) => /^\.server-.*\.tmp$/.test(n)), [])
})

test('an install replaces the previous one whole, so files only the old one had are gone', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  await installWhisperServer(dir, undefined, undefined, fakeInstallDeps())
  writeFileSync(join(whisperServerDir(dir), 'sub', 'stale-lib.so'), 'x')
  await installWhisperServer(dir, undefined, undefined, fakeInstallDeps())
  assert.equal(existsSync(join(whisperServerDir(dir), 'sub', 'stale-lib.so')), false)
})

test('an archive without the server binary fails with extract_failed and leaves nothing installed', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  const deps = fakeInstallDeps({
    extract: async (_archive, destDir) => {
      writeFileSync(join(destDir, 'README'), 'no binary here')
    },
  })
  await assert.rejects(installWhisperServer(dir, undefined, undefined, deps), (e: Error & { code?: string }) => e.code === 'extract_failed')
  assert.equal(managedWhisperServer(dir, 'linux'), null)
  assert.deepEqual(readdirSync(whisperDir(dir)), [])
})

test('a machine with no release archive fails with no_release_asset before any download', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  const deps = fakeInstallDeps({ platform: 'darwin', arch: 'arm64' })
  await assert.rejects(installWhisperServer(dir, undefined, undefined, deps), (e: Error & { code?: string }) => e.code === 'no_release_asset')
  assert.equal(deps.downloads.length, 0)
  assert.equal(existsSync(whisperDir(dir)), false)
})

test('a cancel that lands after extraction rejects and leaves no install or staging folder', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  const abort = new AbortController()
  const base = fakeInstallDeps()
  const deps = fakeInstallDeps({
    extract: async (archive, destDir) => {
      await base.extract!(archive, destDir)
      abort.abort()
    },
  })
  await assert.rejects(installWhisperServer(dir, undefined, abort.signal, deps), (e: Error) => e.name === 'AbortError')
  assert.equal(managedWhisperServer(dir, 'linux'), null)
  assert.deepEqual(readdirSync(whisperDir(dir)), [])
})

test('two installs started together share one download', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  const deps = fakeInstallDeps()
  const [a, b] = await Promise.all([installWhisperServer(dir, undefined, undefined, deps), installWhisperServer(dir, undefined, undefined, deps)])
  assert.equal(deps.downloads.length, 1)
  assert.deepEqual(a, b)
})

test('removeWhisperServer deletes the managed install and says whether there was one', async () => {
  const dir = tmpDir('tllm-whisper-install-')
  assert.equal(await removeWhisperServer(dir), false)
  await installWhisperServer(dir, undefined, undefined, fakeInstallDeps())
  assert.equal(await removeWhisperServer(dir), true)
  assert.equal(managedWhisperServer(dir, 'linux'), null)
  assert.equal(existsSync(whisperServerDir(dir)), false)
})

test('whisperServerEnv puts the binary folder first on LD_LIBRARY_PATH and keeps what was there', () => {
  const env = { PATH: '/bin', LD_LIBRARY_PATH: '/opt/lib' }
  const out = whisperServerEnv('/w/server/whisper-server', 'linux', env)
  assert.equal(out.LD_LIBRARY_PATH, '/w/server:/opt/lib')
  assert.equal(out.PATH, '/bin')
  assert.equal(out.DYLD_LIBRARY_PATH, undefined)
  assert.equal(env.LD_LIBRARY_PATH, '/opt/lib', 'the caller\'s env is not modified')
  assert.equal(whisperServerEnv('/w/server/whisper-server', 'linux', {}).LD_LIBRARY_PATH, '/w/server')
})

test('whisperServerEnv also sets DYLD_LIBRARY_PATH on macOS', () => {
  const out = whisperServerEnv('/w/server/whisper-server', 'darwin', { DYLD_LIBRARY_PATH: '/x' })
  assert.equal(out.DYLD_LIBRARY_PATH, '/w/server:/x')
  assert.equal(out.LD_LIBRARY_PATH, '/w/server')
})

test('whisperServerEnv leaves the environment alone on Windows, where the DLLs load from beside the exe', () => {
  const env = { PATH: 'C:\\x' }
  assert.equal(whisperServerEnv('C:\\w\\whisper-server.exe', 'win32', env), env)
})
