import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { setAuthToken, type DaemonSettings } from '../lib/api'
import { SettingsScreen } from './SettingsScreen'

type SaveCall = { payload: unknown; opts: { onSuccess?: (res: DaemonSettings) => void } }
const state: { settings: DaemonSettings | null; sysInfo: unknown; saveCalls: SaveCall[] } = { settings: null, sysInfo: undefined, saveCalls: [] }
const mk = (over: Partial<DaemonSettings> = {}) => ({
  idleTtlMinutes: 60, vramHeadroomMb: 1024, port: 6996, autoGenerateTitles: true, openBrowserOnStart: true,
  autoLoadOnStart: false, modelDefaults: { ctx: 8192, ngl: 99, imageMaxTokens: 0, maxTokens: 0 }, telemetryLevel: 'off',
  lanBind: false, requireApiKey: true, comfyui: { enabled: false, url: '', reverseGate: false, gatePath: '' },
  gateway: { autoSwap: true, keepN: 1 }, hfTokenSet: false, ghTokenSet: false, experimental: { memory: false },
  ...over,
}) as unknown as DaemonSettings
const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
vi.mock('../lib/queries', () => ({
  useSettings: () => ({
    query: { data: state.settings, isLoading: false, isFetching: false, refetch: vi.fn() },
    // The page's own Save: recorded, and settled by the test (onSuccess) when it chooses.
    save: { ...mut(), mutate: (payload: unknown, opts: SaveCall['opts']) => { state.saveCalls.push({ payload, opts }) } },
  }),
  useComfyGate: () => ({ install: mut(), uninstall: mut() }),
  // Settles at once, so the restart overlay goes straight to polling for the new daemon.
  useDaemonRestart: () => ({ ...mut(), mutate: (_: unknown, o?: { onSuccess?: () => void }) => o?.onSuccess?.() }),
  useHfTokenTest: () => mut(),
  useModelDirs: () => ({ data: { dirs: [], primaryDir: '' } }), useModelMutations: () => ({}),
  useNetworkInfo: () => ({ data: undefined }), useStatus: () => ({ data: undefined }),
  useTelemetryPreview: () => ({ data: undefined }), useTelemetryLog: () => ({ data: undefined }),
  useRegenerateMachineId: () => mut(), useAppUpdate: () => ({ data: undefined }), useSysInfo: () => ({ data: state.sysInfo }),
  useAppUpdatePolicyMutation: () => mut(), useDismissAppUpdateMutation: () => mut(),
}))
// Its live gauges poll hooks this file does not mock; the System tab is only opened for Restart.
vi.mock('./settings/HardwareSection', () => ({ HardwareSection: () => null }))
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), track: () => {} }))

describe('SettingsScreen drafts', () => {
  it("keeps an unsaved draft when another section's own save swaps in a new settings object", async () => {
    state.settings = mk()
    const { rerender } = render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    const titles = () => screen.getByRole('checkbox', { name: /Auto-generate chat titles/ }) as HTMLInputElement
    await userEvent.click(titles())
    expect(titles().checked).toBe(false)
    expect(screen.getByText('Unsaved changes')).toBeTruthy()

    // What e.g. HfTokenSection's save produces (setQueryData(['settings'], …)) — here also with a
    // server-side change to a field the user did NOT touch, which must still come through.
    state.settings = mk({ hfTokenSet: true, autoLoadOnStart: true })
    rerender(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    expect(titles().checked).toBe(false)
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: /Auto-load last model/i }) as HTMLInputElement).checked).toBe(true)
  })

  const page = () => <MemoryRouter><SettingsScreen /></MemoryRouter>
  const titles = () => screen.getByRole('checkbox', { name: /Auto-generate chat titles/ }) as HTMLInputElement
  const autoLoad = () => screen.getByRole('checkbox', { name: /Auto-load last model/i }) as HTMLInputElement

  it('after its own Save shows what the server stored, even where it differs from what was sent, and the bar clears', async () => {
    state.settings = mk()
    state.saveCalls = []
    const { rerender } = render(page())
    await userEvent.click(titles())
    await userEvent.click(screen.getByRole('button', { name: /Save settings/ }))
    expect(state.saveCalls).toHaveLength(1)
    // The server stored titles ON (normalised what was sent). Its cache update lands first here,
    // then the mutate's own onSuccess.
    const res = mk({ autoGenerateTitles: true })
    state.settings = res
    rerender(page())
    act(() => state.saveCalls[0].opts.onSuccess!(res))
    expect(titles().checked).toBe(true)
    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })

  it('keeps an edit made while its Save was in flight', async () => {
    state.settings = mk()
    state.saveCalls = []
    const { rerender } = render(page())
    await userEvent.click(titles())
    await userEvent.click(screen.getByRole('button', { name: /Save settings/ }))
    await userEvent.click(autoLoad()) // typed during the round trip, not part of that Save
    const res = mk({ autoGenerateTitles: false })
    act(() => state.saveCalls[0].opts.onSuccess!(res))
    state.settings = res
    rerender(page())
    expect(titles().checked).toBe(false)
    expect(autoLoad().checked).toBe(true)
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })
})

