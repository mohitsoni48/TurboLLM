// The stubbed fork release the route and update tests serve must be one the real resolver accepts: it went stale
// once (the old llama.cpp-style asset names), and every route test over a TurboQuant update then failed with
// "no prebuilt binary for this system".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveTurboquantRelease, turboquantCandidates, type TurboquantHw } from '../engines/download'
import { TURBOQUANT_FIXTURE_TAG, turboquantReleaseList } from './turboquant-release'

const linuxHw = (over: Partial<TurboquantHw>): TurboquantHw =>
  ({ platform: 'linux', arch: 'x64', vendor: 'unknown', hasGpu: false, driverCuda: null, computeCaps: [], ...over })

test('the fixture release resolves for a CPU-only, a Vulkan and an NVIDIA Linux machine', { skip: process.platform !== 'linux' }, () => {
  for (const hw of [linuxHw({}), linuxHw({ vendor: 'amd', hasGpu: true }), linuxHw({ vendor: 'nvidia', hasGpu: true, driverCuda: '13.4', computeCaps: [8.9] })]) {
    const resolved = resolveTurboquantRelease(turboquantReleaseList(), turboquantCandidates(hw), hw.platform)
    assert.equal(resolved?.tag, TURBOQUANT_FIXTURE_TAG, JSON.stringify(hw))
  }
})

test('the fixture release resolves for Apple Silicon', { skip: process.platform !== 'darwin' }, () => {
  const hw: TurboquantHw = { platform: 'darwin', arch: 'arm64', vendor: 'apple', hasGpu: true, driverCuda: null, computeCaps: [] }
  assert.equal(resolveTurboquantRelease(turboquantReleaseList(), turboquantCandidates(hw), hw.platform)?.tag, TURBOQUANT_FIXTURE_TAG)
})
