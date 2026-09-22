// The answers column (ADR-439): the cards, the empty state, and the honest label that is always
// there, whatever the state of the column: it is what stops a reader taking a score for a decision.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnswerList } from './AnswerList'
import type { Answer } from '../../lib/systemone-types'

const ANSWERS: Record<string, Answer> = {
  urgent: { type: 'noul', noul: 0.945 },
  team: {
    type: 'choice',
    choice: 'technical',
    probabilities: { billing: 0.31, technical: 0.5, sales: 0.18, documentation: 0.01 },
    confidence: 0.31,
  },
  mood: {
    type: 'score',
    score: 2.013,
    legend: { '0': 'Calm', '1': 'Annoyed', '2': 'Frustrated', '3': 'Angry' },
    probabilities: { '0': 0.086, '1': 0.089, '2': 0.551, '3': 0.274 },
    confidence: 0.49,
  },
}

const EMPTY_HINT = 'Run, or press ⌘/Ctrl+Enter.'
const HONEST_LABEL = "These are the model's NLI entailment scores, normalised — not a calibrated decision model."
const notShapedLikeAnswers = (value: unknown) => value as Record<string, Answer>

describe('AnswerList', () => {
  it('asks for a run before there are answers, and still carries the honest label', () => {
    render(<AnswerList answers={null} stale={false} />)
    expect(screen.getByText(EMPTY_HINT)).toBeInTheDocument()
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    expect(screen.getByText(HONEST_LABEL)).toBeInTheDocument()
  })

  it('shows one card per answer, in the order the response gave them', () => {
    render(<AnswerList answers={ANSWERS} stale={false} />)
    const names = screen.getAllByRole('group').map((card) => card.getAttribute('aria-label'))
    expect(names).toEqual(['urgent — noul', 'team — choice', 'mood — score'])
    expect(screen.queryByText(EMPTY_HINT)).toBeNull()
  })

  it('keeps the previous answers on screen, dimmed and marked busy, while a run is in flight', () => {
    const { container } = render(<AnswerList answers={ANSWERS} stale />)
    const busy = container.querySelector('[aria-busy="true"]')
    expect(busy).not.toBeNull()
    expect(busy).toHaveClass('opacity-60')
    expect(busy?.querySelectorAll('[role="group"]')).toHaveLength(3)
  })

  it('is not busy or dimmed when the answers are current', () => {
    const { container } = render(<AnswerList answers={ANSWERS} stale={false} />)
    expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(container.querySelector('.opacity-60')).toBeNull()
  })

  it('links to the docs with an absolute address in a new tab', () => {
    render(<AnswerList answers={null} stale={false} />)
    const link = screen.getByRole('link', { name: 'How it works →' })
    expect(link).toHaveAttribute('href', 'https://turbollm.dev/docs/jev#systemone')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('carries the honest label and the link in every state', () => {
    const states = [
      { answers: null, stale: false },
      { answers: null, stale: true },
      { answers: ANSWERS, stale: false },
      { answers: ANSWERS, stale: true },
    ]
    for (const { answers, stale } of states) {
      const { unmount } = render(<AnswerList answers={answers} stale={stale} />)
      expect(screen.getByText(HONEST_LABEL)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'How it works →' })).toBeInTheDocument()
      unmount()
    }
  })

  it('does not throw when the response has no answers object, and shows the empty state', () => {
    render(<AnswerList answers={notShapedLikeAnswers(undefined)} stale={false} />)
    expect(screen.getByText(EMPTY_HINT)).toBeInTheDocument()
    expect(screen.getByText(HONEST_LABEL)).toBeInTheDocument()
  })

  it('shows no cards, and no error, for an empty answers object', () => {
    render(<AnswerList answers={{}} stale={false} />)
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    expect(screen.getByText(HONEST_LABEL)).toBeInTheDocument()
  })

  it('shows a card, not a crash, for an answer that is not an answer, and its id as text', () => {
    const odd = notShapedLikeAnswers({ '<b>x</b>': null, other: 'text' })
    const { container } = render(<AnswerList answers={odd} stale={false} />)
    expect(screen.getAllByRole('group')).toHaveLength(2)
    expect(screen.getByRole('group', { name: '<b>x</b> — unknown' })).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
  })
})
