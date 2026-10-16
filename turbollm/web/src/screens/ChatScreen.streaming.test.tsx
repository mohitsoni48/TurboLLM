// What the chat screen does around a send and a running reply: Escape-to-stop, keeping the user's
// choices and text, and not re-rendering the conversation list per streamed token. Renders the
// REAL screen with the REAL sidebar and Thread settings dialog; data hooks and the SSE call are
// stubbed at their boundary (same discipline as ChatScreen.test.tsx).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import { toast } from '../components/ui/sonner'
import type { ChatSseEvent } from '../lib/chat-types'

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} })
  stopSpy.mockClear()
  regenerateSpy.mockClear()
  editMsgMutate.mockReset()
  sendCalls.length = 0
  continueCalls.length = 0
  convs.clear()
})

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' }, model: { key: 'm1', name: 'M1', ctx: 8192 } } }),
    useModels: () => ({ data: { models: [{ key: 'm1', name: 'M1', compatibleWithActiveEngine: true }] } }),
    useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false }, eject: { mutate: vi.fn(), isPending: false } }),
    useModelDetail: () => ({ data: undefined }),
    useEngines: () => ({ data: undefined }),
    useSettings: () => ({ query: { data: undefined } }),
    useSysInfo: () => ({ data: undefined }),
    useChatAgents: () => ({ data: [] }),
    useBuiltinAgentOverrides: () => ({ data: {} }),
  }
})

