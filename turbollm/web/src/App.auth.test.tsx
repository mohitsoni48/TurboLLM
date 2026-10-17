// App's API key prompt (useKeyPrompt): when it opens, what "Connect" and "Not now" do. A host-only
// setting or "Always Allow" refused for want of a key (auth-signal.ts's host-key signal) opens it
// while everything else works, so no later request tells a right key from a wrong one: the
// refused change is made again only when the user makes it. It used to close on any pasted key,
// so AuthGate's "That key was rejected" never showed and the next attempt was refused again.
//
// Drives the real hook, as App does, over a /status that answers (requireApiKey off), rather than
// the whole <App/>, for the reason App.redirects.test.tsx gives.
import { useState, type ReactNode } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKeyPrompt } from './App'
import { ApiError, createModelPreset, setPrimaryModelDir } from './lib/api'
import { clearCodeAuthNeeded, clearHostKeyNeeded, isHostKeyNeeded, markHostKeyNeeded } from './lib/auth-signal'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './components/ui/alert-dialog'
import { RequestDetail } from './screens/engines/RequestDetail'
import type { RequestLogEntry } from './lib/types'

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return { ...actual, track: vi.fn() }
})

const STATUS_OK = { isError: false, error: null, isSuccess: true }
const STATUS_401 = { isError: true, error: new ApiError('unauthorized', 'A valid API key is required for non-local access.', 401), isSuccess: false }

function Host({ status }: { status: typeof STATUS_OK | typeof STATUS_401 }) {
  return <>{useKeyPrompt(status).prompt}</>
}

