import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeStatsFooter } from './CodeStatsFooter'
import { TerminalToolbar } from './TerminalToolbar'

// The founder's 2026-07-29 complaint about this strip was legibility, not data: rendered as one
// faint run-on monospace string (`Think: 3.0k 15%/200.7k ↑36.6k ↓36 · 2.0 t/s`) it "still looks
// like a bug". These lock in the two properties that fix it — every number is labelled, and the
// terminal-agent variant renders the SAME component rather than a hand-copied lookalike — so a
// later change can't quietly regress either one.

const FULL = {
  thinkingBudget: 3000,
  ctxUsed: 30_000,
  ctxMax: 200_000,
  lastPromptTokens: 36_600,
  lastGenTokens: 36,
  lastPromptTps: 950,
  lastGenTps: 2.04,
}

describe('CodeStatsFooter', () => {
  it('labels every number instead of running them together', () => {
    const { container } = render(<CodeStatsFooter {...FULL} />)

    for (const label of ['Think', 'Context', 'Last turn']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('3.0k')).toBeInTheDocument()
    expect(screen.getByText('15%')).toBeInTheDocument()
    expect(screen.getByText('of 200.0k')).toBeInTheDocument()
    expect(screen.getByText('↑36.6k ↓36')).toBeInTheDocument()

    // The specific string that read as a broken template — a percentage "divided by" a token
    // count. Percentage and max are now separate, labelled elements.
    expect(container.textContent).not.toContain('%/')
  })

  it('uses the app-wide tok/s unit, not a Code-only "t/s" abbreviation', () => {
    const { container } = render(<CodeStatsFooter {...FULL} />)
    expect(screen.getByText('2.0 tok/s')).toBeInTheDocument()
    expect(container.textContent).not.toContain('t/s')
  })

  it('omits any segment whose data is missing rather than fabricating a 0', () => {
    const { container } = render(<CodeStatsFooter thinkingBudget={-1} ctxUsed={0} ctxMax={0} />)
    expect(screen.getByText('Unlimited')).toBeInTheDocument() // the one always-known value
    expect(screen.queryByText('Context')).not.toBeInTheDocument()
    expect(screen.queryByText('Last turn')).not.toBeInTheDocument()
    expect(container.textContent).not.toContain('tok/s')
  })

  it('matches ThinkingBudgetSlider\'s own Off/Unlimited wording so the two can never disagree', () => {
    const { rerender } = render(<CodeStatsFooter thinkingBudget={0} ctxUsed={0} ctxMax={0} />)
    expect(screen.getByText('Off')).toBeInTheDocument()
    rerender(<CodeStatsFooter thinkingBudget={-1} ctxUsed={0} ctxMax={0} />)
    expect(screen.getByText('Unlimited')).toBeInTheDocument()
  })

  it('renders the caller\'s hint on the right, and nothing at all when there is none', () => {
    const { rerender } = render(<CodeStatsFooter {...FULL} hint="Enter to send · Esc to stop" />)
    expect(screen.getByText('Enter to send · Esc to stop')).toBeInTheDocument()
    rerender(<CodeStatsFooter {...FULL} />)
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument()
  })
})

describe('TerminalToolbar (the CLI variant of the same chrome)', () => {
  function renderToolbar() {
    return render(
      <TerminalToolbar
        agent="claude"
        models={[]}
        loadedKey={null}
        loadedName="Qwen3.6-35B"
        modelPending={false}
        ejecting={false}
        onLoadModel={() => {}}
        onEjectModel={() => {}}
        onThinkingBudgetChange={() => {}}
        {...FULL}
      />,
    )
  }

  it('shows the identical labelled stats a chat session shows — same component, not a copy', () => {
    renderToolbar()
    for (const text of ['Think', '3.0k', 'Context', '15%', 'of 200.0k', 'Last turn', '↑36.6k ↓36', '2.0 tok/s']) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
  })

  it('names the CLI driving the session — it appears nowhere else in the UI', () => {
    renderToolbar()
    expect(screen.getByText('claude')).toBeInTheDocument()
  })

  it('fills the hint slot with the terminal\'s own affordance instead of the composer\'s keybinds', () => {
    renderToolbar()
    // Ctrl+D is a real handler (TerminalView.tsx) that navigates away WITHOUT killing the PTY —
    // both halves of this hint have to stay true, same honesty rule as the composer's keybinds.
    expect(screen.getByText(/Ctrl\+D to leave/)).toBeInTheDocument()
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument()
  })
})
