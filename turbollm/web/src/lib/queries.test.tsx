// `useModelActions().load` — the whole life of a load lives on the mutation, not on the
// callbacks a surface passes to `mutate()`.
//
// Two rules, and the second is what makes the first one safe. One pending key, so every
// surface reports the load that is really running rather than its own mutation observer. And
// one failure report, raised from the mutation itself: React Query drops a `mutate()` callback
// whose observer has unmounted, and the surface that fires a load routinely closes itself in
// the same click — a Load button would stay disabled for good, and a failed load would say
// nothing at all.
//
// The rest of this module is covered through the screens that use it.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { useModelLoader } from './model-loader'
import { useModelActions } from './queries'
import { useJevLoadStore } from '../stores/jev-load'

const h = vi.hoisted(() => ({ loadModel: vi.fn(), toastError: vi.fn(), getActivity: vi.fn() }))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, loadModel: (...a: unknown[]) => h.loadModel(...a), track: vi.fn() }
})

vi.mock('./jev-api', () => ({ getActivity: () => h.getActivity() }))

vi.mock('../components/ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => h.toastError(...a), success: vi.fn() },
}))

const CHAT = { key: 'chat-key', name: 'Qwen3 8B' }

const JEV = {
  key: 'jev-key',
  name: 'qwen3.5 4b nli v2',
  jev: { architecture: 'Qwen3_5ForSequenceClassification' },
}

const NOTHING_RUNNING = { items: [], engineGenerating: false }

const ENGINE_REFUSAL = () => new ApiError('engine_start_failed', 'vLLM is not installed.', 409)

/** A load that stays in flight until the test answers it, either way. */
function deferredLoad() {
  let resolveLoad: (() => void) | undefined
  let rejectLoad: ((e: unknown) => void) | undefined
  h.loadModel.mockImplementation(() => new Promise<{ ok: true }>((resolve, reject) => {
    resolveLoad = () => resolve({ ok: true })
    rejectLoad = reject
  }))
  return { settle: () => resolveLoad?.(), refuse: (e: unknown) => rejectLoad?.(e) }
}

/** Every way a surface can start a load, from a component the test can close. */
function Firer() {
  const { requestLoad, confirmLoad } = useModelLoader()
  const actions = useModelActions()
  return (
    <>
      <button type="button" onClick={() => requestLoad(CHAT)}>Fire</button>
      <button type="button" onClick={() => requestLoad(JEV)}>Fire the Jev load</button>
      <button type="button" onClick={() => confirmLoad(JEV, {})}>Load anyway</button>
      <button type="button" onClick={() => actions.load.mutate({ key: 'own-key' })}>Fire its own load</button>
    </>
  )
}

/** A second, independent `useModelLoader()` — the Models page, watching a load it did not start. */
function Watcher() {
  const { isPending, pendingKey, loadError } = useModelLoader()
  return (
    <>
      <p>{isPending ? `loading ${pendingKey}` : 'idle'}</p>
      <p>{loadError ? `${loadError.key} failed: ${loadError.message}` : 'nothing has failed'}</p>
    </>
  )
}

function renderBoth() {
  function Both() {
    const [firerMounted, setFirerMounted] = useState(true)
    return (
      <>
        {firerMounted && <Firer />}
        <Watcher />
        <button type="button" onClick={() => setFirerMounted(false)}>Close the surface</button>
      </>
    )
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><Both /></QueryClientProvider>)
}

const press = (name: string) => userEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  h.loadModel.mockReset()
  h.toastError.mockReset()
  h.getActivity.mockReset().mockResolvedValue(NOTHING_RUNNING)
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null, pendingLoadKey: null, loadError: null })
})

