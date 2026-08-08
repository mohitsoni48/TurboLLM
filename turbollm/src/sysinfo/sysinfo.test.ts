import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRocmSmi,
  isIntegratedGpuName,
  parseWindowsVramRegistry,
  parseLspciMm,
  amdApuVramMb,
  parseKfdNodes,
  pciSlotToKfdIds,
  linuxGpuFromLspci,
  amdApuOnly,
} from './sysinfo'
import type { SysInfo } from './sysinfo'

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

// GitHub #103: recommendBackendId needs to know when the ONLY AMD adapter present is an
// APU/iGPU (ROCm doesn't support most of these on Windows), so it can skip ROCm for Vulkan.
const sysWith = (...gpus: SysInfo['gpus']): SysInfo => ({ os: 'win32/x64', cpu: 'test', cores: 8, ramMB: 32000, gpus })

test('amdApuOnly: true for a single AMD iGPU (e.g. Radeon 860M)', () => {
  assert.equal(amdApuOnly(sysWith({ name: 'AMD Radeon 860M', vramMb: 16000, vendor: 'amd', unified: true })), true)
})

test('amdApuOnly: false when a discrete AMD GPU is present', () => {
  assert.equal(amdApuOnly(sysWith({ name: 'AMD Radeon RX 7900 XTX', vramMb: 24000, vendor: 'amd' })), false)
})

test('amdApuOnly: false when an AMD iGPU sits alongside a discrete AMD GPU', () => {
  assert.equal(amdApuOnly(sysWith(
    { name: 'AMD Radeon 780M', vramMb: 16000, vendor: 'amd', unified: true },
    { name: 'AMD Radeon RX 7900 XTX', vramMb: 24000, vendor: 'amd' },
  )), false)
})

