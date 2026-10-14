// Source-switching in the Add-engine flow: provenance (sourceRepo) belongs to the result that
// reaches the confirm step, never to an abandoned earlier source. API mocked per-test.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AddEngineDialog } from './AddEngineDialog'
import {
  addEngine,
  getReleaseInstall,
  listReleaseAssets,
  startReleaseInstall,
  uploadEngineZip,
} from '../../lib/api'
import type { EngineScanResult, ReleaseAssetListing } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  addEngine: vi.fn(),
  deleteEngineZipInstall: vi.fn().mockResolvedValue({ ok: true }),
  discardReleaseInstall: vi.fn().mockResolvedValue({ ok: true }),
  listReleaseAssets: vi.fn(),
  startReleaseInstall: vi.fn(),
  getReleaseInstall: vi.fn(),
  getEngineCatalog: vi.fn().mockResolvedValue({ engines: [] }),
  uploadEngineZip: vi.fn(),
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
const RELEASE_RESULT: EngineScanResult = {
  found: true,
  binPath: '/e/build/prism/llama-server',
  version: 'b10770',
  capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] },
  suggestedName: 'Prism (b10770)',
}
const ZIP_RESULT: EngineScanResult = {
  ...RELEASE_RESULT, binPath: '/e/build/zip/llama-server', suggestedName: 'Zip (b1)',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listReleaseAssets).mockResolvedValue(LISTING)
  vi.mocked(startReleaseInstall).mockResolvedValue({ accepted: true })
  vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'ready', result: RELEASE_RESULT })
  vi.mocked(uploadEngineZip).mockResolvedValue(ZIP_RESULT)
  vi.mocked(addEngine).mockResolvedValue({ ...ZIP_RESULT, id: 'e1', name: 'Zip (b1)', warning: null } as Awaited<ReturnType<typeof addEngine>>)
})

describe('AddEngineDialog: switching source after a release install', () => {
  it('Back from a release confirm, then a zip source, shows the Source repo URL field and sends sourceRepo', async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AddEngineDialog
            defaultSourceRepo="https://github.com/PrismML-Eng/llama.cpp"
            defaultReleaseRepo="PrismML-Eng/llama.cpp"
            open
            onOpenChange={() => {}}
            trigger={null}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(ASSET)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }))
    await screen.findByText('Confirm engine')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }))

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File([new Uint8Array([1])], 'z.zip', { type: 'application/zip' }))
    await within(dialog).findByDisplayValue('Zip (b1)')

    expect(within(dialog).getByText(/Source repo URL/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add engine' }))
    await waitFor(() => expect(vi.mocked(addEngine).mock.calls[0]?.[0]).toEqual({
      name: 'Zip (b1)',
      binPath: '/e/build/zip/llama-server',
      sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp',
    }))
  })
})
