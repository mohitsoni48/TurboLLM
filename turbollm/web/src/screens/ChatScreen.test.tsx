// ADR-434 (f): the Chat model picker must never offer a Jev model — it labels text and cannot
// chat, and a loaded one would turn this whole screen into the playground. Renders the REAL screen
// (its own model-list logic) with the data hooks and heavy children stubbed at their boundary —
// the same "mock at the API boundary, keep the screen's own logic real" discipline as
// CodeSessionScreen.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '../lib/types'

// jsdom's environment doesn't wire up a working localStorage (the thinking-budget and reasoning-
// effort readers touch it on first render) — same gap CodeSessionScreen.test.tsx works around.
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

let mockLibrary: Array<Partial<ModelEntry>> = []
let mockConversation: unknown = undefined

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' } } }),
    useModels: () => ({ data: { models: mockLibrary } }),
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
    useModelDetail: () => ({ data: undefined }),
    useEngines: () => ({ data: undefined }),
    useSettings: () => ({ query: { data: undefined } }),
    useSysInfo: () => ({ data: undefined }),
    useChatAgents: () => ({ data: [] }),
    useBuiltinAgentOverrides: () => ({ data: {} }),
  }
})

vi.mock('../lib/chat-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-queries')>()
  return {
    ...actual,
    useConversation: () => ({ data: mockConversation }),
    useConversationMutations: () => {
      const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
      return {
        create: idle(), update: idle(), compact: idle(), deleteMsg: idle(), editMsg: idle(),
        regenerate: idle(), stop: idle(), undoCompaction: idle(),
      }
    },
  }
})

vi.mock('../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/link-queries')>()
  return {
    ...actual,
    useLinks: () => ({ data: [] }),
    useRemoteModels: () => ({ data: [] }),
    useLinkStatus: () => ({ data: undefined }),
  }
})

vi.mock('../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})

vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))

// pdfjs-dist reads DOMMatrix at import time, which jsdom lacks; a test that attaches a PDF sets
// what extraction gives.
vi.mock('../lib/pdf-extract', () => ({ extractPdfText: vi.fn() }))

vi.mock('./chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./chat/ConversationSettingsDialog', () => ({ ConversationSettingsDialog: () => null }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))

let modelsOfferedByPicker: Array<Partial<ModelEntry>> | null = null
vi.mock('../components/ModelLoadMenu', () => ({
  ModelLoadMenu: (props: { models: Array<Partial<ModelEntry>> }) => {
    modelsOfferedByPicker = props.models
    return null
  },
}))

