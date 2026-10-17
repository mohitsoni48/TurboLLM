// Tests for scoreAsset and pickReleaseAsset (ADR-044).
// These cover the asset-matching logic for all supported platforms / arches,
// used by turboquantAssetUrl to pick the right release asset per OS.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreAsset,
  pickReleaseAsset,
  recommendBackendId,
  githubHeaders,
  setGithubTokenProvider,
  isRateLimited,
  availableBackends,
  provisionBackend,
  provisionTurboquant,
  renameWithRetry,
} from './download'
import type { ReleaseAsset } from './download'
import { tmpDir } from '../test-support/tmp'
import { execFileSync } from 'node:child_process'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

// ─── helpers ──────────────────────────────────────────────────────────────────

function asset(name: string): ReleaseAsset {
  return { name, browser_download_url: `https://example.com/${name}` }
}

// ─── scoreAsset ───────────────────────────────────────────────────────────────

// Non-archive formats

test('scoreAsset rejects non-archive files regardless of platform', () => {
  assert.equal(scoreAsset('llama-server-macos-arm64.dmg', 'darwin', 'arm64'), -1)
  assert.equal(scoreAsset('llama-server.sha256', 'darwin', 'arm64'), -1)
  assert.equal(scoreAsset('README.md', 'linux', 'x64'), -1)
  assert.equal(scoreAsset('llama-server', 'linux', 'x64'), -1)
})

// macOS arm64

test('scoreAsset scores macOS arm64 asset for darwin/arm64', () => {
  assert.ok(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'arm64') > 0)
})

test('scoreAsset scores darwin asset for darwin/arm64', () => {
  assert.ok(scoreAsset('llama-b9608-bin-darwin-arm64.tar.gz', 'darwin', 'arm64') > 0)
})

test('scoreAsset rejects macOS arm64 asset on darwin/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'x64'), -1)
})

test('scoreAsset rejects Linux asset on darwin/arm64', () => {
  assert.equal(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'darwin', 'arm64'), -1)
})

test('scoreAsset rejects Windows asset on darwin/arm64', () => {
  assert.equal(scoreAsset('llama-server-win-x64.zip', 'darwin', 'arm64'), -1)
})

// macOS x64

test('scoreAsset scores macOS x64 asset for darwin/x64', () => {
  assert.ok(scoreAsset('llama-bin-macos-x64.tar.gz', 'darwin', 'x64') > 0)
})

test('scoreAsset rejects macOS arm64 asset on darwin/x64', () => {
  assert.equal(scoreAsset('llama-bin-macos-arm64.tar.gz', 'darwin', 'x64'), -1)
})

// Linux x64

test('scoreAsset scores Linux x64 asset for linux/x64', () => {
  assert.ok(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'linux', 'x64') > 0)
})

test('scoreAsset scores linux ubuntu asset for linux/x64', () => {
  assert.ok(scoreAsset('llama-b9608-bin-ubuntu-vulkan-x64.tar.gz', 'linux', 'x64') > 0)
})

test('scoreAsset rejects Linux x64 asset on linux/arm64', () => {
  assert.equal(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'linux', 'arm64'), -1)
})

test('scoreAsset rejects macOS asset on linux/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'linux', 'x64'), -1)
})

// Linux arm64

test('scoreAsset scores Linux arm64 asset for linux/arm64', () => {
  assert.ok(scoreAsset('llama-bin-ubuntu-arm64.tar.gz', 'linux', 'arm64') > 0)
})

test('scoreAsset rejects Linux x64 asset on linux/arm64', () => {
  assert.equal(scoreAsset('llama-bin-ubuntu-x64.tar.gz', 'linux', 'arm64'), -1)
})

// Windows x64

test('scoreAsset scores Windows x64 asset for win32/x64', () => {
  assert.ok(scoreAsset('llama-server-win-x64.zip', 'win32', 'x64') > 0)
})

