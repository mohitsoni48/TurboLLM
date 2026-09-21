// `useModelActions().load` — one load, one pending state, however many surfaces are watching
// (C-7, C-8). The rest of this module is covered through the screens that use it.
//
// `useModelActions()` builds a fresh mutation observer per caller, so the Models page was blind
// to a load fired from the app-level confirmation dialog: its row kept an enabled Load button
// through a load that was already running, and a second click met the ADR-285 mutex with a 409.
//
// The second rule here is the one that makes the first one safe: the surface that fires a load
// often closes itself in the same click (ModelDetailDialog does), and React Query drops a
// `mutate()` callback whose observer has unmounted. So the state must be kept by the mutation
// itself — otherwise a load from the detail dialog would leave every Load button disabled for
// good.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useModelLoader } from './model-loader'
import { useJevLoadStore } from '../stores/jev-load'

const h = vi.hoisted(() => ({ loadModel: vi.fn(), toastError: vi.fn() }))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, loadModel: (...a: unknown[]) => h.loadModel(...a), track: vi.fn() }
})

vi.mock('../components/ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => h.toastError(...a), success: vi.fn() },
}))

const CHAT = { key: 'chat-key', name: 'Qwen3 8B' }

/** A load that stays in flight until the test says otherwise. */
function deferredLoad() {
  let settle: (() => void) | undefined
  h.loadModel.mockImplementation(() => new Promise<{ ok: true }>((resolve) => {
    settle = () => resolve({ ok: true })
  }))
  return () => settle?.()
}

function Firer() {
  const { requestLoad } = useModelLoader()
  return <button type="button" onClick={() => requestLoad(CHAT)}>Fire</button>
}

/** A second, independent `useModelLoader()` — the Models page, watching a load it did not start. */
function Watcher() {
  const { isPending, pendingKey } = useModelLoader()
  return <p>{isPending ? `loading ${pendingKey}` : 'idle'}</p>
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

beforeEach(() => {
  h.loadModel.mockReset()
  h.toastError.mockReset()
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null, pendingLoadKey: null, loadError: null })
})

describe('the pending load every surface reads', () => {
  it('reports a load to a surface that did not start it', async () => {
    const settle = deferredLoad()
    renderBoth()

    await userEvent.click(screen.getByRole('button', { name: 'Fire' }))

    await waitFor(() => expect(screen.getByText('loading chat-key')).toBeTruthy())
    settle()
    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy())
  })

  it('still lets go when the surface that started it closed itself first', async () => {
    const settle = deferredLoad()
    renderBoth()

    await userEvent.click(screen.getByRole('button', { name: 'Fire' }))
    await waitFor(() => expect(screen.getByText('loading chat-key')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Close the surface' }))
    settle()

    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy())
  })

  it('keeps the daemon\'s reason for the failure, against the model it was loading', async () => {
    const { ApiError } = await import('./api')
    h.loadModel.mockRejectedValue(new ApiError('engine_start_failed', 'vLLM is not installed.', 409))
    renderBoth()

    await userEvent.click(screen.getByRole('button', { name: 'Fire' }))

    await waitFor(() => expect(useJevLoadStore.getState().loadError).toEqual({
      key: 'chat-key',
      message: 'vLLM is not installed.',
    }))
    expect(screen.getByText('idle')).toBeTruthy()
  })
})
