import { test } from 'node:test'
import assert from 'node:assert/strict'
import { primaryVendorSummary } from './vram'

// Regression test for the Engines-screen fallback bug: before the /recommendation query
// resolves (or if it errors — that query never retries), the hero used sys.gpus[0] alone,
// showing one card's VRAM on a multi-GPU box. Mirrors turbollm/src/engines/hardware.test.ts's
// dual-GPU fixture so the two summaries can never drift apart.
test('primaryVendorSummary: dual-GPU VRAM is summed, not just gpus[0]', () => {
  const gpus = [
    { name: 'NVIDIA GeForce RTX 5060 Ti', vramMb: 16384, vendor: 'nvidia' },
    { name: 'NVIDIA GeForce RTX 5060 Ti', vramMb: 16384, vendor: 'nvidia' },
  ]
  const summary = primaryVendorSummary(gpus)
  assert.equal(summary.vramMb, 32768, 'two 16GB cards pool to 32GB, not one card\'s 16GB')
  assert.equal(summary.gpuName, 'NVIDIA GeForce RTX 5060 Ti')
})

test('primaryVendorSummary: an Intel iGPU alongside an NVIDIA dGPU is excluded from the sum', () => {
  const gpus = [
    { name: 'NVIDIA GeForce RTX 4070', vramMb: 12288, vendor: 'nvidia' },
    { name: 'Intel(R) Iris(R) Xe Graphics', vramMb: 4096, vendor: 'intel' },
  ]
  const summary = primaryVendorSummary(gpus)
  assert.equal(summary.vramMb, 12288, 'the iGPU\'s 4GB must not inflate the usable budget')
  assert.equal(summary.gpuName, 'NVIDIA GeForce RTX 4070')
})

test('primaryVendorSummary: no GPUs reports null name and 0 VRAM', () => {
  const summary = primaryVendorSummary([])
  assert.equal(summary.gpuName, null)
  assert.equal(summary.vramMb, 0)
})
