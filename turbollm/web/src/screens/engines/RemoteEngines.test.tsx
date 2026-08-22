import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RemoteEngines } from './RemoteEngines'
import type { LinkSummary } from '../../lib/link-api'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

// The per-link fan-out is a hook (link-queries.ts), tested through its own module; what
// this file is about is what the COMPONENT renders from it. A hoisted mock reading a
// mutable holder lets each test set the fleet without re-importing.
const fleet: { rows: { link: LinkSummary; status: unknown; error: unknown; isLoading: boolean }[] } = { rows: [] }
vi.mock('../../lib/link-queries', () => ({
  useRemoteEngines: () => fleet.rows,
}))

const online: LinkSummary = {
  id: 'l1',
  name: 'workstation',
  status: 'online',
  // Deliberately the FULL grant. Even a link that was given everything the protocol can
  // grant must not get an engine control — `engines:*` is not grantable at all (ADR-139),
  // so there is no capability that could ever turn these rows into controls.
  grantedCapabilities: [
    'models:use', 'models:wake', 'models:load', 'models:unload',
    'downloads:read', 'downloads:write', 'config:read', 'config:write',
  ],
  lastError: null,
}

const offline: LinkSummary = {
  id: 'l2',
  name: 'kaggle',
  status: 'unreachable',
  grantedCapabilities: ['models:use'],
  lastError: 'kaggle did not answer. Its tunnel URL may have changed.',
}

function renderWith(links: LinkSummary[], engines: Record<string, unknown> = {}) {
  fleet.rows = links
    .filter((l) => l.status === 'online')
    .map((link) => ({ link, status: engines[link.id] ?? null, error: null, isLoading: false }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RemoteEngines links={links} />
    </QueryClientProvider>,
  )
}

describe('RemoteEngines', () => {
  it('renders nothing at all when there are no links', () => {
    const { container } = renderWith([])
    expect(container).toBeEmptyDOMElement()
  })

  it('says out loud that engine management is host-only', () => {
    // ADR-139's carve-out surfaced HONESTLY. A user who sees remote engines listed but
    // cannot act on them, with no explanation, files a bug — that is the whole reason this
    // sentence is a requirement rather than a nicety.
    renderWith([online])
    expect(screen.getByText(/managed on the machine that runs them|host-only|only on that machine/i)).toBeTruthy()
  })

  it('has NO enabled control anywhere on a remote engine row', () => {
    // The binding assertion of this screen. Not "the buttons are disabled" — there must be
    // no button at all, because a greyed engine button implies a permission that could be
    // granted, and none can be.
    const { container } = renderWith([online], {
      l1: { engine: { id: 'e', name: 'llama.cpp', kind: 'llamacpp', state: 'running', port: 8080, pid: 1 }, model: null },
    })
    const section = container.querySelector('[data-testid="remote-engines"]')!
    expect(within(section as HTMLElement).queryAllByRole('button')).toHaveLength(0)
    expect(within(section as HTMLElement).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(section as HTMLElement).queryAllByRole('switch')).toHaveLength(0)
  })

  it('never renders an engines capability, in any spelling', () => {
    // Mirrors src/link/web-mirror.test.ts's guard, at the render layer: the server can never
    // grant `engines:*`, so the UI must never imply it exists as something to ask for.
    const { container } = renderWith([online], {
      l1: { engine: { id: 'e', name: 'llama.cpp', kind: 'llamacpp', state: 'running', port: 8080, pid: 1 }, model: null },
    })
    expect(container.textContent ?? '').not.toMatch(/engines:/i)
  })

  it('shows the running engine and model for an online machine', () => {
    renderWith([online], {
      l1: {
        engine: { id: 'e', name: 'llama.cpp', kind: 'llamacpp', state: 'running', port: 8080, pid: 1 },
        model: { key: 'k', name: 'Qwen3-35B', quant: 'Q4_K_M', ctx: 32768, vision: false },
      },
    })
    expect(screen.getByText('workstation')).toBeTruthy()
    expect(screen.getByText(/llama\.cpp/)).toBeTruthy()
    expect(screen.getByText(/Qwen3-35B/)).toBeTruthy()
  })

  it('explains an unreachable machine instead of spinning forever', () => {
    // `LinkClient` never throws by contract and the routes honour it, so an offline machine
    // must DEGRADE — a reason on screen, not a spinner that never resolves.
    renderWith([offline])
    expect(screen.getByText(/tunnel URL may have changed/i)).toBeTruthy()
    expect(screen.queryByText(/loading/i)).toBeNull()
  })

  it('never discloses the host port or pid', () => {
    // The remote status shape carries them, but they are the host's internals; a fleet list
    // has no use for them and this feature has already had several host-detail leaks.
    const { container } = renderWith([online], {
      l1: { engine: { id: 'e', name: 'llama.cpp', kind: 'llamacpp', state: 'running', port: 8080, pid: 4242 }, model: null },
    })
    expect(container.textContent ?? '').not.toMatch(/8080|4242/)
  })
})
