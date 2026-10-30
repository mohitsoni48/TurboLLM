// The chat's thinking control, untouched, is the model's own default on every platform. On Android every new chat
// started with thinking Off (budget 0), for every model: TurboLLM's own default, which forced thinking off for Qwen3,
// Gemma 4 and LFM2.5-Thinking once thinking reaches LiteRT-LM. And a reasoning-effort level is sent only while the
// loaded model shows that control: one stored for this chat under a model that had it reached the next model too,
// which LiteRT-LM reads as thinking on or off. Same screen harness as ChatScreen.remote-token.test.tsx.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
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
  sysInfo = { os: 'android/arm64' }
  sent.length = 0
  statusResult = refusedForScope()
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
  // eslint-disable-next-line require-yield
  return { ...actual, sendMessage: async function* (...args: unknown[]) { sent.push(args); return } }
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
vi.mock('../components/ThinkingBudgetSlider', () => ({
  ThinkingBudgetSlider: ({ value, automatic }: { value: number; automatic?: boolean }) => <span>thinking budget {value}{automatic ? ' (auto)' : ''}</span>,
}))
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

describe('ChatScreen — the thinking control is the model\'s own until the user sets it', () => {
  afterEach(() => {
    focusManager.setFocused(undefined)
  })

  it('an untouched chat on Android sends no thinking budget: the model\'s own default applies', async () => {
    mockLibrary = [loadedRow()]
    await renderScreen()
    await waitFor(() => expect(screen.getByText('thinking budget -1')).toBeTruthy())
    expect(screen.queryByText('thinking budget 0')).toBeNull()
    const args = await send('hello')
    expect(args[6]).toBe(-1) // sendMessage's thinkingBudget: -1 is sent as nothing (chat-api.ts)
  })

  it('an untouched chat on a LiteRT-LM model shows its thinking as the model\'s own default (Auto), not Unlimited', async () => {
    // -1 sends nothing; a .litertlm may not think by default (gemma-4-E2B-it), which "Unlimited" claimed it did.
    mockLibrary = [loadedRow({ format: 'litertlm' })]
    await renderScreen()
    await waitFor(() => expect(screen.getByText('thinking budget -1 (auto)')).toBeTruthy())
    expect((await send('hello'))[6]).toBe(-1)
  })

  it('a thinking choice the user made is kept on Android', async () => {
    localStorage.setItem('tllm.thinkingBudget.default', '0')
    mockLibrary = [loadedRow()]
    await renderScreen()
    await waitFor(() => expect(screen.getByText('thinking budget 0')).toBeTruthy())
    expect((await send('hello'))[6]).toBe(0)
  })

  it('a stored reasoning-effort level is not sent to a model without that control, and is with it', async () => {
    sysInfo = { os: 'linux/x64' }
    localStorage.setItem('tllm.reasoningEffort.default', 'low')
    mockLibrary = [loadedRow()]
    await renderScreen()
    expect((await send('hello'))[7]).toBeUndefined()
  })

  it('sends the stored level to a model that shows the control', async () => {
    sysInfo = { os: 'linux/x64' }
    localStorage.setItem('tllm.reasoningEffort.default', 'low')
    mockLibrary = [loadedRow({ reasoningEffort: true })]
    await renderScreen()
    expect((await send('hello'))[7]).toBe('low')
  })
})
