import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { cloudflaredAssetName, cloudflaredBinName, cloudflaredBinPath, ensureCloudflared, pickCloudflaredAsset } from './provision'

// Fixture: the real asset list from cloudflare/cloudflared's latest release (tag
// 2026.6.1), fetched via `gh api repos/cloudflare/cloudflared/releases/latest` while
// building this feature. Windows/Linux ship raw executables; macOS ships a .tgz —
// verified live rather than assumed, since every other tool this codebase provisions
// (KoboldCpp, TurboQuant, llama.cpp) ships a single consistent shape per release.
const REAL_ASSETS = [
  { name: 'cloudflared-amd64.pkg', browser_download_url: 'x' },
  { name: 'cloudflared-arm64.pkg', browser_download_url: 'x' },
  { name: 'cloudflared-darwin-amd64.tgz', browser_download_url: 'https://darwin-amd64.tgz' },
  { name: 'cloudflared-darwin-arm64.tgz', browser_download_url: 'https://darwin-arm64.tgz' },
  { name: 'cloudflared-fips-linux-amd64', browser_download_url: 'x' },
  { name: 'cloudflared-fips-linux-amd64.deb', browser_download_url: 'x' },
  { name: 'cloudflared-linux-386', browser_download_url: 'x' },
  { name: 'cloudflared-linux-386.deb', browser_download_url: 'x' },
  { name: 'cloudflared-linux-amd64', browser_download_url: 'https://linux-amd64' },
  { name: 'cloudflared-linux-amd64.deb', browser_download_url: 'x' },
  { name: 'cloudflared-linux-arm', browser_download_url: 'x' },
  { name: 'cloudflared-linux-arm64', browser_download_url: 'https://linux-arm64' },
  { name: 'cloudflared-linux-arm64.deb', browser_download_url: 'x' },
  { name: 'cloudflared-linux-armhf', browser_download_url: 'x' },
  { name: 'cloudflared-windows-386.exe', browser_download_url: 'x' },
  { name: 'cloudflared-windows-386.msi', browser_download_url: 'x' },
  { name: 'cloudflared-windows-amd64.exe', browser_download_url: 'https://windows-amd64.exe' },
  { name: 'cloudflared-windows-amd64.msi', browser_download_url: 'x' },
]

test('cloudflaredAssetName: win32/x64 picks the raw exe', () => {
  assert.equal(cloudflaredAssetName('win32', 'x64'), 'cloudflared-windows-amd64.exe')
})

test('cloudflaredAssetName: win32/arm64 has no published asset', () => {
  assert.equal(cloudflaredAssetName('win32', 'arm64'), null)
})

test('cloudflaredAssetName: linux/x64 and linux/arm64 pick the raw binaries', () => {
  assert.equal(cloudflaredAssetName('linux', 'x64'), 'cloudflared-linux-amd64')
  assert.equal(cloudflaredAssetName('linux', 'arm64'), 'cloudflared-linux-arm64')
})

