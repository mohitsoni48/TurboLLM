// A terminal-agent session (claude/pi/opencode) got a live reasoning-effort override of 'xhigh' the moment it opened,
// whatever the loaded model: DEFAULT_REASONING_EFFORT, the select's resting position (Qwen3.8's template default,
// chosen in f472730 so an untouched control changed nothing), was PATCHed as if picked, and the gateway injected it
// into every request of the session, which LiteRT-LM reads as thinking on. It now syncs only a level the user chose,
// and only while the loaded model shows the select; otherwise no override. Harness of CodeSessionScreen.test.tsx.
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeSessionDetail } from '../../lib/code-api'
import type { ModelEntry } from '../../lib/types'

// jsdom's environment doesn't wire up a working localStorage (authHeaders() reads it on every
// call) — same gap CodeComposer.test.tsx/CodeGitDialog.test.tsx/code-api.test.ts already work around.
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

// ── controllable fake CodeSessionClient ──────────────────────────────────────────────
// The real class owns a fetch-based SSE loop internally with no injectable transport at this
// boundary; replacing the whole module is simpler and more robust than trying to mock fetch/
// ReadableStream. Captures the handlers passed to the constructor so a test can manually fire
// onTurnDone/onLostConnection/etc., and exposes connect/abort as spies.
const connectSpy = vi.fn()
const abortSpy = vi.fn()
let fakeIsActive = false

vi.mock('../../lib/code-session-client', () => ({
  CodeSessionClient: class {
    constructor(_sessionId: string, _handlers: Record<string, (...args: unknown[]) => unknown>) {}
    get isActive() { return fakeIsActive }
    connect = connectSpy
    abort = abortSpy
  },
}))

// ── code-api.ts — mock only the calls this screen's own logic makes ─────────────────
const getCodeSessionMock = vi.fn()
const startCodeRunMock = vi.fn()
const stopCodeSessionMock = vi.fn()
const compactCodeSessionMock = vi.fn()
const effortPatches: Array<{ id: string; effort: unknown }> = []

vi.mock('../../lib/code-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-api')>()
  return {
    ...actual, // keeps steerOutcomeMessage etc. real — pure formatters, no reason to fake them
    getCodeSession: (...args: unknown[]) => getCodeSessionMock(...args),
    startCodeRun: (...args: unknown[]) => startCodeRunMock(...args),
    stopCodeSession: (...args: unknown[]) => stopCodeSessionMock(...args),
    compactCodeSession: (...args: unknown[]) => compactCodeSessionMock(...args),
    updateCodeSessionReasoningEffort: (id: string, effort: unknown) => { effortPatches.push({ id, effort }); return Promise.resolve({ ok: true, effort }) },
    updateCodeSessionThinkingBudget: () => Promise.resolve({ ok: true }),
  }
})

// ── lib/queries.ts (useStatus/useModels/useModelActions) — this screen only reads status ──
// The library is empty unless a test sets it, so the tests that don't care see what they always saw.
let mockLibrary: Array<Partial<ModelEntry>> = []
let loadedModel: { key: string; name: string } | undefined = undefined
vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' }, model: loadedModel } }),
    useModels: () => ({ data: { models: mockLibrary } }),
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
  }
})