describe('the pending load every surface reads', () => {
  it('reports a load to a surface that did not start it', async () => {
    const { settle } = deferredLoad()
    renderBoth()

    await press('Fire')

    await waitFor(() => expect(screen.getByText('loading chat-key')).toBeTruthy())
    settle()
    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy())
  })

  it('still lets go when the surface that started it closed itself first', async () => {
    const { settle } = deferredLoad()
    renderBoth()

    await press('Fire')
    await waitFor(() => expect(screen.getByText('loading chat-key')).toBeTruthy())
    await press('Close the surface')
    settle()

    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy())
  })

  // The daemon loads one model at a time (ADR-285): a second load is refused and settles at
  // once, and releasing the key there would re-enable every Load button mid-load.
  it('keeps the running load when a second one is refused under it', async () => {
    let releaseTheFirstLoad: (() => void) | undefined
    h.loadModel.mockImplementationOnce(() => new Promise<{ ok: true }>((resolve) => {
      releaseTheFirstLoad = () => resolve({ ok: true })
    }))
    h.loadModel.mockRejectedValueOnce(new ApiError('load_in_progress', 'Another model is loading.', 409))
    renderBoth()

    await press('Fire')
    await waitFor(() => expect(screen.getByText('loading chat-key')).toBeTruthy())
    await press('Fire its own load')

    await waitFor(() => expect(screen.getByText('own-key failed: Another model is loading.')).toBeTruthy())
    expect(screen.getByText('loading chat-key')).toBeTruthy()
    releaseTheFirstLoad?.()
    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy())
  })

  it('keeps the daemon\'s reason for the failure, against the model it was loading', async () => {
    h.loadModel.mockRejectedValue(ENGINE_REFUSAL())
    renderBoth()

    await press('Fire')

    await waitFor(() => expect(screen.getByText('chat-key failed: vLLM is not installed.')).toBeTruthy())
    expect(screen.getByText('idle')).toBeTruthy()
  })

  // A failure that never reached the daemon (the fetch itself threw) is still a failure the
  // surfaces have to agree about: the inline message must not stay empty while a toast is up.
  it('records a failure the daemon never got to report', async () => {
    h.loadModel.mockRejectedValue(new TypeError('Failed to fetch'))
    renderBoth()

    await press('Fire')

    await waitFor(() => expect(
      screen.getByText('chat-key failed: check the engine logs on the Engines screen.'),
    ).toBeTruthy())
  })
})

// QA E17, E31(c): a refused load is never a silent no-op, and the surface that fired it has
// usually navigated away by the time the engine gives up.
describe('a load that fails after its surface has gone', () => {
  it('tells the user once, and gives back the "is ready" claim the Jev load made', async () => {
    const { refuse } = deferredLoad()
    renderBoth()

    await press('Fire the Jev load')
    await waitFor(() => expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key'))
    await press('Close the surface')
    refuse(ENGINE_REFUSAL())

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1))
    expect(h.toastError).toHaveBeenCalledWith('Could not load model: vLLM is not installed.')
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('tells the user once about a chat load too', async () => {
    const { refuse } = deferredLoad()
    renderBoth()

    await press('Fire')
    await waitFor(() => expect(screen.getByText('loading chat-key')).toBeTruthy())
    await press('Close the surface')
    refuse(new TypeError('Failed to fetch'))

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1))
    expect(h.toastError).toHaveBeenCalledWith('Could not load model: check the engine logs on the Engines screen.')
  })

  it('tells the user once about a confirmed load too', async () => {
    const { refuse } = deferredLoad()
    renderBoth()

    await press('Load anyway')
    await waitFor(() => expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key'))
    await press('Close the surface')
    refuse(ENGINE_REFUSAL())

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1))
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  // The screens that load a model through their own mutation report their own failures; a
  // second report from here would say the same thing twice, in different words.
  it('says nothing for a load the screen that fired it reports itself', async () => {
    const { refuse } = deferredLoad()
    renderBoth()

    await press('Fire its own load')
    await waitFor(() => expect(screen.getByText('loading own-key')).toBeTruthy())
    refuse(ENGINE_REFUSAL())

    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy())
    expect(h.toastError).not.toHaveBeenCalled()
  })
})
