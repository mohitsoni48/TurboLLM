import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurboLinkSection } from './TurboLinkSection'

vi.mock('../../lib/link-api', () => ({
  listLinks: vi.fn(async () => [{
    id: 'l1', name: 'workstation', baseUrl: 'http://h:6996', status: 'revoked',
    grantedCapabilities: ['models:use'], lastError: 'Access to workstation was revoked. Paste a new link string to reconnect.',
  }]),
  listInbound: vi.fn(async () => []),
  mintLink: vi.fn(),
  addLink: vi.fn(),
  patchLink: vi.fn(),
  deleteLink: vi.fn(),
}))

describe('TurboLinkSection', () => {
  it('shows the actionable reason for a non-online link, not a bare "offline"', async () => {
    render(<TurboLinkSection />)
    expect(await screen.findByText(/was revoked/i)).toBeTruthy()
  })

  it('lists the granted capabilities so the user can see what the link may do', async () => {
    render(<TurboLinkSection />)
    expect(await screen.findByText(/models:use/)).toBeTruthy()
  })
})
