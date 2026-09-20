// What the model said about each hypothesis (ADR-434 (c)). The view renders the answer as it
// arrived — the label order is the model's own `id2label` order, which is why nothing here
// sorts, renames or recomputes a probability.
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CheckResults } from './CheckResults'
import type { ClassifyResponse } from '../../lib/types'

const KITCHEN: ClassifyResponse = {
  model: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
  results: [
    { hypothesis: 'Someone is preparing food.', label: 'entailment', probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 } },
    { hypothesis: 'The kitchen is empty and silent.', label: 'contradiction', probs: { contradiction: 1, entailment: 0, neutral: 0 } },
    { hypothesis: 'The chef is wearing a blue apron.', label: 'neutral', probs: { contradiction: 0.001, entailment: 0.001, neutral: 0.998 } },
  ],
  usage: { prompt_tokens: 69, total_tokens: 69 },
}

describe('CheckResults', () => {
  it('shows one row per hypothesis, with its winning label and its three probabilities', () => {
    render(<CheckResults response={KITCHEN} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('Someone is preparing food.')).toBeTruthy()
    expect(within(rows[0]).getByText('0.957')).toBeTruthy()
    expect(within(rows[1]).getByText('1.000')).toBeTruthy()
    expect(within(rows[2]).getByText('0.998')).toBeTruthy()
    expect(within(rows[2]).getByText('The chef is wearing a blue apron.')).toBeTruthy()
  })

  it('marks the most-entailed hypothesis, and only that one', () => {
    render(<CheckResults response={KITCHEN} />)
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('best match')).toBeTruthy()
    expect(screen.getAllByText('best match')).toHaveLength(1)
  })

  it('marks the most-entailed hypothesis wherever it is in the list', () => {
    render(<CheckResults response={{ ...KITCHEN, results: [KITCHEN.results[1], KITCHEN.results[0]] }} />)
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[1]).getByText('best match')).toBeTruthy()
    expect(screen.getAllByText('best match')).toHaveLength(1)
  })

  it('does not crown a single hypothesis — there is nothing to compare it with', () => {
    render(<CheckResults response={{ ...KITCHEN, results: [KITCHEN.results[0]] }} />)
    expect(screen.queryByText('best match')).toBeNull()
  })

  it("reads the probabilities in the model's own label order", () => {
    const permuted: ClassifyResponse = {
      ...KITCHEN,
      results: [
        {
          hypothesis: 'Someone is preparing food.',
          label: 'entailment',
          probs: { entailment: 0.957, neutral: 0.043, contradiction: 0 },
        },
      ],
    }
    render(<CheckResults response={permuted} />)
    const names = within(screen.getByRole('listitem')).getAllByRole('term').map((el) => el.textContent)
    expect(names).toEqual(['entailment', 'neutral', 'contradiction'])
  })
})
