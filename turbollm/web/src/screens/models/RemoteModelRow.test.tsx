import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RemoteModelRow } from './RemoteModelRow'
import { remoteModel } from '../../lib/fleet-sources'
import type { LinkSummary } from '../../lib/link-api'
import { ApiError } from '../../lib/api'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

const load = vi.fn()
const unload = vi.fn()

function link(over: Partial<LinkSummary> = {}): LinkSummary {
  return {
    id: 'l1', name: 'workstation', status: 'online',
    grantedCapabilities: ['models:use', 'models:load', 'models:unload'],
    lastError: null, ...over,
  }
}

const model = (loaded = false) =>
  remoteModel({ key: 'qwen3', name: 'Qwen3-35B', quant: 'Q4_K_M', nativeCtx: 32768, vision: false, loaded })

function renderRow(opts: { link: LinkSummary; loaded?: boolean; failure?: unknown }) {
  return render(
    <RemoteModelRow
      model={model(opts.loaded)}
      origin={{ kind: 'remote', linkId: opts.link.id, machine: opts.link.name }}
      link={opts.link}
      layout="row"
      onLoad={load}
      onUnload={unload}
      busy={false}
      failure={opts.failure}
    />,
  )
}

beforeEach(() => { load.mockClear(); unload.mockClear() })

describe('RemoteModelRow', () => {
  it('loads through the link, naming the model and the machine', async () => {
    renderRow({ link: link() })
    await userEvent.click(screen.getByRole('button', { name: /load/i }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('offers Unload — not Eject — for a model loaded on another machine', async () => {
    // "Eject" is this machine's word for stopping its own engine. On a remote row the verb
    // must match the capability the user was granted (`models:unload`) and the thing that
    // actually happens on the far end.
    renderRow({ link: link(), loaded: true })
    expect(screen.queryByRole('button', { name: /eject/i })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /unload/i }))
    expect(unload).toHaveBeenCalledTimes(1)
  })

  it('disables Load with the capability named when the grant is missing', () => {
    renderRow({ link: link({ grantedCapabilities: ['models:use'] }) })
    const btn = screen.getByRole('button', { name: /load/i })
    expect(btn).toBeDisabled()
    expect(btn.getAttribute('title')).toMatch(/models:load/)
    expect(btn.getAttribute('title')).toMatch(/workstation/)
  })

  it('a disabled Load is never a silent no-op', async () => {
    renderRow({ link: link({ grantedCapabilities: ['models:use'] }) })
    await userEvent.click(screen.getByRole('button', { name: /load/i })).catch(() => {})
    expect(load).not.toHaveBeenCalled()
  })

  it('says OFFLINE, not "not granted", when the machine is unreachable', () => {
    // The distinction that matters most: told "not granted", the user goes off to mint a new
    // key chasing a permission problem that does not exist.
    renderRow({ link: link({ status: 'unreachable', grantedCapabilities: ['models:use'] }) })
    const title = screen.getByRole('button', { name: /load/i }).getAttribute('title') ?? ''
    expect(title).toMatch(/offline/i)
    expect(title).not.toMatch(/not granted/i)
  })

  it('renders a host_busy refusal as busy, distinct from a permission problem', () => {
    renderRow({ link: link(), failure: new ApiError('host_busy', 'x', 503) })
    expect(screen.getByText(/busy with its own work/i)).toBeTruthy()
    expect(screen.queryByText(/permission/i)).toBeNull()
  })

  it('renders a named-capability 403 refusal by naming that capability', () => {
    const e = new ApiError('forbidden', 'x', 403)
    e.capability = 'models:load'
    renderRow({ link: link(), failure: e })
    expect(screen.getByText(/models:load/)).toBeTruthy()
  })

  it('never renders a size for a remote model, since the host sends none', () => {
    // A `0 MB` column reads as a fact. The host does not disclose file sizes.
    const { container } = renderRow({ link: link() })
    expect(container.textContent ?? '').not.toMatch(/\b0 MB\b/)
  })

  it('offers no delete, tune or pin on a remote row', () => {
    // All three are local-filesystem/local-profile affordances with no façade verb behind
    // them. Rendering them would be a silent no-op at best.
    renderRow({ link: link() })
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /load settings/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /pin/i })).toBeNull()
  })
})
