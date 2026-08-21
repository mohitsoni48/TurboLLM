import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelsScreen } from './ModelsScreen'
import type { LinkSummary } from '../lib/link-api'
import type { RemoteModelRow as RemoteRow } from '../lib/remote-models'
import type { ModelEntry } from '../lib/types'

// The screen's own data layer, stubbed to a quiet default — this file is about the MERGE
// and the capability gating, not about model scanning.
const state: { models: ModelEntry[]; links: LinkSummary[]; remote: RemoteRow[] } = {
  models: [], links: [], remote: [],
}
const localLoad = vi.fn()

vi.mock('../lib/queries', () => ({
  queryKeys: { models: ['models'], status: ['status'] },
  useModels: () => ({ data: { models: state.models, scanning: false }, isLoading: false, isError: false, refetch: vi.fn() }),
  useModelDirs: () => ({ data: { dirs: ['D:\\models'], primaryDir: 'D:\\models' } }),
  useModelMutations: () => ({
    rescan: { mutate: vi.fn() }, addDir: { mutate: vi.fn(), isPending: false, error: null },
    removeDir: { mutate: vi.fn() }, setPrimaryDir: { mutate: vi.fn(), isPending: false },
  }),
  useModelActions: () => ({
    load: { mutate: localLoad, isPending: false, variables: undefined },
    eject: { mutate: vi.fn(), isPending: false },
  }),
  useStatus: () => ({ data: { engine: { state: 'stopped' }, model: null } }),
}))
vi.mock('../lib/onboarding-queries', () => ({ useOnboardingState: () => ({ data: undefined }) }))
vi.mock('../lib/usePinnedModels', () => ({ usePinnedModels: () => ({ isPinned: () => false, togglePinned: vi.fn() }) }))
vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))
vi.mock('./models/DiscoverTab', () => ({ DiscoverTab: () => null }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('./models/HfRepoDialog', () => ({ HfRepoDialog: () => null }))
vi.mock('./engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: vi.fn(),
  deleteModel: vi.fn(),
}))

// link-queries is DELIBERATELY NOT MOCKED. The real hooks run against a stubbed `fetch`,
// so a click travels component -> mutation -> link-api -> HTTP, and these tests assert the
// REQUEST that comes out the far end rather than the argument handed to a mock.
//
// That distinction is the whole point: phase 2 shipped a Critical where a test pinned what
// a click handed off and nothing about what the receiver did with it - the picker offered
// remote models and selecting one silently loaded a different LOCAL model, because the
// handoff was right and the receiver was wrong. A mocked `useRemoteModelActions` cannot
// see that class of bug; this can.
type Call = { url: string; method: string; body: unknown }
const calls: Call[] = []
/** Per-URL-substring canned failures, so one test can make the load POST refuse. */
const failures = new Map<string, { status: number; error: Record<string, unknown> }>()

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })

    for (const [needle, f] of failures) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify({ error: f.error }), {
          status: f.status, headers: { 'content-type': 'application/json' },
        })
      }
    }
    const json = (b: unknown) => new Response(JSON.stringify(b), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    if (url.includes('/api/v1/links/models')) return json({ models: state.remote })
    if (url.endsWith('/api/v1/links')) return json({ links: state.links })
    return json({ ok: true })
  }))
}

/** POSTs that actually left the app, ignoring the polling GETs. */
const writes = () => calls.filter((c) => c.method !== 'GET')

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'local-1', name: 'Local Llama', quant: 'Q4_K_M', arch: 'llama', dir: 'D:\\models',
    path: 'D:\\models\\local.gguf', sizeBytes: 4e9, nativeCtx: 8192, loaded: false,
    compatibleWithActiveEngine: true, format: 'gguf', hasChatTemplate: true,
    ...over,
  } as ModelEntry
}

function link(over: Partial<LinkSummary> = {}): LinkSummary {
  return {
    id: 'l1', name: 'workstation', status: 'online',
    grantedCapabilities: ['models:use', 'models:load', 'models:unload'], lastError: null, ...over,
  }
}

function remote(over: Partial<RemoteRow['model']> = {}, linkId = 'l1'): RemoteRow {
  return {
    linkId,
    machine: 'workstation',
    model: { key: 'r1', name: 'Remote Qwen', quant: 'Q4_K_M', nativeCtx: 32768, vision: false, loaded: false, ...over },
  }
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ModelsScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.models = [entry()]
  state.links = []
  state.remote = []
  calls.length = 0
  failures.clear()
  localLoad.mockClear()
  installFetch()
})

