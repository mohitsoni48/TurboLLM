import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectHardware } from './hardware'
import type { SysInfo } from '../sysinfo/sysinfo'

// Regression test for the multi-GPU VRAM bug: detectHardware used to report
// max(vramMb) across cards; a dual-GPU box must report the SUM (pooled budget).
const dualNvidia: SysInfo = {
  os: 'win32/x64',
  cpu: 'Test CPU',
  cores: 16,
  ramMB: 65536,
  gpus: [
    { name: 'NVIDIA GeForce RTX 5060 Ti', vramMb: 16384, vendor: 'nvidia' },
    { name: 'NVIDIA GeForce RTX 5060 Ti', vramMb: 16384, vendor: 'nvidia' },
  ],
}

test('detectHardware: dual-GPU VRAM is summed, not maxed', () => {
  const hw = detectHardware(dualNvidia)
  assert.equal(hw.vramMb, 32768, 'two 16GB cards pool to 32GB, not 16GB')
  assert.equal(hw.gpuVendor, 'nvidia')
  assert.equal(hw.hasGpu, true)
  assert.equal(hw.gpuName, 'NVIDIA GeForce RTX 5060 Ti')
})

test('detectHardware: mixed-size GPUs sum correctly', () => {
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [
      { name: 'RTX 4090', vramMb: 24576, vendor: 'nvidia' },
      { name: 'RTX 3060', vramMb: 12288, vendor: 'nvidia' },
    ],
  }
  const hw = detectHardware(info)
  assert.equal(hw.vramMb, 36864, '24GB + 12GB = 36GB total VRAM')
  // Headline is the largest card of the primary vendor.
  assert.equal(hw.gpuName, 'RTX 4090')
})

test('detectHardware: single GPU is unchanged (sum of one)', () => {
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [{ name: 'RTX 5070 Ti', vramMb: 16384, vendor: 'nvidia' }],
  }
  assert.equal(detectHardware(info).vramMb, 16384)
})

test('detectHardware: no GPU reports 0 VRAM', () => {
  const info: SysInfo = { ...dualNvidia, gpus: [] }
  const hw = detectHardware(info)
  assert.equal(hw.vramMb, 0)
  assert.equal(hw.hasGpu, false)
})
