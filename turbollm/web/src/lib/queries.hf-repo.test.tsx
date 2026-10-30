// An open HF repo panel must notice a finished download. Its `downloaded`/`localKey` come from
// the daemon matching the repo's files against the scanned library, and `useHfRepo` only
// re-polls while `verifying` — so the models list's next scan pass is what has to refresh it.
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHfRepo, useModels } from './queries'

const h = vi.hoisted(() => ({ lastScanAt: 'scan-1', downloaded: false, hfRepo: vi.fn() }))

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  getModels: async () => ({ models: [], scanning: false, lastScanAt: h.lastScanAt }),
  hfRepo: (repo: string) => h.hfRepo(repo),
}))

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const view = renderHook(() => ({ models: useModels(), repo: useHfRepo('o/m-GGUF') }), { wrapper })
  return { qc, ...view }
}

beforeEach(() => {
  h.lastScanAt = 'scan-1'
  h.downloaded = false
  h.hfRepo.mockReset()
  h.hfRepo.mockImplementation(async (repo: string) => ({
    repo,
    files: [{ name: 'm-Q4_K_M.gguf', downloaded: h.downloaded }],
    verifying: false,
  }))
})

describe('useModels → an open HF repo panel', () => {
  it('refetches the repo detail once a new scan pass lands (a download finished)', async () => {
    const { qc, result } = renderPanel()
    await waitFor(() => expect(result.current.repo.data?.files[0].downloaded).toBe(false))
    await waitFor(() => expect(result.current.models.data?.lastScanAt).toBe('scan-1'))

    // The download completed and the daemon rescanned.
    h.downloaded = true
    h.lastScanAt = 'scan-2'
    await qc.refetchQueries({ queryKey: ['models'] })

    await waitFor(() => expect(result.current.repo.data?.files[0].downloaded).toBe(true))
    expect(h.hfRepo).toHaveBeenCalledTimes(2)
  })

  it('leaves the repo detail alone while the library is unchanged', async () => {
    const { qc, result } = renderPanel()
    await waitFor(() => expect(result.current.repo.data).toBeDefined())
    await waitFor(() => expect(result.current.models.data).toBeDefined())
    await qc.refetchQueries({ queryKey: ['models'] })
    expect(h.hfRepo).toHaveBeenCalledTimes(1)
  })
})
