// One question's answer, in the shape of its type (ADR-439). The numbers are the model's own
// normalised entailment scores: a score's levels stay in level order, because the scale is ordinal.
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnswerCard } from './AnswerCard'
import type { Answer } from '../../lib/systemone-types'

const URGENT = { type: 'noul', noul: 0.945 } satisfies Answer

const TEAM = {
  type: 'choice',
  choice: 'technical',
  probabilities: {
    billing: 0.3128654970760234,
    technical: 0.5019493177387915,
    sales: 0.18031189083820662,
    documentation: 0.004873294346978557,
  },
  confidence: 0.31205475103149055,
} satisfies Answer

const MOOD = {
  type: 'score',
  score: 2.013,
  legend: {
    '0': 'Calm, just asking or stating facts',
    '1': 'Mildly annoyed but polite',
    '2': 'Clearly frustrated',
    '3': 'Very angry, strong language',
  },
  probabilities: { '0': 0.086, '1': 0.089, '2': 0.551, '3': 0.274 },
  confidence: 0.49210868531804325,
} satisfies Answer

const EM_DASH = '—'
const MIDDLE_DOT = '·'

const rowsOf = () => screen.getAllByRole('listitem').map((row) => row.textContent)
const fillWidthOf = (element: Element) => (element.querySelector('span.bg-accent') as HTMLElement).style.width
const notShapedLikeAnAnswer = (value: unknown) => value as Answer