test('scoreAsset scores Windows asset named with windows for win32/x64', () => {
  assert.ok(scoreAsset('llama-b9608-bin-windows-x64.zip', 'win32', 'x64') > 0)
})

test('scoreAsset rejects Linux asset on win32/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'win32', 'x64'), -1)
})

test('scoreAsset rejects macOS asset on win32/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'win32', 'x64'), -1)
})

// Archive format preference

test('scoreAsset scores tar.gz higher than zip for same platform/arch', () => {
  const tarScore = scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'arm64')
  const zipScore = scoreAsset('llama-turboquant-macos-arm64.zip', 'darwin', 'arm64')
  assert.ok(tarScore > zipScore, `tar.gz (${tarScore}) should outrank zip (${zipScore})`)
})

// Named arch preference

test('scoreAsset scores named arch higher than unnamed arch', () => {
  const named = scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'arm64')
  const unnamed = scoreAsset('llama-turboquant-macos.tar.gz', 'darwin', 'arm64')
  assert.ok(named > unnamed, `named arch (${named}) should outrank unnamed (${unnamed})`)
})

// ─── pickReleaseAsset ─────────────────────────────────────────────────────────

test('pickReleaseAsset returns null for an empty asset list', () => {
  assert.equal(pickReleaseAsset([], 'darwin', 'arm64'), null)
})

test('pickReleaseAsset returns null when no asset matches the platform', () => {
  const assets = [
    asset('llama-linux-x64.tar.gz'),
    asset('llama-win-x64.zip'),
  ]
  assert.equal(pickReleaseAsset(assets, 'darwin', 'arm64'), null)
})

test('pickReleaseAsset returns the matching macOS asset from a mixed list', () => {
  const assets = [
    asset('llama-linux-x64-vulkan.tar.gz'),
    asset('llama-macos-arm64.tar.gz'),
    asset('llama-win-x64.zip'),
    asset('checksums.sha256'),
  ]
  const result = pickReleaseAsset(assets, 'darwin', 'arm64')
  assert.equal(result?.name, 'llama-macos-arm64.tar.gz')
})

test('pickReleaseAsset picks tar.gz over zip when both match the platform', () => {
  const assets = [
    asset('llama-macos-arm64.zip'),
    asset('llama-macos-arm64.tar.gz'),
  ]
  const result = pickReleaseAsset(assets, 'darwin', 'arm64')
  assert.equal(result?.name, 'llama-macos-arm64.tar.gz')
})

test('pickReleaseAsset returns Linux x64 asset for linux/x64', () => {
  const assets = [
    asset('llama-linux-x64-vulkan.tar.gz'),
    asset('llama-linux-x64-vulkan.zip'),
    asset('llama-macos-arm64.tar.gz'),
  ]
  const result = pickReleaseAsset(assets, 'linux', 'x64')
  assert.equal(result?.name, 'llama-linux-x64-vulkan.tar.gz')
})

test('pickReleaseAsset returns Windows asset for win32/x64', () => {
  const assets = [
    asset('llama-win-x64.zip'),
    asset('llama-linux-x64.tar.gz'),
  ]
  const result = pickReleaseAsset(assets, 'win32', 'x64')
  assert.equal(result?.name, 'llama-win-x64.zip')
})

// ─── recommendBackendId ─────────────────────────────────────────────────────
// GitHub #103: turbollm always defaulted an AMD GPU to ROCm when a ROCm prebuilt exists for
// this platform, even on AMD APUs/iGPUs (e.g. Radeon 860M) that ROCm doesn't support on
// Windows — Vulkan should win there instead. Runs on the CI machine's real platform (both
// win32 and linux ship a rocm + vulkan prebuilt), skipped elsewhere.
const hasRocmAndVulkan = process.platform === 'win32' || process.platform === 'linux'

test('recommendBackendId: AMD with a discrete GPU still picks ROCm', { skip: !hasRocmAndVulkan && 'requires a platform with both rocm and vulkan prebuilts' }, () => {
  assert.equal(recommendBackendId('amd', true, undefined, false), 'rocm')
})

