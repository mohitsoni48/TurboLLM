// Pure-parser tests for live hardware usage (ADR-383). Every function under test is I/O-free:
// the strings here are real tool output captured from the tools themselves, so a parser change
// that breaks a real vendor's format fails here rather than on a user's box.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpuPctFromTimes,
  mergeUsage,
  parseAmdgpuSysfs,
  parseIoregAccelerator,
  parseNvidiaSmiUsage,
  parseRocmUsage,
  parseWddmSample,
  sumCpuTimes,
} from './usage-parse'
import type { GpuSample } from './usage-parse'
import type { SysInfo } from './sysinfo'

const sysWith = (...gpus: SysInfo['gpus']): SysInfo => ({
  os: 'win32/x64',
  cpu: 'test',
  cores: 8,
  ramMB: 64000,
  gpus,
})

// ── nvidia-smi ───────────────────────────────────────────────────────────────

test('parseNvidiaSmiUsage: the real RTX 5070 Ti line captured on the dev box', () => {
  // Verbatim output of:
  //   nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total \
  //              --format=csv,noheader,nounits
  const [g] = parseNvidiaSmiUsage('0, NVIDIA GeForce RTX 5070 Ti, 99, 5922, 16303')
  assert.equal(g.id, '0')
  assert.equal(g.name, 'NVIDIA GeForce RTX 5070 Ti')
  assert.equal(g.utilPct, 99)
  assert.equal(g.vramUsedMb, 5922)
  assert.equal(g.vramTotalMb, 16303)
  assert.equal(g.vramSharedMb, null)
})

test('parseNvidiaSmiUsage: two cards', () => {
  const gs = parseNvidiaSmiUsage('0, Tesla T4, 12, 900, 15360\n1, Tesla T4, 0, 12, 15360')
  assert.equal(gs.length, 2)
  assert.equal(gs[1].id, '1')
  assert.equal(gs[1].utilPct, 0) // a real zero must survive as 0, never become null
})

test('parseNvidiaSmiUsage: [N/A] fields become null, not 0', () => {
  // Some cards (and some driver/VM combinations) report [N/A] for utilization. Reporting that as
  // 0% would draw an idle bar on a card that is actually pegged — the UI must show a dash.
  const [g] = parseNvidiaSmiUsage('0, NVIDIA A100-SXM4, [N/A], 4096, 40960')
  assert.equal(g.utilPct, null)
  assert.equal(g.vramUsedMb, 4096)
})

test('parseNvidiaSmiUsage: blank and malformed lines are skipped, not crashed on', () => {
  assert.deepEqual(parseNvidiaSmiUsage(''), [])
  assert.deepEqual(parseNvidiaSmiUsage('\n  \n'), [])
  assert.deepEqual(parseNvidiaSmiUsage('garbage without commas'), [])
})

// ── Windows WDDM performance counters ────────────────────────────────────────

test('parseWddmSample: one adapter from our own PowerShell JSON line', () => {
  const line =
    '{"adapters":[{"id":"luid_0x00000000_0x000116eb_phys_0","dedicatedMb":5926.8,"sharedMb":12.3,"utilPct":11.5}]}'
  const [g] = parseWddmSample(line)
  assert.equal(g.id, 'luid_0x00000000_0x000116eb_phys_0')
  assert.equal(g.vramUsedMb, 5926.8)
  assert.equal(g.vramSharedMb, 12.3)
  assert.equal(g.utilPct, 11.5)
  // WDDM exposes no capacity figure at all — mergeUsage fills this from SysInfo.
  assert.equal(g.vramTotalMb, null)
})

test('parseWddmSample: malformed JSON yields [] rather than throwing', () => {
  assert.deepEqual(parseWddmSample('not json'), [])
  assert.deepEqual(parseWddmSample(''), [])
  assert.deepEqual(parseWddmSample('{"adapters":"nope"}'), [])
})

// ── ROCm ─────────────────────────────────────────────────────────────────────

