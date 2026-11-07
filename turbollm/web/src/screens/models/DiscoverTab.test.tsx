// Discover's "Text classification" category (ADR-444): one toggle beside the sort that swaps the
// engine's search for the Laya and Jev models TurboLLM can run, whichever engine is active.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiscoverTab } from './DiscoverTab'
import type { Engine, HfSearchCategory, HfSearchItem } from '../../lib/types'
import { LITERT_SMALLEST_PICK, requiredMb } from '../../lib/onboarding-pick'

const CATEGORY_DESCRIPTION = 'Laya and Jev models TurboLLM can run, whichever engine is active'

const state: {
  sys: { os: string; ramMB: number; gpus: { name: string; vramMb: number }[] }
  engineRows: HfSearchItem[]
  categoryRows: HfSearchItem[]
  searchedCategories: (HfSearchCategory | undefined)[]
  engines?: { engines: Engine[]; activeEngineId: string }
  isDesktop: boolean
  repoContentProps: { repo: string; preselectFile?: string }[]
} = { sys: desktop(), engineRows: [], categoryRows: [], searchedCategories: [], isDesktop: true, repoContentProps: [] }

vi.mock('../../lib/queries', () => ({
  useHfSearch: (_q: string, _sort: string, category?: HfSearchCategory) => {
    state.searchedCategories.push(category)
    const results = category ? state.categoryRows : state.engineRows
    return { data: { results }, isLoading: false, isError: false, error: null, refetch: vi.fn() }
  },
  useSysInfo: () => ({ data: state.sys }),
  useEngines: () => ({ data: state.engines }),
}))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

vi.mock('../../lib/useIsDesktop', () => ({ useIsDesktop: () => state.isDesktop }))
vi.mock('./DownloadsPanel', () => ({ DownloadsPanel: () => null }))
vi.mock('./ImportUrlDialog', () => ({ ImportUrlDialog: () => null }))
vi.mock('./HfRepoDialog', () => ({
  HfRepoContent: (props: { repo: string; preselectFile?: string }) => {
    state.repoContentProps.push(props)
    return <p>Details of {props.repo}</p>
  },
}))

function desktop() {
  return { os: 'windows', ramMB: 32768, gpus: [{ name: 'RTX', vramMb: 16384 }] }
}

function phone() {
  return { os: 'android/arm64', ramMB: 7655, gpus: [] }
}

function row(repo: string, textClassification?: HfSearchItem['textClassification']): HfSearchItem {
  return { repo, downloads: 1200, likes: 30, updatedAt: '', gated: false, tags: [], localCount: 0, textClassification }
}

function categoryToggle() {
  return screen.getByRole('button', { name: 'Text classification' })
}

function resultRow(repo: string) {
  return screen.getByRole('button', { name: new RegExp(repo) })
}

function lastSearchedCategory() {
  return state.searchedCategories.at(-1)
}

beforeEach(() => {
  state.sys = desktop()
  state.engineRows = [row('unsloth/Qwen3-8B-GGUF')]
  state.categoryRows = [row('convaiinnovations/laya', { runtime: 'laya' }), row('AlexWortega/openjev', { runtime: 'vllm' })]
  state.searchedCategories = []
  state.engines = undefined
  state.isDesktop = true
  state.repoContentProps = []
})

