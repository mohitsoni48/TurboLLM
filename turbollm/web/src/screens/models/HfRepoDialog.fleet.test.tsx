import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HfRepoContent } from './HfRepoDialog'
import type { LinkSummary } from '../../lib/link-api'

// Review I-1: `startRemoteDownload` / `useRemoteDownloadActions().start` had ZERO consumers
// — built, typed, and uncalled. This file is the proof they are now genuinely reachable
// from the UI, and it does it the receiver way: `link-queries` is real, `fetch` is stubbed,
// and the assertion is on the request that actually left.
//
// A download is the one fleet action where the target is a real choice rather than a
// property of the row you clicked — the file is on Hugging Face, not on any machine yet —
// which is why it is a menu here rather than a per-row button.

const enqueue = vi.fn()

const state: { links: LinkSummary[]; startFail: { status: number; error: Record<string, unknown> } | null } = {
  links: [], startFail: null,
}
type Call = { url: string; method: string; body: unknown }
const calls: Call[] = []
const writes = () => calls.filter((c) => c.method !== 'GET')

vi.mock('../../lib/queries', () => ({
  useHfRepo: () => ({
    data: {
      repo: 'owner/repo',
      gated: false,
      downloads: 0,
      likes: 0,
      license: null,
      safetensors: false,
      card: '',
      files: [{ name: 'model-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 4e9, sha256: 'abc', mmproj: false, downloaded: false }],
    },
  }),
  useSysInfo: () => ({ data: { gpus: [{ vramMb: 16000 }] } }),
  useStatus: () => ({ data: { engine: { kind: 'llamacpp' } } }),
  useDownloadMutations: () => ({ enqueue: { mutate: enqueue, isPending: false, error: null } }),
  useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false } }),
}))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
      status, headers: { 'content-type': 'application/json' },
    })
    if (url.includes('/downloads') && method === 'POST') {
      if (state.startFail) return json({ error: state.startFail.error }, state.startFail.status)
      return json({ ok: true }, 202)
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

function renderContent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HfRepoContent repo="owner/repo" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.links = []
  state.startFail = null
  calls.length = 0
  enqueue.mockClear()
  installFetch()
})

describe('HfRepoDialog — download target', () => {
  it('is a plain local Download button when there are no links', async () => {
    renderContent()
    const btn = await screen.findByRole('button', { name: /download/i })
    await userEvent.click(btn)
    expect(enqueue).toHaveBeenCalledTimes(1)
    // No target menu, no remote request: an install without Turbo Link is unchanged.
    expect(writes()).toHaveLength(0)
  })

  it('starts the download ON a linked machine, through that machine\'s route', async () => {
    state.links = [link()]
    renderContent()
    // Wait for the TRIGGER specifically: the links query resolves async, so the plain
    // local button renders first and a name-based lookup would race it.
    await userEvent.click(await screen.findByTestId('download-target-trigger'))
    await userEvent.click(await screen.findByText('workstation'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].url).toBe('/api/v1/links/l1/downloads')
    expect(writes()[0].method).toBe('POST')
    expect(writes()[0].body).toMatchObject({ repo: 'owner/repo', rfilename: 'model-Q4_K_M.gguf' })
    // The local queue was not touched.
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('still downloads locally when "This machine" is chosen', async () => {
    state.links = [link()]
    renderContent()
    // Wait for the TRIGGER specifically: the links query resolves async, so the plain
    // local button renders first and a name-based lookup would race it.
    await userEvent.click(await screen.findByTestId('download-target-trigger'))
    await userEvent.click(await screen.findByText('This machine'))
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(writes()).toHaveLength(0)
  })

  it('disables a machine that was not granted downloads:write, naming the capability', async () => {
    state.links = [link({ grantedCapabilities: ['downloads:read'] })]
    renderContent()
    // Wait for the TRIGGER specifically: the links query resolves async, so the plain
    // local button renders first and a name-based lookup would race it.
    await userEvent.click(await screen.findByTestId('download-target-trigger'))
    const item = (await screen.findByText('workstation')).closest('[role="menuitem"]')!
    expect(item.getAttribute('title')).toMatch(/downloads:write/)
    expect(item.getAttribute('data-disabled')).not.toBeNull()
  })

  // Final review M-8. `FleetAction` pairs `title` with an `aria-describedby` target because
  // a `title` alone is not reliably announced — a greyed entry whose only explanation is a
  // hover tooltip is barely better than no explanation. The menu carried the weaker half.
  it('announces the reason to a screen reader, not only on hover', async () => {
    state.links = [link({ grantedCapabilities: ['downloads:read'] })]
    renderContent()
    await userEvent.click(await screen.findByTestId('download-target-trigger'))
    const item = (await screen.findByText('workstation')).closest('[role="menuitem"]')!
    const describedBy = item.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const reason = document.getElementById(describedBy!)
    expect(reason?.textContent).toMatch(/downloads:write/)
    // …and the machine's own name still announces first: `aria-describedby` ADDS to the
    // accessible name where an `aria-label` would have replaced it.
    expect(item.getAttribute('aria-label')).toBeNull()
  })

  it('leaves a PERMITTED machine undescribed — nothing to explain', async () => {
    state.links = [link()]
    renderContent()
    await userEvent.click(await screen.findByTestId('download-target-trigger'))
    const item = (await screen.findByText('workstation')).closest('[role="menuitem"]')!
    expect(item.getAttribute('aria-describedby')).toBeNull()
  })

  it('renders a refusal from the host through the shared failure taxonomy', async () => {
    state.links = [link()]
    state.startFail = { status: 503, error: { code: 'host_busy', message: 'x' } }
    renderContent()
    // Wait for the TRIGGER specifically: the links query resolves async, so the plain
    // local button renders first and a name-based lookup would race it.
    await userEvent.click(await screen.findByTestId('download-target-trigger'))
    await userEvent.click(await screen.findByText('workstation'))
    expect(await screen.findByText(/busy with its own work/i)).toBeTruthy()
  })
})
