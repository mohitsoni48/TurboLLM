// Release provenance marker, install dir naming and the install core (ADR-453). The install
// tests use a fake fetch serving release JSON and zip bytes; no real network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'
import { MAX_ZIP_BYTES, ZipError } from './zip-install'
import { serverBinName } from './scan'
import type { ProbeResult } from './probe'
import type { ProvisionProgress } from './download'
import {
  RELEASE_INSTALL_MARKER,
  currentHostProfile,
  installReleaseAsset,
  readReleaseMarker,
  ReleaseInstallError,
  releaseInstallDirName,
  writeReleaseMarker,
  type ReleaseInstallPlan,
  type ReleaseProvenance,
} from './release-install'

const PROVENANCE: ReleaseProvenance = {
  repo: 'PrismML-Eng/llama.cpp',
  tag: 'prism-b10770-6684606',
  asset: 'llama-prism-b10770-6684606-bin-win-cuda-13.3-x64.zip',
  assetKey: 'llama-bin-win-cuda-13.3-x64.zip',
  publishedAt: '2026-09-25T10:00:00Z',
  prerelease: false,
  companions: ['cudart-llama-bin-win-cuda-13.3-x64.zip'],
}

test('releaseInstallDirName is owner-repo-assetKey without the archive extension', () => {
  assert.equal(releaseInstallDirName(PROVENANCE), 'PrismML-Eng-llama.cpp-llama-bin-win-cuda-13.3-x64')
  assert.equal(
    releaseInstallDirName({ repo: 'a/b', assetKey: 'x-bin-ubuntu-x64.tar.gz' }),
    'a-b-x-bin-ubuntu-x64',
  )
})

test('releaseInstallDirName falls back to release-build for a hostile key', () => {
  assert.equal(releaseInstallDirName({ repo: '', assetKey: '..' }), 'release-build')
})

test('marker round trip', () => {
  const dir = tmpDir('rel-')
  writeReleaseMarker(dir, PROVENANCE)
  assert.deepEqual(readReleaseMarker(dir), PROVENANCE)
})

test('readReleaseMarker is tolerant: null, missing, bad JSON, missing fields', () => {
  const dir = tmpDir('rel-')
  assert.equal(readReleaseMarker(null), null)
  assert.equal(readReleaseMarker(join(dir, 'nope')), null)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, RELEASE_INSTALL_MARKER), '{not json')
  assert.equal(readReleaseMarker(dir), null)
  for (const missing of ['repo', 'tag', 'assetKey'] as const) {
    const partial: Record<string, unknown> = { ...PROVENANCE }
    delete partial[missing]
    writeFileSync(join(dir, RELEASE_INSTALL_MARKER), JSON.stringify(partial))
    assert.equal(readReleaseMarker(dir), null, `missing ${missing}`)
  }
})

test('currentHostProfile reports this machine', async () => {
  const host = await currentHostProfile()
  assert.equal(host.platform, process.platform)
  assert.equal(host.arch, process.arch)
  if (host.gpuVendor !== 'nvidia') assert.equal(host.driverMaxCuda, null)
})

const REPO = 'o/r'
const PROBE_OK: ProbeResult = { version: 'b1', capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] } }
const probeOk = async () => PROBE_OK

const MAIN = 'llama-b1-bin-win-cuda-13.3-x64.zip'
const CUDART = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
const MAIN_SLUG = releaseInstallDirName({ repo: REPO, assetKey: 'llama-bin-win-cuda-13.3-x64.zip' })

interface FakeAsset {
  name: string
  bytes: Buffer
  size?: number
  contentLength?: number
  status?: number
}

function fakeGithub(assets: FakeAsset[], tag = 'b1') {
  const requested: string[] = []
  const urlOf = (name: string) => `https://objects.example.test/${name}`
  const release = {
    tag_name: tag,
    published_at: '2026-09-25T10:00:00Z',
    prerelease: false,
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url: urlOf(a.name),
      size: a.size ?? a.bytes.length,
    })),
  }
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/releases/tags/')) return Response.json(release)
    const asset = assets.find((a) => urlOf(a.name) === url)
    if (!asset) return new Response('nope', { status: 404 })
    if (asset.status) return new Response('boom', { status: asset.status })
    const headers = { 'content-length': String(asset.contentLength ?? asset.bytes.length) }
    return new Response(asset.bytes, { headers })
  }) as typeof fetch
  return { fetchImpl, requested, assetRequests: () => requested.filter((u) => u.startsWith(urlOf(''))) }
}

