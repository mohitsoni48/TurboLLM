import { describe, expect, it } from 'vitest'
import {
  aggregateGpu,
  fmtGb,
  fmtPct,
  isUnifiedBox,
  ramPct,
  tone,
  toneColor,
  unifiedGpuMb,
  vramPct,
  type HwUsage,
} from './hw-format'
import type { HwGpuUsage } from './types'

const gpu = (over: Partial<HwGpuUsage> & { index: number }): HwGpuUsage => ({
  name: `GPU ${over.index}`,
  utilPct: null,
  vramUsedMb: null,
  vramTotalMb: 0,
  vramSharedMb: null,
  unified: false,
  ...over,
})

const box = (gpus: HwGpuUsage[], over: Partial<HwUsage> = {}): HwUsage => ({
  cpuPct: null,
  ram: { usedMb: 8000, totalMb: 32000 },
  sampledAt: 0,
  gpus,
  ...over,
})

describe('fmtGb', () => {
  it('renders — for null', () => expect(fmtGb(null)).toBe('—'))
  it('renders MB/1000 to one decimal', () => {
    expect(fmtGb(18200)).toBe('18.2')
    expect(fmtGb(512)).toBe('0.5')
    expect(fmtGb(0)).toBe('0.0')
  })
})

describe('fmtPct', () => {
  it('renders — for null', () => expect(fmtPct(null)).toBe('—'))
  it('rounds to a whole percent', () => {
    expect(fmtPct(38)).toBe('38%')
    expect(fmtPct(38.4)).toBe('38%')
    expect(fmtPct(38.5)).toBe('39%')
    expect(fmtPct(100)).toBe('100%')
  })
})

describe('tone', () => {
  it('is ok below 85, warn at 85, danger at 95', () => {
    expect(tone(null)).toBe('ok')
    expect(tone(0)).toBe('ok')
    expect(tone(84.9)).toBe('ok')
    expect(tone(85)).toBe('warn')
    expect(tone(94.9)).toBe('warn')
    expect(tone(95)).toBe('danger')
    expect(tone(100)).toBe('danger')
  })
})

describe('toneColor', () => {
  it('maps to the theme tokens; ok uses the accent, not green', () => {
    expect(toneColor('ok')).toBe('var(--accent)')
    expect(toneColor('warn')).toBe('var(--warn)')
    expect(toneColor('danger')).toBe('var(--err)')
  })
})

describe('isUnifiedBox', () => {
  it('is false for a CPU-only box', () => expect(isUnifiedBox(box([]))).toBe(false))
  it('is true when every GPU is unified', () =>
    expect(isUnifiedBox(box([gpu({ index: 0, unified: true }), gpu({ index: 1, unified: true })]))).toBe(true))
  it('is false for mixed unified/discrete', () =>
    expect(isUnifiedBox(box([gpu({ index: 0, unified: true }), gpu({ index: 1, unified: false })]))).toBe(false))
})

describe('aggregateGpu', () => {
  it('takes max utilization and summed VRAM across cards', () => {
    const u = box([
      gpu({ index: 0, utilPct: 40, vramUsedMb: 1000, vramTotalMb: 16000 }),
      gpu({ index: 1, utilPct: 90, vramUsedMb: 2000, vramTotalMb: 16000 }),
    ])
    expect(aggregateGpu(u)).toEqual({ utilPct: 90, usedMb: 3000, totalMb: 32000 })
  })
  it('stays null when every card reports null utilization — never collapses to 0', () => {
    const u = box([
      gpu({ index: 0, utilPct: null, vramUsedMb: 1000, vramTotalMb: 16000 }),
      gpu({ index: 1, utilPct: null, vramUsedMb: 2000, vramTotalMb: 16000 }),
    ])
    expect(aggregateGpu(u)).toEqual({ utilPct: null, usedMb: 3000, totalMb: 32000 })
  })
  it('a single null used makes the aggregate null — known+unknown must not print a measured-looking sum', () => {
    const u = box([
      gpu({ index: 0, utilPct: 10, vramUsedMb: 1000, vramTotalMb: 8000 }),
      gpu({ index: 1, utilPct: null, vramUsedMb: null, vramTotalMb: 8000 }),
    ])
    expect(aggregateGpu(u).usedMb).toBe(null)
  })
  it('a single null util makes the aggregate null — a max over the known cards could hide a 100% card', () => {
    const u = box([
      gpu({ index: 0, utilPct: 40, vramUsedMb: 1000, vramTotalMb: 8000 }),
      gpu({ index: 1, utilPct: null, vramUsedMb: 2000, vramTotalMb: 8000 }),
    ])
    expect(aggregateGpu(u).utilPct).toBe(null)
  })
  it('returns nulls for a CPU-only box', () =>
    expect(aggregateGpu(box([]))).toEqual({ utilPct: null, usedMb: null, totalMb: 0 }))
})

describe('ramPct / vramPct', () => {
  it('computes used/total percent', () => {
    expect(ramPct(box([], { ram: { usedMb: 8000, totalMb: 32000 } }))).toBe(25)
  })
  it('is null when the total is 0', () =>
    expect(ramPct(box([], { ram: { usedMb: 100, totalMb: 0 } }))).toBe(null))
  it('vramPct is null when the aggregate has no usage or no total', () => {
    expect(vramPct(box([gpu({ index: 0, vramUsedMb: 500, vramTotalMb: 2000 })]))).toBe(25)
    expect(vramPct(box([gpu({ index: 0, vramUsedMb: null, vramTotalMb: 2000 })]))).toBe(null)
    expect(vramPct(box([]))).toBe(null)
  })
})

describe('unifiedGpuMb', () => {
  it('sums the GPU slice of the shared pool', () => {
    const u = box([
      gpu({ index: 0, unified: true, vramUsedMb: 3000, vramTotalMb: 32000 }),
      gpu({ index: 1, unified: true, vramUsedMb: 1000, vramTotalMb: 32000 }),
    ])
    expect(unifiedGpuMb(u)).toBe(4000)
  })
  it('is null when the slice is unknown or the box is not unified', () => {
    expect(unifiedGpuMb(box([gpu({ index: 0, unified: true, vramUsedMb: null })]))).toBe(null)
    expect(unifiedGpuMb(box([gpu({ index: 0, unified: false, vramUsedMb: 3000 })]))).toBe(null)
  })
})
