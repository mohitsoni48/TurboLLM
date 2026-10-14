import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assetKey,
  classifyReleaseAsset,
  companionsFor,
  parseRepoInput,
  rankReleaseAssets,
  type ClassifiedAsset,
  type HostProfile,
  type RankedAsset,
} from './release-assets'
import {
  assetsNamed,
  BEELLAMA_V047,
  KOBOLDCPP_V1_122_1,
  OFFICIAL_B9608,
  PRISM_B10770,
  TURBOQUANT_B10298,
} from './release-assets.fixtures'

function classify(name: string): ClassifiedAsset {
  return classifyReleaseAsset(assetsNamed([name])[0]!)
}

// classifyReleaseAsset

test('classify: Windows CUDA zip carries os, arch, backend, version and archive', () => {
  const c = classify('llama-prism-b10770-6684606-bin-win-cuda-13.3-x64.zip')
  assert.deepEqual(
    { os: c.os, arch: c.arch, backend: c.backend, cuda: c.cudaVersion, archive: c.archive, companion: c.companion },
    { os: 'windows', arch: 'x64', backend: 'cuda', cuda: '13.3', archive: 'zip', companion: null },
  )
})

test('classify: a cudart-prefixed archive is a companion that still reports its CUDA version', () => {
  const c = classify('cudart-llama-bin-win-cuda-13.3-x64.zip')
  assert.equal(c.companion, 'cudart')
  assert.equal(c.cudaVersion, '13.3')
  assert.equal(c.backend, 'cuda')
})

test('classify: a cudart token in the middle of the name (BeeLlama) is a companion too', () => {
  const c = classify('beellama-v0.4.7-cudart-win-cuda-12.4-x64.zip')
  assert.equal(c.companion, 'cudart')
  assert.equal(c.cudaVersion, '12.4')
})

test('classify: win-hip-radeon is rocm', () => {
  assert.equal(classify('llama-b1-bin-win-hip-radeon-x64.zip').backend, 'rocm')
})

test('classify: ubuntu sycl fp16 is linux sycl', () => {
  const c = classify('llama-b1-bin-ubuntu-sycl-fp16-x64.tar.gz')
  assert.deepEqual([c.os, c.backend, c.archive], ['linux', 'sycl', 'tar.gz'])
})

test('classify: macOS with no backend token is metal; kleidiai is ignored', () => {
  const c = classify('llama-b1-bin-macos-arm64-kleidiai.tar.gz')
  assert.deepEqual([c.os, c.arch, c.backend], ['macos', 'arm64', 'metal'])
})

test('classify: an xcframework names no operating system', () => {
  assert.equal(classify('llama-b1-xcframework.zip').os, null)
  assert.equal(classify('llama-b9608-ui.tar.gz').os, null)
})

test('classify: android arm64 tar.gz', () => {
  const c = classify('llama-b1-bin-android-arm64.tar.gz')
  assert.deepEqual([c.os, c.arch, c.archive], ['android', 'arm64', 'tar.gz'])
})

test('classify: unknown architectures are other, never accepted as x64', () => {
  assert.equal(classify('llama-b9608-bin-ubuntu-s390x.tar.gz').arch, 'other')
})

test('classify: backends that are not selectable families map to other', () => {
  assert.equal(classify('llama-b9608-bin-ubuntu-openvino-2026.0-x64.tar.gz').backend, 'other')
})

test('classify: opencl adreno arm64 on Windows', () => {
  const c = classify('llama-b9608-bin-win-opencl-adreno-arm64.zip')
  assert.deepEqual([c.os, c.arch, c.backend], ['windows', 'arm64', 'opencl'])
})

test('classify: no architecture token means arch null', () => {
  assert.equal(classify('llama-turboquant-macos-arm64.tar.gz').arch, 'arm64')
  assert.equal(classify('llama-b1-bin-ubuntu-x64.tar.gz').arch, 'x64')
  assert.equal(classify('thing-linux.tar.gz').arch, null)
})

