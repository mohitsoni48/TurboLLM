// Shape smoke tests for hand-written daemon↔web type twins (types.ts). These types are erased
// at runtime, so there is nothing to unit-test about them directly — what IS worth asserting is
// that a value shaped the way the daemon actually sends it satisfies the type, which is what
// keeps a future field rename/removal here from silently drifting out of sync with usage-parse.ts
// (see that file's own comment on HwGpuUsage) without tsc catching it in an unrelated file.
import { describe, expect, it } from 'vitest'
import type { HwDiskUsage, HwUsage } from './types'

describe('HwUsage.disk (GitHub #211 follow-up)', () => {
  it('accepts a real disk sample', () => {
    const disk: HwDiskUsage = { readMBps: 12.5, writeMBps: 3.25, combined: false }
    const usage: HwUsage = { cpuPct: 10, ram: { usedMb: 1, totalMb: 2 }, gpus: [], disk, sampledAt: Date.now() }
    expect(usage.disk?.readMBps).toBe(12.5)
    expect(usage.disk?.writeMBps).toBe(3.25)
    expect(usage.disk?.combined).toBe(false)
  })

  it('accepts a combined sample — one un-split throughput figure (macOS iostat)', () => {
    const disk: HwDiskUsage = { readMBps: 512, writeMBps: null, combined: true }
    expect(disk.combined).toBe(true)
    expect(disk.writeMBps).toBeNull()
  })

  it('accepts null — no reader for this platform, or no rated sample yet', () => {
    const usage: HwUsage = { cpuPct: null, ram: { usedMb: 1, totalMb: 2 }, gpus: [], disk: null, sampledAt: Date.now() }
    expect(usage.disk).toBeNull()
  })

  it('accepts a partially-null sample (one side of the split unavailable)', () => {
    const disk: HwDiskUsage = { readMBps: 5, writeMBps: null, combined: false }
    expect(disk.writeMBps).toBeNull()
    expect(disk.combined).toBe(false)
  })
})
