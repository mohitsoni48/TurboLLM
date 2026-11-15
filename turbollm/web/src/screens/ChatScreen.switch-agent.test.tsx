// Switching the agent of a chat that already has messages (GitHub #52: "change the agent once the first message has
// been sent"). The header's agent badge is a menu; picking an agent PATCHes the chat with what that agent decides:
// system prompt, tool allow-list, Research's forced web search and the skills it brings. Same screen harness as
// ChatScreen.thinking-default.test.tsx, with an open conversation.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import { buildAgentConfig } from '../lib/agent-conversation'
import { getPersonalization, resolveAgents } from '../lib/personas'
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
  conv = { ...BASE_CONV, systemPrompt: promptOf('default') }
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

/** What `agentId` generates for a chat, so a chat starts out with an unedited prompt (no confirmation) unless a test edits it. */
const promptOf = (agentId: string) =>
  buildAgentConfig(agentId, resolveAgents(customAgents, {}).find((a) => a.id === agentId), getPersonalization()).systemPrompt

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

const agentButton = () => screen.findByRole('button', { name: /Change agent/ })

async function pick(name: RegExp) {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  await user.click(await agentButton())
  await user.click(await screen.findByRole('menuitem', { name }))
}

describe('ChatScreen — switching the agent of a chat that has messages', () => {
  afterEach(() => { focusManager.setFocused(undefined) })

  it('shows the chat’s agent in the header as a menu, defaulting to Default', async () => {
    mockLibrary = [loadedRow()]
    await renderScreen()
    expect((await agentButton()).textContent).toContain('Default')
  })

  it('names the agent the daemon stored with the chat, with nothing in this browser’s memory', async () => {
    mockLibrary = [loadedRow()]
    conv = { ...BASE_CONV, chatAgentId: 'writer', systemPrompt: promptOf('writer') }
    await renderScreen()
    expect((await agentButton()).textContent).toContain('Writer')
  })

  it('a chat opened straight from its URL shows its own agent, not the default', async () => {
    mockLibrary = [loadedRow()]
    localStorage.setItem('tllm.persona.conv.c1', 'writer')
    await renderScreen()
    expect((await agentButton()).textContent).toContain('Writer')
  })

  it('Blank rewrites the chat: empty system prompt, no tools, no web-search policy; its own skills leave, the user’s stay', async () => {
    mockLibrary = [loadedRow()]
    conv = { ...BASE_CONV, chatAgentId: 'writer', systemPrompt: promptOf('writer') }
    await renderScreen()
    await pick(/Blank/)
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
    expect(updateMutateAsync.mock.calls[0][0]).toEqual({
      id: 'c1', chatAgentId: 'blank', systemPrompt: '', allowedTools: [], toolPolicy: null, skillIds: ['user-picked'],
    })
    await waitFor(() => expect(localStorage.getItem('tllm.persona.conv.c1')).toBe('blank'))
    expect(trackSpy).toHaveBeenCalledWith('chat', 'switch_agent')
  })

  it('Research forces web search and leaves every tool allowed (null clears the allow-list)', async () => {
    mockLibrary = [loadedRow()]
    conv = { ...BASE_CONV, chatAgentId: 'writer', systemPrompt: promptOf('writer') }
    await renderScreen()
    await pick(/Research/)
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
    const patch = updateMutateAsync.mock.calls[0][0] as { systemPrompt: string; allowedTools: unknown; toolPolicy: unknown; skillIds: string[] }
    expect([patch.allowedTools, patch.toolPolicy, patch.skillIds]).toEqual([null, 'force_web_search', ['user-picked']])
    expect(patch.systemPrompt).toContain('TurboLLM')
  })

  it('a custom agent brings its prompt, tool list and skills', async () => {
    mockLibrary = [loadedRow()]
    conv = { ...BASE_CONV, skillIds: ['user-picked'], allowedTools: undefined, systemPrompt: promptOf('default') }
    await renderScreen()
    await pick(/Writer/)
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
    const patch = updateMutateAsync.mock.calls[0][0] as { systemPrompt: string; allowedTools: string[]; skillIds: string[] }
    expect(patch.systemPrompt).toContain('You write.')
    expect([patch.allowedTools, patch.skillIds]).toEqual([['web_search'], ['user-picked', 's-write']])
  })

  it('injects what creation injects: the user’s memory facts, and the hardware for the Expert agent', async () => {
    mockLibrary = [loadedRow()]
    settingsData = { autoMemoryEnabled: true }
    await renderScreen()
    await pick(/TurboLLM Expert/)
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
    const { systemPrompt } = updateMutateAsync.mock.calls[0][0] as { systemPrompt: string }
    expect(systemPrompt).toContain('- likes tea')
    expect(systemPrompt).toContain("## User's hardware\nGPU: RTX 3050 (6 GB VRAM)\nRAM: 16 GB\nOS: win32")
    expect(listMemoryFactsMock).toHaveBeenCalledTimes(1)
    expect(fetchSysInfoMock).toHaveBeenCalledTimes(1)
  })

  it('a chat with its own system prompt asks before replacing it: Keep it changes nothing, Switch agent switches', async () => {
    mockLibrary = [loadedRow()]
    conv = { ...BASE_CONV, systemPrompt: 'You are a pirate.' }
    await renderScreen()
    await pick(/Blank/)
    expect(await screen.findByText('Replace this chat’s system prompt?')).toBeTruthy()
    expect(updateMutateAsync).not.toHaveBeenCalled()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(updateMutateAsync).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Replace this chat’s system prompt?')).toBeNull())
    await pick(/Blank/)
    await user.click(await screen.findByRole('button', { name: 'Switch agent' }))
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
    expect((updateMutateAsync.mock.calls[0][0] as { systemPrompt: string }).systemPrompt).toBe('')
  })

  it('the built-in Expert thread, whose prompt the daemon manages, shows the agent but cannot be switched', async () => {
    mockLibrary = [loadedRow()]
    conv = { ...BASE_CONV, expertMode: true }
    await renderScreen()
    await waitFor(() => expect(screen.getByText('Default')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Change agent/ })).toBeNull()
    expect(screen.getByText('Default').closest('span[title]')!.getAttribute('title')).toContain('TurboLLM Expert thread')
  })

  it('locks the menu while a switch is in flight, so a second pick cannot start from a stale agent', async () => {
    mockLibrary = [loadedRow()]
    let finish!: () => void
    updateMutateAsync.mockImplementationOnce(() => new Promise<Record<string, unknown>>((resolve) => { finish = () => resolve({}) }))
    await renderScreen()
    await pick(/Blank/)
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Change agent/ })).toBeNull())
    finish()
    expect((await agentButton()).textContent).toContain('Blank')
  })

  it('a failed switch leaves the header on the old agent', async () => {
    mockLibrary = [loadedRow()]
    updateMutateAsync.mockRejectedValueOnce(new ApiError('boom', 'The daemon said no.', 500))
    await renderScreen()
    await pick(/Blank/)
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('tllm.persona.conv.c1')).toBeNull()
    expect((await agentButton()).textContent).toContain('Default')
  })
})
