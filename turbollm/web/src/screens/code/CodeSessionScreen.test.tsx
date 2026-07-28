// Closes the test-coverage gap TODO.md flagged for CodeSessionScreen.tsx: "the toast-on-send and
// reconnect-seeding logic there aren't unit-testable as-is." Renders the REAL screen (real hooks,
// real send()/effects) with the heavy child components stubbed out and the API/SSE layers mocked
// — same "mock at the API boundary, keep the screen's own logic real" discipline as
// CodeGitDialog.test.tsx, extended with a controllable fake CodeSessionClient since that class
// owns its own fetch-based streaming internally.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import type { CodeSessionDetail } from '../../lib/code-api'

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

vi.mock('../../lib/code-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-api')>()
  return {
    ...actual, // keeps steerOutcomeMessage etc. real — pure formatters, no reason to fake them
    getCodeSession: (...args: unknown[]) => getCodeSessionMock(...args),
    startCodeRun: (...args: unknown[]) => startCodeRunMock(...args),
    stopCodeSession: (...args: unknown[]) => stopCodeSessionMock(...args),
  }
})

// ── lib/queries.ts (useStatus/useModels/useModelActions) — this screen only reads status ──
vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' } } }),
    useModels: () => ({ data: { models: [] } }),
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
vi.mock('./CodeTranscript', () => ({
  CodeTranscript: () => null,
  CodeTranscriptSkeleton: () => null,
  TodoChecklist: () => null,
}))
// A minimal, interactive stand-in for the real composer — exposes exactly the two triggers these
// tests need (a plain send and a steer send) without depending on its own internal state machine.
vi.mock('./CodeComposer', () => ({
  CodeComposer: (props: { value: string; onValueChange: (v: string) => void; onSubmit: (kind?: 'followUp' | 'steer') => void }) => (
    <div>
      <textarea aria-label="composer" value={props.value} onChange={(e) => props.onValueChange(e.target.value)} />
      <button onClick={() => props.onSubmit()}>Send</button>
      <button onClick={() => props.onSubmit('steer')}>Steer</button>
    </div>
  ),
}))

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
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/code/sess-1']}>
        <Routes>
          <Route path="/workspace/code/:sessionId" element={<ScreenUnderTest />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Lazily resolved so the module-level mocks above are guaranteed registered first.
let ScreenComp: React.ComponentType | null = null
function ScreenUnderTest() {
  if (!ScreenComp) throw new Error('ScreenUnderTest used before importScreen() resolved')
  const S = ScreenComp
  return <S />
}

describe('CodeSessionScreen — reconnect-on-load seeding', () => {
  beforeEach(async () => {
    connectSpy.mockClear()
    abortSpy.mockClear()
    fakeIsActive = false
    getCodeSessionMock.mockReset()
    ScreenComp = await importScreen()
  })

  it('a session opened while a run is live in the daemon calls client.connect() to attach, instead of assuming nothing is in flight', async () => {
    getCodeSessionMock.mockResolvedValue(detail({ running: true }))
    renderScreen()
    await waitFor(() => expect(connectSpy).toHaveBeenCalled())
  })

  it('does NOT call connect() when nothing is running in the daemon', async () => {
    getCodeSessionMock.mockResolvedValue(detail({ running: false }))
    renderScreen()
    await waitFor(() => expect(getCodeSessionMock).toHaveBeenCalled())
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('does NOT call connect() again if the client already reports itself active (no duplicate stream)', async () => {
    fakeIsActive = true
    getCodeSessionMock.mockResolvedValue(detail({ running: true }))
    renderScreen()
    await waitFor(() => expect(getCodeSessionMock).toHaveBeenCalled())
    expect(connectSpy).not.toHaveBeenCalled()
  })
})

describe('CodeSessionScreen — toast-on-send', () => {
  beforeEach(async () => {
    connectSpy.mockClear()
    toastSuccess.mockClear()
    toastError.mockClear()
    getCodeSessionMock.mockReset()
    startCodeRunMock.mockReset()
    getCodeSessionMock.mockResolvedValue(detail({ running: false }))
    ScreenComp = await importScreen()
  })

  it('a successful steer send shows a success toast built from the real outcome (steered: true)', async () => {
    startCodeRunMock.mockResolvedValue({ steered: true })
    const user = userEvent.setup()
    renderScreen()
    await screen.findByLabelText('composer')
    await user.type(screen.getByLabelText('composer'), 'redirect the current turn')
    await user.click(screen.getByRole('button', { name: 'Steer' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(toastSuccess.mock.calls[0][0]).toMatch(/redirect|steer/i)
  })

  it('a steer send that could not actually interject (queued instead) shows the honest outcome, not a false "redirected" claim', async () => {
    startCodeRunMock.mockResolvedValue({ steered: false })
    const user = userEvent.setup()
    renderScreen()
    await screen.findByLabelText('composer')
    await user.type(screen.getByLabelText('composer'), 'redirect the current turn')
    await user.click(screen.getByRole('button', { name: 'Steer' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(toastSuccess.mock.calls[0][0]).not.toMatch(/redirect/i)
  })

  it('a plain follow-up send shows NO toast on success — its queued card is the only feedback', async () => {
    startCodeRunMock.mockResolvedValue({ steered: false })
    const user = userEvent.setup()
    renderScreen()
    await screen.findByLabelText('composer')
    await user.type(screen.getByLabelText('composer'), 'a normal follow-up')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(startCodeRunMock).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('a failed send shows an error toast and restores the typed text rather than losing it', async () => {
    startCodeRunMock.mockRejectedValue(new ApiError('internal', 'Could not send.', 500))
    const user = userEvent.setup()
    renderScreen()
    await screen.findByLabelText('composer')
    await user.type(screen.getByLabelText('composer'), 'this should survive the failure')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByLabelText('composer')).toHaveValue('this should survive the failure')
  })

  it('a successful send re-connects the stream (clientRef.current?.connect()) so the client picks up the newly-started/queued turn', async () => {
    startCodeRunMock.mockResolvedValue({ steered: false })
    const user = userEvent.setup()
    renderScreen()
    await screen.findByLabelText('composer')
    connectSpy.mockClear() // clear the reconnect-on-load call this same render already made
    await user.type(screen.getByLabelText('composer'), 'go')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(connectSpy).toHaveBeenCalled())
  })
})
