// Settings → "Skills in new chats" (GitHub issue 340): ticks a skill into, and out of, the list every new chat starts
// with, saving at once; skills a chat cannot use are not offered.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSkillsSection } from './ChatSkillsSection'

const mutate = vi.fn()
const settings = { defaultChatSkillIds: ['web'] as string[] }

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: settings }, save: { mutate, isPending: false } }),
}))
vi.mock('../../lib/agent-api', () => ({
  skillKeys: { list: () => ['skills'] },
  fetchSkills: async () => [
    { id: 'web', name: 'Web research', description: 'Search and cite', instructions: '', tools: [] },
    { id: 'compose', name: 'Compose', description: 'Write well', instructions: '', tools: [] },
    { id: 'filesystem', name: 'Filesystem', description: 'Files', instructions: '', tools: [] },
  ],
}))

const show = () => render(<QueryClientProvider client={new QueryClient()}><ChatSkillsSection /></QueryClientProvider>)

beforeEach(() => {
  mutate.mockClear()
  settings.defaultChatSkillIds = ['web']
})

describe('ChatSkillsSection', () => {
  it('shows the saved skills ticked, and never offers one a chat cannot use', async () => {
    show()
    expect(await screen.findByLabelText('Start new chats with Web research')).toBeChecked()
    expect(screen.getByLabelText('Start new chats with Compose')).not.toBeChecked()
    expect(screen.queryByText('Filesystem')).toBeNull()
  })

  it('saves a ticked skill into the list, and an unticked one out of it', async () => {
    show()
    await userEvent.click(await screen.findByLabelText('Start new chats with Compose'))
    expect(mutate.mock.calls[0][0]).toEqual({ defaultChatSkillIds: ['web', 'compose'] })
    await userEvent.click(screen.getByLabelText('Start new chats with Web research'))
    expect(mutate.mock.calls[1][0]).toEqual({ defaultChatSkillIds: [] })
  })
})
