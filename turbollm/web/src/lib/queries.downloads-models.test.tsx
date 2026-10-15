// The models list must pick up the scan a finished download triggers, even when nothing keeps it polling. With no
// model loaded, its poll stops once every finished download is accounted for by a library row — and the shards 2..N
// of a split GGUF (or an MLX/vLLM model's component files) are accounted for by the split's row as soon as that row
// exists, while it is still flagged incomplete. Without a nudge from the downloads poll, the row stayed
// "incomplete or unreadable" (Load disabled) after the last shard finished, until the user navigated or rescanned.
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDownloads, useModels } from './queries'
import { modelsRefetchInterval } from './models-poll'
import type { DownloadsList, ModelsList } from './types'

const SHARD1 = '/m/q/Qwen3-235B-Q4_K_M-00001-of-00002.gguf'
const SHARD2 = '/m/q/Qwen3-235B-Q4_K_M-00002-of-00002.gguf'

const h = vi.hoisted(() => ({
  downloads: null as unknown as DownloadsList,
  models: [] as ModelsList[],
  getModels: vi.fn(),
}))

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  // Each call returns the next queued scan result; the last one repeats.
  getModels: () => {
    h.getModels()
    return Promise.resolve(h.models.length > 1 ? h.models.shift()! : h.models[0])
  },
  listDownloads: () => Promise.resolve(h.downloads),
}))

const row = (incomplete: boolean) => ({ key: 'k', name: 'Qwen3 235B', path: SHARD1, dir: '/m/q', incomplete, loaded: false })
const scan = (incomplete: boolean, scanning: boolean, lastScanAt: string) =>
  ({ models: [row(incomplete)], scanning, lastScanAt }) as unknown as ModelsList
const dl = (shard2: 'downloading' | 'done') =>
  ({ downloads: [{ id: 'd1', status: 'done', dest: SHARD1 }, { id: 'd2', status: shard2, dest: SHARD2 }] }) as unknown as DownloadsList

beforeEach(() => {
  h.getModels.mockReset()
})

describe('useDownloads → useModels', () => {
  it('refetches the models list when a download newly finishes, so the last shard lands in the library', async () => {
    // Shard 1 is in, shard 2 still downloading: the split's row exists, flagged incomplete.
    h.downloads = dl('downloading')
    h.models = [scan(true, false, 'scan-1')]
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => ({ models: useModels(), downloads: useDownloads() }), { wrapper })
    await waitFor(() => expect(result.current.models.data?.lastScanAt).toBe('scan-1'))
    await waitFor(() => expect(result.current.downloads.data).toBeDefined())
    const callsBefore = h.getModels.mock.calls.length

    // Shard 2 finishes. The daemon flips its record to `done` and starts a rescan in the same tick, so the list
    // reads `scanning` until the pass that sees shard 2 has landed.
    h.downloads = dl('done')
    h.models = [scan(true, true, 'scan-1'), scan(false, false, 'scan-2')]
    // By design the models poll itself is quiet here: nothing is loaded, and shard 2 is accounted for by the row.
    expect(modelsRefetchInterval(scan(true, false, 'scan-1'), undefined, h.downloads)).toBe(false)

    await qc.refetchQueries({ queryKey: ['downloads'] })

    await waitFor(() => expect(result.current.models.data?.lastScanAt).toBe('scan-2'), { timeout: 4000 })
    expect(result.current.models.data?.models[0].incomplete).toBe(false)
    expect(h.getModels.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('does not refetch the models list when no download changed state', async () => {
    h.downloads = dl('done')
    h.models = [scan(false, false, 'scan-1')]
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => ({ models: useModels(), downloads: useDownloads() }), { wrapper })
    await waitFor(() => expect(result.current.models.data).toBeDefined())
    await waitFor(() => expect(result.current.downloads.data).toBeDefined())
    const callsBefore = h.getModels.mock.calls.length

    await qc.refetchQueries({ queryKey: ['downloads'] })
    await new Promise((r) => setTimeout(r, 50))
    expect(h.getModels.mock.calls.length).toBe(callsBefore)
  })
})