test('recommendBackendId: AMD APU-only (amdApuOnly=true) skips ROCm for Vulkan', { skip: !hasRocmAndVulkan && 'requires a platform with both rocm and vulkan prebuilts' }, () => {
  assert.equal(recommendBackendId('amd', true, undefined, true), 'vulkan')
})

test('recommendBackendId: amdApuOnly is irrelevant to other vendors', { skip: process.platform !== 'win32' && 'requires a platform with a CUDA prebuilt (win32 only — no Linux CUDA prebuilt upstream)' }, () => {
  assert.equal(recommendBackendId('nvidia', true, undefined, true), 'cuda')
})



// ─── githubHeaders: the configured token must reach EVERY GitHub call ──────────
// Regression: the token saved in Settings was only threaded into the branch-selector
// route, so update checks and downloads stayed unauthenticated and kept hitting the
// 60/hour limit while a perfectly good token sat unused in the config.

test('githubHeaders: uses the ambient configured token when no explicit tokenFn is given', () => {
  setGithubTokenProvider(() => 'cfg-token')
  try {
    assert.equal(githubHeaders()['Authorization'], 'Bearer cfg-token')
  } finally {
    setGithubTokenProvider(null)
  }
})

test('githubHeaders: an explicit tokenFn still wins over the ambient one', () => {
  setGithubTokenProvider(() => 'cfg-token')
  try {
    assert.equal(githubHeaders({}, () => 'explicit')['Authorization'], 'Bearer explicit')
  } finally {
    setGithubTokenProvider(null)
  }
})

test('githubHeaders: no token configured leaves the request unauthenticated', () => {
  setGithubTokenProvider(() => '')
  const prev = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    assert.equal('Authorization' in githubHeaders(), false)
  } finally {
    setGithubTokenProvider(null)
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev
  }
})

test('githubHeaders: a throwing provider degrades to unauthenticated, never breaks the call', () => {
  setGithubTokenProvider(() => { throw new Error('store closed') })
  const prev = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    assert.equal('Authorization' in githubHeaders(), false)
  } finally {
    setGithubTokenProvider(null)
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev
  }
})

// ─── ROCm Windows asset rename (GitHub #220) ───────────────────────────────────
// llama.cpp renamed the Windows ROCm archive from `*-bin-win-hip-radeon-x64.zip` to
// `*-bin-win-rocm-<toolkit-ver>-x64.zip` between builds, which 404'd every hardcoded
// filename the moment a pinned/latest tag crossed that rename. The backend def now
// carries a pattern that matches either name so provisionBackend can resolve the real
// filename from the release's own asset list instead of guessing it.

test('availableBackends: win32 rocm carries an assetPattern matching both the old and new upstream names', { skip: process.platform !== 'win32' && 'win32-only backend list' }, () => {
  const rocm = availableBackends('b10991').find((b) => b.id === 'rocm')
  assert.ok(rocm, 'rocm backend should exist on win32/x64')
  const pattern = rocm!.assetPatterns?.[0]
  assert.ok(pattern, 'rocm backend should carry an assetPattern')
  assert.ok(pattern!.test('llama-b9608-bin-win-hip-radeon-x64.zip'), 'matches the old hip-radeon name')
  assert.ok(pattern!.test('llama-b10991-bin-win-rocm-10.0-x64.zip'), 'matches the new rocm-<ver> name')
  assert.ok(!pattern!.test('llama-b10991-bin-win-cuda-13.3-x64.zip'), 'does not match an unrelated backend asset')
})