async function renderScreen() {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ChatScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

// GitHub #52 (b15hop): find text inside a long chat. The find bar itself is covered in
// chat/ChatFindBar.test.tsx; these check what only the screen owns — when Ctrl/Cmd+F is taken from
// the browser, the header button, and that the bar searches the messages the screen really renders.
function chatMessage(seq: number, role: 'user' | 'assistant', content: string) {
  return {
    id: `m${seq}`, convId: 'c1', seq, role, content, reasoning: '', attachments: [], textAttachments: [],
    toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false,
  }
}

function openConversation() {
  return {
    id: 'c1', title: 'Cats', systemPrompt: '', modelKey: '', sampling: {}, expertMode: false, preserveThinking: true,
    messages: [chatMessage(1, 'user', 'Tell me about the cat'), chatMessage(2, 'assistant', 'A cat is a small mammal. Every cat purrs.')],
  }
}

async function renderOpenConversation() {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // jsdom has no layout: give matches a position and let the chat be scrolled without doing anything.
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, writable: true, value: () => ({ top: 0, height: 20 }) })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chat/c1']}>
        <Routes><Route path="/chat/:convId" element={<ChatScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const findBox = () => screen.queryByRole('textbox', { name: /find in chat/i })
// The first render of this heavy screen is slow when the machine is busy (several test files at once),
// so wait well past the default one second rather than fail on a slow start.
const findBoxAppears = () => waitFor(() => expect(findBox()).not.toBeNull(), { timeout: 5000 })
const pressFindShortcut = (init: KeyboardEventInit = { key: 'f', ctrlKey: true }) => {
  const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('ChatScreen — find in chat', () => {
  beforeEach(() => { mockConversation = openConversation() })
  afterEach(() => { mockConversation = undefined })

  it('opens the find bar on Ctrl+F, taking the shortcut from the browser', async () => {
    await renderOpenConversation()
    expect(findBox()).toBeNull()

    const event = pressFindShortcut()

    await findBoxAppears()
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens the find bar on Cmd+F too', async () => {
    await renderOpenConversation()

    pressFindShortcut({ key: 'F', metaKey: true })

    await findBoxAppears()
  })

  it('leaves Ctrl+F to the browser when no conversation is open', async () => {
    mockConversation = undefined
    const { ChatScreen } = await import('./ChatScreen')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><MemoryRouter><ChatScreen /></MemoryRouter></QueryClientProvider>)

    const event = pressFindShortcut()

    expect(event.defaultPrevented).toBe(false)
    expect(findBox()).toBeNull()
  })

  it('leaves Ctrl+F alone on a Mac, where it moves the cursor in a text field, but Cmd+F still opens find', async () => {
    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      await renderOpenConversation()

      const ctrlF = pressFindShortcut({ key: 'f', ctrlKey: true })
      expect(ctrlF.defaultPrevented).toBe(false)
      expect(findBox()).toBeNull()

      pressFindShortcut({ key: 'f', metaKey: true })
      await findBoxAppears()
    } finally {
      platform.mockRestore()
    }
  })

  it('names the shortcut that works on this computer in the header button tooltip', async () => {
    await renderOpenConversation()
    expect(screen.getByRole('button', { name: /find in chat/i }).getAttribute('title')).toBe('Find in chat (Ctrl+F)')
    cleanup()

    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      await renderOpenConversation()

      expect(screen.getByRole('button', { name: /find in chat/i }).getAttribute('title')).toBe('Find in chat (⌘F)')
    } finally {
      platform.mockRestore()
    }
  })

  it('ignores a keydown that has no key, as browser autofill fires, instead of throwing', async () => {
    await renderOpenConversation()
    const onError = vi.fn()
    window.addEventListener('error', onError)
    const autofill = new KeyboardEvent('keydown', { ctrlKey: true, bubbles: true, cancelable: true })
    Object.defineProperty(autofill, 'key', { value: undefined })

    window.dispatchEvent(autofill)

    window.removeEventListener('error', onError)
    expect(onError).not.toHaveBeenCalled()
    expect(findBox()).toBeNull()
  })

  it('closes the find bar when the chat it was searching is left, so it cannot carry a search into another chat', async () => {
    await renderOpenConversation()
    pressFindShortcut()
    await findBoxAppears()

    pressFindShortcut({ key: 'n', ctrlKey: true })

    await waitFor(() => expect(findBox()).toBeNull())
  })

  it('opens the find bar from a header button, for phones and mice', async () => {
    await renderOpenConversation()

    fireEvent.click(screen.getByRole('button', { name: /find in chat/i }))

    await findBoxAppears()
  })

  it('closes the find bar on Escape', async () => {
    await renderOpenConversation()
    pressFindShortcut()
    await findBoxAppears()

    fireEvent.keyDown(findBox()!, { key: 'Escape' })

    expect(findBox()).toBeNull()
  })

  it('brings the cursor back to the box when Ctrl+F is pressed while it is already open', async () => {
    await renderOpenConversation()
    pressFindShortcut()
    await findBoxAppears()
    ;(document.activeElement as HTMLElement).blur()

    pressFindShortcut()

    await waitFor(() => expect(document.activeElement).toBe(findBox()))
  })

  it('searches the messages the chat actually shows', async () => {
    await renderOpenConversation()
    pressFindShortcut()
    await findBoxAppears()

    fireEvent.change(findBox()!, { target: { value: 'cat' } })

    expect(screen.getByTestId('find-count').textContent).toBe('1 of 3')
  })
})