describe('AnswerCard', () => {
  it('shows a yes/no answer as its number to three places, its caption and one bar', () => {
    const { container } = render(<AnswerCard id="urgent" answer={URGENT} />)
    const card = screen.getByRole('group', { name: `urgent ${EM_DASH} noul` })
    expect(within(card).getByText('0.945')).toBeInTheDocument()
    expect(within(card).getByText('entailment probability')).toBeInTheDocument()
    expect(container.querySelectorAll('span.bg-accent')).toHaveLength(1)
    expect(fillWidthOf(card)).toBe('94.5%')
  })

  it('shows a choice as the chosen option and its confidence, then every option by probability', () => {
    render(<AnswerCard id="team" answer={TEAM} />)
    const card = screen.getByRole('group', { name: `team ${EM_DASH} choice` })
    expect(within(card).getByText('technical')).toBeInTheDocument()
    expect(within(card).getByText('confidence 0.31')).toBeInTheDocument()
    expect(rowsOf()).toEqual([
      `technical ${MIDDLE_DOT} 0.50`,
      `billing ${MIDDLE_DOT} 0.31`,
      `sales ${MIDDLE_DOT} 0.18`,
      `documentation ${MIDDLE_DOT} 0.00`,
    ])
  })

  it('keeps the input order for options that share a probability', () => {
    const tied: Answer = {
      type: 'choice',
      choice: 'z',
      probabilities: { b: 0.25, a: 0.25, z: 0.5 },
      confidence: 0.5,
    }
    render(<AnswerCard id="tie" answer={tied} />)
    expect(rowsOf()).toEqual([`z ${MIDDLE_DOT} 0.50`, `b ${MIDDLE_DOT} 0.25`, `a ${MIDDLE_DOT} 0.25`])
  })

  it('shows a score with its range and every level in level order, not probability order', () => {
    render(<AnswerCard id="mood" answer={MOOD} />)
    const card = screen.getByRole('group', { name: `mood ${EM_DASH} score` })
    expect(within(card).getByText('2.01')).toBeInTheDocument()
    expect(within(card).getByText('0–3')).toBeInTheDocument()
    expect(within(card).getByText('confidence 0.49')).toBeInTheDocument()
    expect(rowsOf()).toEqual([
      `0 ${MIDDLE_DOT} Calm, just asking or stating facts ${MIDDLE_DOT} 0.09`,
      `1 ${MIDDLE_DOT} Mildly annoyed but polite ${MIDDLE_DOT} 0.09`,
      `2 ${MIDDLE_DOT} Clearly frustrated ${MIDDLE_DOT} 0.55`,
      `3 ${MIDDLE_DOT} Very angry, strong language ${MIDDLE_DOT} 0.27`,
    ])
  })

  it('shows zero confidence as 0.00 and never prints NaN, whatever the type', () => {
    const answers = [
      { ...TEAM, confidence: 0 },
      { ...MOOD, confidence: 0 },
    ]
    for (const answer of answers) {
      const { container, unmount } = render(<AnswerCard id="q" answer={answer} />)
      expect(screen.getByText('confidence 0.00')).toBeInTheDocument()
      expect(container.textContent).not.toContain('NaN')
      unmount()
    }
    const { container } = render(<AnswerCard id="q" answer={{ type: 'noul', noul: 0 }} />)
    expect(container.textContent).not.toContain('NaN')
  })

  it('sizes a bar to its probability as a percentage with one decimal', () => {
    const spread: Answer = {
      type: 'choice',
      choice: 'one',
      probabilities: { none: 0, some: 0.3128654970760234, one: 1 },
      confidence: 1,
    }
    render(<AnswerCard id="bars" answer={spread} />)
    const widths = screen.getAllByRole('listitem').map(fillWidthOf)
    expect(widths).toEqual(['100%', '31.3%', '0%'])
  })

  it('shows a question id made of markup as text, never as markup', () => {
    const { container } = render(<AnswerCard id="<b>x</b>" answer={URGENT} />)
    expect(screen.getByRole('group', { name: `<b>x</b> ${EM_DASH} noul` })).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
  })

  it('makes every card a group reachable by its name', () => {
    render(
      <>
        <AnswerCard id="urgent" answer={URGENT} />
        <AnswerCard id="team" answer={TEAM} />
        <AnswerCard id="mood" answer={MOOD} />
      </>,
    )
    const names = screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))
    expect(names).toEqual([`urgent ${EM_DASH} noul`, `team ${EM_DASH} choice`, `mood ${EM_DASH} score`])
  })

  it('shows option names and legend texts made of markup as text, never as markup', () => {
    const hostileChoice: Answer = {
      type: 'choice',
      choice: '<img src=x onerror=alert(1)>',
      probabilities: { '<img src=x onerror=alert(1)>': 0.6, '<b>x</b>': 0.4 },
      confidence: 0.5,
    }
    const hostileScore: Answer = {
      type: 'score',
      score: 0.5,
      legend: { '0': '<script>alert(1)</script>', '1': '<b>x</b>' },
      probabilities: { '0': 0.5, '1': 0.5 },
      confidence: 0.5,
    }
    const { container } = render(
      <>
        <AnswerCard id="c" answer={hostileChoice} />
        <AnswerCard id="s" answer={hostileScore} />
      </>,
    )
    expect(container.querySelector('img, b, script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('does not throw on a choice with no probabilities or a score with no legend', () => {
    const emptyChoice = notShapedLikeAnAnswer({ type: 'choice', choice: 'a', probabilities: {}, confidence: 0.5 })
    const noLegend = notShapedLikeAnAnswer({ type: 'score', score: 1, probabilities: {}, confidence: 0.5 })
    const { container } = render(
      <>
        <AnswerCard id="c" answer={emptyChoice} />
        <AnswerCard id="s" answer={noLegend} />
      </>,
    )
    expect(screen.getAllByRole('group')).toHaveLength(2)
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/undefined|NaN|-1/)
  })

  it('shows a dash, not null, undefined or NaN, for a number that is not a number', () => {
    const noulNull = notShapedLikeAnAnswer({ type: 'noul', noul: null })
    const confidenceText = notShapedLikeAnAnswer({ ...TEAM, confidence: 'NaN' })
    const { container } = render(
      <>
        <AnswerCard id="n" answer={noulNull} />
        <AnswerCard id="c" answer={confidenceText} />
      </>,
    )
    expect(screen.getByText(`confidence ${EM_DASH}`)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/null|undefined|NaN/)
  })

  it('names an answer of an unknown type and says it cannot show it, without throwing', () => {
    const odd = notShapedLikeAnAnswer({ type: 'ranking', order: ['a', 'b'] })
    render(<AnswerCard id="r" answer={odd} />)
    const card = screen.getByRole('group', { name: `r ${EM_DASH} ranking` })
    expect(card).toHaveTextContent('not in a shape the playground can show')
  })

  it('does not throw when the answer is not even an object', () => {
    render(
      <>
        <AnswerCard id="a" answer={notShapedLikeAnAnswer(null)} />
        <AnswerCard id="b" answer={notShapedLikeAnAnswer('text')} />
      </>,
    )
    const names = screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))
    expect(names).toEqual([`a ${EM_DASH} unknown`, `b ${EM_DASH} unknown`])
  })
})
