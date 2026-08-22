// `unifiedMemoryOnly` — is EVERY GPU on this box one that shares system RAM? (GitHub #179)
//
// Auto-tune's spill detection asks the memory-topology question, not the vendor question: on a
// unified-memory part there is no VRAM/RAM boundary for the driver to demote an allocation across,
// so host-backed GPU memory is where the model normally lives rather than evidence of a spill. See
// spill.ts's `isSpilling` doc and spill.test.ts's unified section for the consequence.
//
// Kept in its own file rather than appended to sysinfo.test.ts so the #179 change is reviewable in
// isolation; `amdApuOnly`'s own cases stay where they are.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unifiedMemoryOnly, parseRocmSmi } from './sysinfo'
import type { SysInfo } from './sysinfo'

const sysWith = (...gpus: SysInfo['gpus']): SysInfo => ({ os: 'win32/x64', cpu: 'test', cores: 8, ramMB: 64000, gpus })

test('unifiedMemoryOnly: the GitHub #179 box — a single AMD APU iGPU', () => {
  // The reporter's machine: a Ryzen APU whose "VRAM" is a carveout+GTT slice of the 64 GB the box
  // already has. Every auto-tune probe reported gigabytes of host-backed GPU memory (6235, 3770,
  // 2736, 2138, 11035 MB) because that IS where the weights live.
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'AMD Radeon(TM) Graphics', vramMb: 32000, vendor: 'amd', unified: true })), true)
})

test('unifiedMemoryOnly: CPU-only box is NOT unified — [].every() must not flip it', () => {
  // The guard that matters most: `[].every(...)` is `true` in JS, so without the length check a box
  // with no GPU at all would claim unified memory. denseSearch never probes there (it skips the
  // whole search when sys.gpus.length === 0) but nothing else should have to rely on that.
  assert.equal(unifiedMemoryOnly(sysWith()), false)
})

test('unifiedMemoryOnly: any discrete card present ⇒ false', () => {
  // A discrete card has its own VRAM and really can spill out of it, so spill detection must stay on.
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'AMD Radeon RX 7900 XTX', vramMb: 24000, vendor: 'amd' })), false)
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16303, vendor: 'nvidia' })), false)
  // The common laptop/desktop mix: iGPU alongside a dGPU. The dGPU decides.
  assert.equal(unifiedMemoryOnly(sysWith(
    { name: 'AMD Radeon 780M', vramMb: 16000, vendor: 'amd', unified: true },
    { name: 'NVIDIA GeForce RTX 4070', vramMb: 12000, vendor: 'nvidia' },
  )), false)
})

test('unifiedMemoryOnly: vendor-agnostic — Apple, Intel, ARM and Qualcomm iGPUs all count', () => {
  // Same physics, so the same answer. Intel/ARM/Qualcomm integrated parts are tagged `unified: true`
  // by enumWindowsGpus/makeVulkanGpu, and Apple Silicon by the Metal path.
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'Apple M3 Max', vramMb: 96000, vendor: 'apple', unified: true })), true)
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'Intel(R) Arc(TM) Graphics', vramMb: 16000, vendor: 'intel', unified: true })), true)
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'Mali-G715-Immortalis', vramMb: 6000, vendor: 'arm', unified: true })), true)
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'Adreno (TM) 750', vramMb: 6000, vendor: 'qualcomm', unified: true })), true)
})

test('unifiedMemoryOnly: an untagged GPU is treated as discrete, not unified', () => {
  // `unified` is optional on GpuInfo. Absent means "not known to share system RAM", which must fail
  // toward keeping spill detection ON — the direction where a wrong answer is merely conservative.
  assert.equal(unifiedMemoryOnly(sysWith({ name: 'Some Unknown Accelerator', vramMb: 8000, vendor: 'unknown' })), false)
  assert.equal(unifiedMemoryOnly(sysWith(
    { name: 'AMD Radeon 890M', vramMb: 32000, vendor: 'amd', unified: true },
    { name: 'Some Unknown Accelerator', vramMb: 8000, vendor: 'unknown' },
  )), false)
})

// ---- parseRocmSmi must tag integrated parts too (GitHub #179) ---------------------------------
// rocm-smi is tried FIRST on AMD boxes, so on any APU where ROCm resolves, this parser — not the
// WMI/lspci path — produces the GpuInfo. It never set `unified`, which silently stripped the flag
// from exactly those machines.

test('parseRocmSmi: an APU reported through rocm-smi is tagged unified', () => {
  const mem = JSON.stringify({ card0: { 'VRAM Total Memory (B)': '34359738368' } })
  const names = JSON.stringify({ card0: { 'Card Series': 'AMD Radeon(TM) Graphics' } })
  const gpus = parseRocmSmi(mem, names)
  assert.equal(gpus.length, 1)
  assert.equal(gpus[0].unified, true)
  assert.equal(unifiedMemoryOnly({ os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000, gpus }), true)
})

test('parseRocmSmi: a discrete card keeps today\'s classification (no unified flag)', () => {
  const mem = JSON.stringify({ card0: { 'VRAM Total Memory (B)': '25753026560' } })
  const names = JSON.stringify({ card0: { 'Card Series': 'Radeon RX 7900 XTX' } })
  const gpus = parseRocmSmi(mem, names)
  assert.equal(gpus[0].unified, undefined)
  assert.equal(unifiedMemoryOnly({ os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000, gpus }), false)
})

test('parseRocmSmi: the generic unnamed fallback is NOT assumed integrated', () => {
  // With --showproductname unavailable the name degrades to "AMD Radeon GPU". Guessing "integrated"
  // there would disable spill detection on an unnamed DISCRETE card, so it must stay untagged.
  const gpus = parseRocmSmi(JSON.stringify({ card0: { 'VRAM Total Memory (B)': '25753026560' } }))
  assert.equal(gpus[0].name, 'AMD Radeon GPU')
  assert.equal(gpus[0].unified, undefined)
})
