// The CUDA runtime a Windows CUDA engine build does not carry (ADR-175, ADR-453): which official runtime
// pack matches a build, and that a release install fetches it when the release ships none. A fake fetch
// serves the release JSON and the zip bytes; there is no real network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'
import { serverBinName } from './scan'
import type { ProbeResult } from './probe'
import { classifyReleaseAsset } from './release-assets'
import { installReleaseAsset } from './release-install'
import { cudaMajorOfBuildName, pickOfficialRuntimePack } from './cuda-runtime'

const pack = (name: string) => classifyReleaseAsset({ name, browser_download_url: `https://x.test/${name}` })

test('cudaMajorOfBuildName reads the major from every spelling forks use', () => {
  assert.equal(cudaMajorOfBuildName('app-b12649-mix-windows-x64-cuda13-portable.zip'), 13)
  assert.equal(cudaMajorOfBuildName('llama-b1-bin-win-cuda-13.3-x64.zip'), 13)
  assert.equal(cudaMajorOfBuildName('llama-b1-bin-win-cuda-12.4-x64.zip'), 12)
  assert.equal(cudaMajorOfBuildName('fork-win-x64-cu124.zip'), 12)
  assert.equal(cudaMajorOfBuildName('fork-win-x64-cu12.zip'), 12)
})

test('cudaMajorOfBuildName is null when the name carries no CUDA version', () => {
  assert.equal(cudaMajorOfBuildName('llama-b1-bin-win-cpu-x64.zip'), null)
  assert.equal(cudaMajorOfBuildName('llama-b1-bin-win-vulkan-x64.zip'), null)
})

test('pickOfficialRuntimePack takes the newest minor of the same major and architecture', () => {
  const assets = [
    pack('cudart-llama-bin-win-cuda-12.4-x64.zip'),
    pack('cudart-llama-bin-win-cuda-13.1-x64.zip'),
    pack('cudart-llama-bin-win-cuda-13.3-x64.zip'),
    pack('cudart-llama-bin-win-cuda-13.4-arm64.zip'),
    pack('llama-b1-bin-win-cuda-13.3-x64.zip'),
  ]
  assert.equal(pickOfficialRuntimePack(assets, 13, 'x64')?.name, 'cudart-llama-bin-win-cuda-13.3-x64.zip')
  assert.equal(pickOfficialRuntimePack(assets, 12, 'x64')?.name, 'cudart-llama-bin-win-cuda-12.4-x64.zip')
  assert.equal(pickOfficialRuntimePack(assets, 13, 'arm64')?.name, 'cudart-llama-bin-win-cuda-13.4-arm64.zip')
})

test('pickOfficialRuntimePack is null when no pack matches', () => {
  const assets = [pack('cudart-llama-bin-win-cuda-12.4-x64.zip'), pack('llama-b1-bin-win-cuda-13.3-x64.zip')]
  assert.equal(pickOfficialRuntimePack(assets, 13, 'x64'), null)
  assert.equal(pickOfficialRuntimePack([], 12, 'x64'), null)
})

const FORK = 'unslothai/llama.cpp'
const MAIN_NO_COMPANION = 'app-b1-windows-x64-cuda13-portable.zip'
const OFFICIAL_PACK = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
const probeOk = async (): Promise<ProbeResult> => ({ version: 'b1', capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] } })
const onWindows = { skip: process.platform !== 'win32' ? 'the missing-runtime warning is Windows-only' : false }

interface FakeAsset {
  name: string
  bytes: Buffer
}
const zipOf = (...names: string[]) => buildZipArchive(names.map((name) => ({ name })))

/** One fake GitHub: `releases` maps `owner/repo` to its release JSON assets, downloads come from `files`. */
function fakeGithub(releases: Record<string, FakeAsset[]>, officialLookupStatus = 200) {
  const requested: string[] = []
  const urlOf = (name: string) => `https://objects.example.test/${name}`
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    const lookup = /\/repos\/([^/]+\/[^/]+)\/releases\/tags\//.exec(url)
    if (lookup) {
      const assets = releases[lookup[1]]
      if (!assets || (lookup[1] === 'ggml-org/llama.cpp' && officialLookupStatus !== 200)) {
        return new Response('nope', { status: officialLookupStatus === 200 ? 404 : officialLookupStatus })
      }
      return Response.json({
        tag_name: 'tag',
        published_at: '2026-09-25T10:00:00Z',
        prerelease: false,
        assets: assets.map((a) => ({ name: a.name, browser_download_url: urlOf(a.name), size: a.bytes.length })),
      })
    }
    const file = Object.values(releases).flat().find((a) => urlOf(a.name) === url)
    return file ? new Response(file.bytes, { headers: { 'content-length': String(file.bytes.length) } }) : new Response('nope', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, requested, officialLookups: () => requested.filter((u) => u.includes('/repos/ggml-org/llama.cpp/')) }
}

