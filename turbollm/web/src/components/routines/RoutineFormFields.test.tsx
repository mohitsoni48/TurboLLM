import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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

/** The other half of the form: the code branch's fields plus the weekly picker's weekday row —
 *  the controls the default chat/daily draft never renders. */
function codeWeeklyDraft(): RoutineDraft {
  return {
    flavor: 'code', prompt: 'Tidy the changelog', modelKey: 'model-a',
    scheduleRule: { kind: 'weekly', daysOfWeek: [1, 3], hour: 9, minute: 0 },
    workspacePath: 'C:/repo', codingAgent: 'pi', permissionMode: 'ask',
  }
}

function Harness() {
  const [draft, setDraft] = useState<RoutineDraft>(emptyRoutineDraft())
  return <RoutineFormFields draft={draft} onChange={setDraft} />
}

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>)
}

function renderControlled(draft: RoutineDraft, onChange: (d: RoutineDraft) => void, disabled?: boolean, lockFlavor?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><RoutineFormFields draft={draft} onChange={onChange} disabled={disabled} lockFlavor={lockFlavor} /></QueryClientProvider>)
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

  // Parameterised over BOTH branches of the form. The chat/daily draft alone never reaches the
  // time input, the weekday buttons, the workspace input or Browse — and the code-flavor half is
  // exactly what RoutineConfirmCard's read-only state during a pending update depends on.
  it.each([
    ['chat flavor, daily schedule', emptyRoutineDraft(), 2],
    ['code flavor, weekly schedule', codeWeeklyDraft(), 10],
  ])('disables every control when disabled — %s', (_name, draft, minButtons) => {
    renderControlled(draft, vi.fn(), true)
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(minButtons)
    for (const b of buttons) expect(b).toBeDisabled()
    for (const t of screen.getAllByRole('textbox')) expect(t).toBeDisabled()
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled()
    if (draft.scheduleRule.kind !== 'interval') expect(screen.getByLabelText('Time of day')).toBeDisabled()
  })
})

// H1 + M2 — the flavor toggle is the one transition that must both materialise the permission
// mode the form displays and drop the departing flavor's fields.
describe('RoutineFormFields — flavor toggle', () => {
  it('materialises an explicit permissionMode when switching to Code, so the displayed default is the one that executes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const draft = emptyRoutineDraft()
    expect(draft.permissionMode).toBeUndefined() // the bug's precondition
    renderControlled(draft, onChange)
    await user.click(screen.getByRole('button', { name: 'Code' }))
    const next = onChange.mock.calls[0][0] as RoutineDraft
    expect(next.flavor).toBe('code')
    // Not just "truthy" — the backend resolves an ABSENT permissionMode to 'auto', so the field
    // must be present, and must be the 'ask' the select is already showing.
    expect(Object.prototype.hasOwnProperty.call(next, 'permissionMode')).toBe(true)
    expect(next.permissionMode).toBe('ask')
  })

  it('keeps an already-chosen permission mode instead of resetting it to ask', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControlled({ ...emptyRoutineDraft(), permissionMode: 'plan' }, onChange)
    await user.click(screen.getByRole('button', { name: 'Code' }))
    expect((onChange.mock.calls[0][0] as RoutineDraft).permissionMode).toBe('plan')
  })

  it('clears the chat-only field when switching to Code', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControlled({ ...emptyRoutineDraft(), agentId: 'agent-1' }, onChange)
    await user.click(screen.getByRole('button', { name: 'Code' }))
    expect((onChange.mock.calls[0][0] as RoutineDraft).agentId).toBeUndefined()
  })

  it('clears the code-only fields when switching back to Chat', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControlled(codeWeeklyDraft(), onChange)
    await user.click(screen.getByRole('button', { name: 'Chat' }))
    const next = onChange.mock.calls[0][0] as RoutineDraft
    expect(next.flavor).toBe('chat')
    // routine-routes.ts persists all four unconditionally, so leftovers become real rows in the
    // database — a chat routine carrying a workspace path it will never use.
    expect(next.workspacePath).toBeUndefined()
    expect(next.codingAgent).toBeUndefined()
    expect(next.permissionMode).toBeUndefined()
  })
})

