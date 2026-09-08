// Issue #211 follow-up: MonitorTab is `MonitorScreen`'s content relocated from a standalone
// `/monitor` nav route into a tab of EnginesScreen (superseding ADR-409's 8-icon rail). This is
// the renamed/adapted twin of the old `MonitorScreen.test.tsx` — same composition coverage
// (gating the log on whether an engine is active, reusing `HardwareSection` unmodified for the
// stats half — not the log-fetch/SSE mechanics themselves, which are `useEngineLog`'s own
// concern) — plus one new case for the "Engine log | Requests" segmented control this tab
// gained (the actual feature this follow-up shipped: a second, TurboLLM-proxy-layer capture,
// not the engine's stderr).
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Engine, EnginesList, HwUsage, Status } from '../../lib/types'
import type { SysInfo, DaemonSettings } from '../../lib/api'

const state = vi.hoisted(() => ({
  enginesList: undefined as EnginesList | undefined,
  enginesIsLoading: false,
  enginesIsError: false,
  status: undefined as Status | undefined,
  hwUsage: undefined as HwUsage | undefined,
  sysInfo: undefined as SysInfo | undefined,
  settings: undefined as DaemonSettings | undefined,
  trackCalls: [] as [string, string][],
  getEngineLogsCalls: 0,
  getRequestsCalls: 0,
  refetchCalls: 0,
}))

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useEngines: () => ({
      data: state.enginesList,
      isLoading: state.enginesIsLoading,
      isError: state.enginesIsError,
      error: state.enginesIsError ? new Error('daemon unreachable') : null,
      refetch: () => { state.refetchCalls += 1 },
    }),
    useStatus: () => ({ data: state.status }),
    useHwUsage: () => ({ data: state.hwUsage, isFetching: false, isLoading: false }),
    useSysInfo: () => ({ data: state.sysInfo, isLoading: false }),
    useSettings: () => ({ query: { data: state.settings }, save: { mutate: () => {} } }),
  }
})

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    track: (screen: string, action: string) => { state.trackCalls.push([screen, action]) },
    getEngineLogs: (..._args: unknown[]) => {
      state.getEngineLogsCalls += 1
      return Promise.resolve({ lines: ['[turbollm] starting engine', 'ready'] })
    },
    getRequests: (..._args: unknown[]) => {
      state.getRequestsCalls += 1
      return Promise.resolve({ entries: [] })
    },
    clearRequests: () => Promise.resolve({ ok: true as const }),
  }
})

// jsdom has no EventSource. Neither `useEngineLog` nor `useRequestLog` need more than the
// constructor + addEventListener/close/onerror — nothing here fires a real frame.
class FakeEventSource {
  onerror: (() => void) | null = null
  addEventListener() {}
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource)

function engine(over: Partial<Engine> = {}): Engine {
  return {
    id: 'e1', name: 'llama.cpp', binPath: '/bin/llama-server', version: '1.0',
    capabilities: { flags: [] } as unknown as Engine['capabilities'],
    ...over,
  }
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return import('./MonitorTab').then(({ MonitorTab }) =>
    render(
      <QueryClientProvider client={qc}>
        <MonitorTab />
      </QueryClientProvider>,
    ),
  )
}

beforeEach(() => {
  state.enginesList = undefined
  state.enginesIsLoading = false
  state.enginesIsError = false
  state.status = undefined
  state.hwUsage = undefined
  state.sysInfo = undefined
  state.settings = undefined
  state.trackCalls = []
  state.getEngineLogsCalls = 0
  state.getRequestsCalls = 0
  state.refetchCalls = 0
})

describe('MonitorTab', () => {
  it('shows an empty state and never subscribes to the log when no engine is active', async () => {
    state.enginesList = { engines: [], activeEngineId: '', customDisabled: [] }
    await renderTab()

    expect(screen.getByText(/No engine selected/)).toBeInTheDocument()
    expect(state.getEngineLogsCalls).toBe(0)
  })

  it('tails the active engine\'s log once one is selected — default view', async () => {
    state.enginesList = { engines: [engine()], activeEngineId: 'e1', customDisabled: [] }
    state.status = { engine: { id: 'e1', name: 'llama.cpp', state: 'running' } } as unknown as Status
    await renderTab()

    await waitFor(() => expect(state.getEngineLogsCalls).toBe(1))
    expect(await screen.findByText('ready')).toBeInTheDocument()
    // The engine's name is surfaced in the header once it's active.
    expect(screen.getByText('llama.cpp')).toBeInTheDocument()
    // The Requests panel must NOT have mounted (and so must not have fetched) while "Engine
    // log" is the active view.
    expect(state.getRequestsCalls).toBe(0)
  })

  it('tracks the auto-scroll toggle on the monitor screen, not engines', async () => {
    state.enginesList = { engines: [engine()], activeEngineId: 'e1', customDisabled: [] }
    state.status = { engine: { id: 'e1', name: 'llama.cpp', state: 'running' } } as unknown as Status
    await renderTab()

    await waitFor(() => expect(state.getEngineLogsCalls).toBe(1))
    const toggle = screen.getAllByRole('switch')[0]
    fireEvent.click(toggle)

    expect(state.trackCalls).toContainEqual(['monitor', 'toggle_engine_log_autoscroll'])
  })

  it('the "Requests" segmented control switches to RequestsPanel, which fetches its own history', async () => {
    state.enginesList = { engines: [engine()], activeEngineId: 'e1', customDisabled: [] }
    state.status = { engine: { id: 'e1', name: 'llama.cpp', state: 'running' } } as unknown as Status
    await renderTab()
    await waitFor(() => expect(state.getEngineLogsCalls).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: 'Requests' }))
    expect(state.trackCalls).toContainEqual(['monitor', 'switch_monitor_view'])

    await waitFor(() => expect(state.getRequestsCalls).toBe(1))
    // The engine-log view's own content must be gone now that Requests is active.
    expect(screen.queryByText('ready')).not.toBeInTheDocument()
    expect(screen.getByText(/No requests captured yet/)).toBeInTheDocument()
  })

  it('shows a neutral loading state instead of flashing "No engine selected" while engines are still loading', async () => {
    state.enginesIsLoading = true
    await renderTab()

    expect(screen.getByText(/Loading/)).toBeInTheDocument()
    expect(screen.queryByText(/No engine selected/)).not.toBeInTheDocument()
    expect(state.getEngineLogsCalls).toBe(0)
  })

  it('shows a retryable error, not a misleading "No engine selected", when the engines list fails to load', async () => {
    state.enginesIsError = true
    await renderTab()

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/No engine selected/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(state.refetchCalls).toBe(1)
  })

  it('renders the system stats pane (HardwareSection) below the log', async () => {
    state.enginesList = { engines: [], activeEngineId: '', customDisabled: [] }
    state.sysInfo = {
      gpus: [{ name: 'RTX 4090', vramMb: 24000 }],
      cpu: 'Ryzen 9', cores: 16, ramMB: 32000, os: 'Windows',
    } as unknown as SysInfo
    await renderTab()

    expect(screen.getByText('Hardware')).toBeInTheDocument()
    expect(screen.getByText(/RTX 4090/)).toBeInTheDocument()
  })
})
