import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
