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
  activateCalls.length = 0
  variants = []
  compactingConv = null
  convs.clear()
  engineState = 'running'
  skills = []
  updateMutateAsync = vi.fn(() => Promise.resolve())
})

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: engineState }, model: { key: 'm1', name: 'M1', ctx: 8192 } } }),
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

/** 'stopped' = no model ready to answer. */
let engineState = 'running'
/** What GET /skills lists. */
let skills: unknown[] = []
/** mut.update's mutateAsync (PATCH /conversations/:id, which a '/skill' send turns the skill on with). */
let updateMutateAsync = vi.fn((): Promise<unknown> => Promise.resolve())
/** The chat a manual Compact is running for (mut.compact pending with it), or null. */
let compactingConv: string | null = null
// POST /api/v1/chat/stop names the reply it stops; the daemon answers whether it stopped it.
const stopSpy = vi.fn((_v: { convId: string; messageId?: string }) => Promise.resolve({ ok: true, stopped: true }))
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
        update: { ...idle(), mutateAsync: (...args: unknown[]) => updateMutateAsync(...(args as [])) }, compact: { ...idle(), isPending: compactingConv !== null, variables: compactingConv ? { convId: compactingConv } : undefined }, deleteMsg: idle(), editMsg: { ...idle(), mutate: editMsgMutate }, regenerate: { ...idle(), mutateAsync: regenerateSpy },
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
const activateCalls: unknown[][] = []
/** What the version switcher lists for any group. */
let variants: unknown[] = []
vi.mock('../lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-api')>()
  return {
    ...actual,
    sendMessage: (...args: unknown[]) => { sendCalls.push(args); return nextGen(args[2] as AbortSignal) },
    continueConversation: (...args: unknown[]) => { continueCalls.push(args); return nextGen(args[1] as AbortSignal) },
    getMessageVariants: () => Promise.resolve({ variants }),
    activateVariant: (...args: unknown[]) => { activateCalls.push(args); return Promise.resolve({ messages: [] }) },
  }
})
vi.mock('../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/link-queries')>()
  return { ...actual, useLinks: () => ({ data: [] }), useRemoteModels: () => ({ data: [] }), useLinkStatus: () => ({ data: undefined }) }
})
vi.mock('../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve(skills) }
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
    expect(stopSpy).toHaveBeenCalledWith({ convId: 'c1', messageId: 'a1' })
  })

  it('an Escape from the composer the message was just sent from (now disabled) still stops it', async () => {
    nextGen = hangingStream()
    await renderScreen('/chat/c1')
    await sendText('write me an essay')
    await screen.findByTitle('Stop generation (Esc)')
    const ta = await composer()
    expect(ta).toBeDisabled()
    await act(async () => { fireEvent.keyDown(ta, { key: 'Escape' }) })
    expect(stopSpy).toHaveBeenCalledWith({ convId: 'c1', messageId: 'a1' })
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
    nextGen = async function* () { throw new ApiError('stale_message', stale, 409) }
    const toastError = vi.spyOn(toast, 'error')
    try {
      const view = await renderScreen('/chat/c1')
      const invalidate = vi.spyOn(view.qc, 'invalidateQueries')
      await act(async () => { fireEvent.keyDown(await composer(), { key: 'ArrowUp' }) })
      fireEvent.change(screen.getByDisplayValue('Recommend a language'), { target: { value: 'Recommend a typed language, carefully' } })
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(stale))
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation', 'c1'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['message-variants'] })
      await waitFor(async () => expect(await composer()).toHaveValue('Recommend a typed language, carefully'))
      expect(await composer()).not.toBeDisabled()
      expect(continueCalls).toHaveLength(1)
      expect(editMsgMutate).not.toHaveBeenCalled()
    } finally {
      toastError.mockRestore()
    }
  })

  // The edit closed before the request, so any refusal but stale_message lost the typed text:
  // reopening the edit starts again from the message.
  it('a Save & Resend refused for another reason (409 generation_in_flight) keeps the edit open with the typed text and says why', async () => {
    const busy = 'A generation is already running for this conversation.'
    showMessages([message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python')])
    nextGen = async function* () { throw new ApiError('generation_in_flight', busy, 409) }
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      await act(async () => { fireEvent.keyDown(await composer(), { key: 'ArrowUp' }) })
      fireEvent.change(screen.getByDisplayValue('Recommend a language'), { target: { value: 'Recommend a typed language, carefully' } })
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(busy))
      expect(screen.getByDisplayValue('Recommend a typed language, carefully')).toBeInTheDocument()
      expect(await composer()).toHaveValue('')

      // Saved again once the daemon takes it, the edit closes and the question is answered.
      nextGen = quickStream()
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      await waitFor(() => expect(continueCalls).toHaveLength(2))
      expect(continueCalls[1][6]).toEqual({ messageId: 'u1', content: 'Recommend a typed language, carefully' })
      await waitFor(() => expect(screen.queryByText('Save & Resend')).toBeNull())
    } finally {
      toastError.mockRestore()
    }
  })

  it('a reply edit the daemon refuses keeps the edit open with the typed text and says why', async () => {
    const busy = 'Stop generation first.'
    showMessages([message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python')])
    editMsgMutate.mockImplementation((_v: unknown, opts: { onError: (e: unknown) => void }) => opts.onError(new ApiError('generation_in_flight', busy, 409)))
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      await act(async () => { fireEvent.click((await screen.findAllByTitle('Edit'))[1]) })
      fireEvent.change(screen.getByDisplayValue('Use Python'), { target: { value: 'Use Python 3.13' } })
      await act(async () => { fireEvent.click(screen.getByText('Save')) })
      expect(editMsgMutate).toHaveBeenCalledWith({ convId: 'c1', msgId: 'a1', content: 'Use Python 3.13' }, expect.anything())
      expect(toastError).toHaveBeenCalledWith(busy)
      expect(screen.getByDisplayValue('Use Python 3.13')).toBeInTheDocument()
      expect(continueCalls).toHaveLength(0)
    } finally {
      toastError.mockRestore()
    }
  })

  // Save & Resend was a PUT and then /continue: with no model ready the /continue was skipped, and
  // a refused one (a Turbo Link machine asleep) left the new question unanswered — the next send
  // then went out as user, user.
  it('Save & Resend is one /continue that names the question and its new text, with no PUT', async () => {
    showMessages([message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python')])
    nextGen = quickStream()
    await renderScreen('/chat/c1')
    await act(async () => { fireEvent.keyDown(await composer(), { key: 'ArrowUp' }) })
    fireEvent.change(screen.getByDisplayValue('Recommend a language'), { target: { value: 'Recommend a typed language' } })
    await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
    await waitFor(() => expect(continueCalls).toHaveLength(1))
    expect(continueCalls[0][0]).toBe('c1')
    expect(continueCalls[0][5]).toBeUndefined()
    expect(continueCalls[0][6]).toEqual({ messageId: 'u1', content: 'Recommend a typed language' })
    expect(editMsgMutate).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Save & Resend')).toBeNull())
  })

  it('a Save & Resend the daemon refuses (503) keeps the edit open with the typed text', async () => {
    const offline = "'rig' is not connected (unreachable)."
    showMessages([message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python')])
    nextGen = async function* () { throw new ApiError('remote_unavailable', offline, 503) }
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      await act(async () => { fireEvent.keyDown(await composer(), { key: 'ArrowUp' }) })
      fireEvent.change(screen.getByDisplayValue('Recommend a language'), { target: { value: 'Recommend a typed language' } })
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(offline))
      expect(screen.getByDisplayValue('Recommend a typed language')).toBeInTheDocument()
      expect(editMsgMutate).not.toHaveBeenCalled()
    } finally {
      toastError.mockRestore()
    }
  })

  it('a Save & Resend with no model loaded sends nothing, says so, and keeps the edit open', async () => {
    engineState = 'stopped'
    showMessages([message('u1', 1, 'user', 'Recommend a language'), message('a1', 2, 'assistant', 'Use Python')])
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      fireEvent.click(screen.getAllByTitle('Edit')[0])
      fireEvent.change(await screen.findByDisplayValue('Recommend a language'), { target: { value: 'Recommend a typed language' } })
      await act(async () => { fireEvent.click(screen.getByText('Save & Resend')) })
      expect(toastError).toHaveBeenCalledWith('Load a model first.')
      expect(screen.getByDisplayValue('Recommend a typed language')).toBeInTheDocument()
      expect(editMsgMutate).not.toHaveBeenCalled()
      expect(continueCalls).toHaveLength(0)
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

  // Regenerate was held back only by `live`, which is set when the turn's meta arrives: a second
  // click before that sent a second /continue, the daemon refused it (409), and the refusal
  // cleared the first turn's live view, taking its streamed text and its Stop button with it.
  it('a double-click sends one /continue, and the turn keeps its live view and Stop', async () => {
    showMessages([message('u1', 1, 'user', 'hi'), message('a1', 2, 'assistant', 'hello')])
    const stream = steppedStream()
    let refuse!: () => void
    const refused = new Promise<void>((r) => { refuse = r })
    nextGen = (signal) => continueCalls.length === 1
      ? stream.gen(signal)
      : (async function* () { await refused; throw new ApiError('generation_in_flight', 'A generation is already running for this conversation.', 409) })()
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      const regenerate = await screen.findByTitle('Regenerate')
      await act(async () => { fireEvent.click(regenerate); fireEvent.click(regenerate) })
      await stream.push(meta)
      await stream.push({ event: 'delta', data: { delta: 'Second answer' } } as ChatSseEvent)
      await act(async () => { refuse(); await new Promise((r) => setTimeout(r, 0)) })
      expect(continueCalls).toHaveLength(1)
      expect(toastError).not.toHaveBeenCalled()
      await stream.push({ event: 'delta', data: { delta: ' streams on' } } as ChatSseEvent)
      expect(screen.getByText(/Second answer streams on/)).toBeInTheDocument()
      await act(async () => { fireEvent.click(screen.getByTitle('Stop generation (Esc)')) })
      expect(stopSpy).toHaveBeenCalledWith({ convId: 'c1', messageId: 'a1' })
      expect((continueCalls[0][1] as AbortSignal).aborted).toBe(true)
    } finally {
      toastError.mockRestore()
    }
  })

  // The same refusal reached another way: a turn this view started but the daemon refused before
  // it began (here a message sent while the Regenerate was still starting) cleared the live view
  // of the turn that did begin, though it never had one of its own.
  it('a turn refused before it began leaves the live view and Stop of the one that began', async () => {
    showMessages([message('u1', 1, 'user', 'hi'), message('a1', 2, 'assistant', 'hello')])
    const stream = steppedStream()
    let refuse!: () => void
    const refused = new Promise<void>((r) => { refuse = r })
    nextGen = stream.gen
    try {
      await renderScreen('/chat/c1')
      await act(async () => { fireEvent.click(await screen.findByTitle('Regenerate')) })
      nextGen = async function* () { await refused; throw new ApiError('generation_in_flight', 'A generation is already running for this conversation.', 409) }
      await sendText('meanwhile')
      expect(sendCalls).toHaveLength(1)
      await stream.push(meta)
      await stream.push({ event: 'delta', data: { delta: 'Second answer' } } as ChatSseEvent)
      await act(async () => { refuse(); await new Promise((r) => setTimeout(r, 0)) })
      await stream.push({ event: 'delta', data: { delta: ' streams on' } } as ChatSseEvent)
      expect(screen.getByText(/Second answer streams on/)).toBeInTheDocument()
      await act(async () => { fireEvent.click(screen.getByTitle('Stop generation (Esc)')) })
      expect(stopSpy).toHaveBeenCalledWith({ convId: 'c1', messageId: 'a1' })
    } finally {
      refuse()
    }
  })

  // The send took the chat's abort entry (the Regenerate's request) for its own, and its refusal
  // removed it: Stop then left the Regenerate's request open, Eject did not end it, and a second
  // Regenerate click was no longer held back.
  it('a send refused while a Regenerate is starting leaves that Regenerate its request\'s abort and its double-click guard', async () => {
    showMessages([message('u1', 1, 'user', 'hi'), message('a1', 2, 'assistant', 'hello')])
    const stream = steppedStream()
    nextGen = stream.gen
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      const regenerate = await screen.findByTitle('Regenerate')
      await act(async () => { fireEvent.click(regenerate) })
      nextGen = async function* () { throw new ApiError('generation_in_flight', 'A generation is already running for this conversation.', 409) }
      await sendText('meanwhile')
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('A generation is already running for this conversation.'))
      await act(async () => { fireEvent.click(regenerate) })
      expect(continueCalls).toHaveLength(1)
      await stream.push(meta)
      await stream.push({ event: 'delta', data: { delta: 'Second answer' } } as ChatSseEvent)
      await act(async () => { fireEvent.click(screen.getByTitle('Stop generation (Esc)')) })
      expect(stopSpy).toHaveBeenCalledWith({ convId: 'c1', messageId: 'a1' })
      expect((continueCalls[0][1] as AbortSignal).aborted).toBe(true)
    } finally {
      toastError.mockRestore()
    }
  })

  // A '/skill' send turns the skill on first (PATCH), and its failure cleared the chat's live
  // view: when the Regenerate went live meanwhile, its streamed text and Stop went with it.
  it('a send that fails before it streams leaves the live view and Stop of a Regenerate that went live meanwhile', async () => {
    skills = [{ id: 'notes', name: 'Notes', description: '', instructions: '', tools: [] }]
    let failUpdate!: () => void
    updateMutateAsync = vi.fn(() => new Promise<unknown>((_, reject) => { failUpdate = () => reject(new ApiError('http_error', 'Request failed with status 500.', 500)) }))
    showMessages([message('u1', 1, 'user', 'hi'), message('a1', 2, 'assistant', 'hello')])
    const stream = steppedStream()
    nextGen = stream.gen
    const toastError = vi.spyOn(toast, 'error')
    try {
      const view = await renderScreen('/chat/c1')
      await waitFor(() => expect(view.qc.getQueryData(['skills', 'list'])).toBeDefined())
      await act(async () => { fireEvent.click(await screen.findByTitle('Regenerate')) })
      await sendText('/notes meanwhile')
      expect(updateMutateAsync).toHaveBeenCalledTimes(1)
      await stream.push(meta)
      await stream.push({ event: 'delta', data: { delta: 'Second answer' } } as ChatSseEvent)
      await act(async () => { failUpdate(); await new Promise((r) => setTimeout(r, 0)) })
      expect(toastError).toHaveBeenCalledWith('Request failed with status 500.')
      expect(sendCalls).toHaveLength(0)
      await stream.push({ event: 'delta', data: { delta: ' streams on' } } as ChatSseEvent)
      expect(screen.getByText(/Second answer streams on/)).toBeInTheDocument()
      await act(async () => { fireEvent.click(screen.getByTitle('Stop generation (Esc)')) })
      expect((continueCalls[0][1] as AbortSignal).aborted).toBe(true)
    } finally {
      toastError.mockRestore()
    }
  })
})

