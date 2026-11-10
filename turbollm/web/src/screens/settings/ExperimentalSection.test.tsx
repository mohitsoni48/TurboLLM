// Settings → Experimental's row list. Written for Turbo Link's arrival (ADR-376), but it
// asserts the whole list: the value of this section is that a user can see, in one place,
// every unfinished thing their install can be asked to run.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExperimentalSection } from './ExperimentalSection'

const save = { mutate: vi.fn(), isPending: false }
const settings = { experimental: { memory: false, cloudDeploy: false, routines: false, turboLink: false, remoteAccess: false, sandbox: false } }
const sys: { os: string | undefined } = { os: 'win32/x64' }
type Runtime = import('../../lib/api').SandboxRuntimeState
const idle: Runtime = { enabled: true, supported: true, installed: null, downloadBytes: 76_654_219, diskBytes: 132_035_580, job: { state: 'idle', doneBytes: 0 } }
const runtime: { data: Runtime } = { data: idle }
const actions = { install: { mutate: vi.fn(), isPending: false }, cancel: { mutate: vi.fn(), isPending: false }, remove: { mutate: vi.fn(), isPending: false } }

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: settings }, save }),
  useSysInfo: () => ({ data: sys.os === undefined ? undefined : { os: sys.os } }),
  useSandboxRuntime: () => runtime,
  useSandboxRuntimeActions: () => actions,
}))

beforeEach(() => {
  save.mutate.mockClear()
  for (const a of Object.values(actions)) a.mutate.mockClear()
  settings.experimental = { memory: false, cloudDeploy: false, routines: false, turboLink: false, remoteAccess: false, sandbox: false }
  sys.os = 'win32/x64'
  runtime.data = idle
})

describe('ExperimentalSection', () => {
  it('offers Turbo Link alongside the other experimental features', () => {
    render(<ExperimentalSection />)
    expect(screen.getByText('Turbo Link')).toBeTruthy()
    expect(screen.getByText('Memory')).toBeTruthy()
    expect(screen.getByText('Routines')).toBeTruthy()
  })

  it('is honest that Turbo Link has never been run against a real second machine', () => {
    // The copy is the only warning a user gets before switching on a cross-machine feature
    // whose every green test ran against this one box. It is load-bearing, so it is pinned.
    render(<ExperimentalSection />)
    expect(screen.getByText(/never yet run against a real second machine/i)).toBeTruthy()
  })

  it('promises that turning Turbo Link off keeps the saved machines', () => {
    // Backed by real behaviour, not reassurance: the daemon deletes no `LinkRecord` and
    // revokes no granted key on disable (link/gate.ts, config.ts). Someone reading this row
    // has to be able to trust that toggling it is reversible.
    render(<ExperimentalSection />)
    expect(screen.getByText(/leaves your linked machines saved/i)).toBeTruthy()
  })

  it('renders Turbo Link off by default and patches only that one flag when switched on', async () => {
    render(<ExperimentalSection />)
    const rows = screen.getAllByRole('checkbox') as HTMLInputElement[]
    const turboLink = rows[rows.length - 1]
    expect(turboLink.checked).toBe(false)

    await userEvent.click(turboLink)
    // One key, not the whole block: routes.ts applies each flag independently, so a patch
    // that echoed the others back would race a change made in another tab.
    expect(save.mutate).toHaveBeenCalledTimes(1)
    expect(save.mutate.mock.calls[0][0]).toEqual({ experimental: { turboLink: true } })
  })

  it('offers Remote access and patches only that one flag when switched on', async () => {
    // The CHANGELOG (1.13.2) and README send users to Settings → Experimental → Remote access;
    // without this row the flag (and RemoteAccessSection behind it) was unreachable from the UI.
    render(<ExperimentalSection />)
    const row = screen.getByText('Remote access').closest('label')!
    const box = row.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(false)

    await userEvent.click(box)
    expect(save.mutate).toHaveBeenCalledTimes(1)
    expect(save.mutate.mock.calls[0][0]).toEqual({ experimental: { remoteAccess: true } })
  })

  it('reflects the flag being already on', () => {
    settings.experimental = { memory: false, cloudDeploy: false, routines: false, turboLink: true, remoteAccess: false, sandbox: false }
    render(<ExperimentalSection />)
    const rows = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(rows[rows.length - 1].checked).toBe(true)
  })
})

// The Python sandbox (GitHub #52): a switch that downloads nothing by itself, then an explicit Download.
describe('ExperimentalSection: Python sandbox', () => {
  const sandboxBox = () => screen.getByText('Python sandbox').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement

  it('patches only the sandbox flag when switched on, and starts no download', async () => {
    render(<ExperimentalSection />)
    await userEvent.click(sandboxBox())
    expect(save.mutate.mock.calls[0][0]).toEqual({ experimental: { sandbox: true } })
    expect(actions.install.mutate).not.toHaveBeenCalled()
  })

  it('is hidden on Android, and until the platform is known', () => {
    sys.os = 'android/arm64'
    const { unmount } = render(<ExperimentalSection />)
    expect(screen.queryByText('Python sandbox')).toBeNull()
    unmount()
    sys.os = undefined
    render(<ExperimentalSection />)
    expect(screen.queryByText('Python sandbox')).toBeNull()
  })

  it('once on, says what it downloads and starts only on Download', async () => {
    settings.experimental.sandbox = true
    render(<ExperimentalSection />)
    expect(screen.getByText(/Downloads about 77 MB once/)).toBeTruthy()
    expect(screen.getByText(/about 132 MB on disk/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(actions.install.mutate).toHaveBeenCalledTimes(1)
  })

  it('shows progress and a Cancel while downloading', async () => {
    settings.experimental.sandbox = true
    runtime.data = { ...idle, job: { state: 'running', doneBytes: 38_000_000 } }
    render(<ExperimentalSection />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(actions.cancel.mutate).toHaveBeenCalledTimes(1)
  })

  it('shows the failure and offers Try again', () => {
    settings.experimental.sandbox = true
    runtime.data = { ...idle, job: { state: 'error', doneBytes: 0, error: { code: 'checksum_failed', message: 'A downloaded file did not match its pinned SHA-256, so nothing was installed.' } } }
    render(<ExperimentalSection />)
    expect(screen.getByText(/did not match its pinned SHA-256/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('when installed, says so and offers Remove', async () => {
    settings.experimental.sandbox = true
    runtime.data = { ...idle, installed: { deno: '2.9.6', pyodide: '0.29.5' } }
    render(<ExperimentalSection />)
    expect(screen.getByText(/Ready: Deno 2\.9\.6/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(actions.remove.mutate).toHaveBeenCalledTimes(1)
  })
})