describe('ChatScreen — model picker offers chat models only', () => {
  const chatModel: Partial<ModelEntry> = { key: 'qwen3-8b', name: 'Qwen3 8B', compatibleWithActiveEngine: true }
  const jevModel: Partial<ModelEntry> = {
    key: 'qwen3.5 4b nli v2', name: 'qwen3.5 4b nli v2', compatibleWithActiveEngine: true,
    jev: { labels: ['contradiction', 'entailment', 'neutral'], nliTemplate: 'Premise: {premise} Hypothesis: {hypothesis}', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
  }
  const wrongEngineChatModel: Partial<ModelEntry> = { key: 'gguf-on-vllm', name: 'GGUF on vLLM', compatibleWithActiveEngine: false }

  beforeEach(() => {
    mockLibrary = [chatModel, jevModel, wrongEngineChatModel]
    modelsOfferedByPicker = null
  })

  it('offers the engine-compatible chat model and not the Jev model', async () => {
    await renderScreen()
    await waitFor(() => expect(modelsOfferedByPicker).not.toBeNull())
    expect(modelsOfferedByPicker?.map((m) => m.key)).toEqual(['qwen3-8b'])
  })
})

// A PDF pdf.js cannot open (damaged, password-protected, not really a PDF) rejected the whole pick
// with nothing on screen, and skipped the input's reset, so the same file could not be picked again
// (picking an unchanged value fires no change event).
describe('ChatScreen — attaching a file that cannot be read', () => {
  it('says the PDF could not be read, attaches the rest of the pick, and lets the same file be picked again', async () => {
    const { extractPdfText } = await import('../lib/pdf-extract')
    const { toast } = await import('../components/ui/sonner')
    const toastError = vi.spyOn(toast, 'error')
    vi.mocked(extractPdfText).mockRejectedValueOnce(new Error('Invalid PDF structure.'))
    try {
      const { container } = await renderScreen()
      const input = container.querySelector('input[type="file"][accept*=".pdf"]') as HTMLInputElement
      // An input keeps its value until reset: record the reset that lets the same file be picked again.
      const reset = vi.fn()
      Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: reset })
      const bad = new File(['%PDF-1.7 truncated'], 'scan.pdf', { type: 'application/pdf' })
      const notes = new File(['hello'], 'notes.txt', { type: 'text/plain' })

      fireEvent.change(input, { target: { files: [bad, notes] } })

      await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not read the PDF scan.pdf. It may be damaged or password-protected.'))
      expect(await screen.findByText('notes.txt')).toBeTruthy()
      expect(screen.queryByText('scan.pdf')).toBeNull()
      expect(reset).toHaveBeenCalledWith('')
    } finally {
      toastError.mockRestore()
    }
  })

  it('says so for any other file the browser fails to read, instead of waiting on it forever', async () => {
    const { toast } = await import('../components/ui/sonner')
    const toastError = vi.spyOn(toast, 'error')
    const realFileReader = globalThis.FileReader
    // A file moved or locked after it was picked: the read ends in `error`, never `load`.
    vi.stubGlobal('FileReader', class {
      result: string | null = null
      error = new DOMException('The file could not be read.', 'NotReadableError')
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsText() { queueMicrotask(() => this.onerror?.()) }
      readAsDataURL() { queueMicrotask(() => this.onerror?.()) }
    })
    try {
      const { container } = await renderScreen()
      const input = container.querySelector('input[type="file"][accept*=".pdf"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [new File(['x'], 'gone.txt', { type: 'text/plain' })] } })
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not read gone.txt.'))
      expect(screen.queryByText('gone.txt')).toBeNull()
    } finally {
      toastError.mockRestore()
      vi.stubGlobal('FileReader', realFileReader)
    }
  })
})