function mount(status: typeof STATUS_OK | typeof STATUS_401 = STATUS_OK, beside?: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      {beside}
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

// A refusal can come from a request made inside a Radix modal that stays open under the prompt:
// Models > Folders (Set primary, Remove), the preset "Save preset" dialog (its Save keeps it open
// on an error), the Build guide's toolchain Re-check, and the Requests drawer. Such a modal sets
// body pointer-events: none, hides the rest of the page from the accessibility tree and keeps
// focus inside itself, so the prompt, a plain div in App's tree, showed but took no click, focus
// or typing, and its buttons were hidden: only Escape or Back, closing the modal, got out. These
// run the real api.ts client over a fetch that refuses the modal's request with 403
// api_key_required, so the prompt opens on the real signal, beside the app's own Dialog,
// AlertDialog and the real Requests drawer.
describe('the API key prompt over an open modal', () => {
  /** fetchMock's host gate for GET /api/v1/keys; 403 api_key_required for anything else. */
  const refusingFetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/v1/keys') return fetchMock(path, init)
    const error = { code: 'api_key_required', message: 'This change requires a valid API key.' }
    return new Response(JSON.stringify({ error }), { status: 403 })
  })
  beforeEach(() => {
    refusingFetch.mockClear()
    vi.stubGlobal('fetch', refusingFetch)
  })

  /** Models > Folders: a modal Dialog that stays open when Set primary is refused. */
  const folders = (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent>
        <DialogTitle>Model folders</DialogTitle>
        <DialogDescription>TurboLLM scans these folders for GGUF models.</DialogDescription>
        <Button onClick={() => void setPrimaryModelDir('/models/b').catch(() => {})}>Set primary</Button>
      </DialogContent>
    </Dialog>
  )

  it('a refusal from inside a modal dialog opens a prompt that takes focus, typing and Connect', async () => {
    mount(STATUS_OK, folders)
    await userEvent.click(screen.getByRole('button', { name: 'Set primary' }))
    expect(await screen.findByRole('alertdialog', { name: 'API key required' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    const input = screen.getByPlaceholderText('Paste API key')
    await waitFor(() => expect(document.activeElement).toBe(input))
    await connectWith('tllm-right')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(isHostKeyNeeded()).toBe(false)
    expect(localStorage.getItem('tllm.authToken')).toBe('tllm-right')
    // The dialog the refusal came from is still there, for the change to be made again.
    expect(screen.getByRole('dialog', { name: 'Model folders' })).toBeTruthy()
  })

  it('over the preset "Save preset" alert dialog, Escape and "Not now" put off the prompt alone, and focus goes back to its Save', async () => {
    mount(STATUS_OK, (
      <AlertDialog open onOpenChange={() => {}}>
        <AlertDialogContent>
          <AlertDialogTitle>Save preset</AlertDialogTitle>
          <AlertDialogDescription>Name this load config.</AlertDialogDescription>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              void createModelPreset('qwen-7b', { name: 'Fast', profile: { extraArgs: ['--mlock'] } }).catch(() => {})
            }}
          >
            Save
          </AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    ))
    const save = screen.getByRole('button', { name: 'Save' })
    await userEvent.click(save)
    await screen.findByRole('alertdialog', { name: 'API key required' })
    const input = screen.getByPlaceholderText('Paste API key')
    await userEvent.type(input, 'tllm-')
    expect(input).toHaveValue('tllm-')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'API key required' })).toBeNull())
    expect(isHostKeyNeeded()).toBe(false)
    expect(screen.getByRole('alertdialog', { name: 'Save preset' })).toBeTruthy()
    // Not <body>: the prompt has no trigger for Radix to focus.
    await waitFor(() => expect(document.activeElement).toBe(save))

    await userEvent.click(save)
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'API key required' })).toBeNull())
    expect(screen.getByRole('alertdialog', { name: 'Save preset' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(save))
  })

  it('a 401 over an open modal still takes the key, and Escape does not put it off', async () => {
    mount(STATUS_401, folders)
    await screen.findByRole('alertdialog', { name: 'API key required' })
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog', { name: 'API key required' })).toBeTruthy()
    const input = screen.getByPlaceholderText('Paste API key')
    await userEvent.type(input, 'tllm-mine')
    expect(input).toHaveValue('tllm-mine')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(localStorage.getItem('tllm.authToken')).toBe('tllm-mine')
  })

  it('a captured body refused in the Requests drawer opens a prompt that can be used over it, and "Not now" leaves the row\'s own copy there', async () => {
    const row: RequestLogEntry = {
      id: 'r1', ts: 0, source: 'anthropic', harness: 'claude_code', codeSessionId: 's1', modelKey: 'qwen3-8b',
      remote: null, stream: true, params: {}, counts: { messages: 2, tools: 0, systemChars: 0 }, status: 200,
      error: null, timings: { ttftMs: 120, durationMs: 900 }, tokens: { prompt: 10, completion: 5, promptTps: null, genTps: null },
      finishReason: 'stop', bodies: null,
    }
    function Requests() {
      const [entry, setEntry] = useState<RequestLogEntry | null>(row)
      return <RequestDetail entry={entry} onClose={() => setEntry(null)} captureBodies />
    }
    mount(STATUS_OK, <Requests />)
    await screen.findByRole('alertdialog', { name: 'API key required' })
    expect(refusingFetch.mock.calls[0][0]).toBe('/api/v1/requests/r1')
    const input = screen.getByPlaceholderText('Paste API key')
    await waitFor(() => expect(document.activeElement).toBe(input))
    await userEvent.type(input, 'tllm-')
    expect(input).toHaveValue('tllm-')
    // The drawer, a non-modal sheet like every other one, stays open under the prompt (hidden from
    // screen readers while the prompt is up) when the prompt takes focus...
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent('qwen3-8b')
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    // ...so once the prompt is put off, it shows the row's own copy, and why the bodies are not there.
    const drawer = screen.getByRole('dialog', { name: 'qwen3-8b' })
    expect(within(drawer).getByText('Finish reason')).toBeTruthy()
    await userEvent.click(within(drawer).getByRole('button', { name: 'request' }))
    expect(within(drawer).getByText(/^This change requires a valid API key\. Enter your key in the API key prompt/)).toBeTruthy()
  })
})
