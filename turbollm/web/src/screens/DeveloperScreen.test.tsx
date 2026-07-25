// Covers the two Developer-pane fixes: (1) Server URL shows the LAN-reachable address once LAN
// sharing is on, not just window.location.origin (which still reads 127.0.0.1/localhost even
// when OTHER devices reach the daemon over the LAN); (2) API key management is hidden — with an
// explanatory message, not just silently missing — for a non-host viewer while the LAN is open
// and unauthenticated (requireApiKey off). The real security boundary is server-side
// (keys-network.test.ts); this only verifies the UI honestly reflects that same state.
import { render, screen } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkInfo } from '../lib/api'

let networkInfo: NetworkInfo | undefined

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useApiKeys: () => ({
      query: { data: { keys: [] } },
      create: { mutate: vi.fn(), isPending: false },
      revoke: { mutate: vi.fn(), isPending: false },
    }),
    useNetworkInfo: () => ({ data: networkInfo }),
  }
})

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, getConnect: () => Promise.resolve({ cli: 'claude-code', title: '', steps: [] }) }
})

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return import('./DeveloperScreen').then(({ DeveloperScreen }) =>
    render(
      <QueryClientProvider client={qc}>
        <DeveloperScreen />
      </QueryClientProvider>,
    ),
  )
}

describe('DeveloperScreen — Server URL', () => {
  beforeEach(() => { networkInfo = undefined })

  it('shows window.location.origin when LAN sharing is off', async () => {
    networkInfo = { lanBind: false, lanUrl: 'http://192.168.1.5:6996', hasApiKey: false, requireApiKey: false, isHost: true }
    await renderScreen()
    expect(screen.getByText(window.location.origin)).toBeInTheDocument()
  })

  it('shows the LAN-reachable URL, not window.location.origin, when LAN sharing is on', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: false, requireApiKey: false, isHost: true }
    await renderScreen()
    expect(screen.getByText('http://192.168.1.5:6996')).toBeInTheDocument()
    expect(screen.queryByText(window.location.origin)).not.toBeInTheDocument()
  })
})

describe('DeveloperScreen — API key management gating', () => {
  beforeEach(() => { networkInfo = undefined })

  it('shows the key list + create form on the host machine, even with LAN open and no auth yet', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: false, requireApiKey: false, isHost: true }
    await renderScreen()
    expect(screen.getByPlaceholderText('Key name (e.g. claude-code)')).toBeInTheDocument()
    expect(screen.queryByText(/only available from this machine/i)).not.toBeInTheDocument()
  })

  it('shows the key list + create form once requireApiKey is on, even for a non-host viewer', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: true, requireApiKey: true, isHost: false }
    await renderScreen()
    expect(screen.getByPlaceholderText('Key name (e.g. claude-code)')).toBeInTheDocument()
  })

  it('hides the key list + create form for a non-host viewer while the LAN is open and unauthenticated', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: false, requireApiKey: false, isHost: false }
    await renderScreen()
    expect(screen.queryByPlaceholderText('Key name (e.g. claude-code)')).not.toBeInTheDocument()
    expect(screen.getByText(/only available from this machine/i)).toBeInTheDocument()
  })

  it('fails CLOSED (locked) while network info is still loading, rather than flashing the form', async () => {
    networkInfo = undefined
    await renderScreen()
    expect(screen.queryByPlaceholderText('Key name (e.g. claude-code)')).not.toBeInTheDocument()
    expect(screen.getByText(/only available from this machine/i)).toBeInTheDocument()
  })
})
