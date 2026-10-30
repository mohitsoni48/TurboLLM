// The thinking budget's untouched value (-1) sends nothing, so the model's own default decides. For a model on LiteRT-LM
// that is not always thinking (gemma-4-E2B-it thinks only when asked), so it is shown there as the model's own
// default, Auto: "Unlimited" claimed thinking such a bundle never did, and every new chat, Android's too, starts there.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ThinkingBudgetSlider } from './ThinkingBudgetSlider'

const title = () => screen.getByRole('button', { name: 'Thinking budget' }).getAttribute('title')

describe('ThinkingBudgetSlider', () => {
  it('shows the untouched value as the model\'s own default (Auto) for a LiteRT-LM model, as Unlimited otherwise', () => {
    const { rerender } = render(<ThinkingBudgetSlider value={-1} onChange={() => {}} automatic />)
    expect(title()).toBe('Thinking: Auto (model\'s default) — click to adjust')
    rerender(<ThinkingBudgetSlider value={-1} onChange={() => {}} />)
    expect(title()).toBe('Thinking: Unlimited — click to adjust')
    // Off and a budget read the same either way.
    rerender(<ThinkingBudgetSlider value={0} onChange={() => {}} automatic />)
    expect(title()).toBe('Thinking: Off — click to adjust')
    rerender(<ThinkingBudgetSlider value={2000} onChange={() => {}} automatic />)
    expect(title()).toBe(`Thinking: ${(2000).toLocaleString()} tokens — click to adjust`)
  })
})
