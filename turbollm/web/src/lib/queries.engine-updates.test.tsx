/**
 * The update badge must clear when an install SETTLES, not when the 202 returns:
 * the engineUpdates snapshot taken at the 202 still shows the old installed tag.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getEngineUpdates = vi.fn()
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getEngineUpdates: (...a: unknown[]) => getEngineUpdates(...a) }))

import { useEngineUpdates } from './queries'

function setup(initial: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(({ provisioning }) => useEngineUpdates(provisioning), { wrapper, initialProps: { provisioning: initial } })
}

describe('useEngineUpdates', () => {
  beforeEach(() => {
    getEngineUpdates.mockReset()
    getEngineUpdates.mockResolvedValue({ updates: {}, policies: {} })
  })

  it('refetches once when the provision run settles, with no poll window', async () => {
    const view = setup(true)
    await waitFor(() => expect(getEngineUpdates).toHaveBeenCalledTimes(1))

    view.rerender({ provisioning: false })

    await waitFor(() => expect(getEngineUpdates).toHaveBeenCalledTimes(2))
  })

  it('does not refetch while the run is still active or was never active', async () => {
    const view = setup(false)
    await waitFor(() => expect(getEngineUpdates).toHaveBeenCalledTimes(1))

    view.rerender({ provisioning: false })
    await new Promise((r) => setTimeout(r, 50))

    expect(getEngineUpdates).toHaveBeenCalledTimes(1)
  })
})