test('provisionBackend: resolves the real asset name from the release when assetPatterns is set', { skip: process.platform !== 'win32' && 'Windows-only extraction path (PowerShell Expand-Archive)' }, async (t) => {
  const root = tmpDir('tllm-dl-rocm-')
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/releases/tags/')) {
      return new Response(
        JSON.stringify({
          tag_name: 'b10991',
          assets: [
            { name: 'llama-b10991-bin-win-cuda-13.3-x64.zip', browser_download_url: 'https://dl.example/cuda.zip' },
            { name: 'llama-b10991-bin-win-rocm-10.0-x64.zip', browser_download_url: 'https://dl.example/rocm.zip' },
          ],
        }),
        { status: 200 },
      )
    }
    // The resolved download URL — return an empty zip body; extraction failure is fine,
    // this test only asserts which URL got requested.
    return new Response(new Uint8Array(), { status: 200 })
  }) as typeof fetch

  const backend = availableBackends('b10991').find((b) => b.id === 'rocm')!
  await assert.rejects(() => provisionBackend(root, backend, 'b10991'))
  assert.ok(
    calls.some((c) => c === 'https://dl.example/rocm.zip'),
    `expected a download from the resolved rocm asset URL, got: ${JSON.stringify(calls)}`,
  )
})

// A Cancel (or a failed extraction) cleans up files extracted moments ago, which Windows AV/the indexer can still hold
// open. That delete threw EBUSY from the catch, replacing the AbortError: the route then reported "Could not install
// the cuda engine: EBUSY" instead of a quiet cancel. download.ts imports rmSync by name: syncBuiltinESMExports carries
// the patch to it.
function lockRecursiveDeletes(t: TestContext, locked: (p: string) => boolean) {
  const realRmSync = fs.rmSync
  const rm = t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (locked(String(p)) && existsSync(p)) throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' })
    return realRmSync(p, o)
  })
  syncBuiltinESMExports()
  t.after(() => {
    rm.mock.restore()
    syncBuiltinESMExports()
  })
  return rm
}

test('provisionBackend: a Cancel whose cleanup is locked is still an AbortError, not EBUSY', async (t) => {
  const root = tmpDir('tllm-dl-cancel-')
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
    return new Response('', { status: 500 })
  }) as typeof fetch
  const destDir = join(root, 'llama.cpp-b1-cpu')
  const rm = lockRecursiveDeletes(t, (p) => p === destDir)
  const ac = new AbortController()
  ac.abort()
  const backend = { id: 'cpu' as const, label: 'CPU', assets: ['llama-b1-bin.zip'], downloadBaseUrl: 'https://dl.test' }
  await assert.rejects(provisionBackend(root, backend, 'b1', undefined, ac.signal), (e: Error) => e.name === 'AbortError')
  const cleanup = rm.mock.calls.find((c) => String(c.arguments[0]) === destDir)
  assert.ok((cleanup?.arguments[1] as fs.RmOptions | undefined)?.maxRetries, 'the cleanup retries, as a Windows lock is brief')
})

test('isRateLimited: only a 403/429 WITH x-ratelimit-remaining 0 counts', () => {
  const mk = (status: number, remaining: string | null) =>
    new Response('', { status, headers: remaining === null ? {} : { 'x-ratelimit-remaining': remaining } })
  assert.equal(isRateLimited(mk(403, '0')), true)
  assert.equal(isRateLimited(mk(429, '0')), true)
  // A plain permission error (private repo / bad token) must NOT be reported as a rate limit,
  // or we would tell the user to fix a token that is already valid.
  assert.equal(isRateLimited(mk(403, null)), false)
  assert.equal(isRateLimited(mk(403, '17')), false)
  assert.equal(isRateLimited(mk(404, '0')), false)
})

// ─── provisionTurboquant: an update stages the new release, then swaps ─────────
// The update used to rmSync the install dir before even asking GitHub for the release, so being
// offline, rate-limited or dropped mid-download left the registered engine with no binary.
const tqAssetName = process.platform === 'darwin' ? 'llama-turboquant-macos-arm64.tar.gz' : 'llama-turboquant-linux-x64-vulkan.tar.gz'
const tqSkip =
  (process.platform === 'win32' || !pickReleaseAsset([asset(tqAssetName)], process.platform, process.arch)) &&
  'TurboQuant publishes no prebuilt for this OS/arch'

