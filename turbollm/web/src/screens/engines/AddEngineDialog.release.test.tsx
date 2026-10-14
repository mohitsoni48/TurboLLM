// The "From a GitHub release" source of the Add-engine flow (issue #276): the fourth way in,
// ending on the same confirm step as the folder and zip sources. API mocked per-test.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AddEngineDialog } from './AddEngineDialog'
import {
  addEngine,
  deleteEngineZipInstall,
  discardReleaseInstall,
  getEngineCatalog,
  getReleaseInstall,
  listReleaseAssets,
  startReleaseInstall,
  track,
} from '../../lib/api'
import type { CatalogEngine, EngineScanResult, ReleaseAssetListing } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  addEngine: vi.fn(),
  deleteEngineZipInstall: vi.fn().mockResolvedValue({ ok: true }),
  discardReleaseInstall: vi.fn().mockResolvedValue({ ok: true }),
  listReleaseAssets: vi.fn(),
  startReleaseInstall: vi.fn(),
  getReleaseInstall: vi.fn(),
  getEngineCatalog: vi.fn(),
}))

const ASSET = 'llama-prism-prism-b10770-bin-win-cpu-x64.zip'
const LISTING: ReleaseAssetListing = {
  repo: 'PrismML-Eng/llama.cpp',
  tag: 'prism-b10770',
  publishedAt: '2026-10-08T12:00:00Z',
  prerelease: false,
  fellBack: false,
  assets: [{
    name: ASSET, size: 50_000_000, os: 'windows', arch: 'x64', backend: 'cpu', cudaVersion: null,
    compatible: true, reason: null, recommended: true, companions: [],
  }],
}
const FOUND: EngineScanResult = {
  found: true,
  binPath: '/e/build/prism/llama-server',
  version: 'b10770',
  capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] },
  suggestedName: 'Prism (b10770)',
}

const wrap = (ui: React.ReactElement) =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {ui}
      </QueryClientProvider>
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listReleaseAssets).mockResolvedValue(LISTING)
  vi.mocked(startReleaseInstall).mockResolvedValue({ accepted: true })
  vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'ready', result: FOUND })
  vi.mocked(addEngine).mockResolvedValue({ ...FOUND, id: 'e1', name: 'Prism (b10770)', warning: null } as Awaited<ReturnType<typeof addEngine>>)
  vi.mocked(getEngineCatalog).mockResolvedValue({
    engines: [
      { id: 'prism', name: 'Prism', repo: 'PrismML-Eng/llama.cpp', releaseInstall: true, supportedHere: true },
      { id: 'beellama', name: 'BeeLlama', repo: 'Anbeeld/beellama.cpp', releaseInstall: true, supportedHere: false },
      { id: 'vllm', name: 'vLLM', repo: 'vllm-project/vllm', supportedHere: true },
    ] as CatalogEngine[],
  })
})

async function openDialog() {
  await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
  return screen.getByRole('dialog')
}

describe('AddEngineDialog: GitHub release source', () => {
  it('offers three sources on the choose step', async () => {
    wrap(<AddEngineDialog />)
    const dialog = await openDialog()
    expect(within(dialog).getByRole('button', { name: /Choose folder/ })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /Upload a \.zip/ })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /From a GitHub release/ })).toBeTruthy()
  })

  it('the release path reaches confirm with the suggested name; Add sends no sourceRepo and the field is hidden', async () => {
    wrap(<AddEngineDialog />)
    const dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /From a GitHub release/ }))
    expect(track).toHaveBeenCalledWith('engines', 'open_release_source')
    // The known fork chip comes from the catalog (releaseInstall && supportedHere only).
    expect(await within(dialog).findByRole('button', { name: 'Prism' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'BeeLlama' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'vLLM' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prism' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Find builds' }))
    await within(dialog).findByText(ASSET)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }))

    expect(await screen.findByText('Confirm engine')).toBeTruthy()
    expect((within(dialog).getByDisplayValue('Prism (b10770)') as HTMLInputElement).value).toBe('Prism (b10770)')
    expect(within(dialog).queryByText(/Source repo URL/)).toBeNull()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add engine' }))
    await waitFor(() => expect(vi.mocked(addEngine).mock.calls[0]?.[0]).toEqual({
      name: 'Prism (b10770)',
      binPath: '/e/build/prism/llama-server',
    }))
  })

  it('a Build-guide hand-off (defaultSourceRepo) then the release path still sends no sourceRepo', async () => {
    wrap(
      <AddEngineDialog
        defaultSourceRepo="https://github.com/PrismML-Eng/llama.cpp"
        defaultReleaseRepo="PrismML-Eng/llama.cpp"
        open
        onOpenChange={() => {}}
        trigger={null}
      />,
    )
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(ASSET)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }))
    await screen.findByText('Confirm engine')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add engine' }))
    await waitFor(() => expect(vi.mocked(addEngine).mock.calls[0]?.[0]).toEqual({
      name: 'Prism (b10770)',
      binPath: '/e/build/prism/llama-server',
    }))
  })

  it('Escape on the confirm step calls discardReleaseInstall(binPath) and never deleteEngineZipInstall', async () => {
    const onOpenChange = vi.fn()
    wrap(<AddEngineDialog defaultReleaseRepo="PrismML-Eng/llama.cpp" open onOpenChange={onOpenChange} trigger={null} />)
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(ASSET)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }))
    await screen.findByText('Confirm engine')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(discardReleaseInstall).toHaveBeenCalledWith('/e/build/prism/llama-server'))
    expect(deleteEngineZipInstall).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('defaultReleaseRepo opens straight on the release step with the repo fetched', async () => {
    wrap(<AddEngineDialog defaultReleaseRepo="PrismML-Eng/llama.cpp" open onOpenChange={() => {}} trigger={null} />)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(ASSET)).toBeTruthy()
    expect(listReleaseAssets).toHaveBeenCalledWith('PrismML-Eng/llama.cpp')
    expect(within(dialog).queryByRole('button', { name: /Choose folder/ })).toBeNull()
  })

  it('dismissing while an install is running aborts it', async () => {
    vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'running' })
    wrap(<AddEngineDialog defaultReleaseRepo="PrismML-Eng/llama.cpp" open onOpenChange={() => {}} trigger={null} />)
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(ASSET)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }))
    await within(dialog).findByText(/Downloading/)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(discardReleaseInstall).toHaveBeenCalledWith())
  })
})
