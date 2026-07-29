import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CodeAgentSection } from './CodeAgentSection'

// `node-pty` is an optional native dependency, so a healthy install can have no way to spawn a
// terminal at all. A terminal-only agent must not be offered there — picking it would produce a
// session that fails the moment it opens. These pin the gate in both directions, plus the case
// that matters most for honesty: someone whose SAVED agent is one this machine can't run.
//
// The options live in a Radix portal that only mounts once the menu is open, so each test opens it
// by KEYBOARD. jsdom has no pointer-capture implementation, which is what makes click-driven Radix
// tests flaky; Enter on the focused trigger goes through the same open path without it.

const settingsMock = vi.hoisted(() => ({ data: undefined as unknown }))
const statusMock = vi.hoisted(() => ({ data: undefined as unknown }))
const saveMock = vi.hoisted(() => ({ isPending: false, mutate: vi.fn() }))

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: settingsMock, save: saveMock }),
  useStatus: () => statusMock,
}))

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CodeAgentSection />
    </QueryClientProvider>,
  )
}

/** Open the picker and return the option labels actually offered. */
async function openedOptions(): Promise<string[]> {
  const user = userEvent.setup()
  screen.getByRole('button').focus()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0))
  return screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')
}

describe('CodeAgentSection — terminal-backend gating', () => {
  beforeEach(() => {
    settingsMock.data = { code: { defaultAgent: 'turbollm' } }
    statusMock.data = { terminalAvailable: true }
  })

  it('offers the terminal-only agent when the daemon reports a terminal backend', async () => {
    renderSection()
    const options = await openedOptions()
    expect(options.some((t) => t.includes('claude'))).toBe(true)
    expect(options.some((t) => t.includes('turbollm'))).toBe(true)
  })

  it('hides it entirely when the daemon reports no terminal backend — not shown-disabled', async () => {
    statusMock.data = { terminalAvailable: false }
    renderSection()
    const options = await openedOptions()
    expect(options.some((t) => t.includes('claude'))).toBe(false)
    // The built-in agent is always offerable, so the picker never renders empty.
    expect(options.some((t) => t.includes('turbollm'))).toBe(true)
  })

  it('treats an older daemon that never sends the flag as HAVING a terminal', async () => {
    // Every build predating the flag had node-pty as a hard dependency, so "unknown" means
    // available. Defaulting the other way would hide a working feature on a stale browser tab.
    statusMock.data = {}
    renderSection()
    const options = await openedOptions()
    expect(options.some((t) => t.includes('claude'))).toBe(true)
  })

  it('still reports a saved agent this machine cannot run, and says why', () => {
    // The daemon keeps honoring the saved value for new sessions, so silently relabelling the
    // trigger "turbollm" would be a lie about what Code will actually launch. This one needs no
    // menu open — it renders in the trigger itself.
    settingsMock.data = { code: { defaultAgent: 'claude' } }
    statusMock.data = { terminalAvailable: false }
    renderSection()
    expect(screen.getByText(/Needs a terminal, which this install does not have/)).toBeInTheDocument()
  })
})
