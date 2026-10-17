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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  /** The hook's own list was emptied — logged as `local` AFTER the daemon's clear (`daemon`). */
  clearOrder: [] as string[],
  detail: undefined as RequestLogEntry | undefined,
  clearFails: false,
  toastErrors: [] as string[],
  /** The daemon's own copy (`GET /requests`), and the `bodies` flag of every call to it. */
  listed: [] as RequestLogEntry[],
  listCalls: [] as boolean[],
  listFails: false,
}))

vi.mock('../../components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ui/sonner')>()
  return { ...actual, toast: { ...actual.toast, error: (msg: string) => { state.toastErrors.push(msg) } } }
})

vi.mock('../../lib/use-request-log', () => ({
  useRequestLog: () => ({
    entries: state.entries,
    autoScroll: true,
    setAutoScroll: vi.fn(),
    viewportRef: { current: null },
    clear: () => { state.clearOrder.push('local') },
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
    clearRequests: () => {
      state.clearCalls += 1
      if (state.clearFails) return Promise.reject(new Error('503'))
      state.clearOrder.push('daemon')
      return Promise.resolve({ ok: true as const })
    },
    getRequests: (_filter: unknown, bodies = false) => {
      state.listCalls.push(bodies)
      return state.listFails ? Promise.reject(new Error('503')) : Promise.resolve({ entries: state.listed })
    },
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
  state.clearOrder = []
  state.detail = undefined
  state.clearFails = false
  state.toastErrors = []
  state.listed = []
  state.listCalls = []
  state.listFails = false
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
    // ...and then empties the panel's own list: the stream never says the log was cleared, so the
    // rows (a pending one included) used to stay on screen.
    await waitFor(() => expect(state.clearOrder).toEqual(['daemon', 'local']))
  })

  it('a refused "Clear log" says so and keeps the rows, instead of an unhandled rejection', async () => {
    state.entries = [entry()]
    state.clearFails = true
    await renderPanel()

    await userEvent.click(screen.getByRole('button', { name: 'Request log settings' }))
    await userEvent.click(await screen.findByText('Clear log'))

    await waitFor(() => expect(state.toastErrors).toEqual(['Could not clear the request log.']))
    expect(state.clearOrder).toEqual([])
  })

  describe('Export JSONL', () => {
    // jsdom has no Blob-URL APIs, and following a real blob: link logs a "not implemented:
    // navigation" warning — both stubbed at the browser boundary, so the panel's own download
    // code runs and the exported Blob is captured for reading back.
    let exported: Blob[] = []
    const realUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    beforeEach(() => {
      exported = []
      URL.createObjectURL = vi.fn((b: Blob) => { exported.push(b); return 'blob:mock-url' })
      URL.revokeObjectURL = vi.fn()
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    })
    afterEach(() => {
      URL.createObjectURL = realUrl.create
      URL.revokeObjectURL = realUrl.revoke
      vi.restoreAllMocks()
    })

    const readExport = async () => {
      await waitFor(() => expect(exported).toHaveLength(1))
      const text = await new Promise<string>((resolve) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as string)
        r.readAsText(exported[0])
      })
      return text.split('\n').map((l) => JSON.parse(l) as RequestLogEntry)
    }

    const clickExport = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Request log settings' }))
      await userEvent.click(await screen.findByText('Export JSONL'))
    }

    it('with body capture on, exports the daemon\'s copy WITH bodies — the panel\'s streamed rows never carry them', async () => {
      state.settings = { requestLog: { captureBodies: true } } as unknown as DaemonSettings
      state.entries = [entry()] // as streamed: bodies stripped
      state.listed = [entry({ bodies: { request: '{"messages":[]}', response: 'hello' } })]
      await renderPanel()

      await clickExport()

      const rows = await readExport()
      expect(state.listCalls).toEqual([true])
      expect(rows.map((r) => r.bodies)).toEqual([{ request: '{"messages":[]}', response: 'hello' }])
      expect(state.trackCalls).toContainEqual(['monitor', 'export_request_log'])
    })

    it('with body capture on, still exports the rows the daemon already evicted (its 32 MB body budget) — metadata only', async () => {
      state.settings = { requestLog: { captureBodies: true } } as unknown as DaemonSettings
      state.entries = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]
      // a and b were evicted daemon-side; the stream never says so, so the panel still shows them.
      state.listed = [entry({ id: 'c', bodies: { request: '{"messages":[]}', response: 'hi' } })]
      await renderPanel()

      await clickExport()

      const rows = await readExport()
      expect(rows.map((r) => [r.id, r.bodies])).toEqual([
        ['a', null],
        ['b', null],
        ['c', { request: '{"messages":[]}', response: 'hi' }],
      ])
    })

    it('with body capture off, exports the panel\'s rows without a daemon round-trip', async () => {
      state.entries = [entry({ id: 'a' }), entry({ id: 'b' })]
      await renderPanel()

      await clickExport()

      const rows = await readExport()
      expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
      expect(state.listCalls).toEqual([])
    })

    it('a failed body fetch still exports the metadata rows, and says the bodies are missing', async () => {
      state.settings = { requestLog: { captureBodies: true } } as unknown as DaemonSettings
      state.entries = [entry({ id: 'a' })]
      state.listFails = true
      await renderPanel()

      await clickExport()

      const rows = await readExport()
      expect(rows.map((r) => r.id)).toEqual(['a'])
      expect(state.toastErrors).toEqual(['Could not fetch the captured bodies — exported without them.'])
    })
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
