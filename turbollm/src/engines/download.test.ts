// Tests for scoreAsset and pickReleaseAsset (ADR-044).
// These cover the generic asset-matching logic for all supported platforms / arches.
// TurboQuant's resolver matches exact asset names instead (download.turboquant.test.ts).
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  downloadFile,
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
  restoreInterruptedTurboquantUpdate,
  serverBinNameFor,
} from './download'
import type { ReleaseAsset, TurboquantHw } from './download'
import { buildZipArchive } from '../test-support/zip-archive'
import { tmpDir } from '../test-support/tmp'
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

test('downloadFile: verifies a published sha256 and removes a file that fails it', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bytes = Buffer.from('engine archive bytes')
  globalThis.fetch = (async () => new Response(new Uint8Array(bytes), { status: 200 })) as typeof fetch
  const dest = join(tmpDir('tllm-dl-'), 'engine.tar.gz')
  const good = createHash('sha256').update(bytes).digest('hex')

  await downloadFile('https://dl.example/engine.tar.gz', dest, undefined, undefined, globalThis.fetch, { expectedSha256: good })
  assert.deepEqual(readFileSync(dest), bytes)

  // A truncated/corrupted 530 MB engine archive is exactly what this exists to stop: it never lands at its
  // destination, and the partial download beside it is removed too.
  const corrupt = join(tmpDir('tllm-dl-'), 'engine.tar.gz')
  await assert.rejects(
    downloadFile('https://dl.example/engine.tar.gz', corrupt, undefined, undefined, globalThis.fetch, { expectedSha256: '0'.repeat(64) }),
    /checksum_failed/,
  )
  assert.equal(existsSync(corrupt), false, 'the corrupt download never reached its destination')
  assert.equal(existsSync(corrupt + '.part'), false, 'and its partial file was removed')
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
// Every platform: the release is a .zip (read by PowerShell, bsdtar or the pure-Node reader) holding this host's
// server binary at its root, offered to a non-NVIDIA GPU machine whose one candidate is the Vulkan build.
const tqBin = serverBinNameFor()
const tqHw: TurboquantHw = {
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  arch: 'x64',
  vendor: 'amd',
  hasGpu: true,
  driverCuda: null,
  computeCaps: [],
}
const tqOs = tqHw.platform === 'win32' ? 'windows' : 'linux'
const tqAssetName = `llama-turboquant-${tqOs}-x64-vulkan.zip`

/** A TurboQuant release archive whose server binary reads `body`. */
const tqArchive = (body: string) => buildZipArchive([{ name: tqBin, data: Buffer.from(body) }])

/** GitHub offering one release with `assets` (default: the Vulkan build), each download answered by `download`. */
function serveTqRelease(t: TestContext, download: (url: string) => Response, assets = [tqAssetName]): void {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : String(url)
    if (!u.includes('api.github.com')) return download(u)
    const release = { tag_name: 'b2-1.0.0', assets: assets.map((name) => ({ name, browser_download_url: `https://dl.test/${name}` })) }
    return new Response(JSON.stringify([release]))
  }) as typeof fetch
}

/** An engines root holding a TurboQuant install of 'tq old'. */
function tqOldInstall(): string {
  const root = tmpDir('tllm-tq-')
  mkdirSync(join(root, 'turboquant'))
  writeFileSync(join(root, 'turboquant', tqBin), 'tq old')
  return root
}

/** What an engines root holds besides build/, plus whatever is still in build/ (where each candidate is staged):
 *  an entry under it is a stage left behind. */
function tqLeftovers(root: string): string[] {
  const build = join(root, 'build')
  const staged = existsSync(build) ? readdirSync(build).map((name) => `build/${name}`) : []
  return [...readdirSync(root).filter((name) => name !== 'build'), ...staged]
}

/** An install dir's files, minus the provision marker an install (or the first look at a marker-less one) writes. */
const tqFiles = (dir: string) => readdirSync(dir).filter((name) => name !== '.turbollm-provisioned')

const isTqStage = (path: string) => /[\\/]build[\\/]\.turboquant-[^\\/]+\.stage$/.test(path)

const tqUpdate = { hw: tqHw, replace: true }

