import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HfRepoContent } from './HfRepoDialog'
import type { HfRepoDetail, HfRepoFile, SysGpu } from '../../lib/types'

// Issue #239: the quant picker used only GPU 0, so a quant that fits across two
// cards was marked as overflowing and excluded from the default recommendation.
const state: { sys: { gpus: SysGpu[] } | undefined; detail: HfRepoDetail } = {
  sys: undefined,
  detail: {} as HfRepoDetail,
}

vi.mock('../../lib/queries', () => ({
  useHfRepo: () => ({ data: state.detail }),
  useSysInfo: () => ({ data: state.sys }),
  useStatus: () => ({ data: { engine: { kind: 'llamacpp' } } }),
  useDownloadMutations: () => ({ enqueue: { mutate: vi.fn(), isPending: false, error: null } }),
  useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false } }),
  useSettings: () => ({ query: { data: { hfTokenSet: false } } }),
}))

vi.mock('../../lib/link-queries', () => ({
  useLinks: () => ({ data: [] }),
  useRemoteDownloadActions: () => ({ start: { mutate: vi.fn(), isPending: false } }),
}))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function gpu(vramMb: number): SysGpu {
  return { name: 'AMD Radeon', vramMb }
}

function file(quant: string, sizeBytes: number): HfRepoFile {
  return { name: `model-${quant}.gguf`, quant, sizeBytes, parts: 1, mmproj: false, url: '' }
}

function renderContent() {
  return render(<HfRepoContent repo="owner/model" onClose={vi.fn()} />)
}

const fitsLabel = 'Fits comfortably on your GPU.'
const tightLabel = 'Tight fit — may slow under desktop load.'
const overflowLabel = 'Larger than your VRAM — will spill to system RAM.'
const unknownLabel = 'Fit unknown — GPU VRAM not detected.'

beforeEach(() => {
  state.sys = { gpus: [gpu(16384), gpu(16384)] }
  state.detail = {
    repo: 'owner/model', gated: false, license: 'apache-2.0', downloads: 0, likes: 0, card: '',
    files: [file('Q2_K', 8e9), file('Q4_K_M', 20e9), file('Q5_K_M', 24e9), file('Q8_0', 28e9)],
  }
})

describe('HfRepoContent — multi-GPU VRAM', () => {
  it('uses both cards for the default quant, each dropdown verdict and the selected verdict', async () => {
    const user = userEvent.setup()
    renderContent()
    const picker = screen.getByRole('button', { name: /Q4_K_M/ })
    expect(within(picker).getByTitle(fitsLabel)).toBeInTheDocument()
    expect(screen.getByText(`${fitsLabel} (20.0 GB file · 32 GB VRAM)`)).toBeInTheDocument()

    await user.click(picker)
    for (const [quant, label] of [
      ['Q2_K', fitsLabel], ['Q4_K_M', fitsLabel], ['Q5_K_M', tightLabel], ['Q8_0', overflowLabel],
    ]) {
      expect(within(screen.getByRole('menuitem', { name: new RegExp(quant) })).getByTitle(label)).toBeInTheDocument()
    }
    await user.click(screen.getByRole('menuitem', { name: /Q5_K_M/ }))
    expect(screen.getByText(`${tightLabel} (24.0 GB file · 32 GB VRAM)`)).toBeInTheDocument()
  })

  it('keeps a single card budget and recommendation unchanged', async () => {
    state.sys = { gpus: [gpu(16384)] }
    renderContent()
    expect(screen.getByText(`${fitsLabel} (8.0 GB file · 16 GB VRAM)`)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Q2_K/ }))
    expect(within(screen.getByRole('menuitem', { name: /Q4_K_M/ })).getByTitle(overflowLabel)).toBeInTheDocument()
  })

  it('sums unequal card sizes rather than assuming every card matches GPU 0', () => {
    state.sys = { gpus: [gpu(8192), gpu(24576)] }
    renderContent()
    expect(screen.getByRole('button', { name: /Q4_K_M/ })).toBeInTheDocument()
    expect(screen.getByText(/20\.0 GB file · 32 GB VRAM/)).toBeInTheDocument()
  })

  it('uses detected VRAM even when the first card reports zero', () => {
    state.sys = { gpus: [gpu(0), gpu(16384)] }
    renderContent()
    expect(screen.getByText(`${fitsLabel} (8.0 GB file · 16 GB VRAM)`)).toBeInTheDocument()
  })

  it.each<[string, typeof state.sys]>([
    ['sysinfo has not arrived', undefined],
    ['there are no GPUs', { gpus: [] }],
    ['all cards report zero VRAM', { gpus: [gpu(0), gpu(0)] }],
  ])('keeps fit unknown when %s', async (_label, sys) => {
    state.sys = sys
    renderContent()
    expect(screen.getByText(unknownLabel)).toBeInTheDocument()
    expect(screen.queryByText(/GB VRAM/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Q2_K/ }))
    for (const item of screen.getAllByRole('menuitem')) {
      expect(within(item).getByTitle(unknownLabel)).toBeInTheDocument()
    }
  })

  it('updates the recommendation when hardware information arrives', () => {
    state.sys = undefined
    const view = renderContent()
    expect(screen.getByRole('button', { name: /Q2_K/ })).toBeInTheDocument()
    state.sys = { gpus: [gpu(16384), gpu(16384)] }
    view.rerender(<HfRepoContent repo="owner/model" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Q4_K_M/ })).toBeInTheDocument()
    expect(screen.getByText(/20\.0 GB file · 32 GB VRAM/)).toBeInTheDocument()
  })

  it('uses the same total for safetensors repos', () => {
    state.detail.safetensors = true
    state.detail.files = [{ ...file('', 20e9), name: 'model.safetensors', safetensors: true }]
    renderContent()
    expect(screen.getByText(`${fitsLabel} (20.0 GB total · 32 GB VRAM)`)).toBeInTheDocument()
  })
})