test('classify: x86_64 is x64', () => {
  assert.equal(classify('thing-linux-x86_64.tar.gz').arch, 'x64')
})

test('classify: darwin is macOS, never Windows', () => {
  assert.equal(classify('thing-darwin-arm64.tar.gz').os, 'macos')
})

test('classify: koboldcpp-mac-arm64 is macOS but not an archive', () => {
  const c = classify('koboldcpp-mac-arm64')
  assert.equal(c.os, 'macos')
  assert.equal(c.archive, null)
})

test('classify: SHA256SUMS.txt and bare exes are not archives', () => {
  assert.equal(classify('SHA256SUMS.txt').archive, null)
  assert.equal(classify('koboldcpp.exe').archive, null)
})

test('classify: .tgz is tar.gz', () => {
  assert.equal(classify('thing-linux-x64.tgz').archive, 'tar.gz')
})

test('classify: an explicit cpu token is cpu and a missing one is cpu on non-mac', () => {
  assert.equal(classify('llama-turboquant-linux-x64-cpu.tar.gz').backend, 'cpu')
  assert.equal(classify('llama-b1-bin-ubuntu-x64.tar.gz').backend, 'cpu')
})

test('classify: size comes from the release JSON when present, else null', () => {
  assert.equal(classifyReleaseAsset({ name: 'a-win-x64.zip', browser_download_url: 'u', size: 5 } as never).size, 5)
  assert.equal(classify('a-win-x64.zip').size, null)
})

// assetKey

test('assetKey: removes a Prism tag that contains hyphens', () => {
  assert.equal(
    assetKey('llama-prism-b10770-6684606-bin-win-cuda-13.3-x64.zip', 'prism-b10770-6684606'),
    'llama-bin-win-cuda-13.3-x64.zip',
  )
})

test('assetKey: removes a v-prefixed tag and a bare-number tag alike', () => {
  const name = 'beellama-v0.4.7-bin-win-vulkan-x64.zip'
  assert.equal(assetKey(name, 'v0.4.7'), 'beellama-bin-win-vulkan-x64.zip')
  assert.equal(assetKey(name, '0.4.7'), 'beellama-bin-win-vulkan-x64.zip')
})

test('assetKey: a prerelease tag gives the same key as the stable one', () => {
  assert.equal(
    assetKey('beellama-preview-v0.4.8-bin-win-vulkan-x64.zip', 'preview-v0.4.8'),
    'beellama-bin-win-vulkan-x64.zip',
  )
})

test('assetKey: lowercases and collapses separators', () => {
  assert.equal(assetKey('Llama-B1--Bin_-Win.ZIP', 'B1'), 'llama-bin-win.zip')
})

// parseRepoInput

test('parseRepoInput: accepts every supported spelling', () => {
  for (const raw of [
    'owner/repo',
    '  owner/repo  ',
    'github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/releases',
    'https://github.com/owner/repo/releases/tag/b1',
    'https://github.com/owner/repo/',
  ]) {
    assert.equal(parseRepoInput(raw), 'owner/repo', raw)
  }
})

test('parseRepoInput: rejects path steps, junk and other hosts', () => {
  for (const raw of ['..', 'o/..', 'a/b/c', 'o r/x', '', '   ', 'https://gitlab.com/o/r', 'o/r?x=1', './x']) {
    assert.equal(parseRepoInput(raw), null, raw)
  }
})

// rankReleaseAssets and companionsFor

const host = (over: Partial<HostProfile>): HostProfile => ({
  platform: 'win32',
  arch: 'x64',
  gpuVendor: 'unknown',
  hasGpu: false,
  amdApuOnly: false,
  driverMaxCuda: null,
  ...over,
})

function rank(names: string[], h: HostProfile): RankedAsset[] {
  return rankReleaseAssets(assetsNamed(names).map(classifyReleaseAsset), h)
}

