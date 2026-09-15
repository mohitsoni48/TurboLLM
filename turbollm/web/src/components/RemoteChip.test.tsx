import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RemoteChip } from './RemoteChip'
import { stopRemote } from '../lib/remote-api'
import { toast } from './ui/sonner'

const status = vi.fn()
vi.mock('../lib/remote-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/remote-api')>()),
  getRemoteStatus: () => status(),
  stopRemote: vi.fn(async () => ({ state: { kind: 'off' as const } })),
}))

// Deterministic + inspectable, same convention as CodeComposer.test.tsx: real sonner needs a
// mounted <Toaster/> to render anything, and I4's regression test asserts a toast fired.
vi.mock('./ui/sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
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

  it('does not hand out a stale URL with Copy while reconnecting (I2)', async () => {
    status.mockResolvedValue({
      provider: 'ngrok', enabled: true,
      state: { kind: 'reconnecting', attempt: 3, lastError: 'edge dropped' },
      url: 'https://old.ngrok-free.app', ingressPort: 6997,
    })
    wrap()
    await userEvent.click(await screen.findByRole('button', { name: /remote access/i }))
    expect(await screen.findAllByText(/reconnecting/i)).not.toHaveLength(0)
    expect(screen.queryByText('https://old.ngrok-free.app')).toBeNull()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('does not hand out a stale URL with Copy while failed (I2)', async () => {
    status.mockResolvedValue({
      provider: 'ngrok', enabled: true,
      state: { kind: 'failed', reason: 'tunnel process exited' },
      url: 'https://old.ngrok-free.app', ingressPort: 6997,
    })
    wrap()
    await userEvent.click(await screen.findByRole('button', { name: /remote access/i }))
    expect(await screen.findByText(/tunnel process exited/i)).toBeTruthy()
    expect(screen.queryByText('https://old.ngrok-free.app')).toBeNull()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('holds the last-known status across a transient poll error instead of vanishing (I3)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let calls = 0
    status.mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        return {
          provider: 'cloudflare-quick', enabled: true,
          state: { kind: 'connected', url: 'https://x.test', since: '' }, url: 'https://x.test', ingressPort: 6997,
        }
      }
      throw new Error('network down')
    })
    render(
      <QueryClientProvider client={qc}>
        <RemoteChip enabled />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/public/i)).toBeTruthy()
    // React Query does not clear `data` on a failed BACKGROUND refetch by default, so the
    // chip should keep showing the last-known good state rather than disappearing.
    await qc.refetchQueries({ queryKey: ['remote-status'] }).catch(() => {})
    expect(screen.getByText(/public/i)).toBeTruthy()
  })

  it('stops sharing from the popover and closes it on success (I4)', async () => {
    status.mockResolvedValue({
      provider: 'cloudflare-quick', enabled: true,
      state: { kind: 'connected', url: 'https://x.test', since: '' }, url: 'https://x.test', ingressPort: 6997,
    })
    wrap()
    await userEvent.click(await screen.findByRole('button', { name: /remote access/i }))
    await userEvent.click(await screen.findByRole('button', { name: /stop sharing/i }))
    await waitFor(() => expect(vi.mocked(stopRemote)).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('button', { name: /stop sharing/i })).toBeNull())
  })

  it('shows a toast instead of failing silently when Stop sharing rejects (I4)', async () => {
    vi.mocked(stopRemote).mockRejectedValueOnce(new Error('network down'))
    status.mockResolvedValue({
      provider: 'cloudflare-quick', enabled: true,
      state: { kind: 'connected', url: 'https://x.test', since: '' }, url: 'https://x.test', ingressPort: 6997,
    })
    wrap()
    await userEvent.click(await screen.findByRole('button', { name: /remote access/i }))
    await userEvent.click(await screen.findByRole('button', { name: /stop sharing/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
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
