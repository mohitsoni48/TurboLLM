import { StrictMode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { setAuthToken, type DaemonSettings } from '../lib/api'
import { toast } from '../components/ui/sonner'
import { SettingsScreen } from './SettingsScreen'

type SaveCall = { payload: unknown; opts: { onSuccess?: (res: DaemonSettings & { rebind?: unknown }) => void } }
const state: { settings: DaemonSettings | null; sysInfo: unknown; saveCalls: SaveCall[]; restarts: number } = { settings: null, sysInfo: undefined, saveCalls: [], restarts: 0 }
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
  useDaemonRestart: () => ({ ...mut(), mutate: (_: unknown, o?: { onSuccess?: () => void }) => { state.restarts++; o?.onSuccess?.() } }),
  useHfTokenTest: () => mut(),
  useModelDirs: () => ({ data: { dirs: [], primaryDir: '' } }),
  // The Models & loading tab renders the model folders, which read these.
  useModelMutations: () => ({ addDir: mut(), removeDir: mut(), setPrimaryDir: mut(), rescan: mut() }),
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

  // Settings are not refetched on focus (main.tsx), so a tab left open holds what it loaded. Its
  // Save sent every field as loaded: one opened while "Require an API key" was off turned the key
  // back off, LAN back on, with the next unrelated Save after another tab or the CLI changed them.
  it('sends only what was edited on this page, so a tab loaded before a change made elsewhere does not undo it', async () => {
    state.settings = mk({ lanBind: true, requireApiKey: false, telemetryLevel: 'anon' as DaemonSettings['telemetryLevel'] })
    state.saveCalls = []
    render(page())
    await userEvent.click(titles())
    await userEvent.click(screen.getByRole('button', { name: /Save settings/ }))
    expect(state.saveCalls.map((c) => c.payload)).toEqual([{ autoGenerateTitles: false }])
  })

  it('an edit beside the network settings sends that member of its block alone', async () => {
    state.settings = mk({ lanBind: true, requireApiKey: false })
    state.saveCalls = []
    render(page())
    await userEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Network/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Pause for ComfyUI/ }))
    await userEvent.click(screen.getByRole('button', { name: /Save settings/ }))
    expect(state.saveCalls.map((c) => c.payload)).toEqual([{ comfyui: { enabled: true } }])
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

