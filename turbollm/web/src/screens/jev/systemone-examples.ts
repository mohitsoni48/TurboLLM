// System One playground (ADR-439, ADR-434 (c)): four examples that each show one thing. They load
// inputs only, never a recorded result, so every number a user sees came from their own run.
import type { Question } from '../../lib/systemone-types'

export type SystemOneExample = { id: string; label: string; stateText: string; questionsText: string }

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

const URGENCY_QUESTION: Question = { type: 'noul', instructions: 'Does the message convey urgency?' }

const TEAM_QUESTION: Question = {
  type: 'choice',
  instructions: 'Which team should handle this message?',
  criteria: {
    billing: 'Payment, invoices, refunds or subscription charges',
    technical: 'Bugs, outages or integration problems',
    sales: 'Pricing, plans, upgrades or discounts',
    documentation: 'Questions about where to find docs or reference material',
  },
}

const MOOD_QUESTION: Question = {
  type: 'score',
  instructions: "What is the customer's tone?",
  criteria: [
    'Calm, just asking or stating facts',
    'Mildly annoyed but polite',
    'Clearly frustrated',
    'Very angry, strong language',
  ],
}

export const SYSTEMONE_EXAMPLES: readonly SystemOneExample[] = [
  {
    id: 'support-ticket',
    label: 'Support ticket: all three types',
    stateText: pretty({
      ticket: {
        subject: 'Payment provider integration failing',
        text: "I've been unable to connect my payment provider for three days and the integration keeps failing. I'm losing sales, please help as soon as possible.",
      },
    }),
    questionsText: pretty({ urgent: URGENCY_QUESTION, team: TEAM_QUESTION, mood: MOOD_QUESTION }),
  },
  {
    id: 'yes-no',
    label: 'Yes/no: a question and a statement',
    stateText: 'I was charged twice for my subscription this month. Please refund the duplicate charge.',
    questionsText: pretty({
      urgent: URGENCY_QUESTION,
      angry: { type: 'noul', instructions: 'The customer is angry.' },
    }),
  },
  {
    id: 'routing',
    label: 'Routing: pick one team',
    stateText: 'Thanks, that fixed it! Have a nice day.',
    questionsText: pretty({ team: TEAM_QUESTION }),
  },
  {
    id: 'scoring',
    label: 'Scoring: a position on a scale',
    stateText: "This is the third time I'm writing. Your product is garbage and I'm cancelling today.",
    questionsText: pretty({ mood: MOOD_QUESTION }),
  },
]
