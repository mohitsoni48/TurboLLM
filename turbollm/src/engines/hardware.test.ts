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

// Regression: a non-primary-vendor GPU (an Intel iGPU alongside an NVIDIA/AMD dGPU
// is a common laptop/desktop layout) must NOT be summed into the fit budget — it
// isn't usable for offload on the primary (discrete) backend.
test('detectHardware: an Intel iGPU alongside an NVIDIA dGPU is excluded from the VRAM sum', () => {
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [
      { name: 'NVIDIA GeForce RTX 4070', vramMb: 12288, vendor: 'nvidia' },
      { name: 'Intel(R) Iris(R) Xe Graphics', vramMb: 4096, vendor: 'intel' },
    ],
  }
  const hw = detectHardware(info)
  assert.equal(hw.gpuVendor, 'nvidia')
  assert.equal(hw.vramMb, 12288, 'the iGPU\'s 4GB must not inflate the usable budget')
  assert.equal(hw.gpuName, 'NVIDIA GeForce RTX 4070')
})

// Symmetric case: a lone iGPU with no discrete card at all still reports its own
// (small) VRAM correctly — the primary-vendor filter must not zero it out.
test('detectHardware: an iGPU-only box still reports its own VRAM', () => {
  const info: SysInfo = { ...dualNvidia, gpus: [{ name: 'Intel(R) UHD Graphics', vramMb: 1024, vendor: 'intel' }] }
  const hw = detectHardware(info)
  assert.equal(hw.gpuVendor, 'intel')
  assert.equal(hw.vramMb, 1024)
})

// The SAME-vendor version of the exclusion above, which the cross-vendor test never covered
// (ADR-306). A shared-memory GPU's budget is a slice of system RAM, so summing it with a real
// card double-counts that RAM — and over-reporting is the direction that OOMs at load time.
test('detectHardware: an AMD APU is excluded from the sum when an AMD dGPU is present', () => {
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [
      { name: 'Phoenix1 [Radeon 780M]', vramMb: 16512, vendor: 'amd', unified: true },
      { name: 'Navi 33 [Radeon RX 7600M XT]', vramMb: 8192, vendor: 'amd' },
    ],
  }
  const hw = detectHardware(info)
  assert.equal(hw.gpuVendor, 'amd')
  assert.equal(hw.vramMb, 8192, "the APU's system-RAM budget must not be pooled with the dGPU's real VRAM")
  assert.equal(hw.gpuName, 'Navi 33 [Radeon RX 7600M XT]', 'the real card is the headline, not the iGPU')
})

test('detectHardware: an APU-only box keeps its full unified budget', () => {
  // The other half of the rule: with no discrete card of the same vendor, the unified budget IS
  // the budget — this is exactly the GitHub #85 Strix Halo case.
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [{ name: 'Strix Halo [Radeon 8050S / 8060S]', vramMb: 117037, vendor: 'amd', unified: true }],
  }
  const hw = detectHardware(info)
  assert.equal(hw.gpuVendor, 'amd')
  assert.equal(hw.vramMb, 117037)
})

test('detectHardware: two real cards of the same vendor still pool, as before', () => {
  // Guard against the exclusion over-reaching: nothing here is unified, so nothing is dropped.
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [
      { name: 'AMD Radeon RX 7900 XTX', vramMb: 24576, vendor: 'amd' },
      { name: 'AMD Radeon RX 7900 XTX', vramMb: 24576, vendor: 'amd' },
    ],
  }
  assert.equal(detectHardware(info).vramMb, 49152)
})

// ── `unifiedMemory`: is `vramMb` a second pool, or a slice of `ramMB`? (GitHub #164) ─────────
//
// ADR-306 dropped unified adapters from the sum "as soon as the same vendor also has a real card",
// which leaves the iGPU-ONLY box — nothing to exclude against — reporting a system-RAM-derived
// `vramMb` with no signal that it OVERLAPS `ramMB`. These pin the flag that closes that gap. The
// budget itself is deliberately unchanged: ADR-189 keeps the shared-memory heuristic for exactly
// this box, and GitHub #85 raised the APU budget on purpose.

