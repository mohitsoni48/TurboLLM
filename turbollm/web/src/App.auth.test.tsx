// App's API key prompt (useKeyPrompt): when it opens, what "Connect" and "Not now" do. A host-only
// setting or "Always Allow" refused for want of a key (auth-signal.ts's host-key signal) opens it
// while everything else works, so no later request tells a right key from a wrong one: the
// refused change is made again only when the user makes it. It used to close on any pasted key,
// so AuthGate's "That key was rejected" never showed and the next attempt was refused again.
//
// Drives the real hook, as App does, over a /status that answers (requireApiKey off), rather than
// the whole <App/>, for the reason App.redirects.test.tsx gives.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKeyPrompt } from './App'
import { ApiError } from './lib/api'
import { clearCodeAuthNeeded, clearHostKeyNeeded, isHostKeyNeeded, markHostKeyNeeded } from './lib/auth-signal'

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return { ...actual, track: vi.fn() }
})

const STATUS_OK = { isError: false, error: null, isSuccess: true }
const STATUS_401 = { isError: true, error: new ApiError('unauthorized', 'A valid API key is required for non-local access.', 401), isSuccess: false }

function Host({ status }: { status: typeof STATUS_OK | typeof STATUS_401 }) {
  return <>{useKeyPrompt(status).prompt}</>
}

function mount(status: typeof STATUS_OK | typeof STATUS_401 = STATUS_OK) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Host status={status} />
    </QueryClientProvider>,
  )
}

/** The daemon's GET /api/v1/keys behind hostGate: 200 for `tllm-right`, 403 for any other key. */
const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
  const key = (init?.headers as Record<string, string> | undefined)?.['X-TurboLLM-Auth']
  if (key === 'tllm-right') return new Response(JSON.stringify({ keys: [] }), { status: 200 })
  const error = { code: 'forbidden', message: 'API keys are only visible from this machine until "Require an API key" is turned on.' }
  return new Response(JSON.stringify({ error }), { status: 403 })
})

async function connectWith(key: string) {
  const input = screen.getByPlaceholderText('Paste API key')
  await userEvent.clear(input)
  await userEvent.type(input, key)
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
}

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  localStorage.removeItem('tllm.authToken')
  clearHostKeyNeeded()
  clearCodeAuthNeeded()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the API key prompt a host-only setting opens', () => {
  it('checks the pasted key through the host gate: a refused one keeps it up with its hint, the right one closes it', async () => {
    mount()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    act(() => markHostKeyNeeded())
    expect(await screen.findByRole('alertdialog', { name: 'API key required' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()

    await connectWith('tllm-wrong')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/v1/keys')
    expect((init?.headers as Record<string, string>)['X-TurboLLM-Auth']).toBe('tllm-wrong')
    await act(async () => {})
    expect(screen.getByRole('alertdialog', { name: 'API key required' })).toBeTruthy()
    expect(screen.getByText(/That key was rejected/)).toBeTruthy()
    expect(isHostKeyNeeded()).toBe(true)

    await connectWith('tllm-right')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(isHostKeyNeeded()).toBe(false)
    expect(localStorage.getItem('tllm.authToken')).toBe('tllm-right')
  })

  it('"Not now" puts it off without a key or a request', async () => {
    mount()
    act(() => markHostKeyNeeded())
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(isHostKeyNeeded()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a 401 from /status opens it without "Not now", and its key is judged by /status, not the host gate', async () => {
    mount(STATUS_401)
    expect(await screen.findByRole('alertdialog', { name: 'API key required' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
    await connectWith('tllm-wrong')
    await act(async () => {})
    expect(fetchMock.mock.calls.map(([p]) => p)).not.toContain('/api/v1/keys')
    expect(screen.getByRole('alertdialog', { name: 'API key required' })).toBeTruthy()
  })
})