const planFor = (asset: string) => ({ repo: FORK, tag: 'tag', asset })
const onlyInstalledDir = (root: string) => join(root, 'build', readdirSync(join(root, 'build'))[0])

test('a CUDA release asset with no runtime companion gets the official runtime beside the binary', async () => {
  const root = tmpDir('cudart-')
  const gh = fakeGithub({
    [FORK]: [{ name: MAIN_NO_COMPANION, bytes: zipOf(serverBinName, 'ggml-cuda.dll') }],
    'ggml-org/llama.cpp': [{ name: OFFICIAL_PACK, bytes: zipOf('cudart64_13.dll', 'cublas64_13.dll', 'cublasLt64_13.dll') }],
  })
  const result = await installReleaseAsset(root, planFor(MAIN_NO_COMPANION), { probeFn: probeOk, fetchImpl: gh.fetchImpl })
  assert.equal(result.found, true)
  if (!result.found) return
  const dir = onlyInstalledDir(root)
  for (const dll of ['cudart64_13.dll', 'cublas64_13.dll', 'cublasLt64_13.dll', 'ggml-cuda.dll']) {
    assert.ok(existsSync(join(dir, dll)), `${dll} sits beside the binary`)
  }
  assert.equal(result.warning, undefined)
  assert.deepEqual(result.provenance.companions, [OFFICIAL_PACK])
})

test('a release that ships its own matching runtime never asks the official release for one', async () => {
  const root = tmpDir('cudart-')
  const main = 'llama-b1-bin-win-cuda-13.3-x64.zip'
  const own = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
  const gh = fakeGithub({
    [FORK]: [
      { name: main, bytes: zipOf(serverBinName, 'ggml-cuda.dll') },
      { name: own, bytes: zipOf('cudart64_13.dll') },
    ],
  })
  const result = await installReleaseAsset(root, planFor(main), { probeFn: probeOk, fetchImpl: gh.fetchImpl })
  assert.equal(result.found, true)
  assert.deepEqual(gh.officialLookups(), [])
})

test('a build that is not CUDA never asks the official release for a runtime', async () => {
  const root = tmpDir('cudart-')
  const main = 'llama-b1-bin-win-cpu-x64.zip'
  const gh = fakeGithub({ [FORK]: [{ name: main, bytes: zipOf(serverBinName, 'ggml-cpu.dll') }] })
  const result = await installReleaseAsset(root, planFor(main), { probeFn: probeOk, fetchImpl: gh.fetchImpl })
  assert.equal(result.found, true)
  assert.deepEqual(gh.officialLookups(), [])
})

test('when the official runtime cannot be fetched the install still lands, with the warning', onWindows, async () => {
  const root = tmpDir('cudart-')
  const gh = fakeGithub(
    { [FORK]: [{ name: MAIN_NO_COMPANION, bytes: zipOf(serverBinName, 'ggml-cuda.dll') }] },
    503,
  )
  const result = await installReleaseAsset(root, planFor(MAIN_NO_COMPANION), { probeFn: probeOk, fetchImpl: gh.fetchImpl })
  assert.equal(result.found, true)
  if (!result.found) return
  assert.equal(result.warning?.code, 'missing_cudart')
  assert.deepEqual(result.provenance.companions, [])
  assert.ok(!existsSync(join(onlyInstalledDir(root), 'cudart64_13.dll')))
})

test('the official release has no pack for this CUDA major: the install lands with the warning', onWindows, async () => {
  const root = tmpDir('cudart-')
  const gh = fakeGithub({
    [FORK]: [{ name: 'app-b1-windows-x64-cuda14-portable.zip', bytes: zipOf(serverBinName, 'ggml-cuda.dll') }],
    'ggml-org/llama.cpp': [{ name: OFFICIAL_PACK, bytes: zipOf('cudart64_13.dll') }],
  })
  const result = await installReleaseAsset(root, planFor('app-b1-windows-x64-cuda14-portable.zip'), {
    probeFn: probeOk,
    fetchImpl: gh.fetchImpl,
  })
  assert.equal(result.found, true)
  if (!result.found) return
  assert.equal(result.warning?.code, 'missing_cudart')
})
