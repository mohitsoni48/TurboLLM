import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RemoteAccessSection } from './RemoteAccessSection'
import { startRemote, stopRemote, preflightRemote } from '../../lib/remote-api'

vi.mock('../../lib/remote-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/remote-api')>()),
  getRemoteStatus: vi.fn(async () => ({
    provider: 'cloudflare-quick' as const,
    enabled: false,
    state: { kind: 'off' as const },
    url: '',
    ingressPort: null,
  })),
  startRemote: vi.fn(async () => ({ state: { kind: 'starting' as const } })),
  stopRemote: vi.fn(async () => ({ state: { kind: 'off' as const } })),
  preflightRemote: vi.fn(async () => ({ provider: 'ngrok' as const, state: { kind: 'off' as const } })),
}))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  getSettings: vi.fn(async () => ({ remoteAccess: { provider: 'cloudflare-quick' } })),
  saveSettings: vi.fn(async () => ({})),
  track: vi.fn(),
}))

const wrap = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

describe('RemoteAccessSection', () => {
  it('states the quick tunnel cost on its card rather than hiding it', async () => {
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText(/URL changes on every restart/i)).toBeTruthy()
    expect(screen.getByText(/no uptime guarantee/i)).toBeTruthy()
  })

  it("warns that ngrok's interstitial appears in front of this UI", async () => {
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText(/interstitial page in front of this UI/i)).toBeTruthy()
  })

  it('describes Tailscale Serve as devices-only, not public', async () => {
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText(/your devices only/i)).toBeTruthy()
  })

  it('renders a provider preflight reason verbatim, not a generic failure', async () => {
    vi.mocked(preflightRemote).mockResolvedValueOnce({
      provider: 'tailscale-serve',
      state: { kind: 'unavailable', reason: 'Tailscale is not installed on this machine.' },
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /tailscale serve/i }))
    expect(await screen.findByText(/Tailscale is not installed on this machine/i)).toBeTruthy()
  })

  it('shows the live URL with a copy control once connected', async () => {
    const api = await import('../../lib/remote-api')
    // mockResolvedValueOnce — see the note on the same call further down this file: a
    // non-Once override here becomes the mock's new default and leaks into every later test
    // that doesn't set its own, since this suite's vitest config sets no clearMocks/mockReset.
    vi.mocked(api.getRemoteStatus).mockResolvedValueOnce({
      provider: 'cloudflare-quick',
      enabled: true,
      state: { kind: 'connected', url: 'https://x.trycloudflare.com', since: '2026-09-10T00:00:00Z' },
      url: 'https://x.trycloudflare.com',
      ingressPort: 6997,
    })
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText('https://x.trycloudflare.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy()
  })

  it('surfaces a reconnect as reconnecting, not as a dead URL', async () => {
    const api = await import('../../lib/remote-api')
    vi.mocked(api.getRemoteStatus).mockResolvedValueOnce({
      provider: 'cloudflare-quick',
      enabled: true,
      state: { kind: 'reconnecting', attempt: 2, lastError: 'health probe failed' },
      url: '',
      ingressPort: 6997,
    })
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText(/reconnecting/i)).toBeTruthy()
    expect(screen.getByText(/health probe failed/i)).toBeTruthy()
  })

  it('stops remote access from the section', async () => {
    const api = await import('../../lib/remote-api')
    // mockResolvedValueOnce, not mockResolvedValue: this file's vitest config sets no
    // clearMocks/mockReset, so a non-Once override here persists into every later test that
    // doesn't set its own — including the next one, which relies on the OUTER mock's default
    // (off) status. Confirmed by running this suite with the next test isolated (passes) vs.
    // after this one (failed on startRemote never being called) before this fix.
    vi.mocked(api.getRemoteStatus).mockResolvedValueOnce({
      provider: 'tailscale-serve',
      enabled: true,
      state: { kind: 'connected', url: 'https://box.ts.net', since: '2026-09-10T00:00:00Z' },
      url: 'https://box.ts.net',
      ingressPort: 6997,
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('switch', { name: /remote access/i }))
    await waitFor(() => expect(vi.mocked(stopRemote)).toHaveBeenCalled())
  })

  it('turning on Tailscale Serve does NOT show an internet-exposure confirmation', async () => {
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /tailscale serve/i }))
    await userEvent.click(screen.getByRole('switch', { name: /remote access/i }))
    expect(screen.queryByText(/reachable from the internet/i)).toBeNull()
    await waitFor(() => expect(vi.mocked(startRemote)).toHaveBeenCalled())
  })
})
