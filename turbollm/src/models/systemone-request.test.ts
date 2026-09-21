// System One request validation (ADR-439, ADR-436 (1)): an untrusted body becomes a SystemOneInput
// or exactly one { field, message } problem, and never throws. The messages are the public wording
// the playground's own draft rules repeat, so every one is pinned here as a complete string.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  jsonDepth,
  MAX_BODY_CHARS,
  parseSystemOneBody,
  type RequestProblem,
} from './systemone-request'

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: 'x', model: 'm', questions: { q: { type: 'noul', instructions: 'i' } }, ...over }
}

function nested(depth: number): unknown[] {
  return JSON.parse('['.repeat(depth) + ']'.repeat(depth)) as unknown[]
}

function minimalQuestions(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, position) => [`q${position}`, { type: 'noul', instructions: 'i' }]),
  )
}

function refusalOf(raw: unknown): RequestProblem {
  const result = parseSystemOneBody(raw)
  assert.ok(!result.ok, 'expected the body to be refused')
  return result.problem
}

test('jsonDepth counts a scalar as 0, a container as 1 and adds one per nested level', () => {
  for (const scalar of ['x', 1, null]) assert.equal(jsonDepth(scalar, 32), 0)
  assert.equal(jsonDepth([], 32), 1)
  assert.equal(jsonDepth({}, 32), 1)
  assert.equal(jsonDepth({ a: { b: 1 } }, 32), 2)
  assert.equal(jsonDepth(nested(32), 32), 32)
})

test('jsonDepth stops counting once the depth passes the limit', () => {
  assert.equal(jsonDepth(nested(33), 32), 33)
  assert.equal(jsonDepth(nested(5000), 32), 33)
})

test('jsonDepth does not overflow the stack on a 20000-level value and counts arrays and objects alike', () => {
  assert.equal(jsonDepth(nested(20000), 32), 33)
  assert.equal(jsonDepth({ a: [{ b: [1] }] }, 32), 4)
})

test('parseSystemOneBody accepts a valid body and returns it as the input', () => {
  const body = validBody()

  const result = parseSystemOneBody(body)

  assert.ok(result.ok)
  assert.deepEqual(result.input, body)
})

test('parseSystemOneBody refuses a body that is not a JSON object', () => {
  for (const raw of [null, undefined, 'text', 42, [], [validBody()]]) {
    assert.deepEqual(refusalOf(raw), { field: 'body', message: 'body must be a JSON object.' })
  }
})

test('parseSystemOneBody bounds the nesting of state at 32 levels and never throws on a deeper one', () => {
  assert.ok(parseSystemOneBody(validBody({ state: nested(32) })).ok)
  for (const depth of [33, 5000, 20000]) {
    assert.deepEqual(refusalOf(validBody({ state: nested(depth) })), {
      field: 'state',
      message: 'state must not be nested more than 32 levels deep.',
    })
  }
})

test('parseSystemOneBody bounds the nesting of model, an unknown key and the questions container', () => {
  assert.deepEqual(refusalOf(validBody({ model: nested(33) })), {
    field: 'model',
    message: 'model must not be nested more than 32 levels deep.',
  })
  assert.deepEqual(refusalOf(validBody({ x: nested(33) })), {
    field: 'x',
    message: 'x must not be nested more than 32 levels deep.',
  })
  assert.deepEqual(refusalOf(validBody({ questions: nested(33) })), {
    field: 'questions',
    message: 'questions must not be nested more than 32 levels deep.',
  })
})

test('parseSystemOneBody checks nesting before size and type', () => {
  assert.equal(refusalOf(validBody({ state: nested(5000), model: 7 })).field, 'state')
})

test('parseSystemOneBody accepts a body of exactly 1048576 characters and refuses one more', () => {
  const overhead = JSON.stringify(validBody({ state: '' })).length
  const atLimit = validBody({ state: 'a'.repeat(MAX_BODY_CHARS - overhead) })
  const overLimit = validBody({ state: 'a'.repeat(MAX_BODY_CHARS - overhead + 1) })

  assert.equal(JSON.stringify(atLimit).length, 1048576)
  assert.ok(parseSystemOneBody(atLimit).ok)
  assert.deepEqual(refusalOf(overLimit), { field: 'body', message: 'body must be at most 1048576 characters.' })
})

test('parseSystemOneBody requires model to be a non-empty string', () => {
  for (const model of [undefined, '', 7, ['a']]) {
    assert.deepEqual(refusalOf(validBody({ model })), {
      field: 'model',
      message: 'model must be a non-empty string.',
    })
  }
})

