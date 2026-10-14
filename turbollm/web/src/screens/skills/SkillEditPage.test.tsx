import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SkillEditPage } from './SkillEditPage'
import { saveSkill } from '../../lib/agent-api'
import { toast } from '../../components/ui/sonner'

vi.mock('../../lib/agent-api', () => ({
  skillKeys: { all: ['skills'], list: () => ['skills', 'list'] },
  fetchSkills: async () => [{ id: 'code-review', name: 'Code Review', description: '', instructions: 'Hand-tuned.', tools: [] }],
  saveSkill: vi.fn(async (s: unknown) => s),
  deleteSkill: vi.fn(),
}))
vi.mock('../../components/ui/sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), track: () => {} }))

function renderNew() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/skills/new']}>
        <Routes><Route path="/skills/:skillId" element={<SkillEditPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => { vi.mocked(saveSkill).mockClear(); vi.mocked(toast.error).mockClear() })

describe('SkillEditPage (new skill)', () => {
  it('keeps typed separators in the Tools field and saves each tool separately', async () => {
    renderNew()
    await userEvent.type(screen.getByPlaceholderText('Architecture Diagram'), 'Fetcher')
    const tools = screen.getByPlaceholderText('web_search fetch_url') as HTMLInputElement
    await userEvent.type(tools, 'web_search, fetch_url')
    expect(tools.value).toBe('web_search, fetch_url')
    await userEvent.type(screen.getByPlaceholderText(/When to use this skill/), 'Do it.')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveSkill).toHaveBeenCalled())
    expect(vi.mocked(saveSkill).mock.calls[0][0].tools).toEqual(['web_search', 'fetch_url'])
  })

  it('refuses to create a skill whose ID is already taken instead of overwriting it', async () => {
    renderNew()
    // Slugs to "code-review" — the existing skill's id.
    await userEvent.type(screen.getByPlaceholderText('Architecture Diagram'), 'Code review')
    await userEvent.type(screen.getByPlaceholderText(/When to use this skill/), 'Short.')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already exists/)))
    expect(saveSkill).not.toHaveBeenCalled()
  })
})
