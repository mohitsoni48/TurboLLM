import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
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
const availabilityMock = vi.hoisted(() => ({
  data: { agents: [
    { id: 'claude', installed: true, installCommand: 'npm install -g @anthropic-ai/claude-code' },
    { id: 'pi', installed: true, installCommand: 'npm install -g @earendil-works/pi-coding-agent' },
    { id: 'opencode', installed: true, installCommand: 'npm install -g opencode-ai' },
  ] },
  refetch: vi.fn().mockResolvedValue(undefined),
}))
const saveMock = vi.hoisted(() => ({ isPending: false, mutate: vi.fn() }))

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: settingsMock, save: saveMock }),
  useStatus: () => statusMock,
  useAgentAvailability: () => availabilityMock,
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

// An agent CLI install runs on in the daemon when the page that started it closes or reloads. The
// page that comes back used to offer Install again (its "Installing…" was its own request's state
// only); it now reads the daemon's `installing`.
describe('CodeAgentSection — an install the daemon is running', () => {
  const offered = availabilityMock.data.agents.map((a) => ({ ...a }))
  beforeEach(() => {
    settingsMock.data = { code: { defaultAgent: 'turbollm' } }
    statusMock.data = { terminalAvailable: true }
  })
  afterEach(() => { availabilityMock.data.agents = offered.map((a) => ({ ...a })) })

  it('shows "Installing…" for it after a reload, with no Install to start a second one', async () => {
    availabilityMock.data.agents = offered.map((a) => (a.id === 'claude' ? { ...a, installed: false, installing: true } : a))
    renderSection()
    const options = await openedOptions()
    const claude = options.find((t) => t.startsWith('claude'))
    expect(claude).toContain('Installing…')
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Installing…/ })).toBeDisabled()
  })

  it('offers Install for a missing agent when nothing is installing it', async () => {
    availabilityMock.data.agents = offered.map((a) => (a.id === 'claude' ? { ...a, installed: false, installing: false } : a))
    renderSection()
    await openedOptions()
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled()
  })
})