const ROCM_MEM = JSON.stringify({
  card0: { 'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '2147483648' },
})
const ROCM_USE = JSON.stringify({ card0: { 'GPU use (%)': '37' } })

test('parseRocmUsage: joins --showmeminfo and --showuse by card key', () => {
  const [g] = parseRocmUsage(ROCM_MEM, ROCM_USE)
  assert.equal(g.id, 'card0')
  assert.equal(g.vramUsedMb, 2147) // 2147483648 B / 1e6, rounded
  assert.equal(g.vramTotalMb, 17163)
  assert.equal(g.utilPct, 37)
})

test('parseRocmUsage: a card present in memory output but missing from use output', () => {
  // rocm-smi can disagree between subcommands; memory is the authority for which cards exist,
  // and a missing utilization figure is a dash, not a zero.
  const [g] = parseRocmUsage(ROCM_MEM, '{}')
  assert.equal(g.vramUsedMb, 2147)
  assert.equal(g.utilPct, null)
})

test('parseRocmUsage: unparseable JSON yields []', () => {
  assert.deepEqual(parseRocmUsage('nope', 'nope'), [])
})

// ── Linux amdgpu sysfs ───────────────────────────────────────────────────────

test('parseAmdgpuSysfs: converts byte counters and reads gpu_busy_percent', () => {
  const [g] = parseAmdgpuSysfs([
    {
      id: 'card0',
      name: 'AMD Radeon RX 7900 XTX',
      vramUsed: '8589934592',
      vramTotal: '25769803776',
      gttUsed: '1073741824',
      busyPct: '64',
    },
  ])
  assert.equal(g.vramUsedMb, 8590)
  assert.equal(g.vramTotalMb, 25770)
  assert.equal(g.vramSharedMb, 1074)
  assert.equal(g.utilPct, 64)
})

test('parseAmdgpuSysfs: gpu_busy_percent absent (older kernels) is null, not 0', () => {
  const [g] = parseAmdgpuSysfs([
    { id: 'card0', name: 'AMD', vramUsed: '1000000', vramTotal: '2000000', gttUsed: null, busyPct: null },
  ])
  assert.equal(g.utilPct, null)
  assert.equal(g.vramSharedMb, null)
})

// ── macOS ioreg ──────────────────────────────────────────────────────────────

test('parseIoregAccelerator: pulls utilization and in-use memory from ioreg text', () => {
  // Shape of `ioreg -c IOAccelerator -r -d 1 -w 0` on Apple Silicon. UNVERIFIED on real
  // hardware (ADR-383 records this); the parser is written against the documented key names
  // and fails open to [] if they do not appear.
  const text = `
    +-o AGXAcceleratorG13X  <class AGXAcceleratorG13X>
      {
        "PerformanceStatistics" = {"Device Utilization %"=71,"In use system memory"=16106127360}
        "IOClass" = "AGXAcceleratorG13X"
      }
  `
  const [g] = parseIoregAccelerator(text)
  assert.equal(g.utilPct, 71)
  assert.equal(g.vramUsedMb, 16106)
})

test('parseIoregAccelerator: no match yields [] rather than a zeroed card', () => {
  assert.deepEqual(parseIoregAccelerator('nothing useful here'), [])
})

// ── CPU percent ──────────────────────────────────────────────────────────────

const times = (user: number, idle: number) => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }]

test('sumCpuTimes: sums every core into one idle/total pair', () => {
  const t = sumCpuTimes([
    { times: { user: 10, nice: 1, sys: 2, idle: 87, irq: 0 } },
    { times: { user: 20, nice: 0, sys: 0, idle: 80, irq: 0 } },
  ])
  assert.equal(t.idle, 167)
  assert.equal(t.total, 200)
})

test('cpuPctFromTimes: the first tick has no predecessor, so it reports null not 0', () => {
  // Load-bearing: a 0% first reading would render an idle CPU bar for one tick on every open.
  assert.equal(cpuPctFromTimes(null, sumCpuTimes(times(10, 90))), null)
})

test('cpuPctFromTimes: a zero-length interval is null, not a divide-by-zero', () => {
  const t = sumCpuTimes(times(10, 90))
  assert.equal(cpuPctFromTimes(t, t), null)
})

test('cpuPctFromTimes: half the delta spent idle is 50%', () => {
  const prev = sumCpuTimes(times(0, 0))
  const cur = sumCpuTimes(times(50, 50))
  assert.equal(cpuPctFromTimes(prev, cur), 50)
})