vi.mock('../../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})

vi.mock('../../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))

// ── heavy child components — stubbed to keep this test scoped to the SCREEN's own logic ──
vi.mock('../chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./CodeResourcesHeader', () => ({ CodeResourcesHeader: () => null }))
vi.mock('./CodeGitDialog', () => ({ CodeGitDialog: () => null }))
vi.mock('../models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('../engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('../chat/ToolApprovalBar', () => ({ ToolApprovalBar: () => null }))
vi.mock('./CodeTranscript', () => ({ CodeTranscript: () => null, CodeTranscriptSkeleton: () => null, TodoChecklist: () => null }))
vi.mock('./CodeComposer', () => ({ CodeComposer: () => null }))
// A terminal-agent session (claude/pi/opencode) mounts these two instead of the composer; the real
// TerminalView needs a canvas that jsdom does not have.
vi.mock('./TerminalView', async () => {
  const { forwardRef } = await import('react')
  return { TerminalView: forwardRef(() => null) }
})
vi.mock('./TerminalToolbar', () => ({ TerminalToolbar: () => null }))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('../../components/ui/sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

async function importScreen() {
  // Imported dynamically, after the mocks above are registered (vi.mock calls are hoisted by
  // vitest regardless of import order, but this keeps the file's own reading order honest).
  const mod = await import('./CodeSessionScreen')
  return mod.CodeSessionScreen
}

function detail(overrides: Partial<CodeSessionDetail> = {}): CodeSessionDetail {
  return {
    session: {
      id: 'sess-1', convId: 'conv-1', title: 'Fix the bug', status: 'review',
      branch: 'main', when: 'now', add: 0, del: 0, mode: 'auto',
      createdAt: new Date().toISOString(), repoRoot: '/repo',
    },
    conversation: {
      id: 'conv-1', title: 'Fix the bug', systemPrompt: '', modelKey: 'model-a', sampling: {},
      expertMode: false,
      messages: [
        { id: 'm1', convId: 'conv-1', seq: 1, role: 'user', content: 'fix the bug', reasoning: '', attachments: [], textAttachments: [], toolCalls: [], stats: {}, createdAt: new Date().toISOString(), variantGroup: null, isActive: true },
        { id: 'm2', convId: 'conv-1', seq: 2, role: 'assistant', content: 'done', reasoning: '', attachments: [], textAttachments: [], toolCalls: [], stats: {}, createdAt: new Date().toISOString(), variantGroup: null, isActive: true },
      ],
    },
    doc: null,
    running: false,
    queued: [],
    ...overrides,
  } as unknown as CodeSessionDetail
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return Object.assign(render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/code/sess-1']}>
        <Routes>
          <Route path="/workspace/code/:sessionId" element={<ScreenUnderTest />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ), { qc })
}

// Lazily resolved so the module-level mocks above are guaranteed registered first.
let ScreenComp: React.ComponentType | null = null
function ScreenUnderTest() {
  if (!ScreenComp) throw new Error('ScreenUnderTest used before importScreen() resolved')
  const S = ScreenComp
  return <S />
}

function terminalSession(): CodeSessionDetail {
  const t = detail()
  t.session.codeAgent = 'claude'
  return t
}

describe('CodeSessionScreen — a terminal session\'s reasoning-effort override is the user\'s, or none', () => {
  beforeEach(async () => {
    effortPatches.length = 0
    getCodeSessionMock.mockReset()
    loadedModel = undefined
    mockLibrary = []
    ScreenComp = await importScreen()
  })
  afterEach(() => { mockLibrary = []; loadedModel = undefined })

  it('with nothing chosen, the session opens with no override: the model\'s own default applies', async () => {
    loadedModel = { key: 'qwen38', name: 'Qwen3.8' }
    mockLibrary = [{ key: 'qwen38', name: 'Qwen3.8', reasoningEffort: true }]
    getCodeSessionMock.mockResolvedValue(terminalSession())
    renderScreen()
    await waitFor(() => expect(effortPatches.length).toBeGreaterThan(0))
    expect(effortPatches.every((p) => p.effort === null)).toBe(true)
  })

  it('a level the user chose is synced while the loaded model shows the select', async () => {
    localStorage.setItem('tllm.reasoningEffort.sess-1', 'low')
    loadedModel = { key: 'qwen38', name: 'Qwen3.8' }
    mockLibrary = [{ key: 'qwen38', name: 'Qwen3.8', reasoningEffort: true }]
    getCodeSessionMock.mockResolvedValue(terminalSession())
    renderScreen()
    await waitFor(() => expect(effortPatches.at(-1)?.effort).toBe('low'))
  })

  it('a chosen level is not synced to a model without the select (a .litertlm): no override', async () => {
    localStorage.setItem('tllm.reasoningEffort.default', 'low')
    loadedModel = { key: 'lfm', name: 'LFM2.5 230M' }
    mockLibrary = [{ key: 'lfm', name: 'LFM2.5 230M', format: 'litertlm', reasoningEffort: false }]
    getCodeSessionMock.mockResolvedValue(terminalSession())
    renderScreen()
    await waitFor(() => expect(effortPatches.length).toBeGreaterThan(0))
    expect(effortPatches.every((p) => p.effort === null)).toBe(true)
  })
})
