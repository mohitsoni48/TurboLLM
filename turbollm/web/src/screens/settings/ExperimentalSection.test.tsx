// Settings → Experimental's row list. Written for Turbo Link's arrival (ADR-376), but it
// asserts the whole list: the value of this section is that a user can see, in one place,
// every unfinished thing their install can be asked to run.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExperimentalSection } from './ExperimentalSection'

const save = { mutate: vi.fn(), isPending: false }
const settings = { experimental: { memory: false, cloudDeploy: false, routines: false, turboLink: false } }

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: settings }, save }),
}))

beforeEach(() => {
  save.mutate.mockClear()
  settings.experimental = { memory: false, cloudDeploy: false, routines: false, turboLink: false }
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

  it('reflects the flag being already on', () => {
    settings.experimental = { memory: false, cloudDeploy: false, routines: false, turboLink: true }
    render(<ExperimentalSection />)
    const rows = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(rows[rows.length - 1].checked).toBe(true)
  })
})