test('detectHardware: an iGPU-only Windows box reports its budget as unified, not a second pool', () => {
  // sysinfo.ts gives an iGPU 50% of system RAM (round(totalmem/1e6 * 0.5)) and tags it
  // `unified: true`; ramMB is round(totalmem/1e6). 33.5 GB of RAM -> 16750 / 33500, exactly the
  // shape reported in #164. `vramMb` must survive untouched, and the flag must be true.
  const info: SysInfo = {
    os: 'win32/x64',
    cpu: 'AMD Ryzen 7 7840U',
    cores: 16,
    ramMB: 33500,
    gpus: [{ name: 'AMD Radeon 780M Graphics', vramMb: 16750, vendor: 'amd', unified: true }],
  }
  const hw = detectHardware(info)
  assert.equal(hw.vramMb, 16750, 'ADR-189: the iGPU-only budget is kept, not deleted')
  assert.equal(hw.unifiedMemory, true, 'that 16750 MB is a slice of the same 33500 MB, not extra')
})

test('detectHardware: a discrete card of the same size is NOT unified', () => {
  // The control for the test above: identical numbers, real VRAM. Nothing downstream may tighten.
  const info: SysInfo = {
    os: 'win32/x64',
    cpu: 'Test CPU',
    cores: 16,
    ramMB: 33500,
    gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16750, vendor: 'nvidia' }],
  }
  const hw = detectHardware(info)
  assert.equal(hw.vramMb, 16750)
  assert.equal(hw.unifiedMemory, false)
})

test('detectHardware: Strix Halo (GitHub #85) is unified and keeps its full raised budget', () => {
  const info: SysInfo = {
    ...dualNvidia,
    ramMB: 131072,
    gpus: [{ name: 'Strix Halo [Radeon 8050S / 8060S]', vramMb: 117037, vendor: 'amd', unified: true }],
  }
  const hw = detectHardware(info)
  assert.equal(hw.vramMb, 117037, 'ADR-304/306/310: this budget was RAISED on purpose, never lower it')
  assert.equal(hw.unifiedMemory, true)
})

test('detectHardware: Apple Silicon is unified', () => {
  const info: SysInfo = {
    os: 'darwin/arm64',
    cpu: 'Apple M3 Max',
    cores: 14,
    ramMB: 36864,
    gpus: [{ name: 'Apple M3 Max', vramMb: 27648, vendor: 'apple', unified: true }],
  }
  assert.equal(detectHardware(info).unifiedMemory, true)
})

test('detectHardware: an APU beside a same-vendor dGPU is NOT unified — the dGPU is what was summed', () => {
  // The flag describes the adapters that actually contributed to `vramMb`. ADR-306 already dropped
  // the APU here, so `vramMb` is the RX 7600M XT's real 8 GB and is genuinely a second pool.
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [
      { name: 'Phoenix1 [Radeon 780M]', vramMb: 16512, vendor: 'amd', unified: true },
      { name: 'Navi 33 [Radeon RX 7600M XT]', vramMb: 8192, vendor: 'amd' },
    ],
  }
  const hw = detectHardware(info)
  assert.equal(hw.vramMb, 8192)
  assert.equal(hw.unifiedMemory, false, 'the summed adapter is a real card, so RAM is a separate pool')
})

test('detectHardware: an Intel iGPU beside an NVIDIA dGPU is NOT unified (cross-vendor)', () => {
  // The case a naive `info.gpus.some(g => g.unified)` gets wrong: the summed budget is the 5070
  // Ti's dedicated VRAM. Charging it against system RAM would penalise an ordinary gaming laptop.
  const info: SysInfo = {
    ...dualNvidia,
    gpus: [
      { name: 'Intel(R) UHD Graphics', vramMb: 32768, vendor: 'intel', unified: true },
      { name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16384, vendor: 'nvidia' },
    ],
  }
  const hw = detectHardware(info)
  assert.equal(hw.vramMb, 16384)
  assert.equal(hw.unifiedMemory, false)
})

test('detectHardware: a CPU-only box is NOT unified — the empty-pool guard', () => {
  // `[].every()` is `true`, so without the `length > 0` guard a box with no GPU at all would
  // report unified and start charging a 0 MB GPU budget against system RAM.
  const info: SysInfo = { ...dualNvidia, gpus: [] }
  const hw = detectHardware(info)
  assert.equal(hw.hasGpu, false)
  assert.equal(hw.vramMb, 0)
  assert.equal(hw.unifiedMemory, false)
})