test('provisionTurboquant replace: a failed update leaves the working install; a complete one is swapped in', async (t) => {
  const root = tqOldInstall()
  const tqDir = join(root, 'turboquant')
  let download = () => new Response(null, { status: 503 })
  serveTqRelease(t, () => download())

  await assert.rejects(provisionTurboquant(root, 'owner/repo', undefined, undefined, tqUpdate))
  assert.equal(readFileSync(join(tqDir, tqBin), 'utf8'), 'tq old')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])

  download = () => new Response(tqArchive('tq new'))
  const bin = await provisionTurboquant(root, 'owner/repo', undefined, undefined, tqUpdate)
  assert.equal(bin, join(tqDir, tqBin))
  assert.equal(readFileSync(bin, 'utf8'), 'tq new')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])

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
    assert.equal(await provisionTurboquant(root, 'owner/repo', undefined, undefined, tqUpdate), bin)
  } finally {
    locked.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(bin, 'utf8'), 'tq new')
  assert.ok(existsSync(parked), 'the locked old install is left behind')
  // The next update removes the leftover first.
  await provisionTurboquant(root, 'owner/repo', undefined, undefined, tqUpdate)
  assert.deepEqual(tqLeftovers(root), ['turboquant'])

  // The staged tree was extracted moments before the swap, and Windows refuses to rename a directory while AV or the
  // indexer holds a file under it open (EPERM). The lock is brief: the swap retries rather than failing the update.
  // Only the swap runs as win32 — the lookup and extraction before it must stay this platform's.
  const realRenameSync = fs.renameSync
  const actualPlatform = process.platform
  let refusals = 2
  const busy = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (isTqStage(String(from)) && refusals-- > 0) {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    }
    return realRenameSync(from, to)
  })
  syncBuiltinESMExports()
  try {
    assert.equal(await provisionTurboquant(root, 'owner/repo', undefined, undefined, tqUpdate), bin)
  } finally {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
    busy.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(busy.mock.calls.filter((c) => isTqStage(String(c.arguments[0]))).length, 3)
  assert.equal(readFileSync(bin, 'utf8'), 'tq new')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])
})

// The new install was swapped in and the old one deleted before anything ran the new binary. `verify` runs with the
// new install in place and the old one parked: when it throws, the old install goes back.
test('provisionTurboquant replace: a new install that fails verify is swapped back out for the old one', async (t) => {
  const root = tqOldInstallAndNewRelease(t)
  const seen: string[] = []
  const verify = async (bin: string) => {
    seen.push(readFileSync(bin, 'utf8'))
    throw new Error('Could not run the binary (--version and --help both failed).')
  }
  await assert.rejects(provisionTurboquant(root, 'owner/repo', undefined, undefined, { ...tqUpdate, verify }), /Could not run the binary/)
  assert.deepEqual(seen, ['tq new'], 'verify ran on the new install, in place')
  assert.equal(readFileSync(join(root, 'turboquant', tqBin), 'utf8'), 'tq old')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])
})

// The merge seam: the candidate plan (a CUDA build whose backend never loads, then Vulkan) picks the build, and the
// update's swap protocol still guards the working install — a winner that fails verify goes, the old one comes back.
test('provisionTurboquant replace: a build the candidate plan fell through to that fails verify is rolled back', async (t) => {
  const root = tqOldInstall()
  const cudaAsset = `llama-turboquant-${tqOs}-x64-cuda-12.4.zip`
  const downloads: string[] = []
  serveTqRelease(t, (url) => {
    downloads.push(url)
    return new Response(tqArchive(url.includes('cuda') ? 'tq cuda' : 'tq vulkan'))
  }, [cudaAsset, tqAssetName])
  // A Pascal GPU: CUDA 12.4 first, then Vulkan. The fake binaries list no device, so the CUDA build falls through.
  const pascal: TurboquantHw = { ...tqHw, vendor: 'nvidia', driverCuda: '13.4', computeCaps: [6.1] }
  const seen: string[] = []
  const verify = async (bin: string) => {
    seen.push(readFileSync(bin, 'utf8'))
    throw new Error('Could not run the binary (--version and --help both failed).')
  }
  await assert.rejects(
    provisionTurboquant(root, 'owner/repo', undefined, undefined, { hw: pascal, replace: true, verify }),
    /Could not run the binary/,
  )
  assert.equal(downloads.length, 2, 'the CUDA build, then the Vulkan one it fell through to')
  assert.deepEqual(seen, ['tq vulkan'], 'verify ran on the build the plan settled on, in place')
  assert.equal(readFileSync(join(root, 'turboquant', tqBin), 'utf8'), 'tq old')
  assert.deepEqual(tqFiles(join(root, 'turboquant')), [tqBin], 'without a mark of an update cut short')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])
})

