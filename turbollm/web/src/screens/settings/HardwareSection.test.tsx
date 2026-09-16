import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { HwGpuUsage, HwUsage } from '../../lib/types'
import type { SysInfo } from '../../lib/api'

// Same mocking shape as HardwareBar.test.tsx: HardwareSection's only external dependencies are
// the sysinfo + hwstats queries, both mocked at the module level so the test drives exactly what
// the daemon would have returned.
const state = vi.hoisted(() => ({
  sys: undefined as SysInfo | undefined,
  usage: undefined as HwUsage | undefined,
}))

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useSysInfo: () => ({ data: state.sys, isLoading: state.sys === undefined }),
    useHwUsage: () => ({ data: state.usage, isFetching: false, isLoading: false }),
  }
})

import { HardwareSection } from './HardwareSection'

const gpu = (over: Partial<HwGpuUsage> & { index: number }): HwGpuUsage => ({
  name: `GPU ${over.index}`,
  utilPct: null,
  vramUsedMb: null,
  vramTotalMb: 0,
  vramSharedMb: null,
  unified: false,
  ...over,
})

const sysInfo = (gpus: SysInfo['gpus'] = []): SysInfo => ({
  os: 'win32/x64',
  cpu: 'test cpu',
  cores: 8,
  ramMB: 32000,
  gpus,
})

const usage = (gpus: HwGpuUsage[], over: Partial<HwUsage> = {}): HwUsage => ({
  cpuPct: 10,
  ram: { usedMb: 8000, totalMb: 32000 },
  gpus,
  disk: null,
  sampledAt: Date.now(),
  ...over,
})

function renderSection() {
  return render(<HardwareSection />)
}

beforeEach(() => {
  cleanup()
  state.sys = undefined
  state.usage = undefined
})

describe('HardwareSection — disk I/O (GitHub #211 follow-up)', () => {
  it('shows nothing disk-related while disk is null (no reader for this platform / not rated yet)', () => {
    state.sys = sysInfo()
    state.usage = usage([], { disk: null })
    renderSection()
    expect(screen.queryByText('Disk I/O')).not.toBeInTheDocument()
  })

  it('renders read and write MB/s once a disk sample lands', () => {
    state.sys = sysInfo()
    state.usage = usage([], { disk: { readMBps: 12.5, writeMBps: 3.25, combined: false } })
    renderSection()
    expect(screen.getByText('Disk I/O')).toBeInTheDocument()
    expect(screen.getByText('12.5 MB/s')).toBeInTheDocument()
    expect(screen.getByText('3.3 MB/s')).toBeInTheDocument()
  })

  it('renders a partial sample (one side null) without hiding the other', () => {
    state.sys = sysInfo()
    state.usage = usage([], { disk: { readMBps: 8, writeMBps: null, combined: false } })
    renderSection()
    expect(screen.getByText('8.0 MB/s')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('labels a split sample Read and Write, never Throughput', () => {
    state.sys = sysInfo()
    state.usage = usage([], { disk: { readMBps: 12.5, writeMBps: 3.25, combined: false } })
    renderSection()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Write')).toBeInTheDocument()
    expect(screen.queryByText('Throughput')).not.toBeInTheDocument()
  })

  it('collapses a combined sample (macOS iostat) into one Throughput row', () => {
    state.sys = sysInfo()
    state.usage = usage([], { disk: { readMBps: 512, writeMBps: null, combined: true } })
    renderSection()
    expect(screen.getByText('Throughput')).toBeInTheDocument()
    expect(screen.getByText('512.0 MB/s')).toBeInTheDocument()
    expect(screen.queryByText('Read')).not.toBeInTheDocument()
    expect(screen.queryByText('Write')).not.toBeInTheDocument()
  })
})

describe('HardwareSection — shared/spilled VRAM (GitHub #211 follow-up)', () => {
  const discreteGpu = sysInfo([{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16303, vendor: 'nvidia' }])

  it('does not show a shared-memory figure when the card has none (no spillage)', () => {
    state.sys = discreteGpu
    state.usage = usage([gpu({ index: 0, name: 'NVIDIA GeForce RTX 5070 Ti', utilPct: 40, vramUsedMb: 5000, vramTotalMb: 16303, vramSharedMb: null })])
    renderSection()
    expect(screen.queryByText(/shared/i)).not.toBeInTheDocument()
  })

  it('surfaces the shared/spilled figure for a discrete card that has spilled into system RAM', () => {
    state.sys = discreteGpu
    state.usage = usage([gpu({ index: 0, name: 'NVIDIA GeForce RTX 5070 Ti', utilPct: 90, vramUsedMb: 16303, vramTotalMb: 16303, vramSharedMb: 2048 })])
    renderSection()
    expect(screen.getByText(/2\.0 GB shared/i)).toBeInTheDocument()
  })
})