function recommended(rows: RankedAsset[]): RankedAsset | undefined {
  return rows.find((r) => r.recommended)
}

const PRISM_WIN = (suffix: string): string => `llama-prism-b10770-6684606-bin-${suffix}`

test('rank: Windows nvidia with a CUDA 13.4 driver recommends cuda 13.3 and pairs its cudart', () => {
  const rows = rank(PRISM_B10770, host({ gpuVendor: 'nvidia', hasGpu: true, driverMaxCuda: '13.4' }))
  const pick = recommended(rows)
  assert.equal(pick?.name, PRISM_WIN('win-cuda-13.3-x64.zip'))
  assert.deepEqual(pick?.companions.map((c) => c.name), ['cudart-llama-bin-win-cuda-13.3-x64.zip'])
  assert.equal(rows.some((r) => r.name.startsWith('cudart')), false)
})

test('rank: a CUDA 12.8 driver recommends cuda 12.4 and keeps 13.3 compatible with a reason', () => {
  const rows = rank(PRISM_B10770, host({ gpuVendor: 'nvidia', hasGpu: true, driverMaxCuda: '12.8' }))
  assert.equal(recommended(rows)?.name, PRISM_WIN('win-cuda-12.4-x64.zip'))
  const tooNew = rows.find((r) => r.name === PRISM_WIN('win-cuda-13.3-x64.zip'))
  assert.equal(tooNew?.compatible, true)
  assert.equal(tooNew?.reason, 'needs CUDA 13.3, driver supports 12.8')
  const names = rows.map((r) => r.name)
  assert.ok(names.indexOf(PRISM_WIN('win-cuda-12.4-x64.zip')) < names.indexOf(PRISM_WIN('win-cuda-13.3-x64.zip')))
})

test('rank: an unknown driver recommends the highest CUDA', () => {
  const rows = rank(PRISM_B10770, host({ gpuVendor: 'nvidia', hasGpu: true }))
  assert.equal(recommended(rows)?.name, PRISM_WIN('win-cuda-13.3-x64.zip'))
})

test('rank: discrete AMD gets rocm, an APU-only AMD box gets vulkan', () => {
  const amd = host({ gpuVendor: 'amd', hasGpu: true })
  assert.equal(recommended(rank(PRISM_B10770, amd))?.name, PRISM_WIN('win-hip-radeon-x64.zip'))
  assert.equal(recommended(rank(PRISM_B10770, { ...amd, amdApuOnly: true }))?.name, PRISM_WIN('win-vulkan-x64.zip'))
})

test('rank: Intel gets sycl, no GPU gets cpu, Windows arm64 gets the arm64 cpu build', () => {
  assert.equal(recommended(rank(PRISM_B10770, host({ gpuVendor: 'intel', hasGpu: true })))?.name, PRISM_WIN('win-sycl-x64.zip'))
  assert.equal(recommended(rank(PRISM_B10770, host({})))?.name, PRISM_WIN('win-cpu-x64.zip'))
  assert.equal(recommended(rank(PRISM_B10770, host({ arch: 'arm64' })))?.name, PRISM_WIN('win-cpu-arm64.zip'))
})

test('rank: Linux nvidia gets Prism linux-cuda-13.3 with no companion; official b9608 falls back to vulkan', () => {
  const linux = host({ platform: 'linux', gpuVendor: 'nvidia', hasGpu: true, driverMaxCuda: '13.4' })
  const prism = recommended(rank(PRISM_B10770, linux))
  assert.equal(prism?.name, PRISM_WIN('linux-cuda-13.3-x64.tar.gz'))
  assert.deepEqual(prism?.companions, [])
  assert.equal(recommended(rank(OFFICIAL_B9608, linux))?.name, 'llama-b9608-bin-ubuntu-vulkan-x64.tar.gz')
})