describe('ModelsScreen — merged fleet library', () => {
  it('is unchanged for an install with no links', () => {
    renderScreen()
    expect(screen.getByText('Local Llama')).toBeTruthy()
    // No machine filter and no origin column when there is only one machine.
    expect(screen.queryByRole('group', { name: /filter by machine/i })).toBeNull()
    expect(screen.queryByText('This machine')).toBeNull()
  })

  it('lists this machine\'s models before any linked machine\'s', async () => {
    state.links = [link()]
    state.remote = [remote()]
    const { container } = renderScreen()
    await screen.findByText('Remote Qwen')
    const text = container.textContent ?? ''
    expect(text.indexOf('Local Llama')).toBeLessThan(text.indexOf('Remote Qwen'))
  })

  it('shows an origin for every row once a link exists', async () => {
    state.links = [link()]
    state.remote = [remote()]
    renderScreen()
    await screen.findByText('Remote Qwen')
    // "This machine" appears both as a filter chip and as the local row's origin badge.
    expect(screen.getAllByText('This machine').length).toBeGreaterThan(0)
    expect(screen.getAllByText('workstation').length).toBeGreaterThan(0)
  })

  it('filters to one machine, on link id', async () => {
    state.links = [link()]
    state.remote = [remote()]
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'workstation' }))
    expect(screen.queryByText('Local Llama')).toBeNull()
    expect(screen.getByText('Remote Qwen')).toBeTruthy()
  })

  it('loads a remote model by POSTing that machine\'s load route, never the local engine route', async () => {
    // The bug this guards: a qualified remote id reaching POST /api/v1/engine/start aborts
    // every in-flight generation and then loads a DIFFERENT local model. Asserted on the
    // REQUEST, so pointing the mutation at the wrong route fails here.
    state.links = [link()]
    state.remote = [remote()]
    state.models = []
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: /load/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({
      url: '/api/v1/links/l1/load', method: 'POST', body: { modelKey: 'r1' },
    })
    expect(calls.some((c) => c.url.includes('/engine/'))).toBe(false)
    expect(localLoad).not.toHaveBeenCalled()
  })

  it('a disabled remote control issues no request at all when clicked', async () => {
    // "Never a silent no-op" has a second half: it must also never be a silent REQUEST.
    state.links = [link({ grantedCapabilities: ['models:use'] })]
    state.remote = [remote()]
    state.models = []
    renderScreen()
    const btn = await screen.findByRole('button', { name: /load/i })
    await userEvent.click(btn).catch(() => {})
    expect(btn).toBeDisabled()
    expect(writes()).toHaveLength(0)
  })

  it('unloads a loaded remote model through that machine\'s unload route', async () => {
    state.links = [link()]
    state.remote = [remote({ loaded: true })]
    state.models = []
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: /unload/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].url).toBe('/api/v1/links/l1/unload')
  })

  // Requirement: host_busy / model_not_loaded / a named-capability 403 must each render
  // their OWN state. These drive a real failing HTTP response all the way through
  // link-api's envelope parsing and describeRemoteFailure into the DOM.
  it('renders a host_busy refusal as the host being busy', async () => {
    state.links = [link()]; state.remote = [remote()]; state.models = []
    failures.set('/load', { status: 503, error: { code: 'host_busy', message: 'x' } })
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: /load/i }))
    expect(await screen.findByText(/busy with its own work/i)).toBeTruthy()
    expect(screen.queryByText(/permission/i)).toBeNull()
  })

  it('renders a 403 that names a capability by naming that capability', async () => {
    state.links = [link()]; state.remote = [remote()]; state.models = []
    failures.set('/load', { status: 403, error: { code: 'forbidden', message: 'x', capability: 'models:load' } })
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: /load/i }))
    // Proves the capability survived the HTTP envelope, not just a hand-set field.
    expect(await screen.findByText(/models:load/)).toBeTruthy()
  })

  it('renders an offline refusal distinctly from a busy one', async () => {
    state.links = [link()]; state.remote = [remote()]; state.models = []
    failures.set('/load', { status: 503, error: { code: 'unavailable', message: 'x' } })
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: /load/i }))
    expect(await screen.findByText(/did not answer/i)).toBeTruthy()
    expect(screen.queryByText(/busy with its own work/i)).toBeNull()
  })

  it('never renders the host-authored message, which can carry a host path', async () => {
    state.links = [link()]; state.remote = [remote()]; state.models = []
    failures.set('/load', {
      status: 409,
      error: { code: 'model_not_loadable', message: "ENOENT open 'D:\\models\\x.gguf'" },
    })
    const { container } = renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: /load/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(container.textContent ?? '').not.toMatch(/ENOENT|D:/)
  })

  it('disables a remote Load, naming the capability, when the grant is missing', async () => {
    state.links = [link({ grantedCapabilities: ['models:use'] })]
    state.remote = [remote()]
    state.models = []
    renderScreen()
    const btn = await screen.findByRole('button', { name: /load/i })
    expect(btn).toBeDisabled()
    expect(btn.getAttribute('title')).toMatch(/models:load/)
  })

  it('an offline machine contributes no rows but is still explained', async () => {
    state.links = [link({ status: 'unreachable', lastError: 'workstation is not reachable.' })]
    state.remote = [remote()]
    renderScreen()
    expect(await screen.findByText(/not reachable/i)).toBeTruthy()
    expect(screen.queryByText('Remote Qwen')).toBeNull()
    // …and it stays selectable in the filter, so the user can still ask about it.
    expect(screen.getByRole('button', { name: 'workstation' })).toBeTruthy()
  })

  // Final review I-4. The aggregated `/api/v1/links/models` route has no per-link error
  // channel, so a link that is online but was never granted `models:use` contributed zero
  // models, offered a machine-filter chip that yields an empty list, and said nothing at
  // all. An online machine going silent is exactly as confusing as one that vanishes.
  it('an ONLINE machine that was never granted models:use is explained, not silently empty', async () => {
    state.links = [link({ grantedCapabilities: ['models:load'] })]
    state.remote = []
    renderScreen()
    const note = await screen.findByText(/models:use/)
    expect(note.textContent).toMatch(/workstation/)
  })

  it('says nothing extra about an online machine that simply has no models yet', async () => {
    state.links = [link()]
    state.remote = []
    renderScreen()
    await screen.findByRole('button', { name: 'workstation' })
    expect(screen.queryByText(/models:use/)).toBeNull()
  })

  it('two machines with the same model name produce two distinct rows', async () => {
    state.links = [link(), link({ id: 'l2', name: 'kaggle' })]
    state.remote = [remote({ name: 'Twin' }), remote({ name: 'Twin' }, 'l2')]
    state.models = []
    renderScreen()
    await waitFor(() => expect(screen.getAllByText('Twin')).toHaveLength(2))
  })
})
