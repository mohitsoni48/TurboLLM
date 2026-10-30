// A remote-access token (ADR-422) is never given config:read, so GET /api/v1/status answers it 403
// for good (connection-state.ts's scopedTokenLimited), while the chat itself is open to it
// (models:use). Chat's composer read whether a model is loaded only from /status, so such a token
// stared at a disabled "Load a model to start chatting" with a model loaded on the host. Renders
// the REAL screen with the data hooks and heavy children stubbed at their boundary (same discipline
// as ChatScreen.test.tsx).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import { queryKeys } from '../lib/queries'
import type { ModelEntry } from '../lib/types'

// Rendering the real screen takes several seconds on a loaded CI box, which the default 5000 ms test
// timeout does not cover; the assertions themselves stay unchanged.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  mockLibrary = []
  statusResult = refusedForScope()
  pickerProps = null
  settingsDialogProps = null
  createMutateAsync.mockClear()
})

/** What useStatus gives a remote-access token: the daemon's 403 for config:read, no data. */
function refusedForScope() {
  return { data: undefined, isError: true, error: new ApiError('forbidden', 'This access token is not allowed to do that.', 403) }
}

const loadedRow = (over: Partial<ModelEntry> = {}): Partial<ModelEntry> => ({
  key: 'qwen3-8b', name: 'Qwen3 8B', quant: 'Q8_0', incomplete: false, parseError: null,
  loaded: true, compatibleWithActiveEngine: true, ...over,
})

const QWEN_SAMPLING = { temperature: 0.6, topP: 0.95 }

let mockLibrary: Array<Partial<ModelEntry>> = []
let statusResult: { data: unknown; isError: boolean; error: unknown } = refusedForScope()
const createMutateAsync = vi.fn((_vars: { modelKey: string }) => Promise.resolve({ id: 'new1' }))

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  const { useQuery } = await import('@tanstack/react-query')
  return {
    ...actual,
    useStatus: () => statusResult,
    // A real query under the real key, so re-reading the list (invalidateQueries) shows what the
    // host has loaded by then. No refetchInterval: only the screen's own re-read asks again.
    useModels: () => useQuery({ queryKey: actual.queryKeys.models, queryFn: async () => ({ models: mockLibrary }) }),
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
    useModelDetail: (key: string | null) => ({ data: key === 'qwen3-8b' ? { profile: { sampling: QWEN_SAMPLING } } : undefined }),
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
    useConversation: () => ({ data: undefined }),
    useConversationMutations: () => {
      const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
      return {
        create: { ...idle(), mutateAsync: createMutateAsync }, update: idle(), compact: idle(), deleteMsg: idle(),
        editMsg: idle(), regenerate: idle(), stop: idle(), undoCompaction: idle(),
      }
    },
  }
})

vi.mock('../lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-api')>()
  // eslint-disable-next-line require-yield
  return { ...actual, sendMessage: async function* () { return } }
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
vi.mock('../lib/pdf-extract', () => ({ extractPdfText: vi.fn() }))
vi.mock('./chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
let settingsDialogProps: { modelSampling?: unknown } | null = null
vi.mock('./chat/ConversationSettingsDialog', () => ({
  ConversationSettingsDialog: (props: { modelSampling?: unknown }) => {
    settingsDialogProps = props
    return null
  },
}))
vi.mock('../components/ReasoningEffortSelect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ReasoningEffortSelect')>()
  return { ...actual, ReasoningEffortSelect: () => <span>reasoning effort</span> }
})
vi.mock('../components/ThinkingBudgetSlider', () => ({ ThinkingBudgetSlider: () => <span>thinking budget</span> }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))

type PickerProps = { loadedKey?: string | null; loadedName?: string | null; blockedReason?: string }
let pickerProps: PickerProps | null = null
vi.mock('../components/ModelLoadMenu', () => ({
  ModelLoadMenu: (props: PickerProps) => {
    pickerProps = props
    return null
  },
}))

