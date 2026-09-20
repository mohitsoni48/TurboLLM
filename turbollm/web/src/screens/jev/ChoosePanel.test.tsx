// The Choose editor (ADR-434 (c)): a question and the options the model ranks against it.
// Same shape as CheckPanel, different domain words — and it never sends a hypothesis_template.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChoosePanel } from './ChoosePanel'
import { MAX_JEV_INPUTS } from '../../lib/jev-api'

const h = vi.hoisted(() => ({ track: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

const DRAFT = { question: 'What is the capital of France?', options: ['Berlin', 'Paris'] }

function renderPanel(over: Partial<Parameters<typeof ChoosePanel>[0]> = {}) {
  const onChange = vi.fn()
  const onRun = vi.fn()
  render(<ChoosePanel value={DRAFT} onChange={onChange} onRun={onRun} running={false} {...over} />)
  return { onChange, onRun }
}

beforeEach(() => {
  h.track.mockReset()
})

describe('ChoosePanel', () => {
  it('shows the question and one row per option', () => {
    renderPanel()
    expect(screen.getByLabelText('Question')).toHaveValue(DRAFT.question)
    const rows = screen.getAllByPlaceholderText('An option')
    expect(rows.map((r) => (r as HTMLInputElement).value)).toEqual(DRAFT.options)
  })

  it('reports a typed question', async () => {
    const { onChange } = renderPanel()
    await userEvent.type(screen.getByLabelText('Question'), '?')
    expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, question: `${DRAFT.question}?` })
  })

  it('reports a typed option in its own row', async () => {
    const { onChange } = renderPanel()
    await userEvent.type(screen.getAllByPlaceholderText('An option')[1], 'x')
    expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, options: ['Berlin', 'Parisx'] })
  })

  it('adds an empty row at the end', async () => {
    const { onChange } = renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Add option' }))
    expect(onChange).toHaveBeenCalledWith({ ...DRAFT, options: [...DRAFT.options, ''] })
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_add_option')
  })

  it('names each option row by its position, so a screen reader can tell them apart', () => {
    renderPanel()
    expect(screen.getByRole('textbox', { name: 'Option 1' })).toHaveValue(DRAFT.options[0])
    expect(screen.getByRole('textbox', { name: 'Option 2' })).toHaveValue(DRAFT.options[1])
  })

  it('names each Remove button after the row it removes, and removes only that row', async () => {
    const { onChange } = renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Remove option 2' }))
    expect(onChange).toHaveBeenCalledWith({ ...DRAFT, options: [DRAFT.options[0]] })
  })

  it('removes the row whose button was pressed', async () => {
    const { onChange } = renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Remove option 1' }))
    expect(onChange).toHaveBeenCalledWith({ ...DRAFT, options: ['Paris'] })
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_remove_option')
  })

  it('keeps the last row', () => {
    renderPanel({ value: { question: 'q', options: ['only one'] } })
    expect(screen.getByRole('button', { name: 'Remove option 1' })).toBeDisabled()
  })

  it('stops adding rows at the request limit', () => {
    renderPanel({ value: { question: 'q', options: Array.from({ length: MAX_JEV_INPUTS }, () => 'o') } })
    expect(screen.getByRole('button', { name: 'Add option' })).toBeDisabled()
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
    expect(screen.getByLabelText('Question')).toBeDisabled()
    for (const row of screen.getAllByPlaceholderText('An option')) expect(row).toBeDisabled()
  })
})