test('parseSystemOneBody requires state to be a string, an object or an array', () => {
  for (const state of [undefined, null, 42, true]) {
    assert.deepEqual(refusalOf(validBody({ state })), {
      field: 'state',
      message: 'state is required and must be a string, an object or an array.',
    })
  }
  for (const state of ['a string', { a: 1 }, [1]]) assert.ok(parseSystemOneBody(validBody({ state })).ok)
})

test('parseSystemOneBody refuses an empty string state but accepts an empty container and blank text', () => {
  assert.deepEqual(refusalOf(validBody({ state: '' })), { field: 'state', message: 'state must not be empty.' })
  for (const state of [{}, [], ' ']) assert.ok(parseSystemOneBody(validBody({ state })).ok)
})

test('parseSystemOneBody requires between 1 and 64 questions', () => {
  const expected = { field: 'questions', message: 'questions must be an object with 1 to 64 questions.' }

  for (const questions of [undefined, null, [], 'x', {}]) assert.deepEqual(refusalOf(validBody({ questions })), expected)
  assert.ok(parseSystemOneBody(validBody({ questions: minimalQuestions(64) })).ok)
  assert.deepEqual(refusalOf(validBody({ questions: minimalQuestions(65) })), expected)
})

test('parseSystemOneBody reports only the first failure', () => {
  assert.equal(refusalOf(validBody({ model: 7, state: 42 })).field, 'model')
})

test('parseSystemOneBody ignores extra top-level keys and keeps the question order', () => {
  const questions = {
    b: { type: 'noul', instructions: 'i' },
    a: { type: 'noul', instructions: 'i' },
  }

  const result = parseSystemOneBody(validBody({ temperature: 1, questions }))

  assert.ok(result.ok)
  assert.deepEqual(Object.keys(result.input), ['state', 'model', 'questions'])
  assert.deepEqual(Object.keys(result.input.questions), ['b', 'a'])
})

test('parseSystemOneBody turns a RangeError raised while reading the body into a refusal', () => {
  const body = validBody()
  Object.defineProperty(body, 'state', {
    enumerable: true,
    get() {
      throw new RangeError('x')
    },
  })

  assert.deepEqual(refusalOf(body), { field: 'body', message: 'body is nested too deeply to be processed.' })
})

const Q_NOUL = { type: 'noul', instructions: 'Does the message convey urgency?' }

const Q_CHOICE = {
  type: 'choice',
  instructions: 'Which team should handle this message?',
  criteria: {
    billing: 'Payment, invoices, refunds or subscription charges',
    technical: 'Bugs, outages or integration problems',
    sales: 'Pricing, plans, upgrades or discounts',
    documentation: 'Questions about where to find docs or reference material',
  },
}

const Q_MOOD = {
  type: 'score',
  instructions: "What is the customer's tone?",
  criteria: [
    'Calm, just asking or stating facts',
    'Mildly annoyed but polite',
    'Clearly frustrated',
    'Very angry, strong language',
  ],
}

function withQuestion(question: unknown, id = 'q'): Record<string, unknown> {
  return validBody({ questions: { [id]: question } })
}

test('parseSystemOneBody requires a question id of 1 to 128 characters', () => {
  const tooLong = 'i'.repeat(129)

  assert.deepEqual(refusalOf(withQuestion(Q_NOUL, '')), {
    field: 'questions.',
    message: 'questions. must have an id of 1 to 128 characters.',
  })
  assert.deepEqual(refusalOf(withQuestion(Q_NOUL, tooLong)), {
    field: `questions.${tooLong}`,
    message: `questions.${tooLong} must have an id of 1 to 128 characters.`,
  })
  assert.ok(parseSystemOneBody(withQuestion(Q_NOUL, 'i'.repeat(128))).ok)
})

test('parseSystemOneBody requires each question to be an object', () => {
  for (const question of [null, 'x', [], 5]) {
    assert.deepEqual(refusalOf(withQuestion(question)), { field: 'questions.q', message: 'questions.q must be an object.' })
  }
})

test('parseSystemOneBody refuses a question field it does not know', () => {
  assert.deepEqual(refusalOf(withQuestion({ ...Q_NOUL, extra: 1 })), {
    field: 'questions.q.extra',
    message: 'questions.q.extra is not a known field.',
  })
})

test('parseSystemOneBody requires a question type of noul, choice or score', () => {
  const expected = { field: 'questions.q.type', message: 'questions.q.type must be "noul", "choice" or "score".' }

  for (const type of [undefined, 'yesno', 7]) assert.deepEqual(refusalOf(withQuestion({ ...Q_NOUL, type })), expected)
  for (const question of [Q_NOUL, Q_CHOICE, Q_MOOD]) assert.ok(parseSystemOneBody(withQuestion(question)).ok)
})

