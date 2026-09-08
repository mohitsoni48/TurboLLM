// Coverage for the Requests panel (issue #211 follow-up): the LM Studio-style developer log
// backed by TurboLLM's own proxy-layer capture (gateway.ts / chat-upstream.ts), NOT the
// engine's stderr — that's `MonitorLogPanel`'s job, a completely separate capture covered by
// MonitorTab.test.tsx. This exercises row rendering, the source filter, the gear menu's column
// toggle and body-capture switch, and opening a row's detail drawer. The live-tail SSE
// mechanics are `useRequestLog`'s own concern (mocked away here, same as `useEngineLog` is
// mocked in MonitorTab.test.tsx).
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestLogEntry } from '../../lib/types'
import type { DaemonSettings } from '../../lib/api'

function entry(over: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: 'r1', ts: Date.parse('2026-09-08T12:00:00Z'), source: 'openai', harness: 'claude_code',
    codeSessionId: null, modelKey: 'qwen3-8b', remote: null, stream: false,
    params: { temperature: 0.7 }, counts: { messages: 1, tools: 0, systemChars: 0 },
    status: 200, error: null, timings: { ttftMs: 120, durationMs: 900 },
    tokens: { prompt: 10, completion: 5, promptTps: 100, genTps: 50 }, finishReason: 'stop',
    bodies: null,
    ...over,
  }
}

const state = vi.hoisted(() => ({
  entries: [] as RequestLogEntry[],
  settings: { requestLog: { captureBodies: false } } as unknown as DaemonSettings,
  saveMutateCalls: [] as unknown[],
  trackCalls: [] as [string, string][],
  clearCalls: 0,
  detail: undefined as RequestLogEntry | undefined,
}))

vi.mock('../../lib/use-request-log', () => ({
  useRequestLog: () => ({
    entries: state.entries,
    autoScroll: true,
    setAutoScroll: vi.fn(),
    viewportRef: { current: null },
  }),
}))

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useSettings: () => ({
      query: { data: state.settings },
      save: { mutate: (patch: unknown) => { state.saveMutateCalls.push(patch) } },
    }),
  }
})

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    track: (screen: string, action: string) => { state.trackCalls.push([screen, action]) },
    clearRequests: () => { state.clearCalls += 1; return Promise.resolve({ ok: true as const }) },
    getRequestDetail: (id: string) => Promise.resolve({ entry: state.detail ?? state.entries.find((e) => e.id === id)! }),
  }
})

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return import('./RequestsPanel').then(({ RequestsPanel }) =>
    render(
      <QueryClientProvider client={qc}>
        <RequestsPanel active />
      </QueryClientProvider>,
    ),
  )
}

beforeEach(() => {
  state.entries = []
  state.settings = { requestLog: { captureBodies: false } } as unknown as DaemonSettings
  state.saveMutateCalls = []
  state.trackCalls = []
  state.clearCalls = 0
  state.detail = undefined
})

describe('RequestsPanel', () => {
  it('shows an empty state when nothing has been captured yet', async () => {
    await renderPanel()
    expect(screen.getByText(/No requests captured yet/)).toBeInTheDocument()
  })

  it('renders a row per entry with model, status, and token counts', async () => {
    state.entries = [entry(), entry({ id: 'r2', modelKey: 'other-model', status: 500, error: { code: 'engine_error', message: 'boom' } })]
    await renderPanel()

    expect(screen.getByText('qwen3-8b')).toBeInTheDocument()
    expect(screen.getByText('other-model')).toBeInTheDocument()
    expect(screen.getAllByText('10→5 tok')).toHaveLength(2)
  })

  it('the source filter chips narrow the visible rows', async () => {
    state.entries = [
      entry({ id: 'a', source: 'openai' }),
      entry({ id: 'b', source: 'anthropic', modelKey: 'claude-shaped' }),
      entry({ id: 'c', source: 'chat', modelKey: 'chat-model' }),
    ]
    await renderPanel()
    expect(screen.getAllByText(/qwen3-8b|claude-shaped|chat-model/)).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'API (Anthropic)' }))
    expect(screen.getByText('claude-shaped')).toBeInTheDocument()
    expect(screen.queryByText('qwen3-8b')).not.toBeInTheDocument()
    expect(screen.queryByText('chat-model')).not.toBeInTheDocument()
  })

  it('clicking a row opens the detail drawer and tracks the open', async () => {
    state.entries = [entry()]
    await renderPanel()

    fireEvent.click(screen.getByText('qwen3-8b'))
    expect(state.trackCalls).toContainEqual(['monitor', 'open_request_detail'])
    // The Params tab is the drawer's default view.
    expect(await screen.findByText('Sampling params')).toBeInTheDocument()
    expect(screen.getByText(/"temperature": 0.7/)).toBeInTheDocument()
  })

  it('the gear menu\'s "Log prompts and responses" switch patches settings and is tracked', async () => {
    state.entries = [entry()]
    await renderPanel()

    await userEvent.click(screen.getByRole('button', { name: 'Request log settings' }))
    const bodyToggle = await screen.findByText('Log prompts and responses')
    await userEvent.click(bodyToggle)

    expect(state.trackCalls).toContainEqual(['monitor', 'toggle_request_log_bodies'])
    expect(state.saveMutateCalls).toContainEqual({ requestLog: { captureBodies: true } })
  })

  it('the gear menu\'s "Clear log" calls clearRequests and is tracked', async () => {
    state.entries = [entry()]
    await renderPanel()

    await userEvent.click(screen.getByRole('button', { name: 'Request log settings' }))
    await userEvent.click(await screen.findByText('Clear log'))

    expect(state.trackCalls).toContainEqual(['monitor', 'clear_request_log'])
    await waitFor(() => expect(state.clearCalls).toBe(1))
  })

  it('a column toggle hides that column\'s value from every row', async () => {
    state.entries = [entry()]
    await renderPanel()
    expect(screen.getByText('claude_code')).toBeInTheDocument() // harness column, on by default

    await userEvent.click(screen.getByRole('button', { name: 'Request log settings' }))
    await userEvent.click(await screen.findByText('Harness'))

    expect(screen.queryByText('claude_code')).not.toBeInTheDocument()
  })
})
