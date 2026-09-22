// System One (ADR-439): the web app's twin of the backend request/response types, the request
// limits and the nesting bound. This project cannot import src/models/systemone-request.ts, so the
// limits are asserted as the literal backend numbers: changing one here means changing this test.
import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_CHARS,
  MAX_CHOICE_OPTIONS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_NESTING_DEPTH,
  MAX_OPTION_CHARS,
  MAX_QUESTIONS,
  MAX_QUESTION_ID_CHARS,
  MAX_SCORE_LEVELS,
  MAX_SYSTEMONE_HYPOTHESES,
  MIN_CHOICE_OPTIONS,
  MIN_INSTRUCTIONS_CHARS,
  MIN_QUESTIONS,
  MIN_SCORE_LEVELS,
  jsonDepth,
} from './systemone-types'
import type { Answer, Question, SystemOneRequest, SystemOneResponse } from './systemone-types'

const nested = (depth: number): unknown => JSON.parse('['.repeat(depth) + ']'.repeat(depth))

const STATE_URGENT =
  "I've been unable to connect my payment provider for three days and the integration keeps failing. I'm losing sales, please help as soon as possible."

const Q_NOUL: Question = { type: 'noul', instructions: 'Does the message convey urgency?' }
const Q_CHOICE: Question = {
  type: 'choice',
  instructions: 'Which team should handle this message?',
  criteria: {
    billing: 'Payment, invoices, refunds or subscription charges',
    technical: 'Bugs, outages or integration problems',
    sales: 'Pricing, plans, upgrades or discounts',
    documentation: 'Questions about where to find docs or reference material',
  },
}
const Q_MOOD: Question = {
  type: 'score',
  instructions: "What is the customer's tone?",
  criteria: [
    'Calm, just asking or stating facts',
    'Mildly annoyed but polite',
    'Clearly frustrated',
    'Very angry, strong language',
  ],
}

const REQUEST: SystemOneRequest = {
  state: STATE_URGENT,
  model: 'm',
  questions: { urgent: Q_NOUL, team: Q_CHOICE, mood: Q_MOOD },
}

const RESPONSE: SystemOneResponse = {
  model: 'm',
  answers: {
    urgent: { type: 'noul', noul: 0.945 },
    team: {
      type: 'choice',
      choice: 'technical',
      probabilities: {
        billing: 0.3128654970760234,
        technical: 0.5019493177387915,
        sales: 0.18031189083820662,
        documentation: 0.004873294346978557,
      },
      confidence: 0.31205475103149055,
    },
    mood: {
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
    },
  },
  usage: { input_tokens: 1200, output_tokens: 0 },
}

describe('the request limits', () => {
  it('equal the backend numbers, so a drift fails loudly', () => {
    expect({
      MIN_QUESTIONS,
      MAX_QUESTIONS,
      MAX_QUESTION_ID_CHARS,
      MIN_INSTRUCTIONS_CHARS,
      MAX_INSTRUCTIONS_CHARS,
      MIN_CHOICE_OPTIONS,
      MAX_CHOICE_OPTIONS,
      MAX_OPTION_CHARS,
      MIN_SCORE_LEVELS,
      MAX_SCORE_LEVELS,
      MAX_SYSTEMONE_HYPOTHESES,
      MAX_BODY_CHARS,
      MAX_NESTING_DEPTH,
    }).toEqual({
      MIN_QUESTIONS: 1,
      MAX_QUESTIONS: 64,
      MAX_QUESTION_ID_CHARS: 128,
      MIN_INSTRUCTIONS_CHARS: 1,
      MAX_INSTRUCTIONS_CHARS: 4000,
      MIN_CHOICE_OPTIONS: 2,
      MAX_CHOICE_OPTIONS: 255,
      MAX_OPTION_CHARS: 255,
      MIN_SCORE_LEVELS: 2,
      MAX_SCORE_LEVELS: 10,
      MAX_SYSTEMONE_HYPOTHESES: 512,
      MAX_BODY_CHARS: 1_048_576,
      MAX_NESTING_DEPTH: 32,
    })
  })

  it('never put a minimum above its maximum', () => {
    expect(MIN_QUESTIONS).toBeLessThanOrEqual(MAX_QUESTIONS)
    expect(MIN_INSTRUCTIONS_CHARS).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS)
    expect(MIN_CHOICE_OPTIONS).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS)
    expect(MIN_SCORE_LEVELS).toBeLessThanOrEqual(MAX_SCORE_LEVELS)
  })
})

// The typed fixtures are the assertion: a drifted type fails npm run typecheck, not this run.
describe('the request and response types', () => {
  it('describe a request with one question of each type', () => {
    expect(Object.values(REQUEST.questions).map((question) => question.type)).toEqual(['noul', 'choice', 'score'])
  })

  it('narrow each answer by its type', () => {
    const team: Answer = RESPONSE.answers.team
    const mood: Answer = RESPONSE.answers.mood
    if (team.type !== 'choice' || mood.type !== 'score') throw new Error('the fixture answers changed type')

    expect(team.choice).toBe('technical')
    expect(mood.score).toBe(2.013)
  })
})

describe('jsonDepth', () => {
  it.each([
    ['a string', 'x', 0],
    ['a number', 1, 0],
    ['null', null, 0],
    ['an empty array', [], 1],
    ['an empty object', {}, 1],
    ['an object in an object', { a: { b: 1 } }, 2],
  ])('measures %s as %d levels', (_name, value, depth) => {
    expect(jsonDepth(value, MAX_NESTING_DEPTH)).toBe(depth)
  })

  it('accepts a value exactly at the limit', () => {
    expect(jsonDepth(nested(32), MAX_NESTING_DEPTH)).toBe(32)
  })

  it('stops counting as soon as the limit is passed', () => {
    expect(jsonDepth(nested(33), MAX_NESTING_DEPTH)).toBe(33)
    expect(jsonDepth(nested(5000), MAX_NESTING_DEPTH)).toBe(33)
  })

  it('does not overflow the stack on a pasted value nested 20,000 deep', () => {
    expect(jsonDepth(nested(20000), MAX_NESTING_DEPTH)).toBe(33)
  })
})