test('provisionTurboquant replace: a failed update leaves the working install; a complete one is swapped in', { skip: tqSkip }, async (t) => {
  const root = tmpDir('tllm-tq-')
  const tqDir = join(root, 'turboquant')
  mkdirSync(tqDir)
  writeFileSync(join(tqDir, 'llama-server'), 'tq old')
  const src = tmpDir('tllm-tq-src-')
  writeFileSync(join(src, 'llama-server'), 'tq new')
  execFileSync('tar', ['-czf', join(src, 'release.tar.gz'), '-C', src, 'llama-server'])
  const archive = readFileSync(join(src, 'release.tar.gz'))
  let download = () => new Response(null, { status: 503 })
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : String(url)
    if (!u.includes('api.github.com')) return download()
    const osTag = process.platform === 'darwin' ? 'macos' : 'linux'
    return new Response(JSON.stringify([{ tag_name: `turboquant-${osTag}-b2`, assets: [{ name: tqAssetName, browser_download_url: `https://dl.test/${tqAssetName}` }] }]))
  }) as typeof fetch

  await assert.rejects(provisionTurboquant(root, 'owner/repo', undefined, undefined, { replace: true }))
  assert.equal(readFileSync(join(tqDir, 'llama-server'), 'utf8'), 'tq old')
  assert.deepEqual(readdirSync(root), ['turboquant'])

  download = () => new Response(archive)
  const bin = await provisionTurboquant(root, 'owner/repo', undefined, undefined, { replace: true })
  assert.equal(bin, join(tqDir, 'llama-server'))
  assert.equal(readFileSync(bin, 'utf8'), 'tq new')
  assert.deepEqual(readdirSync(root), ['turboquant'])

  // Once the new install is in place the update has succeeded: a lock on the replaced one (Windows AV) must not
  // report it as failed. download.ts imports rmSync by name: syncBuiltinESMExports carries the patch to it.
  const parked = join(root, '.turboquant-old')
  const realRmSync = fs.rmSync
  const locked = t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p) === parked && existsSync(p)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return realRmSync(p, o)
  })
  syncBuiltinESMExports()
  try {
    assert.equal(await provisionTurboquant(root, 'owner/repo', undefined, undefined, { replace: true }), bin)
  } finally {
    locked.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(bin, 'utf8'), 'tq new')
  assert.ok(existsSync(parked), 'the locked old install is left behind')
  // The next update removes the leftover first.
  await provisionTurboquant(root, 'owner/repo', undefined, undefined, { replace: true })
  assert.deepEqual(readdirSync(root), ['turboquant'])

  // The staged tree was extracted moments before the swap, and Windows refuses to rename a directory while AV or the
  // indexer holds a file under it open (EPERM). The lock is brief: the swap retries rather than failing the update.
  // Only the swap runs as win32 — the lookup and extraction before it must stay this platform's.
  const stagedDir = join(root, '.turboquant-update', 'turboquant')
  const realRenameSync = fs.renameSync
  const actualPlatform = process.platform
  let refusals = 2
  const busy = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === stagedDir && refusals-- > 0) {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    }
    return realRenameSync(from, to)
  })
  syncBuiltinESMExports()
  try {
    assert.equal(await provisionTurboquant(root, 'owner/repo', undefined, undefined, { replace: true }), bin)
  } finally {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
    busy.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(busy.mock.calls.filter((c) => String(c.arguments[0]) === stagedDir).length, 3)
  assert.equal(readFileSync(bin, 'utf8'), 'tq new')
  assert.deepEqual(readdirSync(root), ['turboquant'])
})

