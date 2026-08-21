import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DownloadsPanel } from './DownloadsPanel'
import type { LinkSummary, RemoteDownload } from '../../lib/link-api'
import type { DownloadRecord } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

const localDl: DownloadRecord = {
  id: 'local-1', name: 'local.gguf', repo: 'o/r', url: 'https://x', dest: 'D:\\models\\local.gguf',
  total: 100, received: 40, status: 'downloading', error: null, bytesPerSec: 1_000_000,
  createdAt: '2026-01-01',
}
const remoteDl: RemoteDownload = {
  id: 'remote-1', name: 'remote.gguf', repo: 'o/r', total: 100, received: 60,
  status: 'downloading', error: null, bytesPerSec: 2_000_000, createdAt: '2026-01-01',
}

const state: {
  local: DownloadRecord[]
  links: LinkSummary[]
  remote: (RemoteDownload & { linkId: string })[]
} = { local: [], links: [], remote: [] }

const cancelRemote = vi.fn()

vi.mock('../../lib/queries', () => ({
  useDownloads: () => ({ data: { downloads: state.local } }),
  useDownloadMutations: () => ({
    cancel: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
    resume: { mutate: vi.fn(), isPending: false },
  }),
}))

vi.mock('../../lib/link-queries', () => ({
  useLinks: () => ({ data: state.links }),
  useRemoteDownloads: () => ({ rows: state.remote, errorByLink: new Map(), isLoading: false }),
  useRemoteDownloadActions: () => ({
    start: { mutate: vi.fn(), isPending: false },
    cancel: { mutate: cancelRemote, isPending: false, variables: undefined },
  }),
}))

function link(over: Partial<LinkSummary> = {}): LinkSummary {
  return {
    id: 'l1', name: 'workstation', status: 'online',
    grantedCapabilities: ['downloads:read', 'downloads:write'], lastError: null, ...over,
  }
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DownloadsPanel />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.local = []
  state.links = []
  state.remote = []
  cancelRemote.mockClear()
})

describe('DownloadsPanel — merged fleet', () => {
  it('stays hidden when nothing is downloading anywhere', () => {
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it('is unchanged for an install with no links', () => {
    state.local = [localDl]
    renderPanel()
    expect(screen.getByText('local.gguf')).toBeTruthy()
    // No machine filter, no origin badges — exactly the pre-Turbo-Link screen.
    expect(screen.queryByRole('group', { name: /filter by machine/i })).toBeNull()
  })

  it('lists local rows first, then each machine\'s', () => {
    state.local = [localDl]
    state.links = [link()]
    state.remote = [{ ...remoteDl, linkId: 'l1' }]
    const { container } = renderPanel()
    const names = [...container.querySelectorAll('[data-testid="download-name"]')].map((n) => n.textContent)
    expect(names).toEqual(['local.gguf', 'remote.gguf'])
  })

  it('marks which machine each row belongs to', () => {
    state.local = [localDl]
    state.links = [link()]
    state.remote = [{ ...remoteDl, linkId: 'l1' }]
    renderPanel()
    expect(screen.getByText('This machine')).toBeTruthy()
    expect(screen.getByText('workstation')).toBeTruthy()
  })

  it('cancels a remote download through the LINK route, never the local one', async () => {
    state.links = [link()]
    state.remote = [{ ...remoteDl, linkId: 'l1' }]
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    // First argument only: the second is react-query's per-call {onError,onSuccess}, which
    // is how the inline failure gets attached to this row.
    expect(cancelRemote.mock.calls[0][0]).toEqual({ linkId: 'l1', downloadId: 'remote-1' })
  })

  it('disables cancel — with the capability named — when the link lacks downloads:write', () => {
    state.links = [link({ grantedCapabilities: ['downloads:read'] })]
    state.remote = [{ ...remoteDl, linkId: 'l1' }]
    renderPanel()
    const btn = screen.getByRole('button', { name: /cancel/i })
    expect(btn).toBeDisabled()
    expect(btn.getAttribute('title')).toMatch(/downloads:write/)
    expect(btn.getAttribute('title')).toMatch(/workstation/)
  })

  it('a disabled control is never a silent no-op — clicking it calls nothing', async () => {
    state.links = [link({ grantedCapabilities: ['downloads:read'] })]
    state.remote = [{ ...remoteDl, linkId: 'l1' }]
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: /cancel/i })).catch(() => {})
    expect(cancelRemote).not.toHaveBeenCalled()
  })

  it('an offline machine contributes no rows but is still explained', () => {
    state.local = [localDl]
    state.links = [link({ status: 'unreachable', lastError: 'workstation did not answer.' })]
    state.remote = [{ ...remoteDl, linkId: 'l1' }]
    renderPanel()
    expect(screen.queryByText('remote.gguf')).toBeNull()
    expect(screen.getByText(/did not answer/i)).toBeTruthy()
  })

  it('never renders a host filesystem path for a remote row', () => {
    state.links = [link()]
    state.remote = [{ ...remoteDl, linkId: 'l1' }]
    const { container } = renderPanel()
    expect(container.textContent ?? '').not.toMatch(/D:|ENOENT/)
  })

  it('offers no Resume on a remote row — resume is a local-only affordance', () => {
    // `resumeDownload` is a LOCAL route; there is no link façade verb for it, so a Resume
    // button on a remote row could only ever be a silent no-op or a 404.
    state.links = [link()]
    state.remote = [{ ...remoteDl, linkId: 'l1', status: 'paused' }]
    const { container } = renderPanel()
    const row = container.querySelector('[data-testid="download-row-remote-1"]')!
    expect(within(row as HTMLElement).queryByRole('button', { name: /resume/i })).toBeNull()
  })
})