// A dir with no working build in it (an install cut off before its server landed) is no working build to park and
// mark at .turboquant-old: an Install replaces it outright, and still verifies what it installed.
test('provisionTurboquant: an Install over an incomplete install dir replaces it without the update protocol', async (t) => {
  const root = tmpDir('tllm-tq-')
  const tqDir = join(root, 'turboquant')
  mkdirSync(tqDir)
  writeFileSync(join(tqDir, 'ggml-base.dll'), 'half an install')
  serveTqRelease(t, () => new Response(tqArchive('tq new')))
  const realRenameSync = fs.renameSync
  const renames = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => realRenameSync(from, to))
  syncBuiltinESMExports()
  t.after(() => {
    renames.mock.restore()
    syncBuiltinESMExports()
  })
  const verified: string[] = []
  const bin = await provisionTurboquant(root, 'owner/repo', undefined, undefined, {
    hw: tqHw,
    verify: async (b) => { verified.push(readFileSync(b, 'utf8')) },
  })
  assert.equal(readFileSync(bin, 'utf8'), 'tq new')
  assert.deepEqual(verified, ['tq new'])
  assert.ok(
    renames.mock.calls.every((c) => !String(c.arguments[1]).endsWith('.turboquant-old')),
    'nothing was parked as a working build',
  )
  assert.deepEqual(tqFiles(tqDir), [tqBin], 'the half install is gone')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])
})

test('provisionTurboquant replace: a swap vetoed by blockSwap leaves the old install and no stage', async (t) => {
  const root = tqOldInstallAndNewRelease(t)
  const verify = async () => { throw new Error('verify must not run: nothing was swapped') }
  await assert.rejects(
    provisionTurboquant(root, 'owner/repo', undefined, undefined, {
      ...tqUpdate,
      verify,
      blockSwap: () => 'A model was loaded on TurboQuant during the download.',
    }),
    (e: Error & { code?: string }) => e.code === 'engine_in_use' && /model was loaded/.test(e.message),
  )
  assert.equal(readFileSync(join(root, 'turboquant', tqBin), 'utf8'), 'tq old')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])
})

/** A TurboQuant install of 'tq old' under the returned engines root, and GitHub serving a release of 'tq new'. */
function tqOldInstallAndNewRelease(t: TestContext): string {
  const root = tqOldInstall()
  serveTqRelease(t, () => new Response(tqArchive('tq new')))
  return root
}

/** An update cut off (the daemon exited) while it probed the new build: what that leaves on disk, copied out at that
 *  moment. The live update goes on and fails. */
async function tqUpdateCutOffMidProbe(t: TestContext): Promise<string> {
  const root = tqOldInstallAndNewRelease(t)
  const exited = join(tmpDir('tllm-tq-exit-'), 'engines')
  const verify = async () => {
    fs.cpSync(root, exited, { recursive: true })
    throw new Error('the daemon exited here')
  }
  await assert.rejects(provisionTurboquant(root, 'owner/repo', undefined, undefined, { ...tqUpdate, verify }))
  assert.equal(readFileSync(join(exited, 'turboquant', tqBin), 'utf8'), 'tq new', 'cut off with the new build in place')
  assert.equal(readFileSync(join(exited, '.turboquant-old', tqBin), 'utf8'), 'tq old', 'and the old one parked')
  return exited
}

// Nothing put a parked old install back at boot: an update cut off between the swap and the new build's probe passing
// left the engine on a build that never ran here, with its only working build in a hidden folder.
test('restoreInterruptedTurboquantUpdate: an update cut off while its new build was probed gets the old one back', async (t) => {
  const root = await tqUpdateCutOffMidProbe(t)
  restoreInterruptedTurboquantUpdate(root)
  assert.equal(readFileSync(join(root, 'turboquant', tqBin), 'utf8'), 'tq old')
  assert.equal(existsSync(join(root, '.turboquant-old')), false)
  assert.deepEqual(tqFiles(join(root, 'turboquant')), [tqBin], 'its mark of a parked working build goes')

  // Cut off between parking the old install and moving the new one in: the old one goes back. (The same release.)
  const live = tqOldInstall()
  const between = join(tmpDir('tllm-tq-between-'), 'engines')
  const realRenameSync = fs.renameSync
  let cut = false
  const rename = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (!cut && String(to) === join(live, 'turboquant')) {
      cut = true // the copy as the daemon left it; the live update goes on, swaps the old install back and fails
      fs.cpSync(live, between, { recursive: true })
      throw Object.assign(new Error('the daemon exited here'), { code: 'EIO' })
    }
    return realRenameSync(from, to)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(provisionTurboquant(live, 'owner/repo', undefined, undefined, tqUpdate), /the daemon exited here/)
  } finally {
    rename.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(join(between, 'turboquant')), false, 'cut off with no install in place')
  restoreInterruptedTurboquantUpdate(between)
  assert.equal(readFileSync(join(between, 'turboquant', tqBin), 'utf8'), 'tq old')
  assert.deepEqual(tqFiles(join(between, 'turboquant')), [tqBin], 'without its mark')
  // No parked install: nothing to do.
  restoreInterruptedTurboquantUpdate(tmpDir('tllm-tq-none-'))
})