describe('SettingsScreen — Restart daemon', () => {
  const openSystem = () => userEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'System' }))

  it('is not offered in the packaged Android app (its daemon cannot come back), but is elsewhere', async () => {
    state.settings = mk()
    state.sysInfo = { bundledEnginesOnly: true }
    const { unmount } = render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await openSystem()
    expect(screen.queryByRole('button', { name: /Restart daemon/ })).toBeNull()
    unmount()

    state.sysInfo = { bundledEnginesOnly: false } // desktop, or Termux
    render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await openSystem()
    expect(screen.getByRole('button', { name: /Restart daemon/ })).toBeTruthy()
    state.sysInfo = undefined
  })

  // /api/v1/status needs the key for a non-loopback caller, so an unauthenticated poll from a LAN
  // client got 401 until the 20s give-up, and the overlay always ended on "taking a while".
  it("polls for the restarted daemon with this client's key", async () => {
    state.settings = mk()
    state.saveCalls = []
    state.sysInfo = { bundledEnginesOnly: false }
    setAuthToken('lan-key')
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { unmount } = render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
      await openSystem()
      await userEvent.click(screen.getByRole('button', { name: /Restart daemon/ }))
      act(() => state.saveCalls[0].opts.onSuccess!(mk())) // pending changes saved first
      expect(screen.getByText('Restarting daemon…')).toBeTruthy()
      const statusCall = () => fetchMock.mock.calls.find((c) => String((c as unknown[])[0]) === '/api/v1/status') as unknown[] | undefined
      await waitFor(() => expect(statusCall()).toBeTruthy(), { timeout: 3000 })
      const headers = (statusCall()![1] as RequestInit).headers as Record<string, string>
      expect(headers['X-TurboLLM-Auth']).toBe('lan-key')
      unmount()
    } finally {
      vi.unstubAllGlobals()
      setAuthToken('')
      state.sysInfo = undefined
    }
  })
})

describe('SettingsScreen — Network port', () => {
  const openNetwork = () => userEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Network/ }))
  const lan = () => screen.queryByRole('checkbox', { name: /Expose on local network/ })
  // The section footnote: its port clause only makes sense where there is a Port row.
  const portNote = () => screen.queryByText(/a port change reconnects this page automatically/)

  it('is not offered in the packaged Android app (its WebView cannot follow the hop), but LAN is; elsewhere both are', async () => {
    state.settings = mk()
    state.sysInfo = { bundledEnginesOnly: true }
    const { unmount } = render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await openNetwork()
    expect(screen.queryByLabelText('Daemon port')).toBeNull()
    expect(lan()).toBeTruthy()
    expect(portNote()).toBeNull()
    expect(screen.getByText(/re-binds in place \(no restart, model stays loaded\)\.$/)).toBeTruthy()
    unmount()

    state.sysInfo = { bundledEnginesOnly: false } // desktop, or Termux
    render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await openNetwork()
    expect(screen.getByLabelText('Daemon port')).toBeTruthy()
    expect(lan()).toBeTruthy()
    expect(portNote()).toBeTruthy()
    state.sysInfo = undefined
  })
})
