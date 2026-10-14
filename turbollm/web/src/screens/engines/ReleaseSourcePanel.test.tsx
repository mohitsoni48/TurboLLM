// ReleaseSourcePanel (issue #276): type a repo or tap a fork chip, see the builds ranked for
// this machine, install one with visible progress and Cancel. The API layer is mocked per-test.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSourcePanel } from './ReleaseSourcePanel'
import {
  ApiError,
  discardReleaseInstall,
  getReleaseInstall,
  getStatus,
  listReleaseAssets,
  startReleaseInstall,
  track,
} from '../../lib/api'
import type { EngineScanResult, ReleaseAssetListing, ReleaseJobView } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  listReleaseAssets: vi.fn(),
  startReleaseInstall: vi.fn(),
  getReleaseInstall: vi.fn(),
  discardReleaseInstall: vi.fn(),
  getStatus: vi.fn(),
}))

const CUDA = 'llama-prism-prism-b10770-bin-win-cuda-13.3-x64.zip'
const CPU = 'llama-prism-prism-b10770-bin-win-cpu-x64.zip'
const LINUX = 'llama-prism-prism-b10770-bin-ubuntu-x64.zip'

const LISTING: ReleaseAssetListing = {
  repo: 'PrismML-Eng/llama.cpp',
  tag: 'prism-b10770',
  publishedAt: '2026-10-08T12:00:00Z',
  prerelease: false,
  fellBack: false,
  assets: [
    {
      name: CUDA, size: 200_000_000, os: 'windows', arch: 'x64', backend: 'cuda', cudaVersion: '13.3',
      compatible: true, reason: null, recommended: true,
      companions: [{ name: 'cudart-llama-bin-win-cuda-13.3-x64.zip', size: 380_000_000 }],
    },
    {
      name: CPU, size: 50_000_000, os: 'windows', arch: 'x64', backend: 'cpu', cudaVersion: null,
      compatible: true, reason: null, recommended: false, companions: [],
    },
    {
      name: LINUX, size: 60_000_000, os: 'linux', arch: 'x64', backend: 'cpu', cudaVersion: null,
      compatible: false, reason: 'Linux build', recommended: false, companions: [],
    },
  ],
}

const FOUND: EngineScanResult = {
  found: true,
  binPath: '/e/build/prism/llama-server',
  version: 'b10770',
  capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] },
  suggestedName: 'Prism (b10770)',
}

function wrap(props: Partial<React.ComponentProps<typeof ReleaseSourcePanel>> = {}) {
  const onReady = vi.fn()
  const onCancel = vi.fn()
  const ui = render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReleaseSourcePanel knownRepos={[]} onReady={onReady} onCancel={onCancel} {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { onReady, onCancel, ...ui }
}

async function submitRepo(repo: string) {
  await userEvent.type(screen.getByRole('textbox'), repo)
  await userEvent.click(screen.getByRole('button', { name: /Find builds/ }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listReleaseAssets).mockResolvedValue(LISTING)
  vi.mocked(startReleaseInstall).mockResolvedValue({ accepted: true })
  vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'running' })
  vi.mocked(discardReleaseInstall).mockResolvedValue({ ok: true })
  vi.mocked(getStatus).mockResolvedValue({
    engineProvision: { active: true, phase: 'downloading', backend: 'github-release', pct: 0.5, part: 2, parts: 2, error: null },
  } as Awaited<ReturnType<typeof getStatus>>)
})