test('cloudflaredAssetName: darwin picks the .tgz archive for both arches', () => {
  assert.equal(cloudflaredAssetName('darwin', 'x64'), 'cloudflared-darwin-amd64.tgz')
  assert.equal(cloudflaredAssetName('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz')
})

test('pickCloudflaredAsset: finds the exact-name match in a real release asset list', () => {
  assert.equal(pickCloudflaredAsset(REAL_ASSETS, 'win32', 'x64')?.name, 'cloudflared-windows-amd64.exe')
  assert.equal(pickCloudflaredAsset(REAL_ASSETS, 'linux', 'x64')?.name, 'cloudflared-linux-amd64')
  assert.equal(pickCloudflaredAsset(REAL_ASSETS, 'linux', 'arm64')?.name, 'cloudflared-linux-arm64')
  assert.equal(pickCloudflaredAsset(REAL_ASSETS, 'darwin', 'arm64')?.name, 'cloudflared-darwin-arm64.tgz')
})

test('pickCloudflaredAsset: null when the platform/arch has no asset at all', () => {
  assert.equal(pickCloudflaredAsset(REAL_ASSETS, 'win32', 'arm64'), null)
})

test('cloudflaredBinName: platform-correct extension, no hardcoded .exe', () => {
  assert.equal(cloudflaredBinName('win32'), 'cloudflared.exe')
  assert.equal(cloudflaredBinName('linux'), 'cloudflared')
  assert.equal(cloudflaredBinName('darwin'), 'cloudflared')
})

// --- ensureCloudflared: cache and partial-download behaviour (stubbed fetch, real temp dir) ---

test('ensureCloudflared: a cached binary is returned without touching the GitHub API', async (t) => {
  const dataDir = tmpDir('cf-provision-')
  const binPath = cloudflaredBinPath(dataDir)
  mkdirSync(dirname(binPath), { recursive: true })
  writeFileSync(binPath, 'fake cloudflared')
  const realFetch = globalThis.fetch
  let calls = 0
  // An unreachable / rate-limited GitHub: every request fails.
  globalThis.fetch = (async () => {
    calls++
    throw new TypeError('fetch failed')
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  const rt = await ensureCloudflared(dataDir)
  assert.equal(rt.binPath, binPath)
  assert.equal(calls, 0)
})

test('ensureCloudflared: a download that dies mid-stream leaves nothing that reads as installed', async (t) => {
  const assetName = cloudflaredAssetName()
  if (!assetName) {
    t.skip('cloudflared publishes no asset for this platform')
    return
  }
  const dataDir = tmpDir('cf-provision-')
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls++
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('api.github.com')) {
      return new Response(
        JSON.stringify({ tag_name: '2026.6.1', assets: [{ name: assetName, browser_download_url: 'https://dl.test/cf' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // The asset body: one chunk, then the connection drops.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))
        setTimeout(() => c.error(new Error('socket hang up')), 5)
      },
    })
    return new Response(body, { status: 200, headers: { 'content-length': '1000000' } })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  await assert.rejects(ensureCloudflared(dataDir), /socket hang up/)
  assert.equal(existsSync(cloudflaredBinPath(dataDir)), false, 'no truncated binary at the final path')
  // The next start must try to download again, not take a partial file as the cached install.
  calls = 0
  await assert.rejects(ensureCloudflared(dataDir), /socket hang up/)
  assert.equal(calls, 2, 'release lookup + download attempted again')
})

// A Stop then a Start during the first download leaves the superseded flow still provisioning, so
// two first-time provisions overlap. Both streamed into the same fixed `<binPath>.part`: the first
// renamed it, and the second's rename failed with ENOENT (or a download dying part-way left a
// zeroed binary the cache check took as installed). The second call must join the first.
test('ensureCloudflared: two concurrent first-time provisions share one download', async (t) => {
  const assetName = cloudflaredAssetName()
  if (!assetName || assetName.endsWith('.tgz')) {
    t.skip('needs the raw-executable asset (Windows/Linux)')
    return
  }
  const dataDir = tmpDir('cf-provision-')
  const payload = new Uint8Array(20 * 1024).map((_, i) => (i % 251) + 1)
  const realFetch = globalThis.fetch
  let downloads = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('api.github.com')) {
      return new Response(
        JSON.stringify({ tag_name: '2026.6.1', assets: [{ name: assetName, browser_download_url: 'https://dl.test/cf' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    downloads++
    let off = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 10))
        if (off >= payload.length) return c.close()
        c.enqueue(payload.slice(off, off + 1024))
        off += 1024
      },
    })
    return new Response(body, { status: 200, headers: { 'content-length': String(payload.length) } })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  const first = ensureCloudflared(dataDir)
  await new Promise((r) => setTimeout(r, 60)) // the first download is under way
  const second = ensureCloudflared(dataDir)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.binPath, cloudflaredBinPath(dataDir))
  assert.equal(b.binPath, a.binPath)
  assert.equal(downloads, 1, 'the second call joined the first download')
  assert.deepEqual(new Uint8Array(readFileSync(a.binPath)), payload)
  assert.equal(existsSync(`${a.binPath}.part`), false)
})

// On macOS the .tgz is extracted straight into cloudflaredDir, so binPath exists while a provision
// is still writing it: a Stop then a Start in that window got the half-written binary back as
// installed instead of joining the provision. A call made while a provision runs must join it,
// whatever is at binPath already. The window is held open here by holding the download and writing
// a partial binary at binPath meanwhile, as tar does mid-extraction; that runs on every platform
// cloudflared publishes for (the raw executables of Windows/Linux reach binPath only through the
// rename, complete).
test('ensureCloudflared: a call while a provision is still writing the binary joins it', async (t) => {
  const assetName = cloudflaredAssetName()
  if (!assetName) {
    t.skip('cloudflared publishes no asset for this platform')
    return
  }
  const dataDir = tmpDir('cf-provision-')
  const binPath = cloudflaredBinPath(dataDir)
  const binary = new TextEncoder().encode('complete cloudflared')
  const payload = assetName.endsWith('.tgz') ? tgzHolding('cloudflared', binary) : binary
  let finishDownload!: () => void
  const downloadHeld = new Promise<void>((r) => { finishDownload = r })
  const realFetch = globalThis.fetch
  let downloads = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('api.github.com')) {
      return new Response(
        JSON.stringify({ tag_name: '2026.6.1', assets: [{ name: assetName, browser_download_url: 'https://dl.test/cf' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    downloads++
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        await downloadHeld
        c.enqueue(payload)
        c.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-length': String(payload.length) } })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const first = ensureCloudflared(dataDir)
  try {
    for (let waited = 0; downloads === 0; waited += 10) {
      assert.ok(waited < 10_000, 'the download never started')
      await new Promise((r) => setTimeout(r, 10))
    }
    writeFileSync(binPath, 'partial') // what tar has written of it so far
    let secondSettled = false
    const second = ensureCloudflared(dataDir).finally(() => { secondSettled = true })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(secondSettled, false, 'a half-written binary must not be returned as installed')
    finishDownload()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.binPath, binPath)
    assert.equal(b.binPath, binPath)
    assert.equal(readFileSync(binPath, 'utf8'), 'complete cloudflared')
    assert.equal(downloads, 1, 'the second call joined the first provision')
  } finally {
    finishDownload()
    await first.catch(() => {})
  }
})

/** A .tgz holding one file `name`, as the macOS release asset holds `cloudflared`. */
function tgzHolding(name: string, content: Uint8Array): Uint8Array {
  const dir = tmpDir('cf-tgz-')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', name), content)
  execFileSync('tar', ['-czf', join(dir, 'asset.tgz'), '-C', join(dir, 'src'), name])
  return new Uint8Array(readFileSync(join(dir, 'asset.tgz')))
}