describe('DiscoverTab — Text classification category', () => {
  it('is off by default and leaves the engine search as it was', () => {
    render(<DiscoverTab />)
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'false')
    expect(lastSearchedCategory()).toBeUndefined()
    expect(resultRow('unsloth/Qwen3-8B-GGUF')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search models by name or author…')).toBeInTheDocument()
    expect(screen.queryByText('Laya engine')).not.toBeInTheDocument()
  })

  it('lists the category once switched on, naming the engine each row loads on', async () => {
    render(<DiscoverTab />)
    await userEvent.click(categoryToggle())
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'true')
    expect(lastSearchedCategory()).toBe('text-classification')
    expect(screen.queryByRole('button', { name: /Qwen3-8B/ })).not.toBeInTheDocument()
    expect(within(resultRow('convaiinnovations/laya')).getByText('Laya engine')).toBeInTheDocument()
    expect(within(resultRow('AlexWortega/openjev')).getByText('vLLM')).toBeInTheDocument()
  })

  it('switches from the keyboard', async () => {
    const user = userEvent.setup()
    render(<DiscoverTab />)
    categoryToggle().focus()
    await user.keyboard('{Enter}')
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard(' ')
    expect(categoryToggle()).toHaveAttribute('aria-pressed', 'false')
  })

  it('returns to the unchanged engine search when switched off', async () => {
    render(<DiscoverTab />)
    await userEvent.click(categoryToggle())
    await userEvent.click(categoryToggle())
    expect(lastSearchedCategory()).toBeUndefined()
    expect(resultRow('unsloth/Qwen3-8B-GGUF')).toBeInTheDocument()
    expect(screen.queryByText('vLLM')).not.toBeInTheDocument()
  })

  it('says what the category is while it is on', async () => {
    state.categoryRows = []
    render(<DiscoverTab />)
    expect(categoryToggle()).toHaveAttribute('title', CATEGORY_DESCRIPTION)
    await userEvent.click(categoryToggle())
    expect(screen.getByPlaceholderText('Search Laya and Jev models…')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(CATEGORY_DESCRIPTION))).toBeInTheDocument()
  })

  it('keeps category rows when "Fits my hardware" is on, though their names carry no size', async () => {
    state.sys = phone()
    render(<DiscoverTab />)
    expect(screen.getByRole('checkbox', { name: /Fits my hardware/ })).toBeChecked()
    await userEvent.click(categoryToggle())
    expect(resultRow('convaiinnovations/laya')).toBeInTheDocument()
    expect(resultRow('AlexWortega/openjev')).toBeInTheDocument()
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument()
  })

  it('does not pin the Android chat picks above the category', async () => {
    state.sys = phone()
    render(<DiscoverTab />)
    expect(screen.getByText('Good picks for this device')).toBeInTheDocument()
    await userEvent.click(categoryToggle())
    expect(screen.queryByText('Good picks for this device')).not.toBeInTheDocument()
  })

  it('opens a category row in the repo details, as any other row', async () => {
    render(<DiscoverTab />)
    await userEvent.click(categoryToggle())
    await userEvent.click(resultRow('convaiinnovations/laya'))
    expect(screen.getByText('Details of convaiinnovations/laya')).toBeInTheDocument()
  })
})

