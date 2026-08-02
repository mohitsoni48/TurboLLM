import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRoutineMutations } from './routine-queries'
import { ApiError } from './api'

const toastError = vi.fn()
vi.mock('../components/ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

let deleteImpl: (id: string) => Promise<{ ok: true }> = async () => ({ ok: true })
vi.mock('./routine-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./routine-api')>()
  return { ...actual, deleteRoutine: (id: string) => deleteImpl(id) }
})

let qc: QueryClient
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  toastError.mockReset()
  deleteImpl = async () => ({ ok: true })
})

/** The `remove` mutation deletes a routine that a confirm card is discarding, and
 *  RoutineConfirmCard's `cancel()` fires it and then synchronously calls `props.onCancelled()`.
 *  A consumer that unmounts the card in response (a transcript replacing the tool-call record, a
 *  wizard advancing) tears the observer down mid-request. A per-`mutate` `onError` is dropped in
 *  that window — TanStack Query v5 only dispatches those while the observer has listeners — which
 *  is why the toast is defined on the mutation itself. These tests are the proof of that placement;
 *  the component test cannot reach it, since it mocks `useRoutineMutations` wholesale. */
describe('useRoutineMutations — remove surfaces its failures independently of the caller', () => {
  // `await act(async ...)` rather than a sync act: Mutation#execute reaches the mutationFn only
  // after an await, so a synchronous act returns before the request has actually started.
  it('toasts a failed DELETE even when the component that fired it unmounted first', async () => {
    let reject: (e: unknown) => void = () => { throw new Error('the DELETE never started') }
    deleteImpl = () => new Promise<{ ok: true }>((_resolve, r) => { reject = r })
    // The control: a caller-supplied handler, exactly the shape RoutineConfirmCard used to pass.
    const perCallOnError = vi.fn()

    const { result, unmount } = renderHook(() => useRoutineMutations(), { wrapper })
    await act(async () => { result.current.remove.mutate('r1', { onError: perCallOnError }) })

    // The consumer's onCancelled removed the card while the DELETE is still in flight.
    unmount()
    // ...and only now does the server answer 401. The pending row is still in the database, and
    // this toast is the only auth feedback the feature produces (routine-api.ts's header).
    reject(new ApiError('unauthorized', 'A valid API key is required.', 401))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Not authorized: A valid API key is required.'))
    // ...and the reason it cannot live on the caller: MutationObserver gates per-`mutate`
    // callbacks on `hasListeners()`, which is false the moment the card unmounts.
    expect(perCallOnError).not.toHaveBeenCalled()
  })

  it('toasts exactly once when the caller stays mounted — no double-toast from two callback levels', async () => {
    deleteImpl = () => Promise.reject(new ApiError('http_error', 'Routine is locked.', 500))

    const { result } = renderHook(() => useRoutineMutations(), { wrapper })
    await act(async () => { result.current.remove.mutate('r1') })

    await waitFor(() => expect(result.current.remove.isError).toBe(true))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Routine is locked.')
  })

  it('says nothing on a successful discard', async () => {
    const { result } = renderHook(() => useRoutineMutations(), { wrapper })
    await act(async () => { result.current.remove.mutate('r1') })
    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true))
    expect(toastError).not.toHaveBeenCalled()
  })
})
