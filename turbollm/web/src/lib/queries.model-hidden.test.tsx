// `useModelActions().setHidden`: hiding a model by hand (Models → Library "Hide") asks the daemon, which keeps the flag,
// and marks the model in the cached list at once, so the row leaves the Library and every picker without waiting for
// the next poll.
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys, useModelActions } from './queries'
import type { ModelEntry, ModelsList } from './types'

const h = vi.hoisted(() => ({ setModelHidden: vi.fn(async (key: string, hidden: boolean) => ({ key, hidden })), getModels: vi.fn() }))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, setModelHidden: h.setModelHidden, getModels: h.getModels, track: vi.fn() }
})

const LIST: ModelsList = {
  models: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }] as ModelEntry[],
  scanning: false,
  lastScanAt: '',
} as ModelsList

describe('useModelActions().setHidden', () => {
  it('asks the daemon and marks the model hidden in the cached list, then unhides it the same way', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(queryKeys.models, LIST)
    h.getModels.mockImplementation(async () => qc.getQueryData(queryKeys.models))
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useModelActions(), { wrapper })

    await act(async () => { await result.current.setHidden.mutateAsync({ key: 'a', hidden: true }) })
    expect(h.setModelHidden).toHaveBeenCalledWith('a', true)
    const hidden = qc.getQueryData<ModelsList>(queryKeys.models)!.models
    expect(hidden.map((m) => [m.key, m.hidden])).toEqual([['a', true], ['b', undefined]])

    await act(async () => { await result.current.setHidden.mutateAsync({ key: 'a', hidden: false }) })
    expect(h.setModelHidden).toHaveBeenLastCalledWith('a', false)
    await waitFor(() => expect(qc.getQueryData<ModelsList>(queryKeys.models)!.models[0].hidden).toBe(false))
  })
})
