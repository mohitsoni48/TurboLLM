// The terminal-agent session's toolbar hands its picker the count CodeSessionScreen made of the models it left out, so
// the picker's empty state can name them, as the composer's does.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TerminalToolbar, type TerminalToolbarProps } from './TerminalToolbar'

vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), track: vi.fn() }))

const props: TerminalToolbarProps = {
  agent: 'claude', models: [], loadedKey: null, loadedName: null, modelPending: false, ejecting: false,
  onLoadModel: () => {}, onEjectModel: () => {}, ctxUsed: 0, ctxMax: 0,
  thinkingBudget: -1, onThinkingBudgetChange: () => {}, reasoningEffort: 'xhigh', onReasoningEffortChange: () => {},
}

describe('TerminalToolbar model picker', () => {
  it("says how many models the selected engine can't run when it has none to offer", async () => {
    render(<TerminalToolbar {...props} modelsHidden={{ byEngine: 1 }} />)
    await userEvent.click(screen.getByRole('button', { name: /Load a model/ }))
    expect(await screen.findByText('No models found.')).toBeInTheDocument()
    expect(screen.getByText(/^1 hidden: the selected engine can't run it/)).toBeInTheDocument()
  })
})
