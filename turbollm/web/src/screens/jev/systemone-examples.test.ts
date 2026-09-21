// System One playground (ADR-439, ADR-434 (c)): four examples that each show one thing and load
// inputs only. An example never carries a recorded result, so the numbers a user sees are always
// the ones their own run produced.
import { describe, expect, it } from 'vitest'
import type { Question } from '../../lib/systemone-types'
import { draftRequest } from './systemone-draft'
import { SYSTEMONE_EXAMPLES } from './systemone-examples'
import type { SystemOneExample } from './systemone-examples'

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

function exampleNamed(id: string): SystemOneExample {
  const found = SYSTEMONE_EXAMPLES.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no example named ${id}`)
  return found
}

const questionsOf = (id: string): Record<string, Question> => JSON.parse(exampleNamed(id).questionsText)

describe('SYSTEMONE_EXAMPLES', () => {
  it('holds the four examples in order, with unique ids and readable labels', () => {
    const ids = SYSTEMONE_EXAMPLES.map((example) => example.id)

    expect(ids).toEqual(['support-ticket', 'yes-no', 'routing', 'scoring'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(SYSTEMONE_EXAMPLES.map((example) => example.label)).toEqual([
      'Support ticket: all three types',
      'Yes/no: a question and a statement',
      'Routing: pick one team',
      'Scoring: a position on a scale',
    ])
  })

  it.each(SYSTEMONE_EXAMPLES.map((example) => [example.id, example] as const))(
    '%s is a valid draft',
    (_id, example) => {
      const result = draftRequest('m', { stateText: example.stateText, questionsText: example.questionsText })

      expect(result.ok).toBe(true)
    },
  )

  it('shows all three question types in the support ticket, whose state is a ticket object', () => {
    const types = Object.values(questionsOf('support-ticket')).map((question) => question.type)

    expect(types).toEqual(['noul', 'choice', 'score'])
    expect(JSON.parse(exampleNamed('support-ticket').stateText)).toEqual({
      ticket: {
        subject: 'Payment provider integration failing',
        text: "I've been unable to connect my payment provider for three days and the integration keeps failing. I'm losing sales, please help as soon as possible.",
      },
    })
  })

  it('shows two noul questions in yes-no, one written as a question and one as a statement', () => {
    const questions = Object.values(questionsOf('yes-no'))

    expect(questions.map((question) => question.type)).toEqual(['noul', 'noul'])
    expect(questions.map((question) => String(question.instructions).endsWith('?'))).toEqual([true, false])
    expect(exampleNamed('yes-no').stateText).toBe(
      'I was charged twice for my subscription this month. Please refund the duplicate charge.',
    )
  })

  it('shows one choice in routing with four described options, over a message that fits none', () => {
    const questions = questionsOf('routing')
    const { team } = questions
    if (team.type !== 'choice') throw new Error('the routing example must ask a choice question')

    expect(questions).toEqual({ team: Q_CHOICE })
    expect(Object.keys(team.criteria)).toHaveLength(4)
    expect(Object.values(team.criteria).every((description) => typeof description === 'string' && description !== '')).toBe(true)
    expect(exampleNamed('routing').stateText).toBe('Thanks, that fixed it! Have a nice day.')
  })

  it('shows one score in scoring with a neutral instruction', () => {
    const questions = questionsOf('scoring')

    expect(questions).toEqual({ mood: Q_MOOD })
    expect(String(questions.mood.instructions).startsWith('How ')).toBe(false)
    expect(exampleNamed('scoring').stateText).toBe(
      "This is the third time I'm writing. Your product is garbage and I'm cancelling today.",
    )
  })

  it('writes the questions as JSON indented by two spaces, with no trailing newline', () => {
    for (const example of SYSTEMONE_EXAMPLES) {
      expect(example.questionsText).toBe(JSON.stringify(JSON.parse(example.questionsText), null, 2))
    }
  })

  it('carries no recorded probability in any text', () => {
    const texts = SYSTEMONE_EXAMPLES.flatMap((example) => [example.stateText, example.questionsText])

    expect(texts.filter((text) => /\d\.\d{2,}/.test(text))).toEqual([])
  })
})