function zipOf(...names: string[]): Buffer {
  return buildZipArchive(names.map((name) => ({ name })))
}

const planFor = (asset: string, tag = 'b1'): ReleaseInstallPlan => ({ repo: REPO, tag, asset })
const buildDir = (root: string) => join(root, 'build')
const siblings = (root: string) => (existsSync(buildDir(root)) ? readdirSync(buildDir(root)) : [])

test('single part lands in build/<slug> with the provenance marker last', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName, 'ggml-cpu.dll') }])
  const result = await installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: gh.fetchImpl })
  assert.equal(result.found, true)
  if (!result.found) return
  assert.equal(result.binPath, join(buildDir(root), MAIN_SLUG, serverBinName))
  assert.ok(result.suggestedName.length > 0)
  const marker = readReleaseMarker(join(buildDir(root), MAIN_SLUG))
  assert.deepEqual(marker, result.provenance)
  assert.deepEqual(marker, {
    repo: REPO,
    tag: 'b1',
    asset: MAIN,
    assetKey: 'llama-bin-win-cuda-13.3-x64.zip',
    publishedAt: '2026-09-25T10:00:00Z',
    prerelease: false,
    companions: [],
  })
  assert.deepEqual(siblings(root), [MAIN_SLUG])
})

test('two parts put the cudart runtime beside the binary and record the companion', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([
    { name: MAIN, bytes: zipOf(serverBinName, 'ggml-cuda.dll') },
    { name: CUDART, bytes: zipOf('cudart64_13.dll') },
  ])
  const progress: ProvisionProgress[] = []
  const result = await installReleaseAsset(root, planFor(MAIN), {
    probeFn: probeOk,
    fetchImpl: gh.fetchImpl,
    onProgress: (p) => progress.push(p),
  })
  assert.equal(result.found, true)
  if (!result.found) return
  const dir = join(buildDir(root), MAIN_SLUG)
  assert.ok(existsSync(join(dir, 'cudart64_13.dll')))
  assert.ok(existsSync(join(dir, 'ggml-cuda.dll')))
  assert.ok(progress.some((p) => p.parts === 2 && p.part === 2))
  assert.equal(result.warning, undefined)
  assert.deepEqual(result.provenance.companions, [CUDART])
})

test('a failure on part 2 leaves no dir, no marker and no staging sibling', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([
    { name: MAIN, bytes: zipOf(serverBinName, 'ggml-cuda.dll') },
    { name: CUDART, bytes: zipOf('cudart64_13.dll'), status: 500 },
  ])
  await assert.rejects(installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: gh.fetchImpl }), /500/)
  assert.deepEqual(siblings(root), [])
})

test('a failed probe leaves the prior install at the same slug untouched', async () => {
  const root = tmpDir('relinst-')
  const prior = join(buildDir(root), MAIN_SLUG)
  mkdirSync(prior, { recursive: true })
  writeFileSync(join(prior, 'old.txt'), 'prior')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName, 'ggml-cuda.dll') }])
  const badProbe = async (): Promise<ProbeResult> => {
    throw new Error('probe boom')
  }
  await assert.rejects(installReleaseAsset(root, planFor(MAIN), { probeFn: badProbe, fetchImpl: gh.fetchImpl }), /probe boom/)
  assert.equal(readFileSync(join(prior, 'old.txt'), 'utf8'), 'prior')
  assert.deepEqual(siblings(root), [MAIN_SLUG])
})

test('re-installing the same variant refreshes the same dir with the new tag', async () => {
  const root = tmpDir('relinst-')
  const first = fakeGithub([{ name: 'llama-b1-bin-win-cpu-x64.zip', bytes: zipOf(serverBinName) }], 'b1')
  const second = fakeGithub([{ name: 'llama-b2-bin-win-cpu-x64.zip', bytes: zipOf(serverBinName) }], 'b2')
  await installReleaseAsset(root, planFor('llama-b1-bin-win-cpu-x64.zip', 'b1'), { probeFn: probeOk, fetchImpl: first.fetchImpl })
  const result = await installReleaseAsset(root, planFor('llama-b2-bin-win-cpu-x64.zip', 'b2'), {
    probeFn: probeOk,
    fetchImpl: second.fetchImpl,
  })
  assert.equal(siblings(root).length, 1)
  assert.equal(result.found && result.provenance.tag, 'b2')
  assert.equal(readReleaseMarker(join(buildDir(root), siblings(root)[0]))?.tag, 'b2')
})

