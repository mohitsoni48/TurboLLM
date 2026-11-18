// Skills library → "On by default": a switch on each skill card that puts the skill on (or off) the list every new chat
// starts with (the daemon's defaultSkillIds). Saves only that list; opening the skill is still the rest of the card.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SkillsLibrary } from './SkillsLibrary'

const save = { mutate: vi.fn(), isPending: false }
const settings: { defaultSkillIds?: string[] } = { defaultSkillIds: ['web'] }

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: settings }, save }),
}))
vi.mock('../../lib/agent-api', () => ({
  skillKeys: { list: () => ['skills'] },
  fetchSkills: async () => [
    { id: 'web', name: 'Web research', description: '', instructions: '', tools: [] },
    { id: 'code', name: 'Code review', description: '', instructions: '', tools: [] },
    { id: 'filesystem', name: 'Filesystem', description: '', instructions: '', tools: [] },
  ],
  importSkillText: vi.fn(),
  learnFromFolder: vi.fn(),
}))

async function renderLibrary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><MemoryRouter><SkillsLibrary /></MemoryRouter></QueryClientProvider>)
  await screen.findByText('Web research')
}

const toggle = (name: string) => screen.getByRole('switch', { name: `On by default: ${name}` })

beforeEach(() => {
  save.mutate.mockClear()
  settings.defaultSkillIds = ['web']
})

describe('SkillsLibrary: On by default', () => {
  it('shows a skill on the saved list as on and the others as off', async () => {
    await renderLibrary()
    expect(toggle('Web research').getAttribute('aria-checked')).toBe('true')
    expect(toggle('Code review').getAttribute('aria-checked')).toBe('false')
  })

  it('adds a skill to the default list, keeping the ones already on it', async () => {
    await renderLibrary()
    await userEvent.click(toggle('Code review'))
    expect(save.mutate.mock.calls.map((c) => c[0])).toEqual([{ defaultSkillIds: ['web', 'code'] }])
  })

  it('offers no default switch for a skill that chat cannot run', async () => {
    await renderLibrary()
    expect(screen.queryByRole('switch', { name: 'On by default: Filesystem' })).toBeNull()
  })

  it('removes a skill from the default list', async () => {
    await renderLibrary()
    await userEvent.click(toggle('Web research'))
    expect(save.mutate.mock.calls.map((c) => c[0])).toEqual([{ defaultSkillIds: [] }])
  })
})