describe('ChatScreen — while a manual Compact runs', () => {
  // The daemon holds the chat's in-flight slot for the whole compaction and refuses every message
  // action meanwhile. Only the composer was held back: Regenerate, the version switcher and an
  // edit's Save stayed enabled, and each click toasted the refusal ('A generation is already
  // running…', 'Stop generation first.') over a chat showing the Compacting banner and no Stop.
  function twoVersionReply() {
    const reply = { ...message('a1', 2, 'assistant', 'Use Python'), variantGroup: 'a0' }
    variants = [{ ...message('a0', 2, 'assistant', 'Use Rust'), variantGroup: 'a0', isActive: false }, reply]
    showMessages([message('u1', 1, 'user', 'Recommend a language'), reply])
  }

  it('hides Regenerate and disables the version switcher and the edits\' Save until it ends', async () => {
    twoVersionReply()
    compactingConv = 'c1'
    nextGen = quickStream()
    const toastError = vi.spyOn(toast, 'error')
    try {
      const view = await renderScreen('/chat/c1')
      expect(await screen.findByText('2/2')).toBeInTheDocument()
      expect(screen.getByText('Compacting conversation…')).toBeInTheDocument()
      expect(screen.queryByTitle('Regenerate')).toBeNull()
      expect(screen.getByTitle('Previous version')).toBeDisabled()

      fireEvent.click(screen.getAllByTitle('Edit')[1]) // the reply
      expect(screen.getByText('Save')).toBeDisabled()
      // Ctrl/Cmd+Enter in the box still reaches the Save handler: refused there, the edit stays open.
      fireEvent.keyDown(screen.getByDisplayValue('Use Python'), { key: 'Enter', ctrlKey: true })
      expect(toastError).toHaveBeenCalledWith('This chat is being compacted. Try again when it finishes.')
      expect(screen.getByDisplayValue('Use Python')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))

      fireEvent.click(screen.getAllByTitle('Edit')[0]) // the question
      expect(screen.getByText('Save & Resend')).toBeDisabled()
      await act(async () => { fireEvent.keyDown(screen.getByDisplayValue('Recommend a language'), { key: 'Enter', ctrlKey: true }) })
      expect(screen.getByDisplayValue('Recommend a language')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))

      expect(continueCalls).toHaveLength(0)
      expect(activateCalls).toHaveLength(0)
      expect(editMsgMutate).not.toHaveBeenCalled()

      compactingConv = null // it ended
      await act(async () => { view.refetched() })
      expect(await screen.findByTitle('Regenerate')).toBeInTheDocument()
      expect(screen.getByTitle('Previous version')).not.toBeDisabled()
    } finally {
      toastError.mockRestore()
    }
  })

  it('a Compact of another chat leaves this chat\'s Regenerate and version switcher alone', async () => {
    twoVersionReply()
    compactingConv = 'c2'
    await renderScreen('/chat/c1')
    expect(await screen.findByText('2/2')).toBeInTheDocument()
    expect(screen.getByTitle('Regenerate')).toBeInTheDocument()
    expect(screen.getByTitle('Previous version')).not.toBeDisabled()
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
