// The ranked options (ADR-434 (c)). The gateway already ranked them; this view numbers the
// rows it was given and never reorders them, so the list and the JSON view can't disagree.
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChooseResults } from './ChooseResults'
import type { RerankResponse } from '../../lib/types'

const FRANCE: RerankResponse = {
  model: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  results: [
    { index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' },
    { index: 2, document: { text: 'Madrid' }, relevance_score: 0.016, label: 'contradiction' },
    { index: 0, document: { text: 'Berlin' }, relevance_score: 0.008, label: 'contradiction' },
  ],
  usage: { prompt_tokens: 51, total_tokens: 51 },
}

describe('ChooseResults', () => {
  it('numbers the options from 1 and shows each score and label', () => {
    render(<ChooseResults response={FRANCE} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('1')).toBeTruthy()
    expect(within(rows[0]).getByText('Paris')).toBeTruthy()
    expect(within(rows[0]).getByText('0.941')).toBeTruthy()
    expect(within(rows[0]).getByText('entailment')).toBeTruthy()
    expect(within(rows[2]).getByText('3')).toBeTruthy()
    expect(within(rows[2]).getByText('Berlin')).toBeTruthy()
    expect(within(rows[2]).getByText('0.008')).toBeTruthy()
  })

  it('marks the top-ranked option, and only that one', () => {
    render(<ChooseResults response={FRANCE} />)
    expect(within(screen.getAllByRole('listitem')[0]).getByText('best')).toBeTruthy()
    expect(screen.getAllByText('best')).toHaveLength(1)
  })

  it('keeps the order the gateway returned, whatever the scores say', () => {
    const asGiven: RerankResponse = { ...FRANCE, results: [...FRANCE.results].reverse() }
    render(<ChooseResults response={asGiven} />)
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('Berlin')).toBeTruthy()
    expect(within(rows[0]).getByText('best')).toBeTruthy()
    expect(within(rows[2]).getByText('Paris')).toBeTruthy()
  })
})
