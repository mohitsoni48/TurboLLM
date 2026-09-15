import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RemoteAccessSection } from './RemoteAccessSection'
import { startRemote, stopRemote, preflightRemote } from '../../lib/remote-api'
import { ApiError } from '../../lib/api'

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
  it('states the quick tunnel cost on its card rather than hiding it (selected by default)', async () => {
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText(/URL changes on every restart/i)).toBeTruthy()
    expect(screen.getByText(/no uptime guarantee/i)).toBeTruthy()
  })

  it("warns that ngrok's interstitial appears in front of this UI, once selected", async () => {
    // The Pros/Cons detail now expands only for the selected provider — a compact row per
    // option, not a full spec dump for all six at once — so this needs a click first.
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /^ngrok$/i }))
    expect(await screen.findByText(/interstitial page in front of this UI/i)).toBeTruthy()
  })

  it('describes Tailscale Serve as devices-only, not public, once selected', async () => {
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /tailscale serve/i }))
    expect(await screen.findByText(/your devices only/i)).toBeTruthy()
  })

  it('collapses unselected providers to a compact summary row, not a full Pros/Cons dump', async () => {
    wrap(<RemoteAccessSection />)
    // cloudflare-quick is selected by default and shows its detail...
    expect(await screen.findByText(/URL changes on every restart/i)).toBeTruthy()
    // ...but an unselected provider's Cons/Pros text is not dumped onto the page alongside it.
    expect(screen.queryByText(/interstitial page in front of this UI/i)).toBeNull()
    expect(screen.queryByText(/needs tailscale installed/i)).toBeNull()
  })

  it('renders a provider preflight reason verbatim, not a generic failure', async () => {
    // C2 (final-review.md) added a mount-time preflight of the seeded provider
    // (cloudflare-quick), so that is the FIRST call this render makes; the click on
    // Tailscale Serve fires the second.
    vi.mocked(preflightRemote).mockResolvedValueOnce({ provider: 'cloudflare-quick', state: { kind: 'off' } })
    vi.mocked(preflightRemote).mockResolvedValueOnce({
      provider: 'tailscale-serve',
      state: { kind: 'unavailable', reason: 'Tailscale is not installed on this machine.' },
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /tailscale serve/i }))
    expect(await screen.findByText(/Tailscale is not installed on this machine/i)).toBeTruthy()
  })

  it('preflights the already-selected provider on mount, not only after a click (C2)', async () => {
    const api = await import('../../lib/api')
    // Cast: the mock only needs `remoteAccess.provider` for this test, not every
    // DaemonSettings field — same partial shape the outer-level vi.mock(...) factory above
    // already uses for every other test in this file.
    vi.mocked(api.getSettings).mockResolvedValueOnce({ remoteAccess: { provider: 'ngrok' } } as Awaited<ReturnType<typeof api.getSettings>>)
    vi.mocked(preflightRemote).mockResolvedValueOnce({
      provider: 'ngrok',
      state: { kind: 'needs-setup', reason: 'Paste your ngrok authtoken from the ngrok dashboard.' },
    })
    wrap(<RemoteAccessSection />)
    // No click at all — the reason must appear from the mount-time preflight alone.
    expect(await screen.findByText(/Paste your ngrok authtoken from the ngrok dashboard/i)).toBeTruthy()
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

  it('shows the reason and a Check again control for needs-setup instead of claiming reachable (C1)', async () => {
    const api = await import('../../lib/remote-api')
    vi.mocked(api.getRemoteStatus).mockResolvedValueOnce({
      provider: 'ngrok',
      enabled: true,
      state: { kind: 'needs-setup', reason: 'Paste your ngrok authtoken from the ngrok dashboard.' },
      url: '',
      ingressPort: null,
    })
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText(/Paste your ngrok authtoken from the ngrok dashboard/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /check again/i })).toBeTruthy()
    // The headline defect: the switch reads on (the daemon's desired config is enabled) but
    // the subtitle must not claim it is actually reachable while stuck in needs-setup.
    expect(screen.queryByText(/reachable through this provider/i)).toBeNull()
    expect(screen.getByRole('switch', { name: /remote access/i }).getAttribute('aria-checked')).toBe('true')
  })

  it('surfaces a status-poll error instead of silently rendering Off (I3)', async () => {
    const api = await import('../../lib/remote-api')
    vi.mocked(api.getRemoteStatus).mockRejectedValueOnce(new ApiError('forbidden', 'Host-only action.', 403))
    wrap(<RemoteAccessSection />)
    expect(await screen.findByText(/Host-only action/i)).toBeTruthy()
  })

  it('Retry re-evaluates the exposure confirmation instead of assuming stale consent (C3 bypass a)', async () => {
    const apiLib = await import('../../lib/api')
    const remoteApi = await import('../../lib/remote-api')
    vi.mocked(apiLib.getSettings).mockResolvedValueOnce({ remoteAccess: { provider: 'ngrok' } } as Awaited<ReturnType<typeof apiLib.getSettings>>)
    // A failed start on a provider that is ALREADY public. Before the fix, Retry called
    // doStart() directly (`onRetry={doStart}`), skipping the confirmation unconditionally —
    // so this would fail pre-fix regardless of which provider is selected.
    vi.mocked(remoteApi.getRemoteStatus).mockResolvedValueOnce({
      provider: 'ngrok',
      enabled: true,
      state: { kind: 'failed', reason: 'ingress port already in use' },
      url: '',
      ingressPort: 6997,
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('button', { name: /retry/i }))
    expect(await screen.findByText(/reachable from the internet/i)).toBeTruthy()
    expect(vi.mocked(startRemote)).not.toHaveBeenCalled()
  })

  it('shows the exposure confirmation when server truth disagrees with a stale local draft (C3 bypass b)', async () => {
    const remoteApi = await import('../../lib/remote-api')
    // Simulate a provider-change PATCH that failed or has not landed: the user has locally
    // selected Tailscale Serve (non-public), but the daemon's persisted provider — what
    // /remote/start actually acts on — is still the public cloudflare-quick. Before the fix,
    // the dialog was gated on the local draft alone and would never show here.
    vi.mocked(remoteApi.getRemoteStatus).mockResolvedValueOnce({
      provider: 'cloudflare-quick',
      enabled: false,
      state: { kind: 'off' },
      url: '',
      ingressPort: null,
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /tailscale serve/i }))
    await userEvent.click(screen.getByRole('switch', { name: /remote access/i }))
    expect(await screen.findByText(/reachable from the internet/i)).toBeTruthy()
    expect(vi.mocked(startRemote)).not.toHaveBeenCalled()
  })

  it('shows the exposure confirmation right after picking a public provider, before any status poll catches up (C-new-1)', async () => {
    const remoteApi = await import('../../lib/remote-api')
    // Server settled on a NON-public provider — gating on effectiveProvider (server truth)
    // ALONE, as the first fix wave did, would read this stale value and skip the dialog for
    // up to the full 6s poll interval after a completely ordinary provider change. The union
    // gate must catch this via the local draft alone.
    vi.mocked(remoteApi.getRemoteStatus).mockResolvedValueOnce({
      provider: 'tailscale-serve',
      enabled: false,
      state: { kind: 'off' },
      url: '',
      ingressPort: null,
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /ngrok/i }))
    await userEvent.click(screen.getByRole('switch', { name: /remote access/i }))
    expect(await screen.findByText(/reachable from the internet/i)).toBeTruthy()
    expect(vi.mocked(startRemote)).not.toHaveBeenCalled()
  })

  it('names the provider the user actually selected in the confirmation, not a stale server value (I-new-1)', async () => {
    const remoteApi = await import('../../lib/remote-api')
    // Server still reports the OLD (also public) provider. Before this fix, the dialog was
    // fed `effectiveProvider` (server truth) unconditionally, so it correctly decided to show
    // but named the WRONG provider — a false claim about what is actually about to happen.
    vi.mocked(remoteApi.getRemoteStatus).mockResolvedValueOnce({
      provider: 'cloudflare-quick',
      enabled: false,
      state: { kind: 'off' },
      url: '',
      ingressPort: null,
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /ngrok/i }))
    await userEvent.click(screen.getByRole('switch', { name: /remote access/i }))
    expect(await screen.findByText(/ngrok will publish this daemon/i)).toBeTruthy()
    expect(screen.queryByText(/Cloudflare quick tunnel will publish/i)).toBeNull()
  })

  it('Check again for a stuck needs-setup/unavailable state actually retries the real start, not a no-op local check (I-new-2)', async () => {
    const apiLib = await import('../../lib/api')
    const remoteApi = await import('../../lib/remote-api')
    // Both the seeded local draft and the server-reported provider are the SAME non-public
    // id, so the exposure gate is definitively false and this test isolates exactly what
    // I-new-2 is about: before this fix, Check again only called the client-side
    // preflightRemote() (which mutates nothing server-side — the manager only re-evaluates
    // preflight at its own enable()/disable()), so a cleared prerequisite left the daemon
    // parked exactly where it was and the button visibly did nothing.
    vi.mocked(apiLib.getSettings).mockResolvedValueOnce({ remoteAccess: { provider: 'tailscale-serve' } } as Awaited<ReturnType<typeof apiLib.getSettings>>)
    vi.mocked(remoteApi.getRemoteStatus).mockResolvedValueOnce({
      provider: 'tailscale-serve',
      enabled: true,
      state: { kind: 'unavailable', reason: 'Tailscale is not installed on this machine.' },
      url: '',
      ingressPort: null,
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('button', { name: /check again/i }))
    await waitFor(() => expect(vi.mocked(startRemote)).toHaveBeenCalled())
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
    const api = await import('../../lib/remote-api')
    // C3 (final-review.md) made the toggle also consult server truth (status.provider), and
    // C-new-1's fix (final-review-fix-rereview.md) now refetches status right after a
    // provider-change save resolves — so this test's mount AND that post-save refetch both
    // need a consistent, settled Tailscale Serve status; `mockResolvedValue` (not `Once`)
    // covers both calls. This is the last test in the file, so there is nothing after it for
    // a non-Once override to leak into. Model the server having already caught up with a
    // Tailscale Serve selection — as it would in practice — rather than a stale
    // cloudflare-quick left over from this file's shared default mock: that default is not a
    // realistic settled state once a provider has actually been picked. The test's real
    // intent — Serve gets no confirmation — is unchanged.
    vi.mocked(api.getRemoteStatus).mockResolvedValue({
      provider: 'tailscale-serve',
      enabled: false,
      state: { kind: 'off' },
      url: '',
      ingressPort: null,
    })
    wrap(<RemoteAccessSection />)
    await userEvent.click(await screen.findByRole('radio', { name: /tailscale serve/i }))
    await userEvent.click(screen.getByRole('switch', { name: /remote access/i }))
    expect(screen.queryByText(/reachable from the internet/i)).toBeNull()
    await waitFor(() => expect(vi.mocked(startRemote)).toHaveBeenCalled())
  })
})
