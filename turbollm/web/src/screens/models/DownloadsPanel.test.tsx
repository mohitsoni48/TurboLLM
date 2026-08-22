import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DownloadsPanel } from './DownloadsPanel'
import type { LinkSummary, RemoteDownload } from '../../lib/link-api'
import type { DownloadRecord } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

const localCancel = vi.fn()

// Only the LOCAL data layer is mocked. `link-queries` is deliberately real — see the note
// in ModelsScreen.fleet.test.tsx: a mocked mutation can only prove what a click handed off,
// never what the receiver did with it, and that gap is how this feature shipped a Critical
// once already. Here a click travels component -> mutation -> link-api -> HTTP, and the
// assertions are on the request that actually left.
vi.mock('../../lib/queries', () => ({
  useDownloads: () => ({ data: { downloads: state.local } }),
  useDownloadMutations: () => ({
    cancel: { mutate: localCancel, isPending: false, variables: undefined },
    remove: { mutate: vi.fn(), isPending: false },
    resume: { mutate: vi.fn(), isPending: false },
  }),
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
  /** linkId -> that machine's queue, or a canned failure for it. */
  queues: Record<string, RemoteDownload[]>
  queueFail: Record<string, { status: number; error: Record<string, unknown> }>
  cancelFail: { status: number; error: Record<string, unknown> } | null
} = { local: [], links: [], queues: {}, queueFail: {}, cancelFail: null }

type Call = { url: string; method: string }
const calls: Call[] = []
const writes = () => calls.filter((c) => c.method !== 'GET')

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
      status, headers: { 'content-type': 'application/json' },
    })

    const queueMatch = url.match(/^\/api\/v1\/links\/([^/]+)\/downloads$/)
    if (queueMatch && method === 'GET') {
      const id = queueMatch[1]
      const fail = state.queueFail[id]
      if (fail) return json({ error: fail.error }, fail.status)
      return json({ downloads: state.queues[id] ?? [] })
    }
    if (url.includes('/downloads/') && method === 'DELETE') {
      if (state.cancelFail) return json({ error: state.cancelFail.error }, state.cancelFail.status)
      return json({ ok: true })
    }
    // Turbo Link ships behind `daemon.experimental.turboLink` (Settings → Experimental),
    // off by default, and `useLinks`/`useRemoteModels` do not fetch while it is off. This
    // suite is about the MERGE, so the fixture has the feature unlocked; the gate's own
    // behaviour is covered by lib/link-queries.gate.test.tsx.
    if (url.includes('/api/v1/settings')) {
      return json({ experimental: { memory: false, cloudDeploy: false, routines: false, turboLink: true } })
    }
    if (url.endsWith('/api/v1/links')) return json({ links: state.links })
    return json({ ok: true })
  }))
}

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
  state.queues = {}
  state.queueFail = {}
  state.cancelFail = null
  calls.length = 0
  localCancel.mockClear()
  installFetch()
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
    expect(screen.queryByRole('group', { name: /filter by machine/i })).toBeNull()
  })

  it('lists local rows first, then each machine\'s', async () => {
    state.local = [localDl]
    state.links = [link()]
    state.queues = { l1: [remoteDl] }
    const { container } = renderPanel()
    await screen.findByText('remote.gguf')
    const names = [...container.querySelectorAll('[data-testid="download-name"]')].map((n) => n.textContent)
    expect(names).toEqual(['local.gguf', 'remote.gguf'])
  })

  it('marks which machine each row belongs to', async () => {
    state.local = [localDl]
    state.links = [link()]
    state.queues = { l1: [remoteDl] }
    renderPanel()
    await screen.findByText('remote.gguf')
    expect(screen.getByText('This machine')).toBeTruthy()
    expect(screen.getByText('workstation')).toBeTruthy()
  })

  it('cancels a remote download by DELETEing that machine\'s route, never the local one', async () => {
    state.links = [link()]
    state.queues = { l1: [remoteDl] }
    renderPanel()
    await screen.findByText('remote.gguf')
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({ url: '/api/v1/links/l1/downloads/remote-1', method: 'DELETE' })
    expect(localCancel).not.toHaveBeenCalled()
  })

  it('disables cancel — with the capability named — when the link lacks downloads:write', async () => {
    state.links = [link({ grantedCapabilities: ['downloads:read'] })]
    state.queues = { l1: [remoteDl] }
    renderPanel()
    await screen.findByText('remote.gguf')
    const btn = screen.getByRole('button', { name: /cancel/i })
    expect(btn).toBeDisabled()
    expect(btn.getAttribute('title')).toMatch(/downloads:write/)
    expect(btn.getAttribute('title')).toMatch(/workstation/)
  })

  it('a disabled control issues no request at all when clicked', async () => {
    state.links = [link({ grantedCapabilities: ['downloads:read'] })]
    state.queues = { l1: [remoteDl] }
    renderPanel()
    await screen.findByText('remote.gguf')
    await userEvent.click(screen.getByRole('button', { name: /cancel/i })).catch(() => {})
    expect(writes()).toHaveLength(0)
  })

  it('an offline machine contributes no rows but is still explained', async () => {
    state.local = [localDl]
    state.links = [link({ status: 'unreachable', lastError: 'workstation did not answer.' })]
    state.queues = { l1: [remoteDl] }
    renderPanel()
    expect(await screen.findByText(/did not answer/i)).toBeTruthy()
    expect(screen.queryByText('remote.gguf')).toBeNull()
  })

  // Review I-2. An ONLINE machine whose queue cannot be READ contributed no rows and no
  // explanation, which is indistinguishable from an idle machine — exactly the failure the
  // machine-notes mechanism exists to prevent. `fleetMachines` cannot cover this: its note
  // is null for every online machine by design.
  it('explains an online machine that REFUSES the download read', async () => {
    state.local = [localDl]
    state.links = [link({ grantedCapabilities: [] })]
    state.queueFail = { l1: { status: 403, error: { code: 'forbidden', message: 'x', capability: 'downloads:read' } } }
    renderPanel()
    expect(await screen.findByText(/downloads:read/)).toBeTruthy()
  })

  // Final review I-4. The block above was computed and then thrown away by the
  // `rows.length === 0` early return, so the explanation appeared only while some OTHER
  // download happened to be in flight — i.e. never, on the fleet where it matters.
  it('explains a refused read even when NOTHING else is downloading', async () => {
    state.links = [link({ grantedCapabilities: [] })]
    state.queueFail = { l1: { status: 403, error: { code: 'forbidden', message: 'x', capability: 'downloads:read' } } }
    renderPanel()
    expect(await screen.findByText(/downloads:read/)).toBeTruthy()
    expect(screen.getByText(/workstation/)).toBeTruthy()
  })

  it('still stays hidden for a fleet that is merely idle', async () => {
    // The early return's original point survives: three linked machines with empty queues
    // must not conjure a "Downloads" heading that exists only to say they are idle.
    state.links = [link(), link({ id: 'l2', name: 'kaggle' }), link({ id: 'l3', name: 'rig', status: 'unreachable' })]
    const { container } = renderPanel()
    await waitFor(() => expect(calls.some((c) => c.url.includes('/links/l2/downloads'))).toBe(true))
    expect(container).toBeEmptyDOMElement()
  })

  // Review M-1. Download ids are unique per MACHINE, not across the fleet. Keyed by bare id,
  // a refusal on one machine's row rendered on the other machine's row too.
  it('attaches a refusal to the row that caused it, even when two machines share an id', async () => {
    state.links = [link(), link({ id: 'l2', name: 'kaggle' })]
    state.queues = {
      l1: [{ ...remoteDl, id: 'dup', name: 'one.gguf' }],
      l2: [{ ...remoteDl, id: 'dup', name: 'two.gguf' }],
    }
    state.cancelFail = { status: 503, error: { code: 'host_busy', message: 'x' } }
    renderPanel()
    await screen.findByText('one.gguf')
    const first = document.querySelectorAll('[data-testid^="download-row-"]')[0] as HTMLElement
    await userEvent.click(within(first).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.getAllByText(/busy with its own work/i)).toHaveLength(1))
    // The failure belongs to the row that was clicked, not to its same-id twin.
    expect(within(first).queryByText(/busy with its own work/i)).toBeTruthy()
  })

  // Review I-3. A flat `isPending` disabled and spun EVERY row's Cancel while one cancel was
  // in flight — a wrong-row spinner, and the one path where a disabled control carried no
  // reason at all.
  it('never disables an unrelated row\'s Cancel while another row is cancelling', async () => {
    state.local = [localDl]
    state.links = [link()]
    state.queues = { l1: [remoteDl] }
    renderPanel()
    await screen.findByText('remote.gguf')
    const rows = document.querySelectorAll('[data-testid^="download-row-"]')
    const localRow = rows[0] as HTMLElement
    const remoteRow = rows[1] as HTMLElement
    await userEvent.click(within(remoteRow).getByRole('button', { name: /cancel/i }))
    // The local row's Cancel is unrelated and must stay live.
    expect(within(localRow).getByRole('button', { name: /cancel/i })).not.toBeDisabled()
  })

  it('never renders a host filesystem path for a remote row', async () => {
    state.links = [link()]
    state.queues = { l1: [remoteDl] }
    const { container } = renderPanel()
    await screen.findByText('remote.gguf')
    expect(container.textContent ?? '').not.toMatch(/D:|ENOENT/)
  })

  it('offers no Resume on a remote row — resume is a local-only affordance', async () => {
    state.links = [link()]
    state.queues = { l1: [{ ...remoteDl, status: 'paused' }] }
    renderPanel()
    await screen.findByText('remote.gguf')
    const row = document.querySelector('[data-testid="download-row-remote-1"]')!
    expect(within(row as HTMLElement).queryByRole('button', { name: /resume/i })).toBeNull()
  })
})
