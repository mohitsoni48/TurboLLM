// The Connect page's own (unclicked) setup fetch on a page whose network read went stale.
// Nothing refetches ['network'] while the page stays open (refetchOnWindowFocus is off in
// main.tsx), so after LAN is switched on from another window or tab the page still reads
// lanBind:false, and each card click sent GET /api/v1/connect/:cli to a LAN-bound daemon, which
// minted a new cli-<name> key and revoked the one a CLI was already using. Real TanStack Query and
// the real useNetworkInfo; lib/api is faked as a daemon that honours `mint: false` (routes.ts).
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { NetworkInfo } from '../lib/api'

let daemonLan = false
const mints: string[] = []

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    track: () => {},
    getNetworkInfo: async (): Promise<NetworkInfo> => ({
      lanBind: daemonLan,
      lanUrl: daemonLan ? 'http://192.168.1.5:6996' : '',
      hasApiKey: true,
      requireApiKey: true,
      isHost: true,
    }),
    getConnect: async (cli: string, opts: { mint?: boolean } = {}) => {
      if (daemonLan && opts.mint === false) throw new actual.ApiError('lan_bound', 'LAN sharing is on.', 409)
      let key = 'not-needed-on-localhost'
      if (daemonLan) {
        mints.push(cli)
        key = `tllm-minted-${cli}`
      }
      return { cli, title: '', steps: [{ label: 'bash', snippet: `KEY=${key}`, lang: 'bash' }] }
    },
  }
})

describe('Connect an app: a stale loopback-only read never mints a key without a click', () => {
  it('a card click after LAN was switched on elsewhere shows Generate instead of replacing the key', async () => {
    const { ConnectSection } = await import('./DeveloperScreen')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ConnectSection />
      </QueryClientProvider>,
    )
    await screen.findByText('KEY=not-needed-on-localhost') // loopback-only: fetched on its own
    daemonLan = true // switched on from the desktop window or another tab; this page is not told

    await userEvent.click(screen.getByRole('button', { name: /opencode/i }))
    await screen.findByRole('button', { name: /generate setup with a new key/i })
    await userEvent.click(screen.getByRole('button', { name: /claude code/i })) // back to a card fetched before
    await screen.findByRole('button', { name: /generate setup with a new key/i })
    expect(mints).toEqual([])

    // The explicit click still mints, as the panel warns.
    await userEvent.click(screen.getByRole('button', { name: /opencode/i }))
    await userEvent.click(await screen.findByRole('button', { name: /generate setup with a new key/i }))
    await screen.findByText('KEY=tllm-minted-opencode')
    expect(mints).toEqual(['opencode'])
  })
})
