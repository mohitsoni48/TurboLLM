// System One mapping (ADR-439, ADR-436 (1)): how a request's state, instructions and criteria
// become the text the engine scores, and how entailment probabilities become a distribution.
// Everything here is pure; no engine is involved and every number is synthetic.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  criterionTextOf,
  instructionTextOf,
  normalise,
  planSystemOne,
  serialiseState,
  type Criterion,
  type Instructions,
  type Question,
  type StateValue,
  type SystemOnePlan,
} from './systemone'

const STATE_URGENT =
  "I've been unable to connect my payment provider for three days and the integration keeps failing. " +
  "I'm losing sales, please help as soon as possible."

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

function nested(depth: number): unknown[] {
  return JSON.parse('['.repeat(depth) + ']'.repeat(depth)) as unknown[]
}

function planOf(questions: Record<string, Question>, state: StateValue = STATE_URGENT): SystemOnePlan {
  return planSystemOne({ state, model: 'm', questions })
}

function textsOf(plan: SystemOnePlan): string[] {
  return plan.hypotheses.map((hypothesis) => hypothesis.text)
}

test('serialiseState returns a string state byte for byte', () => {
  const padded = '  padded\nstate  '

  assert.equal(serialiseState(padded), padded)
})

test('serialiseState pretty-prints an object state with two-space indentation', () => {
  const state: StateValue = { a: { b: [1, 2] } }

  assert.equal(serialiseState(state), '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}')
})

test('serialiseState pretty-prints an array state the same way', () => {
  assert.equal(serialiseState([1, 'x']), '[\n  1,\n  "x"\n]')
})

test('serialiseState keeps the integer-key ordering of JSON.stringify (pinned, not worked around)', () => {
  assert.equal(serialiseState({ b: 1, 2: 'two', a: 3 }), '{\n  "2": "two",\n  "b": 1,\n  "a": 3\n}')
})

test('serialiseState renders an empty object and an empty array compactly', () => {
  assert.equal(serialiseState({}), '{}')
  assert.equal(serialiseState([]), '[]')
})

test('instructionTextOf returns a string verbatim', () => {
  assert.equal(instructionTextOf('Is it urgent?'), 'Is it urgent?')
})

test('instructionTextOf pretty-prints an array', () => {
  assert.equal(instructionTextOf(['a', 'b']), '[\n  "a",\n  "b"\n]')
})

test('instructionTextOf uses the question field alone when nothing else is present', () => {
  assert.equal(instructionTextOf({ question: 'Is it urgent?' }), 'Is it urgent?')
})

test('instructionTextOf leads with the question field and follows with the rest as JSON', () => {
  const instructions: Instructions = { question: 'Is it urgent?', ticket: 'x' }

  assert.equal(instructionTextOf(instructions), 'Is it urgent?\n{\n  "ticket": "x"\n}')
})

test('instructionTextOf pretty-prints the whole object when there is no usable question field', () => {
  assert.equal(instructionTextOf({ note: 1 }), '{\n  "note": 1\n}')
  assert.equal(instructionTextOf({ question: 5 }), '{\n  "question": 5\n}')
  assert.equal(instructionTextOf({ question: '' }), '{\n  "question": ""\n}')
})

test('criterionTextOf returns text verbatim and treats null and undefined as no text', () => {
  assert.equal(criterionTextOf('text'), 'text')
  assert.equal(criterionTextOf(''), '')
  assert.equal(criterionTextOf(null), undefined)
  assert.equal(criterionTextOf(undefined), undefined)
})

test('criterionTextOf pretty-prints an object and an array', () => {
  const asObject: Criterion = { a: 1 }
  const asArray: Criterion = [1]

  assert.equal(criterionTextOf(asObject), '{\n  "a": 1\n}')
  assert.equal(criterionTextOf(asArray), '[\n  1\n]')
})

