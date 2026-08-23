import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { HwGpuUsage, HwUsage } from '../lib/types'

// The bar's only external dependencies are the hwstats query and the track() call, so both
// are mocked at the module level: the test drives what the daemon would have returned, and
// the click assertion reads the tracked event without a live telemetry queue.
const state = vi.hoisted(() => ({
  data: undefined as HwUsage | undefined,
  trackCalls: [] as [string, string][],
}))

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return { ...actual, useHwUsage: () => ({ data: state.data, isFetching: false, isLoading: false }) }
})
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, track: (screen: string, action: string) => { state.trackCalls.push([screen, action]) } }
})

import { HardwareBar } from './HardwareBar'
import { useUiStore } from '../stores/ui'

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
  cpuPct: 38,
  ram: { usedMb: 8000, totalMb: 32000 },
  sampledAt: 0,
  gpus,
  ...over,
})

function renderBar(data: HwUsage | undefined, hwBar = true) {
  useUiStore.setState({ hwBar })
  state.data = data
  return render(
    <MemoryRouter initialEntries={['/chat']}>
      <HardwareBar />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  cleanup()
  state.trackCalls.length = 0
  localStorage.clear()
})

const discreteBox = () => box([gpu({ index: 0, utilPct: 40, vramUsedMb: 5922, vramTotalMb: 16303 })])

describe('HardwareBar', () => {
  it('renders nothing when hwBar is off', () => {
    const { container } = renderBar(discreteBox(), false)
    expect(container.innerHTML).toBe('')
  })

  it('shows — placeholders while no sample exists yet, so the height never jitters', () => {
    renderBar(undefined)
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('renders cpu, ram, gpu, vram groups on a discrete box', () => {
    renderBar(discreteBox())
    for (const label of ['CPU', 'RAM', 'GPU', 'VRAM']) expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders one memory group - and no vram group - on a unified box', () => {
    renderBar(box([gpu({ index: 0, unified: true, utilPct: 55, vramUsedMb: 4000, vramTotalMb: 32000 })]))
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('GPU')).toBeInTheDocument()
    expect(screen.getByText('MEMORY')).toBeInTheDocument()
    expect(screen.queryByText('VRAM')).toBeNull()
    expect(screen.queryByText('RAM')).toBeNull()
  })

  it('omits the GPU groups entirely on a CPU-only box (ADR-239: no dead UI)', () => {
    renderBar(box([]))
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('RAM')).toBeInTheDocument()
    expect(screen.queryByText('GPU')).toBeNull()
    expect(screen.queryByText('VRAM')).toBeNull()
  })

  it('renders — for a null utilization, never 0%', () => {
    renderBar(box([gpu({ index: 0, utilPct: null, vramUsedMb: 5922, vramTotalMb: 16303 })]))
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('colours the VRAM gauge danger at 96% and warn at 90%', () => {
    renderBar(box([gpu({ index: 0, utilPct: 10, vramUsedMb: 15648, vramTotalMb: 16303 })])) // 96%
    expect(document.querySelector('[style*="var(--err)"]')).not.toBeNull()
    cleanup()
    renderBar(box([gpu({ index: 0, utilPct: 10, vramUsedMb: 14673, vramTotalMb: 16303 })])) // 90%
    expect(document.querySelector('[style*="var(--warn)"]')).not.toBeNull()
    expect(document.querySelector('[style*="var(--err)"]')).toBeNull()
  })

  it('carries the per-card split in a tooltip on multi-GPU boxes', () => {
    renderBar(box([
      gpu({ index: 0, name: 'RTX 5070 Ti', utilPct: 40, vramUsedMb: 1000, vramTotalMb: 16000 }),
      gpu({ index: 1, name: 'RTX 5070 Ti', utilPct: 90, vramUsedMb: 2000, vramTotalMb: 16000 }),
    ]))
    const title = document.querySelector('[title]')?.getAttribute('title') ?? ''
    expect(title).toContain('RTX 5070 Ti')
    expect(title).toContain('90%')
  })

  it('navigates to Settings and tracks the click', () => {
    // MemoryRouter never touches window.location, so a probe route reports the current
    // pathname for the assertion.
    const { container } = render(
      <MemoryRouter initialEntries={['/chat']}>
        <HardwareBar />
        <Routes>
          <Route path="/settings" element={<div data-testid="at-settings" />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(container.querySelector('button')!)
    expect(state.trackCalls).toEqual([['settings', 'open_system_from_hw_bar']])
    expect(screen.getByTestId('at-settings')).toBeInTheDocument()
  })
})
