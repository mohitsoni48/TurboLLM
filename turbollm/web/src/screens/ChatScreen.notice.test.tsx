// A note from the daemon about a turn (the 'notice' event: the loaded LiteRT-LM model cannot call tools, so the chat's
// tools were not sent; the tools do not fit in its context; it chooses its own searches under Research) is shown to
// the user, once per chat: the daemon sends it with every turn it applies to, and a page that follows a reply again
// (an attach, a replay after a reset) gets it again. Same screen harness as ChatScreen.thinking-default.test.tsx.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import type { ModelEntry } from '../lib/types'

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('../components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ui/sonner')>()
  return { ...actual, toast: Object.assign(toastSpy, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

const NOTE = 'This model cannot call tools: its chat template never shows them to it, so this reply was written without web search, fetch, MCP or other tools. Load a model that calls tools to use them.'

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
  sysInfo = { os: 'android/arm64' }
  sent.length = 0
  statusResult = refusedForScope()
  createMutateAsync.mockClear()
  toastSpy.mockClear()
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
let sysInfo: { os: string } | undefined = { os: 'android/arm64' }
const sent: unknown[][] = []
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
    useSysInfo: () => ({ data: sysInfo }),
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
  return {
    ...actual,
    sendMessage: async function* (...args: unknown[]) {
      sent.push(args)
      yield { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' } }
      yield { event: 'notice', data: { message: NOTE } }
      yield { event: 'delta', data: { delta: 'Hello.' } }
      // A replay of the same reply (what a page following it again gets): the note comes again.
      yield { event: 'reset', data: {} }
      yield { event: 'notice', data: { message: NOTE } }
      yield { event: 'delta', data: { delta: 'Hello.' } }
      yield { event: 'done', data: { message: null } }
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
vi.mock('../lib/pdf-extract', () => ({ extractPdfText: vi.fn() }))
vi.mock('./chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./chat/ConversationSettingsDialog', () => ({ ConversationSettingsDialog: () => null }))
vi.mock('../components/ReasoningEffortSelect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ReasoningEffortSelect')>()
  return { ...actual, ReasoningEffortSelect: () => <span>reasoning effort</span> }
})
vi.mock('../components/ThinkingBudgetSlider', () => ({ ThinkingBudgetSlider: ({ value }: { value: number }) => <span>thinking budget {value}</span> }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))

vi.mock('../components/ModelLoadMenu', () => ({ ModelLoadMenu: () => null }))

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

async function send(text: string): Promise<unknown[]> {
  await waitFor(() => expect(composer().placeholder).toBe('Message Qwen3 8B'))
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.click(sendButton())
  await waitFor(() => expect(sent.length).toBe(1))
  return sent[0]
}

describe('ChatScreen — the daemon\'s notes about a turn', () => {
  afterEach(() => {
    focusManager.setFocused(undefined)
  })

  it('shows a note the daemon sends with a turn, once for the chat however often it comes', async () => {
    sysInfo = { os: 'linux/x64' }
    mockLibrary = [loadedRow()]
    await renderScreen()
    await send('hello')
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(NOTE))
    expect(toastSpy).toHaveBeenCalledTimes(1)
  })
})