test('an aborted signal mid-download rejects with AbortError and removes the stage', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName) }])
  const controller = new AbortController()
  const abortingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).includes('/releases/tags/')) {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }
    return gh.fetchImpl(input, init)
  }) as typeof fetch
  await assert.rejects(
    installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: abortingFetch, signal: controller.signal }),
    (e: Error) => e.name === 'AbortError',
  )
  assert.deepEqual(siblings(root), [])
})

test('an archive without the server binary gives found:false and leaves no dir', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf('README.txt') }])
  const result = await installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: gh.fetchImpl })
  assert.deepEqual(result, { found: false })
  assert.deepEqual(siblings(root), [])
})

test('a declared size over MAX_ZIP_BYTES throws zip_too_large before any download', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName), size: MAX_ZIP_BYTES + 1 }])
  await assert.rejects(
    installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: gh.fetchImpl }),
    (e: unknown) => e instanceof ZipError && e.code === 'zip_too_large',
  )
  assert.deepEqual(gh.assetRequests(), [])
})

test('a Content-Length over MAX_ZIP_BYTES throws zip_too_large and leaves nothing', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName), contentLength: MAX_ZIP_BYTES + 1 }])
  await assert.rejects(
    installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: gh.fetchImpl }),
    (e: unknown) => e instanceof ZipError && e.code === 'zip_too_large',
  )
  assert.deepEqual(siblings(root), [])
})

test('a companion, an unknown name and a non-archive are invalid_asset', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([
    { name: MAIN, bytes: zipOf(serverBinName) },
    { name: CUDART, bytes: zipOf('cudart64_13.dll') },
    { name: 'SHA256SUMS.txt', bytes: Buffer.from('x') },
  ])
  for (const asset of [CUDART, 'missing.zip', 'SHA256SUMS.txt']) {
    await assert.rejects(
      installReleaseAsset(root, planFor(asset), { probeFn: probeOk, fetchImpl: gh.fetchImpl }),
      (e: unknown) => e instanceof ReleaseInstallError && e.code === 'invalid_asset',
      asset,
    )
  }
  assert.deepEqual(gh.assetRequests(), [])
})

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'

test('a cancel during the last extract rejects and leaves no dir', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName) }])
  const controller = new AbortController()
  const onProgress = (p: ProvisionProgress) => {
    if (p.phase === 'extracting') controller.abort()
  }
  await assert.rejects(
    installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: gh.fetchImpl, onProgress, signal: controller.signal }),
    isAbort,
  )
  assert.deepEqual(siblings(root), [])
})

test('a cancel during the probe never swaps and the prior install stays byte-identical', async () => {
  const root = tmpDir('relinst-')
  const prior = join(buildDir(root), MAIN_SLUG)
  mkdirSync(prior, { recursive: true })
  writeFileSync(join(prior, 'old.txt'), 'prior')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName) }])
  const controller = new AbortController()
  const abortingProbe = async (): Promise<ProbeResult> => {
    controller.abort()
    return PROBE_OK
  }
  await assert.rejects(
    installReleaseAsset(root, planFor(MAIN), { probeFn: abortingProbe, fetchImpl: gh.fetchImpl, signal: controller.signal }),
    isAbort,
  )
  assert.deepEqual(readdirSync(prior), ['old.txt'])
  assert.deepEqual(siblings(root), [MAIN_SLUG])
})

test('a slug option installs into that dir instead of the derived one', async () => {
  const root = tmpDir('relinst-')
  const gh = fakeGithub([{ name: MAIN, bytes: zipOf(serverBinName) }])
  const result = await installReleaseAsset(root, planFor(MAIN), { probeFn: probeOk, fetchImpl: gh.fetchImpl, slug: 'kept-dir' })
  assert.equal(result.found && result.binPath, join(buildDir(root), 'kept-dir', serverBinName))
  assert.deepEqual(siblings(root), ['kept-dir'])
  assert.equal(readReleaseMarker(join(buildDir(root), 'kept-dir'))?.assetKey, 'llama-bin-win-cuda-13.3-x64.zip')
})