test('provisionTurboquant replace: a failed download whose stage cleanup is locked reports the download error', { skip: tqSkip }, async (t) => {
  const root = tmpDir('tllm-tq-')
  mkdirSync(join(root, 'turboquant'))
  writeFileSync(join(root, 'turboquant', 'llama-server'), 'tq old')
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : String(url)
    if (!u.includes('api.github.com')) return new Response(null, { status: 503 })
    const osTag = process.platform === 'darwin' ? 'macos' : 'linux'
    return new Response(JSON.stringify([{ tag_name: `turboquant-${osTag}-b2`, assets: [{ name: tqAssetName, browser_download_url: `https://dl.test/${tqAssetName}` }] }]))
  }) as typeof fetch
  // Both deletes on the way out: the staged install dir (the inner provision's catch) and the stage root (the finally).
  const stageRoot = join(root, '.turboquant-update')
  lockRecursiveDeletes(t, (p) => p === stageRoot || p === join(stageRoot, 'turboquant'))
  await assert.rejects(provisionTurboquant(root, 'owner/repo', undefined, undefined, { replace: true }), /HTTP 503/)
  assert.equal(readFileSync(join(root, 'turboquant', 'llama-server'), 'utf8'), 'tq old')
})

// ─── renameWithRetry: Windows briefly refuses to rename what AV/the indexer holds open ─────────

/** Make the next renames fail with `codes` (in order, then succeed) while `process.platform` reads `platform`.
 *  renameWithRetry imports renameSync by name: syncBuiltinESMExports carries the patched function to that binding. */
function refuseRenames(t: TestContext, platform: NodeJS.Platform, codes: string[]) {
  const realRenameSync = fs.renameSync
  const mocked = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    const code = codes.shift()
    if (code) throw Object.assign(new Error(`${code}: rename`), { code })
    return realRenameSync(from, to)
  })
  const actualPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  syncBuiltinESMExports()
  t.after(() => {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
  return mocked
}

test('renameWithRetry: on Windows, a rename refused for a moment (EPERM/EBUSY/EACCES) is retried until it succeeds', async (t) => {
  const dir = tmpDir('tllm-rename-retry-')
  mkdirSync(join(dir, 'stage'))
  writeFileSync(join(dir, 'stage', 'llama-server.exe'), 'new')
  const renames = refuseRenames(t, 'win32', ['EPERM', 'EBUSY', 'EACCES'])

  await renameWithRetry(join(dir, 'stage'), join(dir, 'final'))

  assert.equal(renames.mock.callCount(), 4)
  assert.equal(readFileSync(join(dir, 'final', 'llama-server.exe'), 'utf8'), 'new')
  assert.deepEqual(readdirSync(dir), ['final'])
})

test('renameWithRetry: a lock that outlasts the retries, or any other error, still throws', async (t) => {
  const dir = tmpDir('tllm-rename-giveup-')
  mkdirSync(join(dir, 'stage'))
  t.mock.timers.enable({ apis: ['setTimeout'] })

  // Six refusals and then a rename that would work: a seventh attempt would succeed and fail this test.
  const always = refuseRenames(t, 'win32', Array(6).fill('EPERM'))
  const outcome = renameWithRetry(join(dir, 'stage'), join(dir, 'final')).then(() => 'renamed', (e) => (e as NodeJS.ErrnoException).code)
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(5_000)
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(await outcome, 'EPERM')
  assert.equal(always.mock.callCount(), 6, 'gives up after ~3 s of backoff, not forever')

  // Not a lock: thrown at once, no waiting (the timers are still mocked, so a wait would hang here).
  await assert.rejects(renameWithRetry(join(dir, 'missing'), join(dir, 'final')), { code: 'ENOENT' })
  assert.deepEqual(readdirSync(dir), ['stage'])
})

test('renameWithRetry: off Windows an EPERM is a real permission error and is thrown at once', async (t) => {
  const dir = tmpDir('tllm-rename-posix-')
  mkdirSync(join(dir, 'stage'))
  const renames = refuseRenames(t, 'linux', ['EPERM'])

  await assert.rejects(renameWithRetry(join(dir, 'stage'), join(dir, 'final')), { code: 'EPERM' })
  assert.equal(renames.mock.callCount(), 1)
  assert.deepEqual(readdirSync(dir), ['stage'])
})
