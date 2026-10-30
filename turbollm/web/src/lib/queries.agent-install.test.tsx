// `useAgentAvailability`: an agent CLI install runs on in the daemon when the page that started it
// closes or reloads, so a page that comes back has no request of its own to wait on. It polls
// while the daemon reports an install running, to learn when it ends, and stops once none is.
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentAvailability } from './queries'

const h = vi.hoisted(() => ({ getAgentAvailability: vi.fn() }))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, getAgentAvailability: h.getAgentAvailability }
})

const agents = (claude: { installed: boolean; installing: boolean }) => ({
  agents: [
    { id: 'claude', installCommand: 'npm install -g @anthropic-ai/claude-code', ...claude },
    { id: 'pi', installed: true, installCommand: 'npm install -g @earendil-works/pi-coding-agent', installing: false },
  ],
})

afterEach(() => { vi.useRealTimers() })

describe('useAgentAvailability', () => {
  it('polls while the daemon reports an install running, and stops once it has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    h.getAgentAvailability
      .mockResolvedValueOnce(agents({ installed: false, installing: true }))
      .mockResolvedValueOnce(agents({ installed: false, installing: true }))
      .mockResolvedValue(agents({ installed: true, installing: false }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useAgentAvailability(), { wrapper })

    await waitFor(() => expect(result.current.data?.agents[0].installing).toBe(true))
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(result.current.data?.agents[0].installed).toBe(true))
    const calls = h.getAgentAvailability.mock.calls.length
    expect(calls).toBe(3)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.getAgentAvailability.mock.calls.length, 'no install running: no more polling').toBe(calls)
  })
})
