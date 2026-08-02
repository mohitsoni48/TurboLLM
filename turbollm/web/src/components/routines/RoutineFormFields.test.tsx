import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { RoutineFormFields } from './RoutineFormFields'
import { emptyRoutineDraft, type RoutineDraft } from '../../lib/routine-form'

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useChatAgents: () => ({ data: [{ id: 'agent-1', name: 'Research Agent', description: '', systemPrompt: '', skillIds: [], tools: [] }] }),
    useModels: () => ({ data: { models: [{ key: 'model-a', name: 'Model A', compatibleWithActiveEngine: true }] } }),
  }
})

function Harness() {
  const [draft, setDraft] = useState<RoutineDraft>(emptyRoutineDraft())
  return <RoutineFormFields draft={draft} onChange={setDraft} />
}

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>)
}

describe('RoutineFormFields', () => {
  it('shows the Agent field for chat flavor, and swaps to workspace/coding-agent fields for code', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(screen.getByText('Agent')).toBeInTheDocument()
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    expect(screen.getByText('Coding agent')).toBeInTheDocument()
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
  })

  it('lists real agents and models from the query hooks, not hardcoded options', () => {
    renderForm()
    expect(screen.getByRole('option', { name: 'Research Agent' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Model A' })).toBeInTheDocument()
  })

  it('switching to a weekly schedule shows Mon–Fri picked by default, and lets a day be toggled off', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.selectOptions(screen.getByDisplayValue('Daily'), 'weekly')
    const mon = screen.getByRole('button', { name: 'Mon' })
    expect(mon.className).toContain('text-accent')
    await user.click(mon)
    expect(mon.className).not.toContain('text-accent')
  })

  it('edits flow back out through onChange only — the component holds no draft state of its own', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const draft = emptyRoutineDraft()
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RoutineFormFields draft={draft} onChange={onChange} />
      </QueryClientProvider>,
    )
    await user.type(screen.getByPlaceholderText(/What should this routine do/), 'x')
    expect(onChange).toHaveBeenCalledWith({ ...draft, prompt: 'x' })
    // Controlled: the parent ignored the change, so the field is still empty.
    expect(screen.getByPlaceholderText(/What should this routine do/)).toHaveValue('')
  })

  it('disables every control when disabled', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RoutineFormFields draft={emptyRoutineDraft()} onChange={vi.fn()} disabled />
      </QueryClientProvider>,
    )
    expect(screen.getByPlaceholderText(/What should this routine do/)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Code' })).toBeDisabled()
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled()
  })
})