describe('ReleaseSourcePanel', () => {
  it('does not fetch the asset list on mount (ADR-396)', async () => {
    wrap()
    await new Promise((r) => setTimeout(r, 50))
    expect(listReleaseAssets).not.toHaveBeenCalled()
  })

  it('submitting the repo fetches the list once', async () => {
    wrap()
    await submitRepo('PrismML-Eng/llama.cpp')
    await screen.findByText(CUDA)
    expect(listReleaseAssets).toHaveBeenCalledTimes(1)
    expect(listReleaseAssets).toHaveBeenCalledWith('PrismML-Eng/llama.cpp')
  })

  it('with initialRepo set (explicit action from the card) the assets step is fetched once on mount', async () => {
    wrap({ initialRepo: 'PrismML-Eng/llama.cpp' })
    await screen.findByText(CUDA)
    expect(listReleaseAssets).toHaveBeenCalledTimes(1)
  })

  it('a known-fork chip fills the repo input', async () => {
    wrap({ knownRepos: [{ name: 'Prism', repo: 'PrismML-Eng/llama.cpp' }] })
    await userEvent.click(screen.getByRole('button', { name: 'Prism' }))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('PrismML-Eng/llama.cpp')
    expect(listReleaseAssets).not.toHaveBeenCalled()
  })

  it('preselects and badges the recommended row, shows the companion and the total size', async () => {
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect((screen.getByRole('radio', { name: new RegExp(CUDA) }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/\+ CUDA runtime, 380 MB/)).toBeTruthy()
    expect(screen.getByText(/Total download: 580 MB/)).toBeTruthy()
  })

  it('hides incompatible builds under a toggle that reveals the reason', async () => {
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    expect(screen.queryByText(LINUX)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 other builds' }))
    expect(screen.getByText(LINUX)).toBeTruthy()
    expect(screen.getByText('Linux build')).toBeTruthy()
  })

  it('states a fall-back release', async () => {
    vi.mocked(listReleaseAssets).mockResolvedValue({ ...LISTING, fellBack: true })
    wrap({ initialRepo: 'a/b' })
    expect(await screen.findByText('Newest release with a build for your system: prism-b10770')).toBeTruthy()
  })

  it('Install starts the job with the exact asset name and tracks it', async () => {
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(vi.mocked(startReleaseInstall).mock.calls[0]?.[0]).toEqual({
      repo: 'PrismML-Eng/llama.cpp', tag: 'prism-b10770', asset: CUDA,
    }))
    expect(track).toHaveBeenCalledWith('engines', 'install_release_asset')
  })

  it('an incompatible row needs a second confirming click', async () => {
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 other builds' }))
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(LINUX) }))
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(startReleaseInstall).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Install anyway/ }))
    await waitFor(() => expect(startReleaseInstall).toHaveBeenCalledTimes(1))
    expect(vi.mocked(startReleaseInstall).mock.calls[0]?.[0].asset).toBe(LINUX)
  })

  it('shows provision progress while installing and Cancel discards with no binPath', async () => {
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText(/part 2\/2/)).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(discardReleaseInstall).toHaveBeenCalledTimes(1))
    expect(vi.mocked(discardReleaseInstall).mock.calls[0]).toEqual([])
  })

  it('a ready job hands its result to onReady', async () => {
    vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'ready', result: FOUND })
    const { onReady } = wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(FOUND))
  })

  it('an updated job hands its result plus the updated engine to onReady', async () => {
    vi.mocked(getReleaseInstall).mockResolvedValue({
      state: 'updated', result: FOUND, updated: { id: 'e1', name: 'Prism' },
    })
    const { onReady } = wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(onReady).toHaveBeenCalledWith({ ...FOUND, updated: { id: 'e1', name: 'Prism' } }))
  })

  it('an error job returns to the assets step with an inline error', async () => {
    vi.mocked(getReleaseInstall).mockResolvedValue({
      state: 'error', error: { code: 'bad_zip', message: 'That archive is damaged.' },
    })
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText('That archive is damaged.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('G-5: a poll returning idle means the install was lost; back to assets, same row, polling stops', async () => {
    vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'idle' } as ReleaseJobView)
    const { onReady } = wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(CPU) }))
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText('The install was interrupted. Start again.')).toBeTruthy()
    expect((screen.getByRole('radio', { name: new RegExp(CPU) }) as HTMLInputElement).checked).toBe(true)
    const calls = vi.mocked(getReleaseInstall).mock.calls.length
    await new Promise((r) => setTimeout(r, 1300))
    expect(vi.mocked(getReleaseInstall).mock.calls.length).toBe(calls)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('G-5: a poll that rejects (daemon down) keeps installing and keeps polling', async () => {
    vi.mocked(getReleaseInstall).mockRejectedValue(new ApiError('http_error', 'down', 500))
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(vi.mocked(getReleaseInstall).mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3500 })
    expect(screen.queryByText('The install was interrupted. Start again.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('a rate-limited listing shows the Settings -> GitHub token hint', async () => {
    vi.mocked(listReleaseAssets).mockRejectedValue(new ApiError('github_rate_limited', 'GitHub rate limit reached.', 429))
    wrap({ initialRepo: 'a/b' })
    expect(await screen.findByText(/GitHub rate limit reached\./)).toBeTruthy()
    const link = screen.getByRole('link', { name: /Settings → GitHub/ })
    expect(link.getAttribute('href')).toBe('/settings')
  })

  it('other listing errors show their message on the repo step', async () => {
    vi.mocked(listReleaseAssets).mockRejectedValue(new ApiError('repo_not_found', 'No such repo.', 404))
    wrap({ initialRepo: 'a/b' })
    const err = await screen.findByText('No such repo.')
    expect(within(err.closest('div') as HTMLElement).queryByRole('link')).toBeNull()
  })

  it('no_compatible_asset: lists the rows with reasons under a header and disables every Install', async () => {
    vi.mocked(listReleaseAssets).mockResolvedValue({
      ...LISTING, tag: '', assets: [LISTING.assets[2]], noCompatible: true,
    })
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(/no build matches this machine/i)
    expect(screen.getByText(LINUX)).toBeTruthy()
    expect(screen.getByText('Linux build')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('radio') as HTMLInputElement).disabled).toBe(true)
  })

  it('no_compatible_asset with no assets at all: says there are no installable builds, no list header', async () => {
    vi.mocked(listReleaseAssets).mockResolvedValue({
      ...LISTING, tag: '', assets: [], noCompatible: true,
    })
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(/no installable builds/i)
    expect(screen.queryByText(/here is what the release offers/i)).toBeNull()
    expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
