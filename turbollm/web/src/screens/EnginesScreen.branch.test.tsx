// Regression: a source-build card sent `--branch main` for engines whose default branch is not
// `main` (Prism, the `master` ones, concedo), so the clone died with "Remote branch main not found
// in upstream origin" while the dropdown SHOWED the right branch.
//
// The screen renders cards as soon as the recommendation query resolves, but a card's catalog
// entry comes from a separate, slower query. The branch state was seeded once at mount from
// `catalog?.defaultBranch ?? 'main'`, so a card that mounted before its catalog entry arrived
// froze on 'main' forever, while the visible <option> (computed live) switched to the real default.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EnginesScreen } from './EnginesScreen'

vi.mock('./engines/MonitorTab', () => ({ MonitorTab: () => null }))
vi.mock('./TokensScreen', () => ({ TokensScreen: () => null }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: vi.fn(),
}))

const PRISM_VARIANT = {
  id: 'prism-source',
  label: 'Build from source',
  repo: 'PrismML-Eng/llama.cpp',
  requires: {},
  stability: 'experimental',
  speed: 'fast',
  hasPrebuilt: false,
}

// Real shape, captured from the daemon: the recommendation's engine ALREADY carries defaultBranch.
const PRISM_ENGINE = {
  id: 'prism',
  name: 'Prism (llama.cpp fork)',
  kind: 'llama-server',
  description: 'A llama.cpp fork tuned for 1-2 bit ternary/Bonsai models.',
  provision: 'github-release',
  homepage: 'https://github.com/PrismML-Eng/llama.cpp',
  repo: 'PrismML-Eng/llama.cpp',
  platforms: ['win32', 'darwin', 'linux'],
  support: 'experimental',
  installEndpoint: '',
  note: '',
  defaultBranch: 'prism',
  variants: [PRISM_VARIANT],
}

/** The default branch the daemon reports for the engine; undefined = the catalog has none for it. */
let engineDefaultBranch: string | undefined

const engine = () => ({ ...PRISM_ENGINE, defaultBranch: engineDefaultBranch })

const recommendation = () => ({
  hardware: { platform: 'win32', arch: 'x64', gpuVendor: 'nvidia', hasGpu: true, vramMb: 16303, gpuName: 'NVIDIA GeForce RTX 5070 Ti', unifiedMemory: false },
  recommendation: {
    recommended: null,
    fits: [{ engine: engine(), variants: [PRISM_VARIANT], compatible: [PRISM_VARIANT], recommended: false }],
  },
})

const catalog = () => ({
  engines: [{ ...engine(), supportedHere: true, sourceBuilt: false, sourceBranch: '', sourceBinPath: '' }],
})

const STATUS = {
  version: '0.0.0',
  engine: { id: '', name: '', kind: 'llama-server', state: 'stopped', port: 0, pid: 0 },
  model: null,
  downloads: { active: 0 },
  bench: { running: false },
  liveGeneration: null,
  engineProvision: { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1 },
  engineBuild: { active: false, phase: 'idle', engine: '', log: [], error: null },
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

let releaseCatalog: () => void

/** What GET /api/v1/build/git-branches returns for the repo (the daemon sorts the default first). */
let gitBranches: string[] = []

beforeEach(() => {
  engineDefaultBranch = 'prism'
  gitBranches = []
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (/\/api\/v1\/engines(\?|$)/.test(url)) return json({ engines: [], activeEngineId: '' })
      if (/\/api\/v1\/status(\?|$)/.test(url)) return json(STATUS)
      if (/\/api\/v1\/settings(\?|$)/.test(url)) return json({ build: { toolchainDirs: [] } })
      if (url.includes('/api/v1/build/prereqs')) return json({ supported: true, os: 'windows', tools: [], packageManager: null })
      if (url.includes('/api/v1/engines/recommendation')) return json(recommendation())
      if (url.includes('/api/v1/engines/catalog')) {
        await catalogGate
        return json(catalog())
      }
      if (url.includes('/api/v1/build/git-branches')) return json({ total: gitBranches.length, branches: gitBranches })
      return json({})
    }),
  )
})

