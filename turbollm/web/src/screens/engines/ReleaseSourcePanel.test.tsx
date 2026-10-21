// ReleaseSourcePanel (issue #276): type a repo or tap a fork chip, see the builds ranked for
// this machine, install one with visible progress and Cancel. The API layer is mocked per-test.
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSourcePanel } from './ReleaseSourcePanel'
import { queryKeys } from '../../lib/queries'
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

function wrap(props: Partial<React.ComponentProps<typeof ReleaseSourcePanel>> = {}, { strict = false } = {}) {
  const onReady = vi.fn()
  const onCancel = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ReleaseSourcePanel knownRepos={[]} onReady={onReady} onCancel={onCancel} {...props} />
      </QueryClientProvider>
    </MemoryRouter>
  )
  const ui = render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  return { onReady, onCancel, qc, ...ui }
}

async function submitRepo(repo: string) {
  await userEvent.type(screen.getByRole('textbox'), repo)
  await userEvent.click(screen.getByRole('button', { name: /Find builds/ }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listReleaseAssets).mockResolvedValue(LISTING)
  vi.mocked(startReleaseInstall).mockResolvedValue({ accepted: true })
  // The panel reads the daemon's job once on mount (an install it may pick up): no job there, then
  // `running` for every poll of the install a test starts, unless the test says otherwise.
  vi.mocked(getReleaseInstall).mockReset()
  vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'running' })
  vi.mocked(getReleaseInstall).mockResolvedValueOnce({ state: 'idle' })
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

  // The job can finish between two polls (1 s apart). Its build then never reached the dialog's confirm step, whose
  // dismissal discards it, and the abort alone does nothing to a finished job: the build would stay on disk until the
  // daemon's 24 h GC.
  const FINISHED: ReleaseJobView = { state: 'ready', plan: { repo: LISTING.repo, tag: LISTING.tag, asset: CUDA }, result: FOUND }

  it('Cancel after the job finished but before the poll saw it discards the finished build', async () => {
    const { onReady } = wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await screen.findByText(/part 2\/2/)
    vi.mocked(getReleaseInstall).mockResolvedValue(FINISHED)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(discardReleaseInstall).toHaveBeenCalledWith(FOUND.binPath))
    expect(onReady).not.toHaveBeenCalled()
  })

  it('Cancel while installing: a finished job of another install, or an in-place update, is not discarded', async () => {
    for (const view of [
      { ...FINISHED, plan: { ...FINISHED.plan!, asset: CPU } },
      { ...FINISHED, state: 'updated', updated: { id: 'e1', name: 'Prism' } },
    ] as ReleaseJobView[]) {
      vi.mocked(getReleaseInstall).mockReset()
      vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'running' })
      vi.mocked(getReleaseInstall).mockResolvedValueOnce({ state: 'idle' })
      const { unmount } = wrap({ initialRepo: 'a/b' })
      await screen.findByText(CUDA)
      await userEvent.click(screen.getByRole('button', { name: 'Install' }))
      await screen.findByText(/part 2\/2/)
      vi.mocked(getReleaseInstall).mockResolvedValue(view)
      const polls = vi.mocked(getReleaseInstall).mock.calls.length
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(vi.mocked(getReleaseInstall).mock.calls.length).toBe(polls + 1))
      await new Promise((r) => setTimeout(r, 20))
      expect(discardReleaseInstall).toHaveBeenCalledWith()
      expect(discardReleaseInstall).not.toHaveBeenCalledWith(FOUND.binPath)
      unmount()
      vi.mocked(discardReleaseInstall).mockClear()
    }
  })

  // The install is the daemon's job, not the panel's: it runs on when the dialog is dismissed, the app navigates
  // away or the page is reloaded or closed, and only Cancel stops it. The panel used to abort it on unmount (and
  // discard a build that finished unseen), and never read the job when it opened, so a reopened dialog offered a
  // fresh install next to one still running, and a build that finished meanwhile was never offered for Add.
  const WAITING = 'Prism (b10770) finished installing and has not been added yet.'
  const RUNNING: ReleaseJobView = { state: 'running', plan: FINISHED.plan }

  it('opened while an install runs in the daemon, it shows that install, fetches no release list, and Cancel aborts it', async () => {
    vi.mocked(getReleaseInstall).mockReset()
    vi.mocked(getReleaseInstall).mockResolvedValue(RUNNING)
    wrap()
    expect(await screen.findByText(/part 2\/2/)).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(discardReleaseInstall).toHaveBeenCalledWith())
    // Back on the repo step, with the repo that install came from ready to look up again.
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(LISTING.repo)
    expect(listReleaseAssets).not.toHaveBeenCalled()
  })

  it('an install picked up on opening that then fails shows its error on the repo step', async () => {
    vi.mocked(getReleaseInstall).mockReset()
    vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'error', plan: FINISHED.plan, error: { code: 'bad_zip', message: 'That archive is damaged.' } })
    vi.mocked(getReleaseInstall).mockResolvedValueOnce(RUNNING)
    wrap()
    await screen.findByText(/part 2\/2/)
    expect(await screen.findByText('That archive is damaged.', {}, { timeout: 2500 })).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(LISTING.repo)
  })

  it('opened from a card while an install runs, Cancel lands on the builds of that card', async () => {
    vi.mocked(getReleaseInstall).mockReset()
    vi.mocked(getReleaseInstall).mockResolvedValue(RUNNING)
    wrap({ initialRepo: 'a/b' })
    await screen.findByText(/part 2\/2/)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(discardReleaseInstall).toHaveBeenCalledWith())
    expect(await screen.findByText(CUDA)).toBeTruthy()
    expect(listReleaseAssets).toHaveBeenCalledWith('a/b')
  })

  it('opened with a finished install nobody added, it offers it, and Add hands the build to onReady', async () => {
    vi.mocked(getReleaseInstall).mockReset()
    vi.mocked(getReleaseInstall).mockResolvedValue(FINISHED)
    const { onReady } = wrap()
    expect(await screen.findByText(WAITING)).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Add it' }))
    expect(onReady).toHaveBeenCalledWith(FOUND)
    expect(discardReleaseInstall).not.toHaveBeenCalled()
  })

  // The daemon's job then holds the new install, so the panel is the last place that knows of the
  // offered build: it hands it to the dialog, which discards it unless the new build replaces it.
  it('installing another build instead of the one offered drops the offer and hands that build to the dialog', async () => {
    vi.mocked(getReleaseInstall).mockReset()
    vi.mocked(getReleaseInstall).mockResolvedValue(RUNNING)
    vi.mocked(getReleaseInstall).mockResolvedValueOnce(FINISHED)
    const onOfferSuperseded = vi.fn()
    const { onReady } = wrap({ initialRepo: 'a/b', onOfferSuperseded })
    await screen.findByText(WAITING)
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await screen.findByText(/part 2\/2/)
    expect(onOfferSuperseded).toHaveBeenCalledWith(FOUND)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText(CUDA)
    expect(screen.queryByText(WAITING)).toBeNull()
    expect(onReady).not.toHaveBeenCalled()
    expect(onOfferSuperseded).toHaveBeenCalledTimes(1)
  })

  it('a start refused while a build is offered keeps the offer and hands nothing over', async () => {
    vi.mocked(getReleaseInstall).mockReset()
    vi.mocked(getReleaseInstall).mockResolvedValue(FINISHED)
    vi.mocked(startReleaseInstall).mockRejectedValue(new ApiError('engine_already_running', 'An engine install is already running.', 409))
    const onOfferSuperseded = vi.fn()
    wrap({ initialRepo: 'a/b', onOfferSuperseded })
    await screen.findByText(WAITING)
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText('An engine install is already running.')).toBeTruthy()
    expect(screen.getByText(WAITING)).toBeTruthy()
    expect(onOfferSuperseded).not.toHaveBeenCalled()
  })

  it('unmounted while installing, the install is not aborted, and the panel opened next shows it', async () => {
    const first = wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await screen.findByText(/part 2\/2/)
    first.unmount()
    await new Promise((r) => setTimeout(r, 50))
    expect(discardReleaseInstall).not.toHaveBeenCalled()

    wrap()
    expect(await screen.findByText(/part 2\/2/)).toBeTruthy()
    expect(discardReleaseInstall).not.toHaveBeenCalled()
  })

  it('unmounted after the job finished but before the poll saw it, the build is kept and the next panel offers it', async () => {
    const first = wrap({ initialRepo: 'a/b' })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await screen.findByText(/part 2\/2/)
    first.unmount()
    vi.mocked(getReleaseInstall).mockResolvedValue(FINISHED)
    await new Promise((r) => setTimeout(r, 50))
    expect(discardReleaseInstall).not.toHaveBeenCalled()

    const { onReady } = wrap()
    await userEvent.click(await screen.findByRole('button', { name: 'Add it' }))
    expect(onReady).toHaveBeenCalledWith(FOUND)
    expect(discardReleaseInstall).not.toHaveBeenCalled()
  })

  it('a job that ended in an update or an error, or a read of it that fails, is not picked up on opening', async () => {
    for (const answer of [
      () => vi.mocked(getReleaseInstall).mockResolvedValueOnce({ ...FINISHED, state: 'updated', updated: { id: 'e1', name: 'Prism' } }),
      () => vi.mocked(getReleaseInstall).mockResolvedValueOnce({ state: 'error', plan: FINISHED.plan, error: { code: 'bad_zip', message: 'That archive is damaged.' } }),
      () => vi.mocked(getReleaseInstall).mockRejectedValueOnce(new ApiError('forbidden', 'Needs a key.', 403)),
    ]) {
      vi.mocked(getReleaseInstall).mockReset()
      answer()
      const { onReady, unmount } = wrap({ initialRepo: 'a/b' })
      await screen.findByText(CUDA)
      expect(screen.queryByText(/finished installing/)).toBeNull()
      expect(screen.queryByText('That archive is damaged.')).toBeNull()
      expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
      expect(onReady).not.toHaveBeenCalled()
      unmount()
    }
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

  it('an updated job refetches the engine list, catalog and status (the engine changed in place)', async () => {
    vi.mocked(getReleaseInstall).mockResolvedValue({
      state: 'updated', result: FOUND, updated: { id: 'e1', name: 'Prism' },
    })
    const { onReady, qc } = wrap({ initialRepo: 'a/b' })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey)
    expect(keys).toEqual(expect.arrayContaining([queryKeys.engines, queryKeys.engineCatalog, queryKeys.status]))
  })

  it('a ready job (nothing registered yet) refetches nothing: the Add that follows does', async () => {
    vi.mocked(getReleaseInstall).mockResolvedValue({ state: 'ready', result: FOUND })
    const { onReady, qc } = wrap({ initialRepo: 'a/b' })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('under StrictMode (dev double mount) an accepted install shows progress and is not discarded', async () => {
    wrap({ initialRepo: 'a/b' }, { strict: true })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText(/part 2\/2/)).toBeTruthy()
    expect(discardReleaseInstall).not.toHaveBeenCalled()
  })

  it('under StrictMode a refused start still shows its error inline', async () => {
    vi.mocked(startReleaseInstall).mockRejectedValue(new ApiError('engine_already_running', 'Another engine job is running.', 409))
    wrap({ initialRepo: 'a/b' }, { strict: true })
    await screen.findByText(CUDA)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText('Another engine job is running.')).toBeTruthy()
    expect(discardReleaseInstall).not.toHaveBeenCalled()
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
