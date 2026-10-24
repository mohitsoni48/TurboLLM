import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentEditPage } from './AgentEditPage'

let resolveTools: (v: unknown) => void = () => {}
const saveMutate = vi.fn()
vi.mock('../../lib/chat-api', () => ({
  fetchAvailableTools: () => new Promise((r) => { resolveTools = r }),
}))
vi.mock('../../lib/agent-api', () => ({
  skillKeys: { all: ['skills'], list: () => ['skills', 'list'] },
  fetchSkills: async () => [{ id: 's1', name: 'Skill one', description: '' }],
}))
vi.mock('../../lib/queries', () => ({
  useChatAgents: () => ({ data: [], isSuccess: true }),
  useChatAgentMutations: () => ({ add: { mutate: vi.fn() }, update: { mutate: vi.fn() }, remove: { mutate: vi.fn() } }),
  useBuiltinAgentOverrides: () => ({ data: {}, isSuccess: true }),
  useBuiltinAgentOverrideMutations: () => ({ save: { mutate: saveMutate }, reset: { mutate: vi.fn(), isPending: false } }),
}))
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), track: () => {} }))

describe('AgentEditPage', () => {
  it('waits for BOTH skills and tools before hydrating a built-in, so Save never strips its tools', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Skills already cached (Chat and Customize → Skills share this key) while tools still load —
    // hydrating on "either list non-empty" captured tools as [] forever.
    qc.setQueryData(['skills', 'list'], [{ id: 's1', name: 'Skill one', description: '' }])
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/agents/default']}>
          <Routes><Route path="/agents/:agentId" element={<AgentEditPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await act(async () => { resolveTools([{ name: 'web_search', description: 'search' }, { name: 'fetch_url', description: 'fetch' }]) })
    expect(await screen.findByText('Tools (2)')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveMutate.mock.calls[0][0].override.tools).toEqual(['web_search', 'fetch_url'])
    expect(saveMutate.mock.calls[0][0].override.skillIds).toEqual(['s1'])
  })
})