/** Bodies of every POST /api/v1/build/run the screen has made. */
function buildRequests(): Array<Record<string, unknown>> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => String(input instanceof Request ? input.url : input).includes('/api/v1/build/run') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)))
}

function renderEngines() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/engines']}>
        <EnginesScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('EnginesScreen source-build branch (Prism "Remote branch main not found")', () => {
  it('builds the default branch of an engine whose catalog entry arrives AFTER its card mounted', async () => {
    renderEngines()
    // The recommendation is in, the catalog is still pending: the card is on screen with no catalog entry.
    await screen.findByText('Prism (llama.cpp fork)')

    releaseCatalog()
    fireEvent.click(await screen.findByRole('button', { name: /build from source/i }))

    const title = await screen.findByText(/Build .* from source/)
    await waitFor(() => expect(title.textContent).toContain('-prism'))
    expect(title.textContent).not.toContain('-main')

    // The original bug was the screen and the REQUEST disagreeing, so assert the request itself.
    fireEvent.click(await screen.findByRole('button', { name: /build it for me/i }))
    await waitFor(() => expect(buildRequests()).toHaveLength(1))
    expect(buildRequests()[0]).toMatchObject({ repoUrl: 'https://github.com/PrismML-Eng/llama.cpp', branch: 'prism' })
  })

  it('sends NO branch — not a guessed "main" — for an engine whose default branch is unknown', async () => {
    // A guessed branch is exactly how "Remote branch main not found" happens for any repo whose
    // default isn't main. With no known default the honest request is a blank branch, which git
    // resolves to the repo's real default.
    engineDefaultBranch = undefined
    renderEngines()
    await screen.findByText('Prism (llama.cpp fork)')

    releaseCatalog()
    fireEvent.click(await screen.findByRole('button', { name: /build from source/i }))
    await screen.findByText(/Build .* from source/)
    fireEvent.click(await screen.findByRole('button', { name: /build it for me/i }))

    await waitFor(() => expect(buildRequests()).toHaveLength(1))
    const request = buildRequests()[0]
    expect(request).not.toHaveProperty('branch')
    expect(request.name).toBe('Prism (llama.cpp fork)')
  })

  it('keeps the selected blank branch as a real option when the fetched branch list does not contain it', async () => {
    // A <select> whose value matches no option DISPLAYS its first option while the state holds
    // another: here it would show "main" on screen while the request went out with no branch.
    engineDefaultBranch = undefined
    gitBranches = ['main', 'dev']
    renderEngines()
    await screen.findByText('Prism (llama.cpp fork)')
    releaseCatalog()

    const row = (await screen.findByText('Branch:')).closest('div.flex') as HTMLElement
    const select = within(row).getByRole('combobox') as HTMLSelectElement
    fireEvent.focus(select)

    await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toContain('dev'))
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['(repo default)', 'main', 'dev'])
    expect(select.value).toBe('')
  })

  it('still shows the branch it will build after a search that filters that branch out', async () => {
    // The search box filtered the selected branch out of the <select>, which then DISPLAYED the
    // first match while the request went out with the branch in state ("prism").
    gitBranches = ['prism', 'dev', 'develop', 'cuda-a', 'cuda-b', 'x1']
    renderEngines()
    await screen.findByText('Prism (llama.cpp fork)')
    releaseCatalog()

    const row = (await screen.findByText('Branch:')).closest('div.flex') as HTMLElement
    const select = within(row).getByRole('combobox') as HTMLSelectElement
    fireEvent.focus(select)
    const search = await screen.findByPlaceholderText(/Search \d+ branches/)

    fireEvent.change(search, { target: { value: 'cuda' } })

    await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['prism', 'cuda-a', 'cuda-b']))
    expect(select.selectedOptions[0]?.value).toBe('prism')
    expect(screen.getByText('2 of 6')).toBeTruthy()
  })
})
