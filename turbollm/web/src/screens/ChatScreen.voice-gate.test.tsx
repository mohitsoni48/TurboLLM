// The hands-free voice conversation is a beta behind a Settings → Voice opt-in (GitHub #316). The composer's conversation buttons
// (one from sm up, one in the Send button's place on a phone) exist only while it is on: deleting the gate must fail a test.
import { act, render, screen, waitFor } from '@testing-library/react'
import { useVoiceStore } from '../stores/voice'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
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
  sysInfo = { os: 'linux/x64' }
  sent.length = 0
  statusResult = refusedForScope()
  createMutateAsync.mockClear()
  updateMutateAsync.mockClear()
  trackSpy.mockClear()
  listMemoryFactsMock.mockClear()
  fetchSysInfoMock.mockClear()
  customAgents = [WRITER]
  settingsData = undefined
  conv = { ...BASE_CONV }
  act(() => useVoiceStore.getState().setConversation(false))
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
let sysInfo: { os: string } | undefined = { os: 'linux/x64' }
const sent: unknown[][] = []
let statusResult: { data: unknown; isError: boolean; error: unknown } = refusedForScope()
const createMutateAsync = vi.fn((_vars: { modelKey: string }) => Promise.resolve({ id: 'new1' }))
const updateMutateAsync = vi.fn((_vars: Record<string, unknown>) => Promise.resolve<Record<string, unknown>>({}))
const trackSpy = vi.fn()
const listMemoryFactsMock = vi.fn(() => Promise.resolve({ facts: [{ factText: 'likes tea' }] }))
const fetchSysInfoMock = vi.fn(() => Promise.resolve({ gpus: [{ name: 'RTX 3050', vramMb: 6144 }], ramMB: 16384, os: 'win32', cpu: 'x', cores: 8 }))

const WRITER = { id: 'writer', name: 'Writer', description: 'Drafts prose', systemPrompt: 'You write.', skillIds: ['s-write'], tools: ['web_search'] }
let customAgents: Array<typeof WRITER> = [WRITER]
let settingsData: { autoMemoryEnabled?: boolean } | undefined

const BASE_CONV = {
  id: 'c1', title: 'A chat', systemPrompt: '', modelKey: 'qwen3-8b', sampling: {}, expertMode: false,
  skillIds: ['s-write', 'user-picked'], allowedTools: ['web_search'], preserveThinking: true,
  messages: [
    { id: 'm1', role: 'user', content: 'hello', toolCalls: [], createdAt: '2026-11-15T00:00:00Z' },
    { id: 'm2', role: 'assistant', content: 'hi there', toolCalls: [], createdAt: '2026-11-15T00:00:01Z', stats: { ctxUsed: 10, ctxMax: 8192 } },
  ],
}
let conv: Record<string, unknown> = { ...BASE_CONV }

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
    useSettings: () => ({ query: { data: settingsData } }),
    useSysInfo: () => ({ data: sysInfo }),
    useChatAgents: () => ({ data: customAgents }),
    useBuiltinAgentOverrides: () => ({ data: {} }),
  }
})

vi.mock('../lib/chat-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-queries')>()
  return {
    ...actual,
    useConversation: () => ({ data: conv }),
    useConversationMutations: () => {
      const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
      return {
        create: { ...idle(), mutateAsync: createMutateAsync }, update: { ...idle(), mutateAsync: updateMutateAsync }, compact: idle(), deleteMsg: idle(),
        editMsg: idle(), regenerate: idle(), stop: idle(), undoCompaction: idle(),
      }
    },
  }
})

vi.mock('../lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-api')>()
  return {
    ...actual,
    // eslint-disable-next-line require-yield
    sendMessage: async function* (...args: unknown[]) { sent.push(args); return },
    listMemoryFacts: () => listMemoryFactsMock(),
    fetchSysInfo: () => fetchSysInfoMock(),
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
vi.mock('../components/ThinkingBudgetSlider', () => ({
  ThinkingBudgetSlider: ({ value, automatic }: { value: number; automatic?: boolean }) => <span>thinking budget {value}{automatic ? ' (auto)' : ''}</span>,
}))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))

vi.mock('../components/ModelLoadMenu', () => ({ ModelLoadMenu: () => null }))
vi.mock('../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/api')>()), track: (...a: unknown[]) => trackSpy(...a) }))

async function renderScreen() {
  const { ChatScreen } = await import('./ChatScreen')
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/chat/c1']}>
        <Routes><Route path="/workspace/chat/:convId" element={<ChatScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const conversationButtons = () => screen.queryAllByRole('button', { name: /voice conversation/i })

async function composerReady() {
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toBe('Message Qwen3 8B'))
}

describe('ChatScreen — the voice conversation is behind the Settings opt-in', () => {
  afterEach(() => { focusManager.setFocused(undefined); vi.unstubAllGlobals() })

  it('offers dictation only while the opt-in is off: no conversation button anywhere', async () => {
    mockLibrary = [loadedRow()]
    await renderScreen()
    await composerReady()
    expect(conversationButtons()).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: 'Record a voice message' }).length).toBeGreaterThan(0)
  })

  it('shows both conversation buttons (sm and up, and the phone one) once the opt-in is on', async () => {
    mockLibrary = [loadedRow()]
    act(() => useVoiceStore.getState().setConversation(true))
    await renderScreen()
    await composerReady()
    expect(conversationButtons()).toHaveLength(2)
    for (const button of conversationButtons()) expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('removes them when the opt-in is switched off while the screen is open', async () => {
    mockLibrary = [loadedRow()]
    act(() => useVoiceStore.getState().setConversation(true))
    await renderScreen()
    await composerReady()
    expect(conversationButtons()).toHaveLength(2)
    act(() => useVoiceStore.getState().setConversation(false))
    await waitFor(() => expect(conversationButtons()).toHaveLength(0))
  })

  it('and so does another tab switching it off (a storage event)', async () => {
    mockLibrary = [loadedRow()]
    act(() => useVoiceStore.getState().setConversation(true))
    await renderScreen()
    await composerReady()
    localStorage.setItem('tllm.voice.conversation', 'false')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'tllm.voice.conversation', newValue: 'false' })) })
    await waitFor(() => expect(conversationButtons()).toHaveLength(0))
  })
})