// ADR-462 (W-5): the curated picks follow the active engine's format, and a line under the search box says which
// format and engine the list is for. A curated LiteRT-LM row opens its repo with the curated bundle preselected, at
// both places the repo details render (the desktop pane and the phone Sheet, QG-4).
describe('DiscoverTab — curated picks and the scope line follow the active engine', () => {
  const engineRow = (over: Partial<Engine> & { id: string; name: string }): Engine =>
    ({ binPath: '', version: '', capabilities: { kvTypes: [], flags: [] }, ...over })
  const sdk = (id: string, sdkId: string, name: string, formats: Engine['formats']) =>
    engineRow({ id, name, kind: 'turbollm-sdk', formats, sdkEngine: { id: sdkId, kind: sdkId, formats: formats ?? [], backends: ['cpu'] } })
  const SDK_LITERT = sdk('lit', 'litert-lm', 'LiteRT-LM', ['litertlm'])
  const SDK_LLAMA = sdk('cpu', 'llama.cpp-cpu', 'llama.cpp (CPU)', ['gguf'])
  const LEGACY = engineRow({ id: 'old', name: 'TurboLLM SDK', kind: 'turbollm-sdk', formats: ['gguf', 'litertlm'] })
  const LITERT_REPOS = [
    LITERT_SMALLEST_PICK.repo,
    'litert-community/gemma-4-E2B-it-litert-lm',
    'litert-community/gemma-4-E4B-it-litert-lm',
    'litert-community/Qwen3.5-2B',
  ]
  const GGUF_PICK = 'bartowski/Qwen_Qwen3.5-0.8B-GGUF'
  const onAndroid = (active: Engine, sys = phone()) => {
    state.sys = sys
    state.engines = { engines: [SDK_LITERT, SDK_LLAMA, LEGACY], activeEngineId: active.id }
  }
  const lastPreselect = () => state.repoContentProps.at(-1)?.preselectFile

  it('pins the LiteRT-LM picks, and no GGUF pick, with LiteRT-LM active on a phone', () => {
    onAndroid(SDK_LITERT)
    render(<DiscoverTab />)
    for (const repo of LITERT_REPOS) expect(screen.getByRole('button', { name: new RegExp(repo) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: new RegExp(GGUF_PICK) })).not.toBeInTheDocument()
    expect(screen.getByText('Thinks before it answers')).toBeInTheDocument()
  })

  it('pins only the LiteRT-LM picks this phone can hold', () => {
    onAndroid(SDK_LITERT, { os: 'android/arm64', ramMB: 4000, gpus: [] })
    render(<DiscoverTab />)
    expect(Math.round(4000 * 0.6) - 1024).toBeGreaterThanOrEqual(requiredMb(LITERT_SMALLEST_PICK.bytes))
    expect(screen.getByRole('button', { name: new RegExp(LITERT_SMALLEST_PICK.repo) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /gemma-4-E2B-it-litert-lm/ })).not.toBeInTheDocument()
  })

  it('pins no curated row on a phone below the smallest pick', () => {
    onAndroid(SDK_LITERT, { os: 'android/arm64', ramMB: 3000, gpus: [] })
    render(<DiscoverTab />)
    expect(screen.queryByText('Good picks for this device')).not.toBeInTheDocument()
  })

  it('keeps the GGUF picks on the llama.cpp row and on the legacy SDK row', () => {
    for (const active of [SDK_LLAMA, LEGACY]) {
      onAndroid(active)
      const { unmount } = render(<DiscoverTab />)
      expect(screen.getByRole('button', { name: new RegExp(GGUF_PICK) })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: new RegExp(LITERT_SMALLEST_PICK.repo) })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('says which format and engine the list is for', () => {
    onAndroid(SDK_LITERT)
    const { unmount } = render(<DiscoverTab />)
    expect(screen.getByText('Showing .litertlm models for LiteRT-LM')).toBeInTheDocument()
    unmount()
    onAndroid(SDK_LLAMA)
    render(<DiscoverTab />)
    expect(screen.getByText('Showing .gguf models for llama.cpp (CPU)')).toBeInTheDocument()
  })

  it('shows no curated list on a desktop', () => {
    state.engines = { engines: [SDK_LITERT], activeEngineId: 'lit' }
    render(<DiscoverTab />)
    expect(screen.queryByText('Good picks for this device')).not.toBeInTheDocument()
  })

  it('does not list a curated LiteRT-LM repo twice when it is also trending', () => {
    onAndroid(SDK_LITERT)
    state.engineRows = [row(LITERT_REPOS[1]), row('litert-community/Qwen3-0.6B')]
    render(<DiscoverTab />)
    expect(screen.getAllByRole('button', { name: /gemma-4-E2B-it-litert-lm/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: /litert-community\/Qwen3-0\.6B/ })).toBeInTheDocument()
  })

  for (const isDesktop of [true, false]) {
    it(`opens a curated LiteRT-LM row with its bundle preselected (${isDesktop ? 'desktop pane' : 'phone Sheet'})`, async () => {
      onAndroid(SDK_LITERT)
      state.isDesktop = isDesktop
      state.engineRows = [row('litert-community/Qwen3-0.6B')]
      render(<DiscoverTab />)

      await userEvent.click(screen.getByRole('button', { name: /gemma-4-E2B-it-litert-lm/ }))
      expect(screen.getByText('Details of litert-community/gemma-4-E2B-it-litert-lm')).toBeInTheDocument()
      expect(lastPreselect()).toBe('gemma-4-E2B-it.litertlm')

      await userEvent.click(screen.getByRole('button', { name: /litert-community\/Qwen3-0\.6B/ }))
      expect(screen.getByText('Details of litert-community/Qwen3-0.6B')).toBeInTheDocument()
      expect(lastPreselect()).toBeUndefined()
    })
  }

  it('closing the phone Sheet drops the curated selection', async () => {
    onAndroid(SDK_LITERT)
    state.isDesktop = false
    render(<DiscoverTab />)
    await userEvent.click(screen.getByRole('button', { name: /gemma-4-E2B-it-litert-lm/ }))
    expect(lastPreselect()).toBe('gemma-4-E2B-it.litertlm')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText(/Details of/)).not.toBeInTheDocument()
    state.repoContentProps = []
    await userEvent.click(screen.getByRole('button', { name: new RegExp(LITERT_SMALLEST_PICK.repo) }))
    expect(lastPreselect()).toBe(LITERT_SMALLEST_PICK.file)
  })
})

describe('DiscoverTab — an empty list', () => {
  it('says the engine search found nothing', () => {
    state.engineRows = []
    render(<DiscoverTab />)
    expect(screen.getByText('No models found.')).toBeInTheDocument()
  })

  it('names the query that found nothing', async () => {
    state.engineRows = []
    render(<DiscoverTab />)
    await userEvent.type(screen.getByPlaceholderText('Search models by name or author…'), 'nothing-here')
    expect(await screen.findByText('No models found for “nothing-here”.')).toBeInTheDocument()
  })

  it('says the fit filter hid every result, rather than that there were none', () => {
    state.sys = phone()
    state.engineRows = [row('unsloth/Qwen3.6-35B-A3B-GGUF')]
    render(<DiscoverTab />)
    expect(screen.getByText(/None of the 1 results fit this machine's memory/)).toBeInTheDocument()
  })
})
