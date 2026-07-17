import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRocmSmi, isIntegratedGpuName, parseWindowsVramRegistry } from './sysinfo'

// rocm-smi --showmeminfo vram --json output for an RX 7900 XTX (24GB). The WMI
// AdapterRAM fallback would cap this at ~4GB; rocm-smi reports the true total.
const memJson = JSON.stringify({
  card0: {
    'VRAM Total Memory (B)': '25753026560',
    'VRAM Total Used Memory (B)': '1234567890',
  },
})
const nameJson = JSON.stringify({
  card0: { 'Card Series': 'Radeon RX 7900 XTX', 'Card Model': '0x744c' },
})

test('parseRocmSmi: single AMD card reports true 24GB VRAM', () => {
  const gpus = parseRocmSmi(memJson, nameJson)
  assert.equal(gpus.length, 1)
  assert.equal(gpus[0].vendor, 'amd')
  assert.equal(gpus[0].name, 'Radeon RX 7900 XTX')
  // 25753026560 bytes / 1e6 ≈ 25753 MB (~24 GiB), NOT the 4GB WMI cap.
  assert.equal(gpus[0].vramMb, 25753)
  assert.ok(gpus[0].vramMb > 20000, 'must be well above the 4GB AdapterRAM cap')
})

test('parseRocmSmi: falls back to a generic name when productname is absent', () => {
  const gpus = parseRocmSmi(memJson)
  assert.equal(gpus.length, 1)
  assert.equal(gpus[0].vendor, 'amd')
  assert.equal(gpus[0].name, 'AMD Radeon GPU')
  assert.equal(gpus[0].vramMb, 25753)
})

test('parseRocmSmi: multiple AMD cards each parse', () => {
  const multiMem = JSON.stringify({
    card0: { 'VRAM Total Memory (B)': '25753026560' },
    card1: { 'VRAM Total Memory (B)': '25753026560' },
  })
  const gpus = parseRocmSmi(multiMem)
  assert.equal(gpus.length, 2)
  assert.equal(gpus[0].vramMb, 25753)
  assert.equal(gpus[1].vramMb, 25753)
  assert.ok(gpus.every((g) => g.vendor === 'amd'))
})

test('parseRocmSmi: cards reporting zero/unknown VRAM are skipped', () => {
  const badMem = JSON.stringify({
    card0: { 'VRAM Total Memory (B)': '0' },
    card1: { 'Some Other Field': 'x' },
  })
  assert.equal(parseRocmSmi(badMem).length, 0)
})

test('isIntegratedGpuName: classic Intel integrated branding is integrated', () => {
  assert.equal(isIntegratedGpuName('Intel(R) Iris(R) Xe Graphics'), true)
  assert.equal(isIntegratedGpuName('Intel(R) UHD Graphics 770'), true)
  assert.equal(isIntegratedGpuName('Intel(R) HD Graphics 620'), true)
})

test('isIntegratedGpuName: Intel Arc iGPU (no model number) is integrated', () => {
  assert.equal(isIntegratedGpuName('Intel(R) Arc(TM) Graphics'), true)
})

test('isIntegratedGpuName: discrete Intel Arc cards (model number) are NOT integrated', () => {
  assert.equal(isIntegratedGpuName('Intel(R) Arc(TM) A770 Graphics'), false)
  assert.equal(isIntegratedGpuName('Intel(R) Arc(TM) A380'), false)
  assert.equal(isIntegratedGpuName('Intel(R) Arc(TM) B580'), false)
})

test('isIntegratedGpuName: discrete Intel Arc Pro workstation cards (2-digit model) are NOT integrated', () => {
  // Pre-release review regression: the original 3-digit-only pattern misclassified these
  // as integrated, over-reporting their VRAM (the dangerous direction — a load could pass
  // the fit check on a system-RAM estimate then OOM on the card's real, smaller VRAM).
  assert.equal(isIntegratedGpuName('Intel(R) Arc(TM) Pro A60 Graphics'), false)
  assert.equal(isIntegratedGpuName('Intel(R) Arc(TM) Pro A50'), false)
  assert.equal(isIntegratedGpuName('Intel(R) Arc(TM) Pro B60'), false)
})

test('isIntegratedGpuName: newest generic Intel branding (no UHD/Iris/Arc qualifier) is integrated', () => {
  // Real name reported by WMI on a Core Ultra 7 265K (Arrow Lake-S) dev box.
  assert.equal(isIntegratedGpuName('Intel(R) Graphics'), true)
})

test('isIntegratedGpuName: generic AMD APU branding is integrated', () => {
  assert.equal(isIntegratedGpuName('AMD Radeon(TM) Graphics'), true)
})

test('isIntegratedGpuName: discrete AMD cards are NOT integrated', () => {
  assert.equal(isIntegratedGpuName('AMD Radeon RX 7900 XTX'), false)
  assert.equal(isIntegratedGpuName('AMD Radeon PRO W7900'), false)
  assert.equal(isIntegratedGpuName('AMD Instinct MI300X'), false)
})

test('isIntegratedGpuName: NVIDIA and unrelated names are NOT integrated', () => {
  assert.equal(isIntegratedGpuName('NVIDIA GeForce RTX 5070 Ti'), false)
  assert.equal(isIntegratedGpuName('Apple M3 Max'), false)
})

// ---- parseWindowsVramRegistry: true VRAM via the registry's 64-bit qwMemorySize, unlike WMI's
// 32-bit-capped AdapterRAM (GitHub #63: a real 16 GB AMD card was detected as "4.3 GB") --------

test('parseWindowsVramRegistry: reports true 16GB VRAM the 4GB WMI cap would miss', () => {
  const out = 'AMD Radeon RX 9070 XT|17179869184' // exactly 16 GiB, in bytes
  const entries = parseWindowsVramRegistry(out)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'AMD Radeon RX 9070 XT')
  assert.equal(entries[0].vramMb, 17180)
  assert.ok(entries[0].vramMb > 4300, 'must be well above the ~4.3GB WMI AdapterRAM cap')
})

test('parseWindowsVramRegistry: multiple adapters each parse', () => {
  const out = 'AMD Radeon RX 9070 XT|17179869184\nIntel(R) UHD Graphics 770|0'
  const entries = parseWindowsVramRegistry(out)
  // The iGPU's qwMemorySize of 0 is dropped — isIntegratedGpuName already handles iGPU sizing
  // via the shared-memory heuristic, so a zero/missing registry entry is simply skipped.
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'AMD Radeon RX 9070 XT')
})

test('parseWindowsVramRegistry: blank/malformed lines are skipped, not crashed on', () => {
  assert.deepEqual(parseWindowsVramRegistry(''), [])
  assert.deepEqual(parseWindowsVramRegistry('\n\n'), [])
  assert.deepEqual(parseWindowsVramRegistry('no pipe here'), [])
  assert.deepEqual(parseWindowsVramRegistry('Some Card|not-a-number'), [])
})
