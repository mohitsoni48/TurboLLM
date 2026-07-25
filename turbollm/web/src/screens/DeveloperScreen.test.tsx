// Covers the three Developer-pane fixes: (1) Server URL shows the LAN-reachable address once
// LAN sharing is on, not just window.location.origin (which still reads 127.0.0.1/localhost even
// when OTHER devices reach the daemon over the LAN); (2) the API-keys list + create form is
// hidden — with an explanatory message, not just silently missing — for a non-host viewer while
// the LAN is open and unauthenticated (requireApiKey off); (3) same lock for the "Connect an
// app" setup snippets, which embed a live API key and — unlike the keys list — fetch
// automatically on page load with no click required. The real security boundary is server-side
// (keys-network.test.ts); this only verifies the UI honestly reflects that same state.
import { render, screen } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkInfo } from '../lib/api'

let networkInfo: NetworkInfo | undefined
const getConnectSpy = vi.fn(() => Promise.resolve({ cli: 'claude-code', title: '', steps: [{ label: 'bash', snippet: 'ANTHROPIC_AUTH_TOKEN="tllm-secret-value" claude', lang: 'bash' }] }))

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
  return { ...actual, getConnect: (...args: unknown[]) => getConnectSpy(...(args as [])) }
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
    expect(screen.queryByText(/API key management is only available/i)).not.toBeInTheDocument()
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
    expect(screen.getByText(/API key management is only available/i)).toBeInTheDocument()
  })

  it('fails CLOSED (locked) while network info is still loading, rather than flashing the form', async () => {
    networkInfo = undefined
    await renderScreen()
    expect(screen.queryByPlaceholderText('Key name (e.g. claude-code)')).not.toBeInTheDocument()
    expect(screen.getByText(/API key management is only available/i)).toBeInTheDocument()
  })
})

describe('DeveloperScreen — Connect-an-app setup snippet gating', () => {
  beforeEach(() => { networkInfo = undefined; getConnectSpy.mockClear() })

  it('fetches and shows the live-key setup snippet on the host machine, even with LAN open and no auth yet', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: false, requireApiKey: false, isHost: true }
    await renderScreen()
    await screen.findByText(/tllm-secret-value/)
    expect(getConnectSpy).toHaveBeenCalled()
  })

  it('does NOT fetch the setup snippet for a non-host viewer while the LAN is open and unauthenticated — no key is minted', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: false, requireApiKey: false, isHost: false }
    await renderScreen()
    await screen.findByText(/Setup snippets include a live API key/i)
    expect(screen.queryByText(/tllm-secret-value/)).not.toBeInTheDocument()
    expect(getConnectSpy).not.toHaveBeenCalled()
  })

  it('fetches the setup snippet again once requireApiKey is on, even for a non-host viewer', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: true, requireApiKey: true, isHost: false }
    await renderScreen()
    await screen.findByText(/tllm-secret-value/)
    expect(getConnectSpy).toHaveBeenCalled()
  })
})

describe('DeveloperScreen — TurboLLM MCP section', () => {
  beforeEach(() => { networkInfo = undefined })

  it('shows the generic MCP host config and the Claude Code one-liner', async () => {
    networkInfo = { lanBind: false, lanUrl: '', hasApiKey: false, requireApiKey: false, isHost: true }
    await renderScreen()
    expect(screen.getByText('TurboLLM MCP')).toBeInTheDocument()
    expect(screen.getByText(/"command": "npx"/)).toBeInTheDocument()
    expect(screen.getByText(/"args": \[/)).toBeInTheDocument()
    expect(screen.getByText('claude mcp add turbollm -- npx turbollm mcp-server')).toBeInTheDocument()
  })

  it('lists the delegate_code_task parameters', async () => {
    networkInfo = { lanBind: false, lanUrl: '', hasApiKey: false, requireApiKey: false, isHost: true }
    await renderScreen()
    expect(screen.getByText('delegate_code_task parameters')).toBeInTheDocument()
    for (const name of ['repoRoot', 'task', 'mode', 'modelKey', 'timeoutSeconds']) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it('is NOT gated behind the host-only key lock — it embeds no secret, unlike the sections above', async () => {
    networkInfo = { lanBind: true, lanUrl: 'http://192.168.1.5:6996', hasApiKey: false, requireApiKey: false, isHost: false }
    await renderScreen()
    // Both sections above ARE locked in this exact state (see the other describe blocks) —
    // this section must render fully regardless, since it has nothing sensitive to protect.
    expect(screen.getByText('TurboLLM MCP')).toBeInTheDocument()
    expect(screen.getByText(/"command": "npx"/)).toBeInTheDocument()
  })
})