test('parseSystemOneBody requires instructions to be a string, an object or an array', () => {
  const expected = {
    field: 'questions.q.instructions',
    message: 'questions.q.instructions is required and must be a string, an object or an array.',
  }

  for (const instructions of [undefined, null, 42, true]) {
    assert.deepEqual(refusalOf(withQuestion({ type: 'noul', instructions })), expected)
  }
  for (const instructions of ['a string', { question: '?' }, ['a']]) {
    assert.ok(parseSystemOneBody(withQuestion({ type: 'noul', instructions })).ok)
  }
})

test('parseSystemOneBody bounds the serialised instructions to 1 to 4000 characters', () => {
  const expected = {
    field: 'questions.q.instructions',
    message: 'questions.q.instructions must be 1 to 4000 characters.',
  }

  assert.deepEqual(refusalOf(withQuestion({ type: 'noul', instructions: '' })), expected)
  assert.deepEqual(refusalOf(withQuestion({ type: 'noul', instructions: 'i'.repeat(4001) })), expected)
  assert.ok(parseSystemOneBody(withQuestion({ type: 'noul', instructions: 'i'.repeat(4000) })).ok)
  assert.ok(parseSystemOneBody(withQuestion({ type: 'noul', instructions: {} })).ok)
})

test('parseSystemOneBody names the second question in a problem found there', () => {
  const questions = { a: Q_NOUL, b: { ...Q_NOUL, type: 'yesno' } }

  assert.equal(refusalOf(validBody({ questions })).field, 'questions.b.type')
})

test('parseSystemOneBody reports the first question failing before a later one', () => {
  const questions = { a: { ...Q_NOUL, type: 'yesno' }, b: null }

  assert.equal(refusalOf(validBody({ questions })).field, 'questions.a.type')
})

test('parseSystemOneBody gives every question failure its exact message', () => {
  const cases: Array<{ question: unknown; id?: string; field: string; message: string }> = [
    { question: Q_NOUL, id: '', field: 'questions.', message: 'questions. must have an id of 1 to 128 characters.' },
    { question: 5, field: 'questions.q', message: 'questions.q must be an object.' },
    { question: { ...Q_NOUL, extra: 1 }, field: 'questions.q.extra', message: 'questions.q.extra is not a known field.' },
    {
      question: { ...Q_NOUL, type: 'yesno' },
      field: 'questions.q.type',
      message: 'questions.q.type must be "noul", "choice" or "score".',
    },
    {
      question: { type: 'noul' },
      field: 'questions.q.instructions',
      message: 'questions.q.instructions is required and must be a string, an object or an array.',
    },
    {
      question: { type: 'noul', instructions: '' },
      field: 'questions.q.instructions',
      message: 'questions.q.instructions must be 1 to 4000 characters.',
    },
  ]

  for (const { question, id, field, message } of cases) {
    assert.deepEqual(refusalOf(withQuestion(question, id)), { field, message })
  }
})

test('parseSystemOneBody accepts a valid noul question with no criteria end to end', () => {
  const body = withQuestion(Q_NOUL)

  const result = parseSystemOneBody(body)

  assert.ok(result.ok)
  assert.deepEqual(result.input, body)
})

test('parseSystemOneBody bounds the nesting inside a question (pinned)', () => {
  assert.deepEqual(refusalOf(withQuestion(nested(33))), {
    field: 'questions.q',
    message: 'questions.q must not be nested more than 32 levels deep.',
  })
  assert.deepEqual(refusalOf(withQuestion({ type: 'noul', instructions: nested(33) })), {
    field: 'questions.q.instructions',
    message: 'questions.q.instructions must not be nested more than 32 levels deep.',
  })
  assert.ok(parseSystemOneBody(withQuestion({ type: 'noul', instructions: nested(32) })).ok)
})

test('parseSystemOneBody reports a too-deep unknown key as nesting, not as an unknown field (pinned)', () => {
  assert.deepEqual(refusalOf(withQuestion({ ...Q_NOUL, extra: nested(33) })), {
    field: 'questions.q.extra',
    message: 'questions.q.extra must not be nested more than 32 levels deep.',
  })
})

test('parseSystemOneBody refuses instructions nested 5000 levels deep without throwing (pinned)', () => {
  assert.deepEqual(refusalOf(withQuestion({ type: 'noul', instructions: nested(5000) })), {
    field: 'questions.q.instructions',
    message: 'questions.q.instructions must not be nested more than 32 levels deep.',
  })
})