test('normalise turns entailment probabilities into a distribution that sums to one', () => {
  assert.deepEqual(normalise([1, 3]), [0.25, 0.75])
  const spread = normalise([0.321, 0.515, 0.185, 0.005])
  assert.ok(Math.abs(spread.reduce((sum, p) => sum + p, 0) - 1) < 1e-12)
  assert.deepEqual(normalise([0.3]), [1])
})

test('normalise turns all-zero raws into a uniform distribution and never NaN, without mutating its input', () => {
  const zeros = [0, 0, 0, 0]

  assert.deepEqual(normalise(zeros), [0.25, 0.25, 0.25, 0.25])
  assert.deepEqual(zeros, [0, 0, 0, 0])
})

test('serialiseState of a value nested 32 levels deep is exactly 2048 characters and does not throw', () => {
  const text = serialiseState(nested(32))

  assert.equal(text.length, 2048)
})

test('planSystemOne uses a string state verbatim as the one premise and pretty-prints an object state', () => {
  const asText = planOf({ q: Q_NOUL }, '  padded\nstate  ')
  const asObject = planOf({ q: Q_NOUL }, { ticket: 'x' })

  assert.equal(asText.premise, '  padded\nstate  ')
  assert.equal(asObject.premise, '{\n  "ticket": "x"\n}')
})

test('planSystemOne orders the nine hypotheses of the three-question fixture question by question', () => {
  const plan = planOf({ urgent: Q_NOUL, team: Q_CHOICE, mood: Q_MOOD })

  assert.deepEqual(plan.hypotheses, [
    { questionId: 'urgent', index: 0, text: 'Does the message convey urgency?' },
    {
      questionId: 'team',
      index: 0,
      text: 'Which team should handle this message? The correct answer is: billing (Payment, invoices, refunds or subscription charges)',
    },
    {
      questionId: 'team',
      index: 1,
      text: 'Which team should handle this message? The correct answer is: technical (Bugs, outages or integration problems)',
    },
    {
      questionId: 'team',
      index: 2,
      text: 'Which team should handle this message? The correct answer is: sales (Pricing, plans, upgrades or discounts)',
    },
    {
      questionId: 'team',
      index: 3,
      text: 'Which team should handle this message? The correct answer is: documentation (Questions about where to find docs or reference material)',
    },
    { questionId: 'mood', index: 0, text: "What is the customer's tone? The correct answer is: Calm, just asking or stating facts" },
    { questionId: 'mood', index: 1, text: "What is the customer's tone? The correct answer is: Mildly annoyed but polite" },
    { questionId: 'mood', index: 2, text: "What is the customer's tone? The correct answer is: Clearly frustrated" },
    { questionId: 'mood', index: 3, text: "What is the customer's tone? The correct answer is: Very angry, strong language" },
  ])
})

test('planSystemOne makes a noul hypothesis the instruction verbatim', () => {
  assert.deepEqual(textsOf(planOf({ urgent: Q_NOUL })), ['Does the message convey urgency?'])
})

test('planSystemOne appends a noul criteria.true string to the instruction after one space', () => {
  const question: Question = {
    type: 'noul',
    instructions: 'Does the message convey urgency?',
    criteria: { true: 'The customer needs help within hours.' },
  }

  assert.deepEqual(textsOf(planOf({ urgent: question })), [
    'Does the message convey urgency? The customer needs help within hours.',
  ])
})

test('planSystemOne appends a noul criteria.true object as pretty JSON and ignores a null one', () => {
  const asObject: Question = { type: 'noul', instructions: 'Does the message convey urgency?', criteria: { true: { k: 1 } } }
  const asNull: Question = { type: 'noul', instructions: 'Does the message convey urgency?', criteria: { true: null } }

  assert.deepEqual(textsOf(planOf({ q: asObject })), ['Does the message convey urgency? {\n  "k": 1\n}'])
  assert.deepEqual(textsOf(planOf({ q: asNull })), ['Does the message convey urgency?'])
})