test('amdApuOnly: false when there is no AMD adapter at all', () => {
  assert.equal(amdApuOnly(sysWith({ name: 'NVIDIA RTX 5070 Ti', vramMb: 16000, vendor: 'nvidia' })), false)
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

// ---- Unified-memory AMD APUs (GitHub #85 / ADR-304): a Strix Halo box with 131 GB of RAM and a
// 108 GiB GTT pool was detected as a 1.1 GB-VRAM GPU (the BIOS carveout alone), so every model
// reported "will spill to system RAM" and auto-tune found no candidate that fit. -----------------

// The reporter's own adapter, as `lspci -mm` prints it.
const STRIX_HALO_LSPCI =
  'c6:00.0 "Display controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Strix Halo [Radeon 8050S / 8060S]" -r10 "Advanced Micro Devices, Inc. [AMD/ATI]" "Strix Halo [Radeon 8050S / 8060S]"'

test('parseLspciMm: the device field becomes the display name, not the whole PCI dump', () => {
  const e = parseLspciMm(STRIX_HALO_LSPCI)
  assert.ok(e)
  assert.equal(e.slot, 'c6:00.0')
  assert.equal(e.deviceClass, 'Display controller')
  assert.equal(e.vendor, 'Advanced Micro Devices, Inc. [AMD/ATI]')
  // Before ADR-304 the name was the raw line sliced to 80 chars, which showed up in Settings as
  // "c6:00.0 Display controller Advanced Micro Devices, Inc. [AMD/ATI] Strix Halo [Ra".
  assert.equal(e.device, 'Strix Halo [Radeon 8050S / 8060S]')
})

test('parseLspciMm: an NVIDIA discrete card parses the same way', () => {
  const e = parseLspciMm('01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GB203 [GeForce RTX 5070 Ti]" -ra1 "NVIDIA Corporation" "Device 0000"')
  assert.ok(e)
  assert.equal(e.slot, '01:00.0')
  assert.equal(e.device, 'GB203 [GeForce RTX 5070 Ti]')
})

test('parseLspciMm: unparseable lines return null so the caller keeps the old whole-line name', () => {
  assert.equal(parseLspciMm(''), null)
  assert.equal(parseLspciMm('c6:00.0 no quoted fields here'), null)
  assert.equal(parseLspciMm('c6:00.0 "only" "two"'), null)
})

test('isIntegratedGpuName: numbered AMD APU iGPUs (no "Graphics" suffix) are integrated', () => {
  assert.equal(isIntegratedGpuName('Strix Halo [Radeon 8050S / 8060S]'), true)
  assert.equal(isIntegratedGpuName('AMD Radeon 890M'), true)
  assert.equal(isIntegratedGpuName('AMD Radeon 780M'), true)
  assert.equal(isIntegratedGpuName('AMD Radeon 610M'), true)
})

test('isIntegratedGpuName: low-end DISCRETE mobile Radeons are NOT integrated', () => {
  // The dangerous direction: treating a 2GB discrete card as having a system-RAM-sized budget
  // would green-light a load that then OOMs. AMD's discrete mobile line stopped at 5xx, and
  // older discrete parts always carry a series prefix that breaks the radeon-then-digits match.
  assert.equal(isIntegratedGpuName('AMD Radeon 530M'), false)
  assert.equal(isIntegratedGpuName('AMD Radeon 540M'), false)
  assert.equal(isIntegratedGpuName('AMD Radeon HD 6770M'), false)
  assert.equal(isIntegratedGpuName('AMD Radeon R7 M340'), false)
  assert.equal(isIntegratedGpuName('AMD Radeon RX 7600M XT'), false)
  assert.equal(isIntegratedGpuName('AMD Radeon Pro 5600M'), false)
})

test('amdApuVramMb: the carveout PLUS the GTT pool is the real budget', () => {
  // The reporter's box: 1 GiB carveout + 108 GiB GTT, 131.2 GB RAM.
  const vram = Math.round(1.073e9 / 1e6) // 1073 MB — the "1.1 GB" that was being reported
  const gtt = Math.round(115.964e9 / 1e6) // 115964 MB (108 GiB)
  const got = amdApuVramMb(vram, gtt, 131.2e9)
  assert.equal(got, 117037)
  assert.ok(got > 100_000, 'must be the ~117 GB the OS reports as usable, not the 1.1 GB carveout')
})

test('amdApuVramMb: never drops below the dedicated carveout, and caps at 90% of RAM', () => {
  // A hand-set `amdgpu.gttsize=` larger than RAM must not produce a nonsense budget.
  assert.equal(amdApuVramMb(2000, 64_000, 16e9), 14_400) // 90% of 16 GB, not 66 GB
  // Pathological cap (tiny RAM reading) still can't report less than the real dedicated VRAM.
  assert.equal(amdApuVramMb(8000, 4000, 1e9), 8000)
})

// KFD topology is the authoritative APU check: a node with BOTH SIMDs and CPU cores is a fused
// device (the kernel's AMDGPU_IDS_FLAGS_FUSION, otherwise only reachable via a DRM ioctl).
const KFD_CPU_NODE = 'cpu_cores_count 32\nsimd_count 0\nlocation_id 0\ndomain 0\n'
const KFD_APU_NODE = 'cpu_cores_count 32\nsimd_count 512\nmax_waves_per_simd 16\nlocation_id 50688\ndomain 0\n'
const KFD_DGPU_NODE = 'cpu_cores_count 0\nsimd_count 448\nmax_waves_per_simd 32\nlocation_id 256\ndomain 0\n'

test('parseKfdNodes: a fused CPU+SIMD node is flagged; a SIMD-only node is not', () => {
  assert.deepEqual(parseKfdNodes([KFD_APU_NODE]), [{ domain: 0, locationId: 50688, fused: true }])
  assert.deepEqual(parseKfdNodes([KFD_DGPU_NODE]), [{ domain: 0, locationId: 256, fused: false }])
})

test('parseKfdNodes: CPU-only nodes (no SIMDs) are skipped', () => {
  assert.deepEqual(parseKfdNodes([KFD_CPU_NODE]), [])
  assert.deepEqual(parseKfdNodes([KFD_CPU_NODE, KFD_DGPU_NODE]), [{ domain: 0, locationId: 256, fused: false }])
})

test('parseKfdNodes: a modern APU node is NOT fused — the premise ADR-304 got wrong', () => {
  // kfd_assign_gpu(): "Discrete GPUs need their own topology device list entries. Don't assign
  // them to CPU/APU nodes." — `if (dev->node_props.cpu_cores_count) continue;`, unconditional
  // since IOMMUv2 was removed in 6.6. So a current-kernel APU iGPU looks exactly like a discrete
  // node here, and `fused: false` must therefore mean "don't know", never "not an APU".
  const strixHaloNode = 'cpu_cores_count 0\nsimd_count 512\nlocation_id 50688\ndomain 0\n'
  assert.deepEqual(parseKfdNodes([strixHaloNode]), [{ domain: 0, locationId: 50688, fused: false }])
})

test('parseKfdNodes: an APU box with a discrete card alongside it reports both', () => {
  const nodes = parseKfdNodes([KFD_CPU_NODE, KFD_APU_NODE, KFD_DGPU_NODE])
  assert.equal(nodes.length, 2)
  assert.equal(nodes.filter((n) => n.fused).length, 1)
  assert.equal(nodes.filter((n) => !n.fused).length, 1)
})

test('parseKfdNodes: empty/garbage properties bodies are skipped, not crashed on', () => {
  assert.deepEqual(parseKfdNodes([]), [])
  assert.deepEqual(parseKfdNodes(['', 'simd_count not-a-number\n', 'unrelated 5\n']), [])
})

test('pciSlotToKfdIds: matches the kernel pci_dev_id() encoding', () => {
  // The reporter's slot: bus 0xc6, device 0, function 0 → (0xc6 << 8) = 50688, the location_id
  // in KFD_APU_NODE above.
  assert.deepEqual(pciSlotToKfdIds('c6:00.0'), { domain: 0, locationId: 50688 })
  assert.deepEqual(pciSlotToKfdIds('0000:c6:00.0'), { domain: 0, locationId: 50688 }) // sysfs form
  assert.deepEqual(pciSlotToKfdIds('01:00.0'), { domain: 0, locationId: 256 })
  assert.deepEqual(pciSlotToKfdIds('03:04.2'), { domain: 0, locationId: 802 }) // (3 << 8) | (4 << 3) | 2
})

test('pciSlotToKfdIds: the PCI domain is kept, so segments cannot collide', () => {
  // location_id alone is identical across segments — without the domain a discrete card in
  // segment 1 would match an APU's node in segment 0 and wrongly inherit its GTT (ADR-306).
  assert.deepEqual(pciSlotToKfdIds('0001:c6:00.0'), { domain: 1, locationId: 50688 })
  assert.notDeepEqual(pciSlotToKfdIds('0001:c6:00.0'), pciSlotToKfdIds('0000:c6:00.0'))
})

test('pciSlotToKfdIds: null for anything not a PCI slot', () => {
  assert.equal(pciSlotToKfdIds(''), null)
  assert.equal(pciSlotToKfdIds('not-a-slot'), null)
  assert.equal(pciSlotToKfdIds('c6:00'), null)
})

// ---- linuxGpuFromLspci: the end-to-end per-adapter decision, with sysfs + KFD injected. These
// are the cases that decide the number the user actually sees. --------------------------------

const RAM_131GB = 131.2e9
const STRIX_HALO_MEM = { vramMb: 1073, gttMb: 115_964 } // the reporter's carveout + GTT pool
const RX_9070_LSPCI =
  '03:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 48 [Radeon RX 9070/9070 XT]" -rc0 "Sapphire Technology Limited" "Device e51a"'

test('linuxGpuFromLspci: GitHub #85 — a Strix Halo APU reports its full unified-memory budget', () => {
  const gpu = linuxGpuFromLspci(STRIX_HALO_LSPCI, () => STRIX_HALO_MEM, () => true, RAM_131GB)
  assert.ok(gpu)
  assert.equal(gpu.vendor, 'amd')
  assert.equal(gpu.name, 'Strix Halo [Radeon 8050S / 8060S]')
  assert.equal(gpu.vramMb, 117_037)
  assert.ok(gpu.vramMb > 100_000, 'the 1.1 GB BIOS carveout must not be the reported budget')
})

test('linuxGpuFromLspci: a DISCRETE AMD card never counts GTT toward VRAM', () => {
  // GTT for a discrete card is system RAM across PCIe — counting it would over-report a 16 GB
  // card as ~80 GB and green-light loads that OOM.
  const gpu = linuxGpuFromLspci(RX_9070_LSPCI, () => ({ vramMb: 17_180, gttMb: 65_600 }), () => false, RAM_131GB)
  assert.ok(gpu)
  assert.equal(gpu.vendor, 'amd')
  assert.equal(gpu.vramMb, 17_180)
})

test('linuxGpuFromLspci: an NVIDIA card keeps its sysfs VRAM and never takes the APU path', () => {
  const line = '01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GB203 [GeForce RTX 5070 Ti]" -ra1 "NVIDIA Corporation" "Device 0000"'
  // isApu deliberately returns true to prove the vendor gate — nvidia must never reach it.
  const gpu = linuxGpuFromLspci(line, () => ({ vramMb: 17_180, gttMb: 65_600 }), () => true, RAM_131GB)
  assert.ok(gpu)
  assert.equal(gpu.vendor, 'nvidia')
  assert.equal(gpu.vramMb, 17_180)
})

test('linuxGpuFromLspci: an Intel iGPU (no amdgpu sysfs at all) keeps the 50%-of-RAM heuristic', () => {
  // "intel" is only in the vendor field, "Graphics" only in the device field — the reason both
  // are classified together (ADR-304). Splitting them silently un-detected this iGPU.
  const line = '00:02.0 "VGA compatible controller" "Intel Corporation" "3rd Gen Core processor Graphics Controller" -r09 "Lenovo" "Device 21fa"'
  const gpu = linuxGpuFromLspci(line, () => ({ vramMb: 0, gttMb: 0 }), () => false, 16e9)
  assert.ok(gpu)
  assert.equal(gpu.vendor, 'intel')
  assert.equal(gpu.name, '3rd Gen Core processor Graphics Controller')
  assert.equal(gpu.vramMb, 8000)
})

test('linuxGpuFromLspci: the APU budget is tagged unified so it is never pooled with a real card', () => {
  const gpu = linuxGpuFromLspci(STRIX_HALO_LSPCI, () => STRIX_HALO_MEM, () => true, RAM_131GB)
  assert.equal(gpu?.unified, true)
  // A discrete card must NOT carry the flag, or detectHardware would drop it from the sum.
  const dgpu = linuxGpuFromLspci(RX_9070_LSPCI, () => ({ vramMb: 17_180, gttMb: 65_600 }), () => false, RAM_131GB)
  assert.equal(dgpu?.unified, undefined)
})

test('linuxGpuFromLspci: an unknown device keeps its vendor in the display name', () => {
  // A card newer than the local pci.ids prints as a bare "Device 7550" — meaningless alone.
  const line = '03:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Device 7550" -rc0 "Sapphire Technology Limited" "Device e51a"'
  const gpu = linuxGpuFromLspci(line, () => ({ vramMb: 17_180, gttMb: 0 }), () => false, RAM_131GB)
  assert.equal(gpu?.name, 'Advanced Micro Devices, Inc. [AMD/ATI] Device 7550')
  assert.equal(gpu?.vendor, 'amd')
})

test('linuxGpuFromLspci: does not log unless the caller passes a logger', () => {
  // The log is a real diagnostic in production (it is how the next APU report gets triaged), but
  // it must not fire during unit tests — hence the injected no-op default.
  const lines: string[] = []
  linuxGpuFromLspci(STRIX_HALO_LSPCI, () => STRIX_HALO_MEM, () => true, RAM_131GB)
  linuxGpuFromLspci(STRIX_HALO_LSPCI, () => STRIX_HALO_MEM, () => true, RAM_131GB, (m) => lines.push(m))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /gtt=115964MB → 117037MB usable/)
})

test('linuxGpuFromLspci: a line that does not parse still yields the old whole-line behaviour', () => {
  const line = 'c6:00.0 Display controller Advanced Micro Devices, Inc. [AMD/ATI] Strix Halo'
  const gpu = linuxGpuFromLspci(line, () => ({ vramMb: 1073, gttMb: 115_964 }), () => true, RAM_131GB)
  assert.ok(gpu)
  assert.equal(gpu.vendor, 'amd')
  assert.equal(gpu.name, line) // under 80 chars, so unchanged
  assert.equal(gpu.vramMb, 117_037) // the APU fix still applies — it keys off sysfs + KFD, not the name
})