const stopSpy = vi.fn((_id: string) => Promise.resolve())
const regenerateSpy = vi.fn((_id: string) => Promise.resolve())
const editMsgMutate = vi.fn()
// Every ConvItem (and the sidebar itself, the screen and the settings dialog) calls this once per
// render — counting calls is counting re-renders.
let mutationHookCalls = 0
const convs = new Map<string, unknown>()
function conv(id: string) {
  if (!convs.has(id)) {
    convs.set(id, {
      id, title: 'T', systemPrompt: '', modelKey: 'm1', sampling: {}, expertMode: false, preserveThinking: true, skillIds: [],
      messages: [{ id: 'u0', convId: id, seq: 1, role: 'user', content: 'hi', reasoning: '', attachments: [], textAttachments: [], toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false }],
    })
  }
  return convs.get(id)
}
const now = new Date().toISOString()
const conversationList = {
  data: {
    conversations: Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`, title: `Conversation ${i}`, systemPrompt: '', modelKey: 'm1', sampling: {}, expertMode: false,
      preserveThinking: true, updatedAt: now, createdAt: now, folderId: null,
    })),
  },
}
const folderList = { data: { folders: [] } }
vi.mock('../lib/chat-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-queries')>()
  return {
    ...actual,
    useConversation: (id: string | null) => ({ data: id ? conv(id) : undefined }),
    useConversations: () => conversationList,
    useFolders: () => folderList,
    useConversationMutations: () => {
      mutationHookCalls++
      const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(() => Promise.resolve()), isPending: false })
      return {
        create: { ...idle(), mutateAsync: vi.fn(() => Promise.resolve({ id: 'new1' })) },
        update: idle(), compact: idle(), deleteMsg: idle(), editMsg: { ...idle(), mutate: editMsgMutate }, regenerate: { ...idle(), mutateAsync: regenerateSpy },
        stop: { ...idle(), mutateAsync: stopSpy }, undoCompaction: idle(), remove: idle(), moveToFolder: idle(),
        createFolder: idle(), deleteFolder: idle(), renameFolder: idle(),
      }
    },
  }
})

type Gen = (signal: AbortSignal) => AsyncGenerator<ChatSseEvent>
let nextGen: Gen
const sendCalls: unknown[][] = []
const continueCalls: unknown[][] = []
vi.mock('../lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-api')>()
  return {
    ...actual,
    sendMessage: (...args: unknown[]) => { sendCalls.push(args); return nextGen(args[2] as AbortSignal) },
    continueConversation: (...args: unknown[]) => { continueCalls.push(args); return nextGen(args[1] as AbortSignal) },
  }
})
vi.mock('../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/link-queries')>()
  return { ...actual, useLinks: () => ({ data: [] }), useRemoteModels: () => ({ data: [] }), useLinkStatus: () => ({ data: undefined }) }
})
vi.mock('../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})
vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))
// pdfjs-dist reads DOMMatrix at import time, which jsdom lacks; no PDF is attached here.
vi.mock('../lib/pdf-extract', () => ({ extractPdfText: vi.fn() }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('../components/ModelLoadMenu', () => ({ ModelLoadMenu: () => null }))
vi.mock('../components/ThinkingBudgetSlider', () => ({
  ThinkingBudgetSlider: ({ value, onChange }: { value: number; onChange: (v: number) => void }) =>
    <button type="button" data-testid="thinking-budget" data-value={String(value)} onClick={() => onChange(0)}>thinking</button>,
}))

const meta: ChatSseEvent = { event: 'meta', data: { assistantMessageId: 'a1', userMessageId: 'u1' } } as ChatSseEvent

/** A reply that starts and then runs until it is aborted. */
function hangingStream(): Gen {
  return async function* (signal) {
    yield meta
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  }
}
function quickStream(): Gen {
  return async function* () {
    yield meta
    yield { event: 'delta', data: { delta: 'ok' } } as ChatSseEvent
    yield { event: 'done', data: {} } as ChatSseEvent
  }
}
/** A reply whose frames the test hands over one at a time. */
function steppedStream() {
  const queue: ChatSseEvent[] = []
  let wake: (() => void) | undefined
  const gen: Gen = async function* () {
    for (;;) {
      while (queue.length) yield queue.shift()!
      await new Promise<void>((resolve) => { wake = resolve })
    }
  }
  const push = async (e: ChatSseEvent) => {
    await act(async () => {
      queue.push(e)
      wake?.()
      await new Promise((r) => setTimeout(r, 0))
    })
  }
  return { gen, push }
}

async function renderScreen(path: string, props: { embedded?: boolean; convIdOverride?: string } = {}) {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat/:convId" element={<ChatScreen {...props} />} />
          <Route path="/chat" element={<ChatScreen {...props} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree())
  // The stubbed useConversation is not a live query: this re-renders the screen after a test
  // swaps the conversation, as a refetch would.
  return { ...view, qc, refetched: () => view.rerender(tree()) }
}
function message(id: string, seq: number, role: 'user' | 'assistant', content: string) {
  return { id, convId: 'c1', seq, role, content, reasoning: '', attachments: [], textAttachments: [], toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false }
}
const showMessages = (messages: unknown[]) => { convs.set('c1', { ...(conv('c1') as object), messages }) }

const composer = () => screen.findByPlaceholderText(/^Message /) as Promise<HTMLTextAreaElement>
async function sendText(text: string) {
  const ta = await composer()
  fireEvent.change(ta, { target: { value: text } })
  await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
}
const pressCtrlN = () => act(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }))
})

describe('ChatScreen — Escape while a reply is running', () => {
  it('closing the Thread settings dialog with Escape does not stop the reply', async () => {
    nextGen = hangingStream()
    await renderScreen('/chat/c1')
    await sendText('write me an essay')
    await screen.findByTitle('Stop generation (Esc)')
    fireEvent.click(screen.getByTitle(/Thread settings/))
    const dialog = await screen.findByRole('dialog')
    await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stopSpy).not.toHaveBeenCalled()
    expect(screen.getByTitle('Stop generation (Esc)')).toBeInTheDocument()
  })

  it('Escape typed in a text field (the sidebar search) does not stop the reply', async () => {
    nextGen = hangingStream()
    await renderScreen('/chat/c1')
    await sendText('write me an essay')
    await screen.findByTitle('Stop generation (Esc)')
    await act(async () => { fireEvent.keyDown(screen.getByPlaceholderText('Search…'), { key: 'Escape' }) })
    expect(stopSpy).not.toHaveBeenCalled()
  })

  it('a plain Escape still stops it', async () => {
    nextGen = hangingStream()
    await renderScreen('/chat/c1')
    await sendText('write me an essay')
    await screen.findByTitle('Stop generation (Esc)')
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }) })
    expect(stopSpy).toHaveBeenCalledWith('c1')
  })

  it('an Escape from the composer the message was just sent from (now disabled) still stops it', async () => {
    nextGen = hangingStream()
    await renderScreen('/chat/c1')
    await sendText('write me an essay')
    await screen.findByTitle('Stop generation (Esc)')
    const ta = await composer()
    expect(ta).toBeDisabled()
    await act(async () => { fireEvent.keyDown(ta, { key: 'Escape' }) })
    expect(stopSpy).toHaveBeenCalledWith('c1')
  })
})

describe('ChatScreen — a new chat keeps the thinking budget picked before its first message', () => {
  it('sends the picked budget on the second turn too, and the control keeps showing it', async () => {
    nextGen = quickStream()
    await renderScreen('/chat')
    fireEvent.click(await screen.findByTestId('thinking-budget')) // Off (0), before the first message
    await sendText('first')
    await waitFor(() => expect(sendCalls).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTitle('Stop generation (Esc)')).toBeNull())
    expect(screen.getByTestId('thinking-budget').dataset.value).toBe('0')
    nextGen = quickStream()
    await sendText('second')
    await waitFor(() => expect(sendCalls).toHaveLength(2))
    expect(sendCalls[0][0]).toBe('new1')
    expect(sendCalls[0][6]).toBe(0)
    expect(sendCalls[1][0]).toBe('new1')
    expect(sendCalls[1][6]).toBe(0)
  })
})

describe('ChatScreen — a send the daemon refuses before storing it', () => {
  it('puts the typed message back in the composer (503 remote_unavailable)', async () => {
    nextGen = async function* () { throw new ApiError('remote_unavailable', "'rig' is not connected (unreachable).", 503) }
    await renderScreen('/chat/c1')
    const text = 'A long carefully written prompt that took five minutes to type'
    await sendText(text)
    await waitFor(async () => expect(await composer()).toHaveValue(text))
  })

  /** A 503 refusal that only arrives when the test releases it — the composer is enabled meanwhile. */
  function heldRefusal() {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const gen: Gen = async function* () {
      await gate
      throw new ApiError('remote_unavailable', "'rig' is not connected (unreachable).", 503)
    }
    const release = () => act(async () => { open(); await new Promise((r) => setTimeout(r, 20)) })
    return { gen, release }
  }

  it('puts it back in the chat this send just created', async () => {
    nextGen = async function* () { throw new ApiError('remote_unavailable', "'rig' is not connected (unreachable).", 503) }
    await renderScreen('/chat')
    await sendText('first message of a brand-new chat')
    await waitFor(async () => expect(await composer()).toHaveValue('first message of a brand-new chat'))
  })

  it('does not overwrite what was typed after Send while the refusal was in flight', async () => {
    const held = heldRefusal()
    nextGen = held.gen
    await renderScreen('/chat/c1')
    await sendText('the prompt that gets refused')
    fireEvent.change(await composer(), { target: { value: 'a newer thought' } })
    await held.release()
    expect(await composer()).toHaveValue('a newer thought')
  })

  it('does not restore into another conversation opened while the refusal was in flight', async () => {
    const held = heldRefusal()
    nextGen = held.gen
    await renderScreen('/chat/c1')
    await sendText('meant for c1 only')
    fireEvent.click(screen.getByText('Conversation 5'))
    await held.release()
    expect(await composer()).toHaveValue('')
  })

  it('does not put it back once the turn started (the daemon stored the message)', async () => {
    nextGen = async function* () {
      yield meta
      yield { event: 'error', data: { message: 'engine crashed' } } as ChatSseEvent
    }
    await renderScreen('/chat/c1')
    await sendText('stored then failed')
    await waitFor(() => expect(sendCalls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(await composer()).toHaveValue('')
  })
})

describe('ChatScreen — Ctrl/Cmd+N', () => {
  it('starting a new chat while a message is being edited leaves the new chat usable', async () => {
    await renderScreen('/chat/c1')
    fireEvent.click(await screen.findByTitle('Edit'))
    expect(await composer()).toBeDisabled()
    await pressCtrlN()
    expect(screen.queryByText('hi')).toBeNull() // on the new chat now
    expect(await composer()).not.toBeDisabled()
  })

  it('does nothing in the embedded routine-run view, which keeps showing the run', async () => {
    await renderScreen('/chat', { embedded: true, convIdOverride: 'c1' })
    expect(await screen.findByText('hi')).toBeInTheDocument()
    await pressCtrlN()
    expect(screen.getByText('hi')).toBeInTheDocument()
  })
})

describe('ChatScreen — editing a message', () => {
  it('a version switch that takes the message being edited off the shown branch leaves the composer usable', async () => {
    const before = [message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python'), message('u2', 4, 'user', 'How do I install it?'), message('a2', 5, 'assistant', 'pip ...')]
    showMessages(before)
    const view = await renderScreen('/chat/c1')
    await act(async () => { fireEvent.keyDown(await composer(), { key: 'ArrowUp' }) }) // edit the last question
    expect(await composer()).toBeDisabled()
    // Switching the first reply to its other version froze u2 (and its reply); the refetch shows
    // the branch without it, so its Save and Cancel are gone.
    showMessages([before[0], message('a1b', 3, 'assistant', 'Use Rust')])
    await act(async () => { view.refetched() })
    expect(screen.queryByText('How do I install it?')).toBeNull()
    await waitFor(async () => expect(await composer()).not.toBeDisabled())
  })

  it('a Save & Resend refused as stale (409) refetches, shows why and keeps the typed text in the composer', async () => {
    const stale = 'This message is no longer on the shown branch: the chat changed in another tab or device.'
    showMessages([message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python')])
    editMsgMutate.mockImplementation((_v: unknown, opts: { onError: (e: unknown) => void }) => opts.onError(new ApiError('stale_message', stale, 409)))
    const toastError = vi.spyOn(toast, 'error')
    try {
      const view = await renderScreen('/chat/c1')
      const invalidate = vi.spyOn(view.qc, 'invalidateQueries')
      await act(async () => { fireEvent.keyDown(await composer(), { key: 'ArrowUp' }) })
      fireEvent.change(screen.getByDisplayValue('Recommend a language'), { target: { value: 'Recommend a typed language, carefully' } })
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      expect(toastError).toHaveBeenCalledWith(stale)
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation', 'c1'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['message-variants'] })
      await waitFor(async () => expect(await composer()).toHaveValue('Recommend a typed language, carefully'))
      expect(await composer()).not.toBeDisabled()
      expect(continueCalls).toHaveLength(0)
    } finally {
      toastError.mockRestore()
    }
  })

  // The edit closed before the request, so any refusal but stale_message lost the typed text:
  // reopening the edit starts again from the message.
  it('a Save & Resend refused for another reason (409 generation_in_flight) keeps the edit open with the typed text and says why', async () => {
    const busy = 'Stop generation first.'
    showMessages([message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python')])
    editMsgMutate.mockImplementation((_v: unknown, opts: { onError: (e: unknown) => void }) => opts.onError(new ApiError('generation_in_flight', busy, 409)))
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      await act(async () => { fireEvent.keyDown(await composer(), { key: 'ArrowUp' }) })
      fireEvent.change(screen.getByDisplayValue('Recommend a language'), { target: { value: 'Recommend a typed language, carefully' } })
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      expect(toastError).toHaveBeenCalledWith(busy)
      expect(screen.getByDisplayValue('Recommend a typed language, carefully')).toBeInTheDocument()
      expect(continueCalls).toHaveLength(0)

      // Saved again once the daemon takes it, the edit closes and the question is answered.
      editMsgMutate.mockImplementation((_v: unknown, opts: { onSuccess: () => void }) => opts.onSuccess())
      nextGen = quickStream()
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      expect(editMsgMutate).toHaveBeenLastCalledWith({ convId: 'c1', msgId: 'u1', content: 'Recommend a typed language, carefully' }, expect.anything())
      expect(screen.queryByText('Save & Resend')).toBeNull()
      await waitFor(() => expect(continueCalls).toHaveLength(1))
    } finally {
      toastError.mockRestore()
    }
  })
})

describe('ChatScreen — Regenerate', () => {
  // /regenerate (deactivate the reply) and then /continue: a /continue the daemon refused (a
  // Turbo Link machine asleep, the model gone) left the reply deactivated with no way back.
  it('is one /continue that sets the old reply aside itself, with no /regenerate before it', async () => {
    showMessages([message('u1', 1, 'user', 'hi'), message('a1', 2, 'assistant', 'hello')])
    nextGen = quickStream()
    await renderScreen('/chat/c1')
    fireEvent.click(await screen.findByTitle('Regenerate'))
    await waitFor(() => expect(continueCalls).toHaveLength(1))
    expect(continueCalls[0][0]).toBe('c1')
    expect(continueCalls[0][5]).toBe('a1')
    expect(regenerateSpy).not.toHaveBeenCalled()
  })

  // /continue { regenerate } named no reply, so a tab still showing a1 last, after another tab
  // added a turn, replaced that turn's reply, one it never showed.
  it('names the reply clicked, and a stale refusal (409) refetches and shows why', async () => {
    const stale = 'This reply is no longer the last message on the shown branch: the chat changed in another tab or device.'
    showMessages([message('u1', 1, 'user', 'hi'), message('a1', 2, 'assistant', 'hello')])
    nextGen = async function* () { throw new ApiError('stale_message', stale, 409) }
    const toastError = vi.spyOn(toast, 'error')
    try {
      const view = await renderScreen('/chat/c1')
      const invalidate = vi.spyOn(view.qc, 'invalidateQueries')
      await act(async () => { fireEvent.click(await screen.findByTitle('Regenerate')) })
      expect(continueCalls).toHaveLength(1)
      expect(continueCalls[0][5]).toBe('a1')
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(stale))
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation', 'c1'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['message-variants'] })
    } finally {
      toastError.mockRestore()
    }
  })
})

describe('ChatScreen — streaming a reply', () => {
  it('does not re-render the conversation list on every token', async () => {
    const stream = steppedStream()
    nextGen = stream.gen
    await renderScreen('/chat/c1')
    expect(await screen.findByText('Conversation 29')).toBeInTheDocument()
    await sendText('go')
    await stream.push(meta)
    await stream.push({ event: 'delta', data: { delta: 'Hello' } } as ChatSseEvent)
    mutationHookCalls = 0
    const TOKENS = 5
    for (let i = 0; i < TOKENS; i++) await stream.push({ event: 'delta', data: { delta: ' tok' } } as ChatSseEvent)
    expect(screen.getByText(/Hello tok tok tok tok tok/)).toBeInTheDocument()
    // The screen and its header re-render per token; the sidebar and its 30 rows must not (each
    // row alone would add one call per token).
    expect(mutationHookCalls / TOKENS).toBeLessThan(5)
  })
})