test('cpuPctFromTimes: clamps into 0..100 even if the counters go backwards', () => {
  const prev = sumCpuTimes(times(0, 100))
  // Idle went DOWN while total went up — impossible, but counters do glitch across suspend/resume.
  // The naive formula yields 200% here; it must clamp rather than render a 2x-full bar.
  const cur = sumCpuTimes(times(100, 50))
  const v = cpuPctFromTimes(prev, cur)
  assert.ok(v !== null && v >= 0 && v <= 100, `expected 0..100, got ${v}`)
})

// ── mergeUsage ───────────────────────────────────────────────────────────────

const sample = (over: Partial<GpuSample> = {}): GpuSample => ({
  id: '0',
  name: 'NVIDIA GeForce RTX 5070 Ti',
  utilPct: 99,
  vramUsedMb: 5922,
  vramTotalMb: 16303,
  vramSharedMb: null,
  ...over,
})

test('mergeUsage: equal lengths zip by index and keep the reader as the authority', () => {
  const sys = sysWith({ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16303, vendor: 'nvidia' })
  const [g] = mergeUsage(sys, [sample()])
  assert.equal(g.index, 0)
  assert.equal(g.utilPct, 99)
  assert.equal(g.vramUsedMb, 5922)
  assert.equal(g.vramTotalMb, 16303)
  assert.equal(g.unified, false)
})

test('mergeUsage: a reader with no capacity figure (WDDM) inherits the total from SysInfo', () => {
  const sys = sysWith({ name: 'Intel Arc A770', vramMb: 16000, vendor: 'intel' })
  const [g] = mergeUsage(sys, [sample({ id: 'luid_x', name: 'luid_x', vramTotalMb: null, vramUsedMb: 4000 })])
  assert.equal(g.vramTotalMb, 16000)
  assert.equal(g.vramUsedMb, 4000)
})

test('mergeUsage: null samples still describe the cards, with usage all null', () => {
  // The reader being unavailable must not hide the hardware — the UI shows the card with dashes.
  const sys = sysWith({ name: 'Apple M3 Max', vramMb: 65536, vendor: 'apple', unified: true })
  const [g] = mergeUsage(sys, null)
  assert.equal(g.name, 'Apple M3 Max')
  assert.equal(g.vramTotalMb, 65536)
  assert.equal(g.utilPct, null)
  assert.equal(g.vramUsedMb, null)
  assert.equal(g.unified, true)
})

test('mergeUsage: the unified flag survives onto the merged entry', () => {
  // ADR-306 / GitHub #164: this flag is what stops the UI drawing RAM and VRAM as two pools on a
  // box where they are the same bytes. If it is ever dropped in the merge, the bar double-counts.
  const sys = sysWith({ name: 'AMD Radeon(TM) Graphics', vramMb: 32000, vendor: 'amd', unified: true })
  const [g] = mergeUsage(sys, [sample({ id: 'card0', name: 'AMD Radeon(TM) Graphics', vramTotalMb: null })])
  assert.equal(g.unified, true)
})

test('mergeUsage: unified resolves by name when the reader orders cards differently', () => {
  const sys = sysWith(
    { name: 'NVIDIA GeForce RTX 4090', vramMb: 24000, vendor: 'nvidia' },
    { name: 'AMD Radeon(TM) Graphics', vramMb: 16000, vendor: 'amd', unified: true },
  )
  const merged = mergeUsage(sys, [
    sample({ id: '1', name: 'AMD Radeon(TM) Graphics', vramTotalMb: null }),
    sample({ id: '0', name: 'NVIDIA GeForce RTX 4090', vramTotalMb: null }),
  ])
  assert.equal(merged[0].unified, true, 'first reader entry is the AMD iGPU')
  assert.equal(merged[0].vramTotalMb, 16000, 'and it inherits the iGPU capacity, not the 4090 one')
  assert.equal(merged[1].unified, false)
  assert.equal(merged[1].vramTotalMb, 24000)
})

test('mergeUsage: a CPU-only box has no GPU entries at all', () => {
  // ADR-239: no dead UI. An empty list is what tells HardwareBar to omit the GPU groups.
  assert.deepEqual(mergeUsage(sysWith(), null), [])
  assert.deepEqual(mergeUsage(sysWith(), []), [])
})