test('planSystemOne never uses a noul criteria.false', () => {
  const question: Question = {
    type: 'noul',
    instructions: 'Does the message convey urgency?',
    criteria: { true: 'T', false: 'FALSE-SENTINEL' },
  }

  const plan = planOf({ q: question })

  assert.equal(plan.hypotheses.length, 1)
  assert.ok(plan.hypotheses.every((hypothesis) => !hypothesis.text.includes('FALSE-SENTINEL')))
})

test('planSystemOne labels a choice option with its description only when the description has text', () => {
  const question: Question = {
    type: 'choice',
    instructions: 'Pick one.',
    criteria: { sales: null, b: '', c: { k: 1 } },
  }

  assert.deepEqual(textsOf(planOf({ q: question })), [
    'Pick one. The correct answer is: sales',
    'Pick one. The correct answer is: b',
    'Pick one. The correct answer is: c ({\n  "k": 1\n})',
  ])
})

test('planSystemOne puts an object score level after the template as pretty JSON', () => {
  const question: Question = { type: 'score', instructions: 'Rate it.', criteria: [{ k: 1 }, 'plain'] }

  assert.deepEqual(textsOf(planOf({ q: question })), [
    'Rate it. The correct answer is: {\n  "k": 1\n}',
    'Rate it. The correct answer is: plain',
  ])
})

test('planSystemOne leads a hypothesis with the instructions question field and follows with the rest as JSON', () => {
  const question: Question = { type: 'noul', instructions: { question: 'Is it urgent?', ticket: 'x' } }

  assert.deepEqual(textsOf(planOf({ q: question })), ['Is it urgent?\n{\n  "ticket": "x"\n}'])
})

test('planSystemOne keeps every question and instruction out of the premise', () => {
  const plan = planOf({ urgent: Q_NOUL, team: Q_CHOICE, mood: Q_MOOD })

  assert.equal(plan.premise, STATE_URGENT)
})

test('planSystemOne keeps a __proto__ question id as data and pollutes nothing', () => {
  const questions = JSON.parse('{"__proto__":{"type":"noul","instructions":"i"}}') as Record<string, Question>

  const first = planOf(questions)
  const second = planOf(questions)

  assert.equal(first.hypotheses[0].questionId, '__proto__')
  assert.equal(({} as Record<string, unknown>).type, undefined)
  assert.deepEqual(first, second)
})

test('planSystemOne orders integer-like ids and option names the way JSON.parse iterates them (pinned)', () => {
  const questions = JSON.parse(
    '{"b":{"type":"noul","instructions":"B?"},"2":{"type":"noul","instructions":"two?"},"10":{"type":"noul","instructions":"ten?"}}',
  ) as Record<string, Question>
  const choice: Question = {
    type: 'choice',
    instructions: 'Pick.',
    criteria: JSON.parse('{"3":"c","1":"a","2":"b"}') as Record<string, string>,
  }

  assert.deepEqual(planOf(questions).hypotheses.map((hypothesis) => hypothesis.questionId), ['2', '10', 'b'])
  assert.deepEqual(textsOf(planOf({ q: choice })), [
    'Pick. The correct answer is: 1 (a)',
    'Pick. The correct answer is: 2 (b)',
    'Pick. The correct answer is: 3 (c)',
  ])
})

test('planSystemOne never trims blank text', () => {
  const emptyTrue: Question = { type: 'noul', instructions: 'Does the message convey urgency?', criteria: { true: '' } }
  const blankLevel: Question = { type: 'score', instructions: 'Rate it.', criteria: ['  ', 'x'] }

  assert.deepEqual(textsOf(planOf({ q: emptyTrue })), ['Does the message convey urgency? '])
  assert.equal(textsOf(planOf({ q: blankLevel }))[0], 'Rate it. The correct answer is:   ')
})

test('planSystemOne throws a TypeError for a null score level and plans a state nested 32 levels deep', () => {
  const nullLevel: Question = { type: 'score', instructions: 'Rate it.', criteria: ['a', null] }

  assert.throws(() => planOf({ q: nullLevel }), TypeError)
  assert.equal(planOf({ q: Q_NOUL }, nested(32)).premise.length, 2048)
})