// M4 — `lockFlavor` must be surgical: PUT cannot change a routine's flavor, so any surface editing
// an existing row has to take the toggle away WITHOUT taking the rest of the form away.
describe('RoutineFormFields — lockFlavor', () => {
  it('disables the flavor toggle and nothing else', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControlled(emptyRoutineDraft(), onChange, undefined, true)
    expect(screen.getByRole('button', { name: 'Chat' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Code' })).toBeDisabled()
    // Every other control stays live — this is not `disabled`.
    expect(screen.getByPlaceholderText(/What should this routine do/)).not.toBeDisabled()
    expect(screen.getByLabelText('Model')).not.toBeDisabled()
    expect(screen.getByLabelText('Agent')).not.toBeDisabled()
    expect(screen.getByLabelText('Schedule')).not.toBeDisabled()
    await user.type(screen.getByPlaceholderText(/What should this routine do/), 'x')
    expect(onChange).toHaveBeenCalledWith({ ...emptyRoutineDraft(), prompt: 'x' })
  })

  it('explains itself rather than leaving two dead buttons', () => {
    renderControlled(emptyRoutineDraft(), vi.fn(), undefined, true)
    expect(screen.getByText(/flavor is fixed once it exists/i)).toBeInTheDocument()
  })

  it('leaves the toggle live by default, and says nothing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControlled(emptyRoutineDraft(), onChange)
    expect(screen.queryByText(/flavor is fixed once it exists/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Code' }))
    expect((onChange.mock.calls[0][0] as RoutineDraft).flavor).toBe('code')
  })
})

// M1 — a value the catalog does not contain must stay VISIBLE, not silently fall back to the
// placeholder while the draft (and the completeness gate) still believe the field is set.
describe('RoutineFormFields — values missing from the catalog', () => {
  it('shows a stored model key that is not in the model list, rather than the placeholder', () => {
    renderControlled({ ...emptyRoutineDraft(), modelKey: 'deleted-model' }, vi.fn())
    const select = screen.getByLabelText('Model') as HTMLSelectElement
    expect(screen.getByRole('option', { name: /deleted-model \(not in the current catalog\)/ })).toBeInTheDocument()
    expect(select.value).toBe('deleted-model')
  })

  it('shows a stored agent id that is not in the agent list, rather than the placeholder', () => {
    renderControlled({ ...emptyRoutineDraft(), agentId: 'deleted-agent' }, vi.fn())
    const select = screen.getByLabelText('Agent') as HTMLSelectElement
    expect(screen.getByRole('option', { name: /deleted-agent \(not in the current catalog\)/ })).toBeInTheDocument()
    expect(select.value).toBe('deleted-agent')
  })

  it('adds no synthetic option when the value IS in the catalog', () => {
    renderControlled({ ...emptyRoutineDraft(), modelKey: 'model-a', agentId: 'agent-1' }, vi.fn())
    expect(screen.queryByText(/not in the current catalog/)).not.toBeInTheDocument()
  })
})

// M4.1 — regression test for the cleared-time-input guard. Unguarded, `''.split(':').map(Number)`
// yields `[0, undefined]`, i.e. `hour: 0, minute: undefined` — a silently plausible midnight plus
// a minute that renders back as the string "undefined".
describe('RoutineFormFields — cleared time input', () => {
  it('leaves hour/minute untouched when the time input is cleared', () => {
    const onChange = vi.fn()
    renderControlled({ ...emptyRoutineDraft(), scheduleRule: { kind: 'daily', hour: 14, minute: 35 } }, onChange)
    const time = screen.getByLabelText('Time of day') as HTMLInputElement
    expect(time.value).toBe('14:35')
    fireEvent.change(time, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('still writes a complete time through', () => {
    const onChange = vi.fn()
    renderControlled({ ...emptyRoutineDraft(), scheduleRule: { kind: 'daily', hour: 14, minute: 35 } }, onChange)
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '07:05' } })
    expect((onChange.mock.calls[0][0] as RoutineDraft).scheduleRule).toEqual({ kind: 'daily', hour: 7, minute: 5 })
  })
})
