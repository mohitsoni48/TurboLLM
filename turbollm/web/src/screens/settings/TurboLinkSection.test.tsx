import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TurboLinkSection } from './TurboLinkSection'
import { deleteLink, mintLink, patchLink, revokeInbound } from '../../lib/link-api'

vi.mock('../../lib/link-api', () => ({
  listLinks: vi.fn(async () => [{
    id: 'l1', name: 'workstation', baseUrl: 'http://h:6996', status: 'revoked',
    grantedCapabilities: ['models:use'], machineIdChanged: false,
    lastError: 'Access to workstation was revoked. Paste a new link string to reconnect.',
  }]),
  listInbound: vi.fn(async () => [{
    id: 'key-1', name: 'laptop', capabilities: ['models:use'], models: null,
    createdAt: '2026-08-01', lastUsedAt: null,
  }]),
  mintLink: vi.fn(async () => ({ keyId: 'key-2', linkString: 'tllink_abc' })),
  addLink: vi.fn(),
  patchLink: vi.fn(async () => ({})),
  deleteLink: vi.fn(async () => ({ ok: true })),
  revokeInbound: vi.fn(async () => ({ ok: true })),
}))

// The component reads/writes the machine name through the general settings API; neither
// call is what these tests are about, so both are stubbed to a quiet default.
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  getSettings: vi.fn(async () => ({ machineName: 'workstation' })),
  saveSettings: vi.fn(async () => ({ machineName: 'workstation' })),
  track: vi.fn(),
}))

describe('TurboLinkSection', () => {
  it('shows the actionable reason for a non-online link, not a bare "offline"', async () => {
    render(<TurboLinkSection />)
    expect(await screen.findByText(/was revoked/i)).toBeTruthy()
  })

  it('lists the granted capabilities so the user can see what the link may do', async () => {
    render(<TurboLinkSection />)
    // Both panels render capability chips now (an inbound key and a peer link), so this
    // asserts on the set rather than a single node.
    expect((await screen.findAllByText(/models:use/)).length).toBeGreaterThan(0)
  })

  // ADR-376 final review, C-2. An inbound link IS an API key with a grant, so revoking it
  // must delete the KEY. The shipped button called deleteLink, which filters the peer-side
  // link records instead: {ok:true}, unchanged list, peer's token still working.
  it('revokes an inbound link through the KEYS endpoint, never the links endpoint', async () => {
    render(<TurboLinkSection />)
    const button = await screen.findByTitle('Revoke')
    await userEvent.click(button)
    await waitFor(() => expect(revokeInbound).toHaveBeenCalledWith('key-1'))
    expect(deleteLink).not.toHaveBeenCalled()
  })

  // ADR-376 final review, M-3: the server validates and emits a `preset` dimension the
  // component never sent, so it could never be populated.
  it('sends the chosen preset when minting, so the telemetry dimension is populated', async () => {
    render(<TurboLinkSection />)
    await userEvent.type(screen.getByPlaceholderText('e.g. laptop'), 'laptop')
    await userEvent.click(screen.getByLabelText(/Server box/i, { selector: 'input' }).closest('input')!)
    await userEvent.click(screen.getByRole('button', { name: /Create link/i }))
    await waitFor(() => expect(mintLink).toHaveBeenCalled())
    expect(vi.mocked(mintLink).mock.calls[0][0]).toMatchObject({ name: 'laptop', preset: 'server' })
  })

  // ADR-376 final review, M-2: the hint advertised a prefix the product never emits, so a
  // user checking their clipboard against it concludes they copied the wrong thing.
  it('advertises the real link-string prefix', async () => {
    render(<TurboLinkSection />)
    expect(await screen.findByPlaceholderText(/tllink_/)).toBeTruthy()
  })

  // ADR-376 final review, I-5: the anti-hijack warning used to be a transient `lastError`
  // that the next successful poll erased, on a row that renders a green "Online" pill and
  // no error text at all.
  it('keeps showing the machine-changed warning on an ONLINE link until acknowledged', async () => {
    const { listLinks } = await import('../../lib/link-api')
    vi.mocked(listLinks).mockResolvedValueOnce([{
      id: 'l1', name: 'workstation', baseUrl: 'http://h:6996', status: 'online',
      grantedCapabilities: ['models:use'], machineIdChanged: true, lastError: null,
    }] as never)
    render(<TurboLinkSection />)
    expect(await screen.findByText(/different machine/i)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /right machine/i }))
    await waitFor(() => expect(patchLink).toHaveBeenCalledWith('l1', { acknowledgeMachineChange: true }))
  })
})
