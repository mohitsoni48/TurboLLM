// The four examples the founder approved in the mockup (ADR-434 (c)).
//
// They are INPUTS only. The mockup shipped recorded probabilities beside each one so it could
// demo without an engine; a hardcoded number in the real playground would be a lie about the
// loaded model, which may not even be the one those numbers came from.
import { describe, expect, it } from 'vitest'
import { JEV_EXAMPLES } from './jev-examples'

describe('JEV_EXAMPLES — check', () => {
  it('offers the kitchen and stage premises, in that order', () => {
    expect(JEV_EXAMPLES.check.map((e) => e.id)).toEqual(['kitchen', 'stage'])
    expect(JEV_EXAMPLES.check.map((e) => e.label)).toEqual(['Example: kitchen (check)', 'Example: stage (check)'])
  })

  it('carries the kitchen premise and its three hypotheses, word for word', () => {
    expect(JEV_EXAMPLES.check[0].premise).toBe('A chef is chopping onions in a busy restaurant kitchen.')
    expect(JEV_EXAMPLES.check[0].hypotheses).toEqual([
      'Someone is preparing food.',
      'The kitchen is empty and silent.',
      'The chef is wearing a blue apron.',
    ])
  })

  it('carries the stage premise and its three hypotheses, word for word', () => {
    expect(JEV_EXAMPLES.check[1].premise).toBe('A man is playing a guitar on stage.')
    expect(JEV_EXAMPLES.check[1].hypotheses).toEqual([
      'A man is performing music.',
      'The man is asleep in bed.',
      'The man is wearing a red hat.',
    ])
  })
})

describe('JEV_EXAMPLES — choose', () => {
  it('offers the capital and plants questions, in that order', () => {
    expect(JEV_EXAMPLES.choose.map((e) => e.id)).toEqual(['capital', 'plants'])
    expect(JEV_EXAMPLES.choose.map((e) => e.label)).toEqual(['Example: capital (choose)', 'Example: plants (choose)'])
  })

  it('carries the capital question and its three options, word for word', () => {
    expect(JEV_EXAMPLES.choose[0].question).toBe('What is the capital of France?')
    expect(JEV_EXAMPLES.choose[0].options).toEqual(['Berlin', 'Paris', 'Madrid'])
  })

  it('carries the plants question and its three options, word for word', () => {
    expect(JEV_EXAMPLES.choose[1].question).toBe('Which gas do plants absorb during photosynthesis?')
    expect(JEV_EXAMPLES.choose[1].options).toEqual(['oxygen', 'carbon dioxide', 'nitrogen'])
  })
})

describe('JEV_EXAMPLES — inputs only', () => {
  it('ships no recorded answer of any kind', () => {
    expect(JEV_EXAMPLES.check.map((e) => Object.keys(e).sort())).toEqual([
      ['hypotheses', 'id', 'label', 'premise'],
      ['hypotheses', 'id', 'label', 'premise'],
    ])
    expect(JEV_EXAMPLES.choose.map((e) => Object.keys(e).sort())).toEqual([
      ['id', 'label', 'options', 'question'],
      ['id', 'label', 'options', 'question'],
    ])
  })
})