// The next update took the parked old install for a leftover of an earlier update and deleted it, parked the never-
// probed build in its place, and put THAT back when its own new build failed the probe: the working build was gone.
test('provisionTurboquant replace: the update after one cut off mid-probe never deletes the kept working build', async (t) => {
  const root = await tqUpdateCutOffMidProbe(t)
  const verify = async () => { throw new Error('Could not run the binary (--version and --help both failed).') }
  await assert.rejects(provisionTurboquant(root, 'owner/repo', undefined, undefined, { ...tqUpdate, verify }), /Could not run the binary/)
  assert.equal(readFileSync(join(root, 'turboquant', tqBin), 'utf8'), 'tq old')
  assert.deepEqual(tqLeftovers(root), ['turboquant'])
  assert.deepEqual(tqFiles(join(root, 'turboquant')), [tqBin])
})

// An Install never looked at a parked working build. When the boot could not move it back (turboquant/ gone, its
// entry left on the missing binary), an Install downloaded beside it, and the next start swapped that download out
// for it.
test('provisionTurboquant: an Install after a cut-off update the boot could not undo takes the kept build back, and the next boot keeps it', async (t) => {
  const root = await tqUpdateCutOffMidProbe(t)
  const parked = join(root, '.turboquant-old')
  const realRenameSync = fs.renameSync
  const rename = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === parked) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    return realRenameSync(from, to)
  })
  syncBuiltinESMExports()
  try {
    assert.equal(restoreInterruptedTurboquantUpdate(root), false)
  } finally {
    rename.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(join(root, 'turboquant')), false, 'the boot moved the unprobed build out, not the old one back')
  const bin = await provisionTurboquant(root, 'owner/repo', undefined, undefined, { hw: tqHw })
  assert.equal(readFileSync(bin, 'utf8'), 'tq old', 'the Install takes the working build back')
  assert.equal(existsSync(parked), false)
  assert.equal(restoreInterruptedTurboquantUpdate(root), true)
  assert.equal(readFileSync(bin, 'utf8'), 'tq old', 'and the next boot leaves what it registered in place')
  assert.deepEqual(tqFiles(join(root, 'turboquant')), [tqBin])
})

// The other side: once the new build passed, the old install it could not delete is a leftover, kept hidden at boot.
// Also once a Purge removed turboquant/ beside it: put back, the catalog showed TurboQuant installed again, and an
// Install took that old binary instead of downloading the latest.
test('provisionTurboquant replace: an update whose new build passed keeps the old one it could not delete hidden at boot, also after a Purge', async (t) => {
  const root = tqOldInstallAndNewRelease(t)
  const leftover = join(root, '.turboquant-old')
  lockRecursiveDeletes(t, (p) => p === leftover)
  await provisionTurboquant(root, 'owner/repo', undefined, undefined, { ...tqUpdate, verify: async () => {} })
  assert.equal(readFileSync(join(leftover, tqBin), 'utf8'), 'tq old', 'its delete failed')
  restoreInterruptedTurboquantUpdate(root)
  assert.equal(readFileSync(join(root, 'turboquant', tqBin), 'utf8'), 'tq new')

  fs.renameSync(join(root, 'turboquant'), join(root, `.turboquant.purge-${Date.now()}`)) // as DELETE ?purge=1 does
  restoreInterruptedTurboquantUpdate(root)
  assert.equal(existsSync(join(root, 'turboquant')), false, 'the purged engine stays uninstalled')
  const bin = await provisionTurboquant(root, 'owner/repo', undefined, undefined, { hw: tqHw })
  assert.equal(readFileSync(bin, 'utf8'), 'tq new', 'and its Install downloads the latest')
})

test('provisionTurboquant replace: a failed download whose stage cleanup is locked reports the download error', async (t) => {
  const root = tqOldInstall()
  serveTqRelease(t, () => new Response(null, { status: 503 }))
  // Every delete of the stage on the way out: the failed candidate's (its install's catch) and the finally's.
  lockRecursiveDeletes(t, isTqStage)
  await assert.rejects(provisionTurboquant(root, 'owner/repo', undefined, undefined, tqUpdate), /HTTP 503/)
  assert.equal(readFileSync(join(root, 'turboquant', tqBin), 'utf8'), 'tq old')
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