describe('SettingsScreen — Show models for every engine', () => {
  const openModels = () => userEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Models & loading' }))
  const toggle = () => screen.getByRole('checkbox', { name: /Show models for every engine/ }) as HTMLInputElement

  it('is off by default and sends showAllEngineModels with Save once turned on', async () => {
    state.settings = mk()
    state.saveCalls = []
    render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await openModels()
    expect(toggle().checked).toBe(false)

    await userEvent.click(toggle())
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Save settings/ }))

    expect(state.saveCalls).toHaveLength(1)
    expect((state.saveCalls[0].payload as { showAllEngineModels?: boolean }).showAllEngineModels).toBe(true)
  })

  it('shows the stored value', async () => {
    state.settings = mk({ showAllEngineModels: true })
    render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await openModels()
    expect(toggle().checked).toBe(true)
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

  // The old daemon keeps serving /status while it stops its engine (seconds on Windows); reloading
  // on its OK put the page on a daemon about to vanish. Only the new one (shorter uptime) counts.
  it('reloads only once the NEW daemon answers, not on an OK from the old one still tearing down', async () => {
    state.settings = mk()
    state.saveCalls = []
    state.sysInfo = { bundledEnginesOnly: false }
    const replies = [{ uptimeSec: 3600 }, { uptimeSec: 3601 }, { uptimeSec: 0 }] // old, old, then new
    let polls = 0
    let reloadedAtPoll = 0
    const reload = vi.fn(() => { reloadedAtPoll = polls })
    vi.stubGlobal('location', { ...window.location, href: 'http://127.0.0.1:6996/settings', reload })
    vi.stubGlobal('fetch', vi.fn(async () => {
      polls++
      return new Response(JSON.stringify(replies.shift() ?? { uptimeSec: 0 }), { status: 200 })
    }))
    try {
      const { unmount } = render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
      await openSystem()
      await userEvent.click(screen.getByRole('button', { name: /Restart daemon/ }))
      act(() => state.saveCalls[0].opts.onSuccess!(mk()))
      await waitFor(() => expect(reload).toHaveBeenCalledOnce(), { timeout: 4000 })
      expect(reloadedAtPoll).toBe(3)
      unmount()
    } finally {
      vi.unstubAllGlobals()
      state.sysInfo = undefined
    }
  }, 10_000) // about 2 s of real poll intervals, more on a loaded runner

  // StrictMode (npm run dev) mounts, unmounts and remounts effects. The first cleanup cancelled the
  // poll, and the remount's run-once guard returned early: no poll, no reload, no give-up, ever.
  it('under StrictMode, restarts once, then polls and reloads like a production build', async () => {
    state.settings = mk()
    state.saveCalls = []
    state.restarts = 0
    state.sysInfo = { bundledEnginesOnly: false }
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, href: 'http://127.0.0.1:6996/settings', reload })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uptimeSec: 0 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { unmount } = render(<StrictMode><MemoryRouter><SettingsScreen /></MemoryRouter></StrictMode>)
      await openSystem()
      await userEvent.click(screen.getByRole('button', { name: /Restart daemon/ }))
      act(() => state.saveCalls[0].opts.onSuccess!(mk()))
      await waitFor(() => expect(reload).toHaveBeenCalledOnce(), { timeout: 3000 })
      expect(state.restarts).toBe(1)
      expect(fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]) === '/api/v1/status')).toHaveLength(1)
      unmount()
    } finally {
      vi.unstubAllGlobals()
      state.sysInfo = undefined
    }
  })

  // A pending port change: the save already moves the daemon in place, and the overlay could only
  // ever poll this page's own (now dead) port. So the page follows the port and nothing restarts.
  it('with a pending port change, follows the daemon to its new port instead of polling the old one', async () => {
    state.settings = mk()
    state.saveCalls = []
    state.restarts = 0
    state.sysInfo = { bundledEnginesOnly: false }
    const location = { ...window.location, href: 'http://127.0.0.1:6996/settings', reload: vi.fn() }
    vi.stubGlobal('location', location)
    try {
      const { unmount } = render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
      await openSystem()
      await userEvent.click(screen.getByRole('button', { name: /Restart daemon/ }))
      act(() => state.saveCalls[0].opts.onSuccess!({ ...mk({ port: 7100 }), rebind: { portChanged: true, port: 7100, lanBind: false } }))
      expect(screen.queryByText('Restarting daemon…')).toBeNull()
      expect(state.restarts).toBe(0)
      await waitFor(() => expect(location.href).toBe('http://127.0.0.1:7100/settings'), { timeout: 3000 })
      expect(location.reload).not.toHaveBeenCalled()
      unmount()
    } finally {
      vi.unstubAllGlobals()
      state.sysInfo = undefined
    }
  })

  // Another port is another origin with its own localStorage, so a LAN client's saved API key
  // stays behind and the new port asks for it again. The hop used to come with no word of that.
  it('tells a LAN client with a saved key to paste it again on the new port, and gives it time to read that', async () => {
    const success = vi.spyOn(toast, 'success')
    const followFrom = async (href: string, hostname: string) => {
      state.settings = mk()
      state.saveCalls = []
      const location = { ...window.location, href, hostname, reload: vi.fn() }
      vi.stubGlobal('location', location)
      const { unmount } = render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
      await openSystem()
      await userEvent.click(screen.getByRole('button', { name: /Restart daemon/ }))
      vi.useFakeTimers()
      act(() => state.saveCalls[0].opts.onSuccess!({ ...mk({ port: 7100 }), rebind: { portChanged: true, port: 7100, lanBind: true } }))
      return { location, unmount }
    }
    state.sysInfo = { bundledEnginesOnly: false }
    setAuthToken('lan-key')
    try {
      const lan = await followFrom('http://192.168.1.5:6996/settings', '192.168.1.5')
      expect(success).toHaveBeenLastCalledWith(expect.stringMatching(/paste it again on port 7100\.$/), { duration: 6000 })
      act(() => { vi.advanceTimersByTime(1300) })
      expect(lan.location.href).toBe('http://192.168.1.5:6996/settings') // still readable
      act(() => { vi.advanceTimersByTime(3200) })
      expect(lan.location.href).toBe('http://192.168.1.5:7100/settings')
      lan.unmount()
      vi.useRealTimers()
      vi.unstubAllGlobals()

      // On the host itself the daemon needs no key: the plain message and the quick hop, as before.
      const host = await followFrom('http://127.0.0.1:6996/settings', '127.0.0.1')
      expect(success).toHaveBeenLastCalledWith('Port changed to 7100: applied without a restart. Reconnecting…')
      act(() => { vi.advanceTimersByTime(1300) })
      expect(host.location.href).toBe('http://127.0.0.1:7100/settings')
      host.unmount()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      success.mockRestore()
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

describe('SettingsScreen — open LAN access', () => {
  // With the key off, lanAuth lets a request with a foreign Host in like a LAN peer, so a web page
  // that DNS-rebinds its own name to this machine (or its LAN address) gets in keyless as well.
  // The copy named only "any device on your network".
  it('says that a website opened in a browser on the network can use it with no key, not only a device', async () => {
    state.settings = mk({ lanBind: true, requireApiKey: false })
    render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await userEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Network/ }))
    // The "Require an API key" switch's own line, and the Open access warning under it.
    expect(screen.getAllByText(/any website opened in a browser on it,\s+can use this TurboLLM with no\s+key/)).toHaveLength(2)
  })
})

describe('SettingsScreen — LAN access with a key required', () => {
  // The nav has had no Developer screen for a while; the API keys panel is on Customize's Connect tab.
  it('with no key yet, points to Customize → Connect → API keys, not the Developer screen', async () => {
    state.settings = mk({ lanBind: true, requireApiKey: true })
    render(<MemoryRouter><SettingsScreen /></MemoryRouter>)
    await userEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Network/ }))
    expect(screen.getByText('Customize → Connect → API keys')).toBeTruthy()
    expect(screen.queryByText('Developer')).toBeNull()
  })
})
