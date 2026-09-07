// Issue #211: Monitor is a first-class nav destination combining the live engine log
// (previously only reachable via Engines' collapsed diagnostics drawer) and system stats
// (previously only under Settings → System). This covers the screen's own composition —
// gating the log on whether an engine is active, and reusing `HardwareSection` unmodified for
// the stats half — not the log-fetch/SSE mechanics themselves, which are `useEngineLog`'s
// (shared with `EngineLogPanel.tsx`, that file's own concern).
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Engine, EnginesList, HwUsage, Status } from '../lib/types'
import type { SysInfo } from '../lib/api'

const state = vi.hoisted(() => ({
  enginesList: undefined as EnginesList | undefined,
  status: undefined as Status | undefined,
  hwUsage: undefined as HwUsage | undefined,
  sysInfo: undefined as SysInfo | undefined,
  trackCalls: [] as [string, string][],
  getEngineLogsCalls: 0,
}))

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useEngines: () => ({ data: state.enginesList, isLoading: false, isError: false }),
    useStatus: () => ({ data: state.status }),
    useHwUsage: () => ({ data: state.hwUsage, isFetching: false, isLoading: false }),
    useSysInfo: () => ({ data: state.sysInfo, isLoading: false }),
  }
})

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    track: (screen: string, action: string) => { state.trackCalls.push([screen, action]) },
    getEngineLogs: (..._args: unknown[]) => {
      state.getEngineLogsCalls += 1
      return Promise.resolve({ lines: ['[turbollm] starting engine', 'ready'] })
    },
  }
})

// jsdom has no EventSource. `useEngineLog` only needs the constructor to exist and to accept
// `.addEventListener`/`.close`/`.onerror` — nothing here ever fires a real 'line' frame, so a
// no-op stub is enough (mirrors the PointerEvent-polyfill pattern in test/setup.ts).
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

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return import('./MonitorScreen').then(({ MonitorScreen }) =>
    render(
      <QueryClientProvider client={qc}>
        <MonitorScreen />
      </QueryClientProvider>,
    ),
  )
}

beforeEach(() => {
  state.enginesList = undefined
  state.status = undefined
  state.hwUsage = undefined
  state.sysInfo = undefined
  state.trackCalls = []
  state.getEngineLogsCalls = 0
})

describe('MonitorScreen', () => {
  it('shows an empty state and never subscribes to the log when no engine is active', async () => {
    state.enginesList = { engines: [], activeEngineId: '', customDisabled: [] }
    await renderScreen()

    expect(screen.getByText(/No engine running/)).toBeInTheDocument()
    expect(state.getEngineLogsCalls).toBe(0)
  })

  it('tails the active engine\'s log once one is selected', async () => {
    state.enginesList = { engines: [engine()], activeEngineId: 'e1', customDisabled: [] }
    state.status = { engine: { id: 'e1', name: 'llama.cpp', state: 'running' } } as unknown as Status
    await renderScreen()

    await waitFor(() => expect(state.getEngineLogsCalls).toBe(1))
    expect(await screen.findByText('ready')).toBeInTheDocument()
    // The engine's name is surfaced in the header once it's active.
    expect(screen.getByText('llama.cpp')).toBeInTheDocument()
  })

  it('tracks the auto-scroll toggle on the monitor screen, not engines', async () => {
    state.enginesList = { engines: [engine()], activeEngineId: 'e1', customDisabled: [] }
    state.status = { engine: { id: 'e1', name: 'llama.cpp', state: 'running' } } as unknown as Status
    await renderScreen()

    await waitFor(() => expect(state.getEngineLogsCalls).toBe(1))
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)

    expect(state.trackCalls).toContainEqual(['monitor', 'toggle_engine_log_autoscroll'])
  })

  it('renders the system stats pane (HardwareSection) below the log', async () => {
    state.enginesList = { engines: [], activeEngineId: '', customDisabled: [] }
    state.sysInfo = {
      gpus: [{ name: 'RTX 4090', vramMb: 24000 }],
      cpu: 'Ryzen 9', cores: 16, ramMB: 32000, os: 'Windows',
    } as unknown as SysInfo
    await renderScreen()

    expect(screen.getByText('Hardware')).toBeInTheDocument()
    expect(screen.getByText(/RTX 4090/)).toBeInTheDocument()
  })
})
