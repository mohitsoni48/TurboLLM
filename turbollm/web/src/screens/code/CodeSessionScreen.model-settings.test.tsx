// Issue 270: picking "settings" from a Code session's model picker must close the picker and
// leave the settings dialog open with focus inside it. Renders the REAL CodeSessionScreen with the
// REAL CodeComposer / TerminalToolbar and the REAL ModelLoadMenu; only the session API, data hooks
// and heavy children are stubbed, and ModelDetailDialog is replaced by a stub that renders a real
// dialog. Covers both entry points: the composer (chat-style session) and the terminal toolbar
// (a non-opencode terminal agent, whose picker is not blocked).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeSessionDetail } from '../../lib/code-api'
import type { ModelEntry } from '../../lib/types'

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
})

const MODEL_KEY = 'unsloth/Qwen3-8B-GGUF/Q8_0.gguf'
const loadableModel = {
  key: MODEL_KEY, name: 'Qwen3 8B', quant: 'Q8_0', incomplete: false, parseError: null,
  loaded: false, compatibleWithActiveEngine: true,
} as Partial<ModelEntry>

const getCodeSessionMock = vi.fn()

vi.mock('../../lib/code-session-client', () => ({
  CodeSessionClient: class {
    constructor(_sessionId: string, _handlers: Record<string, (...args: unknown[]) => unknown>) {}
    get isActive() { return false }
    connect = vi.fn()
    abort = vi.fn()
  },
}))

vi.mock('../../lib/code-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-api')>()
  return { ...actual, getCodeSession: (...args: unknown[]) => getCodeSessionMock(...args) }
})

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' } } }),
    useModels: () => ({ data: { models: [loadableModel] } }),
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

vi.mock('../chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./CodeResourcesHeader', () => ({ CodeResourcesHeader: () => null }))
vi.mock('./CodeGitDialog', () => ({ CodeGitDialog: () => null }))
vi.mock('../engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('../chat/ToolApprovalBar', () => ({ ToolApprovalBar: () => null }))
vi.mock('./CodeTranscript', () => ({
  CodeTranscript: () => null,
  CodeTranscriptSkeleton: () => null,
  TodoChecklist: () => null,
}))
vi.mock('./TerminalView', async () => {
  const { forwardRef } = await import('react')
  return { TerminalView: forwardRef(() => null) }
})
vi.mock('../models/ModelDetailDialog', async () => {
  const { Dialog, DialogContent, DialogTitle } = await import('../../components/ui/dialog')
  return {
    ModelDetailDialog: ({ modelKey, onClose }: { modelKey: string | null; onClose: () => void }) => (
      <Dialog open={!!modelKey} onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent>
          <DialogTitle>Settings {modelKey}</DialogTitle>
          <input aria-label="Context length" />
        </DialogContent>
      </Dialog>
    ),
  }
})

function sessionDetail(codeAgent?: string): CodeSessionDetail {
  const detail = {
    session: {
      id: 'sess-1', convId: 'conv-1', title: 'Fix the bug', status: 'review',
      branch: 'main', when: 'now', add: 0, del: 0, mode: 'auto',
      createdAt: new Date().toISOString(), repoRoot: '/repo',
    },
    conversation: { id: 'conv-1', title: 'Fix the bug', systemPrompt: '', modelKey: '', sampling: {}, expertMode: false, messages: [] },
    doc: null,
    running: false,
    queued: [],
  } as unknown as CodeSessionDetail
  if (codeAgent) detail.session.codeAgent = codeAgent as never
  return detail
}

let CodeSessionScreen: typeof import('./CodeSessionScreen').CodeSessionScreen

// The cold import transforms the whole screen tree, which starves for tens of seconds under load;
// it gets its own hook timeout so no test timeout has to cover it.
beforeAll(async () => {
  ;({ CodeSessionScreen } = await import('./CodeSessionScreen'))
}, 120_000)

async function renderSession(codeAgent?: string) {
  getCodeSessionMock.mockResolvedValue(sessionDetail(codeAgent))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const rendered = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/code/sess-1']}>
        <Routes><Route path="/workspace/code/:sessionId" element={<CodeSessionScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // The session loads asynchronously: wait for the loaded session's own chrome so the picker is
  // not opened on the pre-load composer, which the terminal toolbar then replaces.
  await screen.findByText(codeAgent ?? 'Fix the bug')
  return rendered
}

// Radix hands focus back to the trigger by calling trigger.focus() directly, and the open dialog's
// focus trap later pulls focus away again, so only a spy on that call separates a hand-off from a
// focus steal.
async function openPicker() {
  const trigger = await screen.findByRole('button', { name: /load a model/i })
  const triggerFocus = vi.spyOn(trigger, 'focus')
  await userEvent.click(trigger)
  const row = await screen.findByRole('menuitem', { name: /qwen3 8b/i })
  return { row, triggerFocus }
}

// jsdom cannot show a real focus steal or the soft keyboard; that stays a live check (plan Task 9 step 3).
async function expectSettingsDialogOpenAndPickerNeverRefocused(triggerFocus: { mock: { calls: unknown[] } }) {
  const dialog = await screen.findByRole('dialog', { name: `Settings ${MODEL_KEY}` })
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
  await new Promise((resolve) => setTimeout(resolve, 0)) // the focus scope's unmount auto-focus is deferred
  expect(triggerFocus.mock.calls).toHaveLength(0)
  await userEvent.keyboard('8192')
  expect(screen.getByLabelText('Context length')).toHaveValue('8192')
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

describe.each([
  ['composer', undefined],
  ['terminal toolbar (claude)', 'claude'],
])('CodeSessionScreen %s — model settings hand-off from the picker', (_entryPoint, codeAgent) => {
  beforeEach(() => getCodeSessionMock.mockReset())
  afterEach(cleanup)

  it('Alt+click on a model row opens the settings dialog, closes the picker and never refocuses the picker trigger', async () => {
    await renderSession(codeAgent)
    const { row, triggerFocus } = await openPicker()

    fireEvent.click(row, { altKey: true })

    await expectSettingsDialogOpenAndPickerNeverRefocused(triggerFocus)
  })

  it('the sliders button opens the settings dialog, closes the picker and never refocuses the picker trigger', async () => {
    await renderSession(codeAgent)
    const { triggerFocus } = await openPicker()

    fireEvent.click(screen.getByRole('button', { name: /configure qwen3 8b before loading/i }))

    await expectSettingsDialogOpenAndPickerNeverRefocused(triggerFocus)
  })
})
