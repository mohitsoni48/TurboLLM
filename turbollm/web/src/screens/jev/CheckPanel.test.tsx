// The Check editor (ADR-434 (c)): a premise and the hypotheses to weigh against it. The panel
// owns nothing but the text — validation lives in jev-run.ts and the run itself in the screen.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckPanel } from './CheckPanel'
import { MAX_JEV_INPUTS } from '../../lib/jev-api'

const h = vi.hoisted(() => ({ track: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

const DRAFT = {
  premise: 'A chef is chopping onions in a busy restaurant kitchen.',
  hypotheses: ['Someone is preparing food.', 'The kitchen is empty and silent.'],
}

function renderPanel(over: Partial<Parameters<typeof CheckPanel>[0]> = {}) {
  const onChange = vi.fn()
  const onRun = vi.fn()
  render(<CheckPanel value={DRAFT} onChange={onChange} onRun={onRun} running={false} {...over} />)
  return { onChange, onRun }
}

beforeEach(() => {
  h.track.mockReset()
})

describe('CheckPanel', () => {
  it('shows the premise and one row per hypothesis', () => {
    renderPanel()
    expect(screen.getByLabelText('Premise')).toHaveValue(DRAFT.premise)
    const rows = screen.getAllByPlaceholderText('A hypothesis to check')
    expect(rows.map((r) => (r as HTMLInputElement).value)).toEqual(DRAFT.hypotheses)
  })

  it('reports a typed premise', async () => {
    const { onChange } = renderPanel()
    await userEvent.type(screen.getByLabelText('Premise'), '!')
    expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, premise: `${DRAFT.premise}!` })
  })

  it('reports a typed hypothesis in its own row', async () => {
    const { onChange } = renderPanel()
    await userEvent.type(screen.getAllByPlaceholderText('A hypothesis to check')[1], '?')
    expect(onChange).toHaveBeenLastCalledWith({
      ...DRAFT,
      hypotheses: [DRAFT.hypotheses[0], `${DRAFT.hypotheses[1]}?`],
    })
  })

  it('adds an empty row at the end', async () => {
    const { onChange } = renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Add hypothesis' }))
    expect(onChange).toHaveBeenCalledWith({ ...DRAFT, hypotheses: [...DRAFT.hypotheses, ''] })
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_add_hypothesis')
  })

  it('removes the row whose button was pressed', async () => {
    const { onChange } = renderPanel()
    await userEvent.click(screen.getAllByLabelText('Remove')[0])
    expect(onChange).toHaveBeenCalledWith({ ...DRAFT, hypotheses: [DRAFT.hypotheses[1]] })
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_remove_hypothesis')
  })

  it('keeps the last row, because a check needs a hypothesis', () => {
    renderPanel({ value: { premise: 'p', hypotheses: ['only one'] } })
    expect(screen.getByLabelText('Remove')).toBeDisabled()
  })

  it('stops adding rows at the request limit', () => {
    renderPanel({ value: { premise: 'p', hypotheses: Array.from({ length: MAX_JEV_INPUTS }, () => 'h') } })
    expect(screen.getByRole('button', { name: 'Add hypothesis' })).toBeDisabled()
  })

  it('runs on demand, and says how to do it from the keyboard', async () => {
    const { onRun } = renderPanel()
    expect(screen.getByText('Ctrl+Enter')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('locks the editor while a run is in flight', () => {
    renderPanel({ running: true })
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
    expect(screen.getByLabelText('Premise')).toBeDisabled()
    for (const row of screen.getAllByPlaceholderText('A hypothesis to check')) expect(row).toBeDisabled()
  })
})
