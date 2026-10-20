// Discover's Import from URL on a phone (below md, so always in the Android app): a Hugging Face
// model-page link closes the Import sheet and opens the repo's own full-screen sheet in the same
// update. Both are ui/sheet overlays with a history entry each for Back (use-backable-overlay.ts),
// and the Import sheet's entry being dropped used to close the repo sheet as well, so the user saw
// the dialog close and nothing open.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiscoverTab } from './DiscoverTab'

const enqueue = vi.fn()

vi.mock('../../lib/queries', () => ({
  useHfSearch: () => ({ data: { results: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useSysInfo: () => ({ data: { os: 'android/arm64', ramMB: 7655, gpus: [] } }),
  useDownloadMutations: () => ({ enqueue: { mutate: enqueue, isPending: false, error: null, reset: () => {} } }),
}))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

vi.mock('../../lib/useIsDesktop', () => ({ useIsDesktop: () => false }))
vi.mock('./DownloadsPanel', () => ({ DownloadsPanel: () => null }))
vi.mock('./HfRepoDialog', () => ({ HfRepoContent: ({ repo }: { repo: string }) => <p>Details of {repo}</p> }))

const REPO = 'unsloth/gemma-3-270m-it-GGUF'

/** jsdom traverses history a few timer tasks after back()/go(), and the hook may start another
 *  traversal from the popstate that fires: wait until no popstate has come for 100 ms, rather
 *  than a fixed delay a stall on a loaded machine could outlast. */
async function settle() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.removeEventListener('popstate', onPop)
          resolve()
        }
        let quiet = setTimeout(done, 100)
        function onPop() {
          clearTimeout(quiet)
          quiet = setTimeout(done, 100)
        }
        window.addEventListener('popstate', onPop)
      }),
  )
}

let page = 0
function atPage() {
  return (history.state as { page?: number } | null)?.page === page
}

beforeEach(async () => {
  enqueue.mockClear()
  await settle()
  page += 1
  history.pushState({ page }, '')
})

describe('DiscoverTab — Import from URL on a phone', () => {
  it('opens the repo of a model-page link in its sheet, and Back closes it', async () => {
    const user = userEvent.setup()
    render(<DiscoverTab />)
    await user.click(screen.getByTitle('Import from URL'))
    await settle()
    await user.type(screen.getByPlaceholderText(/huggingface\.co\/owner\/repo/), `https://huggingface.co/${REPO}`)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await settle()

    expect(screen.queryByText('Import from URL')).not.toBeInTheDocument()
    expect(screen.getByText(`Details of ${REPO}`)).toBeInTheDocument()
    expect(enqueue).not.toHaveBeenCalled()

    await act(async () => { history.back() })
    await settle()
    expect(screen.queryByText(`Details of ${REPO}`)).not.toBeInTheDocument()
    expect(atPage()).toBe(true)
  })
})
