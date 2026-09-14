import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RemoteChip } from './RemoteChip'
import { stopRemote } from '../lib/remote-api'

const status = vi.fn()
vi.mock('../lib/remote-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/remote-api')>()),
  getRemoteStatus: () => status(),
  stopRemote: vi.fn(async () => ({ state: { kind: 'off' as const } })),
}))

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RemoteChip enabled />
    </QueryClientProvider>,
  )

describe('RemoteChip', () => {
  it('renders nothing while remote access is off', async () => {
    status.mockResolvedValue({ provider: 'cloudflare-quick', enabled: false, state: { kind: 'off' }, url: '', ingressPort: null })
    const { container } = wrap()
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('says PUBLIC for an internet-reachable provider', async () => {
    status.mockResolvedValue({
      provider: 'cloudflare-quick', enabled: true,
      state: { kind: 'connected', url: 'https://x.test', since: '' }, url: 'https://x.test', ingressPort: 6997,
    })
    wrap()
    expect(await screen.findByText(/public/i)).toBeTruthy()
  })

  it('says your devices for Tailscale Serve — never "public"', async () => {
    status.mockResolvedValue({
      provider: 'tailscale-serve', enabled: true,
      state: { kind: 'connected', url: 'https://box.ts.net', since: '' }, url: 'https://box.ts.net', ingressPort: 6997,
    })
    wrap()
    expect(await screen.findByText(/your devices/i)).toBeTruthy()
    expect(screen.queryByText(/^public$/i)).toBeNull()
  })

  it('shows a reconnecting state rather than a stale connected one', async () => {
    status.mockResolvedValue({
      provider: 'ngrok', enabled: true,
      state: { kind: 'reconnecting', attempt: 3, lastError: 'edge dropped' }, url: '', ingressPort: 6997,
    })
    wrap()
    expect(await screen.findByText(/reconnecting/i)).toBeTruthy()
  })

  it('stops sharing from the popover', async () => {
    status.mockResolvedValue({
      provider: 'cloudflare-quick', enabled: true,
      state: { kind: 'connected', url: 'https://x.test', since: '' }, url: 'https://x.test', ingressPort: 6997,
    })
    wrap()
    await userEvent.click(await screen.findByRole('button', { name: /remote access/i }))
    await userEvent.click(await screen.findByRole('button', { name: /stop sharing/i }))
    await waitFor(() => expect(vi.mocked(stopRemote)).toHaveBeenCalled())
  })

  it('never polls while the experimental flag is off', async () => {
    status.mockClear()
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RemoteChip enabled={false} />
      </QueryClientProvider>,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(status).not.toHaveBeenCalled()
  })
})