test('rank: on Linux x64 an s390x build and Windows builds are incompatible with reasons', () => {
  const rows = rank(OFFICIAL_B9608, host({ platform: 'linux' }))
  const byName = (n: string) => rows.find((r) => r.name === n)
  assert.deepEqual(
    [byName('llama-b9608-bin-ubuntu-s390x.tar.gz')?.compatible, byName('llama-b9608-bin-ubuntu-s390x.tar.gz')?.reason],
    [false, 's390x build'],
  )
  assert.equal(byName('llama-b9608-bin-win-cpu-x64.zip')?.reason, 'Windows build')
  assert.equal(byName('llama-b9608-bin-macos-arm64.tar.gz')?.reason, 'macOS build')
  assert.equal(byName('llama-b9608-bin-ubuntu-arm64.tar.gz')?.reason, 'arm64 build')
  assert.equal(byName('llama-b9608-xcframework.zip')?.reason, 'no operating system in the name')
})

test('rank: darwin arm64 prefers the plain macos-arm64 over the kleidiai variant', () => {
  const rows = rank(PRISM_B10770, host({ platform: 'darwin', arch: 'arm64', gpuVendor: 'apple', hasGpu: true }))
  assert.equal(recommended(rows)?.name, PRISM_WIN('macos-arm64.tar.gz'))
})

test('rank: BeeLlama on darwin x64 has no compatible build and every row says why', () => {
  const rows = rank(BEELLAMA_V047, host({ platform: 'darwin', arch: 'x64' }))
  assert.ok(rows.length > 0)
  assert.equal(rows.some((r) => r.compatible), false)
  assert.equal(rows.some((r) => r.recommended), false)
  assert.equal(rows.every((r) => r.reason !== null), true)
})

test('rank: on Android only the android build is compatible', () => {
  const rows = rank(PRISM_B10770, host({ platform: 'android' as NodeJS.Platform, arch: 'arm64' }))
  assert.deepEqual(rows.filter((r) => r.compatible).map((r) => r.name), [PRISM_WIN('android-arm64.tar.gz')])
  assert.equal(recommended(rows)?.name, PRISM_WIN('android-arm64.tar.gz'))
})

test('rank: TurboQuant prefers the tar.gz over the zip of the same build', () => {
  const rows = rank(TURBOQUANT_B10298, host({ platform: 'linux' }))
  assert.equal(recommended(rows)?.name, 'llama-turboquant-linux-x64-cpu.tar.gz')
})

test('rank: KoboldCpp ships no archives so nothing is listed', () => {
  assert.deepEqual(rank(KOBOLDCPP_V1_122_1, host({})), [])
})

test('rank: exactly one row is recommended when anything is compatible', () => {
  for (const names of [PRISM_B10770, BEELLAMA_V047, OFFICIAL_B9608, TURBOQUANT_B10298]) {
    const rows = rank(names, host({ platform: 'linux' }))
    assert.equal(rows.filter((r) => r.recommended).length, 1)
  }
})

test('rank: compatible rows come before incompatible ones', () => {
  const flags = rank(OFFICIAL_B9608, host({ platform: 'linux' })).map((r) => r.compatible)
  assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)))
})

test('companionsFor: BeeLlama cuda 12.4 gets the 12.4 cudart, not the 13.3 one', () => {
  const all = assetsNamed(BEELLAMA_V047).map(classifyReleaseAsset)
  const main = all.find((a) => a.name === 'beellama-v0.4.7-bin-win-cuda-12.4-x64.zip')!
  assert.deepEqual(companionsFor(main, all).map((c) => c.name), ['beellama-v0.4.7-cudart-win-cuda-12.4-x64.zip'])
})

test('companionsFor: a Linux cuda main gets none', () => {
  const all = assetsNamed(BEELLAMA_V047).map(classifyReleaseAsset)
  const main = all.find((a) => a.name === 'beellama-v0.4.7-bin-ubuntu-cuda-12.4-x64.tar.gz')!
  assert.deepEqual(companionsFor(main, all), [])
})