async function renderScreen(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const { ChatScreen } = await import('./ChatScreen')
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ChatScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const composer = () => screen.getByRole('textbox') as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

describe('ChatScreen — a remote-access token, which GET /api/v1/status refuses 403', () => {
  afterEach(() => {
    vi.useRealTimers()
    focusManager.setFocused(undefined)
  })

  it('chats with the model the host has loaded, read from the model list', async () => {
    mockLibrary = [loadedRow({ key: 'idle', name: 'Idle', loaded: false }), loadedRow()]
    await renderScreen()

    await waitFor(() => expect(composer().placeholder).toBe('Message Qwen3 8B'))
    expect(composer().disabled).toBe(false)
    expect(pickerProps?.loadedKey).toBe('qwen3-8b')
    expect(pickerProps?.loadedName).toBe('Qwen3 8B')

    fireEvent.change(composer(), { target: { value: 'hello' } })
    expect(sendButton().disabled).toBe(false)
    fireEvent.click(sendButton())

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1))
    expect(createMutateAsync.mock.calls[0][0].modelKey).toBe('qwen3-8b')
  })

  // The list's `loaded` also marks an embedding model, which runs in its own slot beside a chat
  // model (ADR-389) and never answers a chat: named, it labelled the conversation and the picker
  // with it, and alone it turned the composer on for sends the daemon refuses 409.
  it('chats with the loaded chat model, not an embedding model loaded beside it', async () => {
    mockLibrary = [loadedRow({ key: 'nomic-embed', name: 'Nomic Embed', embedding: true }), loadedRow()]
    await renderScreen()

    await waitFor(() => expect(composer().placeholder).toBe('Message Qwen3 8B'))
    expect(pickerProps?.loadedKey).toBe('qwen3-8b')
  })

  it('with only an embedding model loaded on the host, keeps the composer off', async () => {
    mockLibrary = [loadedRow({ key: 'nomic-embed', name: 'Nomic Embed', embedding: true }), loadedRow({ loaded: false })]
    await renderScreen()

    await waitFor(() => expect(screen.getByText('Load a model on the host to begin')).toBeTruthy())
    expect(composer().placeholder).toBe('Load a model on the host to chat')
    expect(composer().disabled).toBe(true)
    expect(pickerProps?.loadedKey).toBeNull()
  })

  it("gives the loaded model's reasoning-effort control and sampling defaults, as with /status", async () => {
    mockLibrary = [loadedRow({ reasoningEffort: true })]
    await renderScreen()

    await waitFor(() => expect(composer().placeholder).toBe('Message Qwen3 8B'))
    expect(screen.getByText('reasoning effort')).toBeTruthy()
    expect(screen.queryByText('thinking budget')).toBeNull()
    expect(settingsDialogProps?.modelSampling).toEqual(QWEN_SAMPLING)
  })

  it('has the picker say why it cannot load or eject a model, since /api/v1/engine/start and /stop refuse every token', async () => {
    mockLibrary = [loadedRow()]
    await renderScreen()

    await waitFor(() => expect(pickerProps?.blockedReason).toBe(
      'This access token can chat with the model loaded on the host, but cannot load or eject one. Do that on the host.',
    ))
  })

  it('with no chat model loaded on the host, keeps the composer off and says where to load one', async () => {
    // A loaded text classification model never chats (model-kind.ts isChatModel).
    mockLibrary = [loadedRow({ loaded: false }), loadedRow({ key: 'decide', name: 'Decide', laya: { checkpoints: ['decide.safetensors'] } })]
    await renderScreen()

    await waitFor(() => expect(composer().placeholder).toBe('Load a model on the host to chat'))
    expect(composer().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(pickerProps?.loadedKey).toBeNull()
  })

  it('re-reads the model list while nothing is loaded, so a model the host loads later turns the composer on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await renderScreen(qc)
    await waitFor(() => expect(composer().placeholder).toBe('Load a model on the host to chat'))
    const modelListReads = () => invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(queryKeys.models)).length

    vi.advanceTimersByTime(4000)
    expect(modelListReads()).toBe(1)
    expect(composer().disabled).toBe(true)

    mockLibrary = [loadedRow()] // the host loads a model
    act(() => { vi.advanceTimersByTime(4000) })
    expect(modelListReads()).toBe(2)
    await waitFor(() => expect(composer().placeholder).toBe('Message Qwen3 8B'))
    expect(composer().disabled).toBe(false)

    // Loaded now, the list polls on its own (models-poll.ts) and the screen stops asking.
    vi.advanceTimersByTime(8000)
    expect(modelListReads()).toBe(2)
  })

  it('does not re-read the model list while the tab is in the background', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await renderScreen(qc)
    await waitFor(() => expect(composer().placeholder).toBe('Load a model on the host to chat'))
    const modelListReads = () => invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(queryKeys.models)).length

    act(() => focusManager.setFocused(false))
    vi.advanceTimersByTime(12_000)
    expect(modelListReads()).toBe(0)

    act(() => focusManager.setFocused(true))
    vi.advanceTimersByTime(4000)
    expect(modelListReads()).toBe(1)
  })

  it('is the 403 only: a 401 (no key or a wrong one) still waits for /status', async () => {
    mockLibrary = [loadedRow()]
    statusResult = { data: undefined, isError: true, error: new ApiError('unauthorized', 'A valid API key is required.', 401) }
    await renderScreen()

    await waitFor(() => expect(composer().placeholder).toBe('Load a model to start chatting'))
    expect(composer().disabled).toBe(true)
    expect(pickerProps?.blockedReason).toBeUndefined()
  })
})
