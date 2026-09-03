import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateVariant } from './compat'
import type { HardwareProfile } from './hardware'
import type { HardwareReq } from './catalog'

const nvidiaWin: HardwareProfile = {
  platform: 'win32',
  arch: 'x64',
  gpuVendor: 'nvidia',
  hasGpu: true,
  vramMb: 16384,
  gpuName: 'NVIDIA GeForce RTX 5070 Ti',
  unifiedMemory: false,
}
const amdWin: HardwareProfile = {
  platform: 'win32',
  arch: 'x64',
  gpuVendor: 'amd',
  hasGpu: true,
  vramMb: 12288,
  gpuName: 'AMD Radeon RX 7800 XT',
  unifiedMemory: false,
}
const appleMac: HardwareProfile = {
  platform: 'darwin',
  arch: 'arm64',
  gpuVendor: 'apple',
  hasGpu: true,
  vramMb: 0, // unified memory not reported as a discrete VRAM number here
  gpuName: 'Apple M3 Max',
  unifiedMemory: true,
}
const noGpu: HardwareProfile = {
  platform: 'linux',
  arch: 'x64',
  gpuVendor: 'unknown',
  hasGpu: false,
  vramMb: 0,
  unifiedMemory: false,
}
const androidTermux: HardwareProfile = {
  platform: 'android',
  arch: 'arm64',
  gpuVendor: 'unknown',
  hasGpu: false,
  vramMb: 0,
  unifiedMemory: false,
}

const cudaReq: HardwareReq = { gpuVendor: ['nvidia'], backend: 'cuda' }
const metalReq: HardwareReq = { platform: ['darwin'], gpuVendor: ['apple'], backend: 'metal' }
const cpuReq: HardwareReq = { backend: 'cpu' }
const androidReq: HardwareReq = { platform: ['android'] }

test('evaluateVariant: NVIDIA box passes a cuda requirement', () => {
  assert.deepEqual(evaluateVariant(nvidiaWin, cudaReq), { ok: true })
})

test('evaluateVariant: NVIDIA box fails a metal requirement with a platform reason', () => {
  const r = evaluateVariant(nvidiaWin, metalReq)
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /macOS only/)
})

test('evaluateVariant: AMD box fails a cuda requirement with a vendor reason', () => {
  const r = evaluateVariant(amdWin, cudaReq)
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /NVIDIA/)
  assert.match(r.reason ?? '', /AMD/)
})

test('evaluateVariant: mac passes a metal requirement', () => {
  assert.deepEqual(evaluateVariant(appleMac, metalReq), { ok: true })
})

test('evaluateVariant: a cpu requirement is always ok (every box)', () => {
  assert.deepEqual(evaluateVariant(nvidiaWin, cpuReq), { ok: true })
  assert.deepEqual(evaluateVariant(amdWin, cpuReq), { ok: true })
  assert.deepEqual(evaluateVariant(appleMac, cpuReq), { ok: true })
  assert.deepEqual(evaluateVariant(noGpu, cpuReq), { ok: true })
  assert.deepEqual(evaluateVariant(androidTermux, cpuReq), { ok: true })
})

test('evaluateVariant: Android/Termux box passes an android platform requirement', () => {
  assert.deepEqual(evaluateVariant(androidTermux, androidReq), { ok: true })
})

test('evaluateVariant: a Windows box fails an android platform requirement with a platform reason', () => {
  const r = evaluateVariant(nvidiaWin, androidReq)
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /Android only/)
})

test('evaluateVariant: arch mismatch reports a clear reason', () => {
  const r = evaluateVariant(nvidiaWin, { arch: ['arm64'] })
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /arm64/)
})

test('evaluateVariant: VRAM gate fires when we have a reading below the minimum', () => {
  const r = evaluateVariant(amdWin, { minVramMb: 24576 }) // 24 GB > 12 GB available
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /VRAM/)
})

test('evaluateVariant: missing VRAM (0) skips the VRAM gate — no false exclusion', () => {
  // appleMac reports vramMb 0 here; a VRAM minimum must NOT exclude it.
  assert.deepEqual(evaluateVariant(appleMac, { minVramMb: 24576 }), { ok: true })
})

test('evaluateVariant: minCudaCC is ignored in v1 (accepted but not enforced)', () => {
  assert.deepEqual(evaluateVariant(nvidiaWin, { gpuVendor: ['nvidia'], minCudaCC: 999 }), { ok: true })
})
