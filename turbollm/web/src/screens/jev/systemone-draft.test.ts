// System One playground (ADR-439): the two editors' texts become the exact request that is POSTed
// and rendered as curl. The state editor accepts plain text; the questions editor must be JSON.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_BODY_CHARS } from '../../lib/systemone-types'
import type { Question, SystemOneRequest } from '../../lib/systemone-types'
import { draftRequest, stateFromText } from './systemone-draft'
import type { DraftProblem, SystemOneDraft } from './systemone-draft'

const MODEL = 'm'
const NOUL_QUESTIONS_TEXT = '{"q":{"type":"noul","instructions":"i"}}'

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

const nestedText = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth)
const nested = (depth: number): unknown => JSON.parse(nestedText(depth))

// The messages the server's request rules pin too (architecture section 3.6): each one a complete
// literal, so a drift in either project's wording turns a test red instead of surprising a user.
const MESSAGE = {
  stateTooDeep: 'state must not be nested more than 32 levels deep.',
  questionsTooDeep: 'questions must not be nested more than 32 levels deep.',
  questionTooDeep: 'questions.q must not be nested more than 32 levels deep.',
  instructionsTooDeep: 'questions.q.instructions must not be nested more than 32 levels deep.',
  criteriaTooDeep: 'questions.q.criteria must not be nested more than 32 levels deep.',
  bodyTooLong: 'body must be at most 1048576 characters.',
  stateEmpty: 'state must not be empty.',
  questionsCount: 'questions must be an object with 1 to 64 questions.',
  idLength: 'questions. must have an id of 1 to 128 characters.',
  questionNotObject: 'questions.q must be an object.',
  unknownField: 'questions.q.extra is not a known field.',
  type: 'questions.q.type must be "noul", "choice" or "score".',
  instructionsRequired: 'questions.q.instructions is required and must be a string, an object or an array.',
  instructionsLength: 'questions.q.instructions must be 1 to 4000 characters.',
  noulCriteriaShape: 'questions.q.criteria must be an object with only "true" and/or "false".',
  noulTrue: 'questions.q.criteria.true must be a string, an object, an array or null.',
  noulFalse: 'questions.q.criteria.false must be a string, an object, an array or null.',
  choiceCount: 'questions.q.criteria must be an object of 2 to 255 options.',
  optionName: 'questions.q.criteria. must be named with 1 to 255 characters.',
  optionDescription: 'questions.q.criteria.o must be a string, an object, an array or null.',
  scoreCount: 'questions.q1.criteria must be an ordered array of 2 to 10 level descriptions.',
  scoreLevel: 'questions.q.criteria.1 must be a non-empty string, an object or an array.',
  hypothesesTotal: 'questions must produce at most 512 hypotheses in total.',
  nestedTooDeeply: 'body is nested too deeply to be processed.',
} as const

const validDraft = (overrides: Partial<SystemOneDraft> = {}): SystemOneDraft => ({
  stateText: STATE_URGENT,
  questionsText: NOUL_QUESTIONS_TEXT,
  ...overrides,
})
const withQuestions = (questions: unknown): SystemOneDraft => validDraft({ questionsText: JSON.stringify(questions) })
const withQuestion = (question: unknown): SystemOneDraft => withQuestions({ q: question })
const noulWithCriteria = (criteria: unknown): SystemOneDraft =>
  withQuestion({ type: 'noul', instructions: 'i', criteria })

const choiceWithOptions = (count: number): SystemOneDraft =>
  withQuestion({ type: 'choice', instructions: 'i', criteria: optionsNamed(count) })
const optionsNamed = (count: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`o${index}`, 'described']))
const scoreWithLevels = (count: number, id = 'q'): SystemOneDraft =>
  withQuestions({ [id]: { type: 'score', instructions: 'i', criteria: Array.from({ length: count }, () => 'level') } })

afterEach(() => {
  vi.restoreAllMocks()
})

function requestOf(result: ReturnType<typeof draftRequest>): SystemOneRequest {
  if (!result.ok) throw new Error(`expected a request, got problems: ${JSON.stringify(result.problems)}`)
  return result.request
}

function problemsOf(result: ReturnType<typeof draftRequest>): DraftProblem[] {
  if (result.ok) throw new Error('expected problems, got a request')
  return result.problems
}

describe('stateFromText', () => {
  it.each<[string, string, unknown]>([
    ['an object', '{"a":1}', { a: 1 }],
    ['an array', '[1,2]', [1, 2]],
    ['a JSON string', '"hello"', 'hello'],
    ['plain text', 'I was charged twice.', 'I was charged twice.'],
    ['a bare number', '42', '42'],
    ['a bare boolean', 'true', 'true'],
    ['null', 'null', 'null'],
    ['unparseable JSON', '{oops', '{oops'],
    ['nothing', '', ''],
    ['an object with surrounding whitespace', '  {"a":1}  ', { a: 1 }],
  ])('turns %s into the state', (_name, text, state) => {
    expect(stateFromText(text)).toEqual(state)
  })

  it('does not throw on a state nested 20,000 deep', () => {
    expect(Array.isArray(stateFromText(nestedText(20000)))).toBe(true)
  })
})

describe('draftRequest', () => {
  it('builds the request with the keys in the order state, model, questions', () => {
    const result = draftRequest(MODEL, { stateText: '{"a":1}', questionsText: NOUL_QUESTIONS_TEXT })

    expect(result).toEqual({
      ok: true,
      request: { state: { a: 1 }, model: MODEL, questions: { q: { type: 'noul', instructions: 'i' } } },
    })
    expect(Object.keys(requestOf(result))).toEqual(['state', 'model', 'questions'])
  })

  it('takes a plain-text state as the state string', () => {
    const request = requestOf(draftRequest(MODEL, { stateText: 'I was charged twice.', questionsText: NOUL_QUESTIONS_TEXT }))

    expect(request.state).toBe('I was charged twice.')
  })

  it('reports invalid questions JSON as one problem on questions', () => {
    const problems = problemsOf(draftRequest(MODEL, { stateText: 'hi', questionsText: '{oops' }))

    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('questions')
    expect(problems[0].message).toMatch(/^questions is not valid JSON: .+/)
  })

  it('keeps the two editors independent', () => {
    const badQuestions = problemsOf(draftRequest(MODEL, { stateText: '{"a":1}', questionsText: '{oops' }))
    const unparseableState = draftRequest(MODEL, { stateText: '{oops', questionsText: NOUL_QUESTIONS_TEXT })

    expect(badQuestions.map((problem) => problem.field)).toEqual(['questions'])
    expect(requestOf(unparseableState).state).toBe('{oops')
  })

  it('returns a fresh request on every call', () => {
    const draft = { stateText: '{"a":1}', questionsText: NOUL_QUESTIONS_TEXT }
    const first = requestOf(draftRequest(MODEL, draft))
    const second = requestOf(draftRequest(MODEL, draft))

    first.questions.q.instructions = 'changed'
    ;(first.state as Record<string, unknown>).a = 2

    expect(second.questions.q.instructions).toBe('i')
    expect(second.state).toEqual({ a: 1 })
  })

  it('does not throw on a state nested 20,000 deep', () => {
    const result = draftRequest(MODEL, { stateText: nestedText(20000), questionsText: NOUL_QUESTIONS_TEXT })

    expect(typeof result.ok).toBe('boolean')
  })
})

const acceptedRequest = (input: SystemOneDraft): SystemOneRequest => requestOf(draftRequest(MODEL, input))
const problemsFor = (input: SystemOneDraft): DraftProblem[] => problemsOf(draftRequest(MODEL, input))

function expectRefusedWith(input: SystemOneDraft, field: string, message: string): void {
  expect(problemsFor(input)).toEqual([{ field, message }])
}

describe('draftRequest accepting a valid draft', () => {
  it('accepts a noul, a choice and a score question and returns the inputs unchanged', () => {
    const questions = { urgent: Q_NOUL, team: Q_CHOICE, mood: Q_MOOD }

    const request = acceptedRequest({ stateText: STATE_URGENT, questionsText: JSON.stringify(questions) })

    expect(request).toEqual({ state: STATE_URGENT, model: MODEL, questions })
  })

  it('accepts criteria.false without criteria.true on a noul question', () => {
    const criteria = { false: 'the customer is calm' }

    expect(acceptedRequest(noulWithCriteria(criteria)).questions.q).toEqual({ type: 'noul', instructions: 'i', criteria })
  })

  it('accepts a noul question with no criteria, empty criteria, or null criteria values', () => {
    expect(acceptedRequest(validDraft()).questions.q).toEqual({ type: 'noul', instructions: 'i' })
    expect(acceptedRequest(noulWithCriteria({})).questions.q).toMatchObject({ criteria: {} })
    expect(acceptedRequest(noulWithCriteria({ true: null, false: null })).questions.q).toMatchObject({
      criteria: { true: null, false: null },
    })
  })
})

describe('draftRequest nesting', () => {
  it('accepts a state nested 32 deep and refuses one nested 33 deep', () => {
    expect(acceptedRequest(validDraft({ stateText: nestedText(32) })).state).toEqual(nested(32))

    expectRefusedWith(validDraft({ stateText: nestedText(33) }), 'state', MESSAGE.stateTooDeep)
  })

  it.each([5000, 20000])('refuses a state nested %d deep without throwing', (depth) => {
    expectRefusedWith(validDraft({ stateText: nestedText(depth) }), 'state', MESSAGE.stateTooDeep)
  })

  it('refuses instructions nested 33 deep and accepts 32', () => {
    expect(acceptedRequest(withQuestion({ type: 'noul', instructions: nested(32) })).questions.q).toMatchObject({
      type: 'noul',
    })

    expectRefusedWith(
      withQuestion({ type: 'noul', instructions: nested(33) }),
      'questions.q.instructions',
      MESSAGE.instructionsTooDeep,
    )
  })

  it('counts the criteria wrapper as one level', () => {
    expect(acceptedRequest(noulWithCriteria({ true: nested(31) })).questions.q).toMatchObject({ type: 'noul' })

    expectRefusedWith(noulWithCriteria({ true: nested(32) }), 'questions.q.criteria', MESSAGE.criteriaTooDeep)
  })

  it('refuses a question that is itself nested 33 deep', () => {
    expectRefusedWith(withQuestion(nested(33)), 'questions.q', MESSAGE.questionTooDeep)
  })

  it('refuses a questions text that is an array nested 33 deep', () => {
    expectRefusedWith(validDraft({ questionsText: nestedText(33) }), 'questions', MESSAGE.questionsTooDeep)
  })

  it('refuses questions nested 20,000 deep without throwing', () => {
    expectRefusedWith(validDraft({ questionsText: nestedText(20000) }), 'questions', MESSAGE.questionsTooDeep)
    expectRefusedWith(
      validDraft({ questionsText: `{"q":{"type":"noul","instructions":${nestedText(20000)}}}` }),
      'questions.q.instructions',
      MESSAGE.instructionsTooDeep,
    )
  })
})

describe('draftRequest state and model rules', () => {
  it('refuses an empty state text', () => {
    expectRefusedWith(validDraft({ stateText: '' }), 'state', MESSAGE.stateEmpty)
  })

  it('accepts a bare number, a bare boolean and a blank text as the state', () => {
    expect(acceptedRequest(validDraft({ stateText: '42' })).state).toBe('42')
    expect(acceptedRequest(validDraft({ stateText: 'true' })).state).toBe('true')
    expect(acceptedRequest(validDraft({ stateText: ' ' })).state).toBe(' ')
  })

  it('refuses an empty model and accepts a blank one', () => {
    expect(problemsOf(draftRequest('', validDraft()))).toEqual([
      { field: 'model', message: 'model must be a non-empty string.' },
    ])
    expect(requestOf(draftRequest('  ', validDraft())).model).toBe('  ')
  })
})

describe('draftRequest questions object rules', () => {
  it.each([['an empty array', '[]'], ['an empty object', '{}']])('refuses %s', (_name, questionsText) => {
    expectRefusedWith(validDraft({ questionsText }), 'questions', MESSAGE.questionsCount)
  })

  it('accepts 64 questions and refuses 65', () => {
    const questionsNamed = (count: number): SystemOneDraft =>
      withQuestions(Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index}`, Q_NOUL])))

    expect(Object.keys(acceptedRequest(questionsNamed(64)).questions)).toHaveLength(64)

    expectRefusedWith(questionsNamed(65), 'questions', MESSAGE.questionsCount)
  })

  it('refuses an empty question id', () => {
    expectRefusedWith(withQuestions({ '': Q_NOUL }), 'questions.', MESSAGE.idLength)
  })

  it('accepts a 128-character question id and refuses 129', () => {
    const longId = 'a'.repeat(129)

    expect(Object.keys(acceptedRequest(withQuestions({ ['a'.repeat(128)]: Q_NOUL })).questions)).toHaveLength(1)

    expectRefusedWith(
      withQuestions({ [longId]: Q_NOUL }),
      `questions.${longId}`,
      `questions.${longId} must have an id of 1 to 128 characters.`,
    )
  })

  it('refuses a question that is not an object', () => {
    expectRefusedWith(withQuestion(5), 'questions.q', MESSAGE.questionNotObject)
    expectRefusedWith(withQuestion([Q_NOUL]), 'questions.q', MESSAGE.questionNotObject)
  })

  it('refuses a key that is not type, instructions or criteria', () => {
    expectRefusedWith(
      withQuestion({ type: 'noul', instructions: 'i', extra: 1 }),
      'questions.q.extra',
      MESSAGE.unknownField,
    )
  })

  it('reports the first question that fails and stops the walk', () => {
    const problems = problemsFor(
      withQuestions({ q: { type: 'yesno', instructions: 'i' }, r: 5 }),
    )

    expect(problems).toEqual([{ field: 'questions.q.type', message: MESSAGE.type }])
  })
})

describe('draftRequest question type and instructions rules', () => {
  it('refuses a type other than noul, choice or score', () => {
    expectRefusedWith(withQuestion({ type: 'yesno', instructions: 'i' }), 'questions.q.type', MESSAGE.type)
    expectRefusedWith(withQuestion({ instructions: 'i' }), 'questions.q.type', MESSAGE.type)
  })

  it.each(['toString', '__proto__', 'constructor'])('refuses the inherited name %s as a type', (type) => {
    expectRefusedWith(withQuestion({ type, instructions: 'i' }), 'questions.q.type', MESSAGE.type)
  })

  it.each([
    ['missing', { type: 'noul' }],
    ['null', { type: 'noul', instructions: null }],
    ['a number', { type: 'noul', instructions: 42 }],
  ])('refuses instructions that are %s', (_name, question) => {
    expectRefusedWith(withQuestion(question), 'questions.q.instructions', MESSAGE.instructionsRequired)
  })

  it('refuses empty instructions and instructions over 4000 characters', () => {
    expectRefusedWith(
      withQuestion({ type: 'noul', instructions: '' }),
      'questions.q.instructions',
      MESSAGE.instructionsLength,
    )
    expectRefusedWith(
      withQuestion({ type: 'noul', instructions: 'x'.repeat(4001) }),
      'questions.q.instructions',
      MESSAGE.instructionsLength,
    )
  })

  it('accepts instructions of exactly 4000 characters and an object carrying a question', () => {
    expect(acceptedRequest(withQuestion({ type: 'noul', instructions: 'x'.repeat(4000) })).questions.q).toMatchObject({
      type: 'noul',
    })
    expect(acceptedRequest(withQuestion({ type: 'noul', instructions: { question: '?' } })).questions.q).toMatchObject({
      instructions: { question: '?' },
    })
  })

  it('measures object instructions by the text the server would send', () => {
    const longQuestion = { question: 'x'.repeat(3990), ticket: 'y'.repeat(20) }

    expectRefusedWith(
      withQuestion({ type: 'noul', instructions: longQuestion }),
      'questions.q.instructions',
      MESSAGE.instructionsLength,
    )
  })
})

describe('draftRequest noul criteria rules', () => {
  it.each([['null', null], ['a string', 'x'], ['an array', []], ['an unknown key', { maybe: 'x' }]])(
    'refuses criteria that is %s',
    (_name, criteria) => {
      expectRefusedWith(noulWithCriteria(criteria), 'questions.q.criteria', MESSAGE.noulCriteriaShape)
    },
  )

  it('refuses a criteria.true that is not text, an object, an array or null', () => {
    expectRefusedWith(noulWithCriteria({ true: 5 }), 'questions.q.criteria.true', MESSAGE.noulTrue)
  })

  it('refuses a criteria.false that is not text, an object, an array or null', () => {
    expectRefusedWith(noulWithCriteria({ false: true }), 'questions.q.criteria.false', MESSAGE.noulFalse)
  })

  it('reports criteria.true before criteria.false', () => {
    expectRefusedWith(noulWithCriteria({ false: 1, true: 2 }), 'questions.q.criteria.true', MESSAGE.noulTrue)
  })
})

describe('draftRequest choice criteria rules', () => {
  it.each([1, 256])('refuses a choice with %d options', (count) => {
    expectRefusedWith(choiceWithOptions(count), 'questions.q.criteria', MESSAGE.choiceCount)
  })

  it.each([2, 255])('accepts a choice with %d options', (count) => {
    expect(Object.keys(acceptedRequest(choiceWithOptions(count)).questions)).toEqual(['q'])
  })

  it('refuses a choice with no criteria', () => {
    expectRefusedWith(withQuestion({ type: 'choice', instructions: 'i' }), 'questions.q.criteria', MESSAGE.choiceCount)
  })

  it('refuses an option with an empty name', () => {
    expectRefusedWith(
      withQuestion({ type: 'choice', instructions: 'i', criteria: { '': 'x', b: 'y' } }),
      'questions.q.criteria.',
      MESSAGE.optionName,
    )
  })

  it('refuses an option name over 255 characters and accepts 255', () => {
    const longName = 'n'.repeat(256)
    const withOptionNamed = (name: string): SystemOneDraft =>
      withQuestion({ type: 'choice', instructions: 'i', criteria: { [name]: 'x', other: 'y' } })

    expect(Object.keys(acceptedRequest(withOptionNamed('n'.repeat(255))).questions)).toEqual(['q'])

    expectRefusedWith(
      withOptionNamed(longName),
      `questions.q.criteria.${longName}`,
      `questions.q.criteria.${longName} must be named with 1 to 255 characters.`,
    )
  })

  it('refuses an option description that is not text, an object, an array or null', () => {
    expectRefusedWith(
      withQuestion({ type: 'choice', instructions: 'i', criteria: { o: 5, p: 'x' } }),
      'questions.q.criteria.o',
      MESSAGE.optionDescription,
    )
  })

  it('reports the first option that fails, not the first fault of the whole question', () => {
    const problems = problemsFor(
      withQuestion({ type: 'choice', instructions: 'i', criteria: { o: 5, '': 'x' } }),
    )

    expect(problems).toEqual([{ field: 'questions.q.criteria.o', message: MESSAGE.optionDescription }])
  })

  it('checks an option name before its description', () => {
    const problems = problemsFor(
      withQuestion({ type: 'choice', instructions: 'i', criteria: { '': 5, b: 'y' } }),
    )

    expect(problems).toEqual([{ field: 'questions.q.criteria.', message: MESSAGE.optionName }])
  })

  it('accepts null option descriptions', () => {
    const criteria = { billing: null, technical: 'Bugs' }

    expect(acceptedRequest(withQuestion({ type: 'choice', instructions: 'i', criteria })).questions.q).toMatchObject({ criteria })
  })
})

describe('draftRequest score criteria rules', () => {
  it.each([1, 11])('refuses a score with %d levels', (count) => {
    expectRefusedWith(scoreWithLevels(count, 'q1'), 'questions.q1.criteria', MESSAGE.scoreCount)
  })

  it.each([2, 10])('accepts a score with %d levels', (count) => {
    expect(Object.keys(acceptedRequest(scoreWithLevels(count)).questions)).toEqual(['q'])
  })

  it('refuses a null level', () => {
    expectRefusedWith(
      withQuestion({ type: 'score', instructions: 'i', criteria: ['a', null] }),
      'questions.q.criteria.1',
      MESSAGE.scoreLevel,
    )
  })

  it('refuses an empty level and accepts a blank one', () => {
    expectRefusedWith(
      withQuestion({ type: 'score', instructions: 'i', criteria: ['a', ''] }),
      'questions.q.criteria.1',
      MESSAGE.scoreLevel,
    )
    expect(acceptedRequest(withQuestion({ type: 'score', instructions: 'i', criteria: ['a', '  '] })).questions.q).toMatchObject({
      criteria: ['a', '  '],
    })
  })

  it('accepts an object or an array as a level', () => {
    const criteria = [{ label: 'calm' }, ['angry']]

    expect(acceptedRequest(withQuestion({ type: 'score', instructions: 'i', criteria })).questions.q).toMatchObject({ criteria })
  })
})

describe('draftRequest hypothesis total', () => {
  const twoFullChoicesAndNouls = (nouls: number): SystemOneDraft => {
    const fullChoice = { type: 'choice', instructions: 'i', criteria: optionsNamed(255) }
    const noulQuestions = Array.from({ length: nouls }, (_, index) => [`n${index}`, Q_NOUL])
    return withQuestions({ a: fullChoice, b: fullChoice, ...Object.fromEntries(noulQuestions) })
  }

  it('accepts 512 hypotheses in total', () => {
    expect(Object.keys(acceptedRequest(twoFullChoicesAndNouls(2)).questions)).toHaveLength(4)
  })

  it('refuses 513 hypotheses in total', () => {
    expectRefusedWith(twoFullChoicesAndNouls(3), 'questions', MESSAGE.hypothesesTotal)
  })
})

describe('draftRequest body size', () => {
  it('refuses a body over the limit with one body problem', () => {
    expectRefusedWith(validDraft({ stateText: 'a'.repeat(MAX_BODY_CHARS + 1) }), 'body', MESSAGE.bodyTooLong)
  })

  it('accepts a body of exactly the limit', () => {
    const overhead = JSON.stringify({ state: '', model: MODEL, questions: JSON.parse(NOUL_QUESTIONS_TEXT) }).length

    const request = acceptedRequest(validDraft({ stateText: 'a'.repeat(MAX_BODY_CHARS - overhead) }))

    expect(JSON.stringify(request).length).toBe(MAX_BODY_CHARS)
  })

  it('does not report the size while the state has a problem', () => {
    const tooDeepAndHuge = `${'['.repeat(33)}"${'a'.repeat(MAX_BODY_CHARS)}"${']'.repeat(33)}`

    expectRefusedWith(validDraft({ stateText: tooDeepAndHuge }), 'state', MESSAGE.stateTooDeep)
  })

  it('does not report the size while the questions have a problem', () => {
    const problems = problemsFor({
      stateText: 'a'.repeat(MAX_BODY_CHARS + 1),
      questionsText: JSON.stringify({ q: { type: 'yesno', instructions: 'i' } }),
    })

    expect(problems).toEqual([{ field: 'questions.q.type', message: MESSAGE.type }])
  })
})

describe('draftRequest problem groups', () => {
  it('reports the state and the questions at once, the state first', () => {
    const problems = problemsFor({
      stateText: '',
      questionsText: JSON.stringify({ q: { type: 'yesno', instructions: 'i' } }),
    })

    expect(problems).toEqual([
      { field: 'state', message: MESSAGE.stateEmpty },
      { field: 'questions.q.type', message: MESSAGE.type },
    ])
  })

  it('reports a state, a questions and a model problem in that order', () => {
    const problems = problemsOf(draftRequest('', { stateText: '', questionsText: '{}' }))

    expect(problems.map((problem) => problem.field)).toEqual(['state', 'questions', 'model'])
  })

  it('keeps a questions parse problem in the questions group without hiding a state problem', () => {
    const problems = problemsFor({ stateText: '', questionsText: '{oops' })

    expect(problems.map((problem) => problem.field)).toEqual(['state', 'questions'])
    expect(problems[0].message).toBe(MESSAGE.stateEmpty)
    expect(problems[1].message).toMatch(/^questions is not valid JSON: /)
  })

  it('reports a deep state and deep questions together, one problem each', () => {
    const problems = problemsFor({ stateText: nestedText(20000), questionsText: nestedText(20000) })

    expect(problems).toEqual([
      { field: 'state', message: MESSAGE.stateTooDeep },
      { field: 'questions', message: MESSAGE.questionsTooDeep },
    ])
  })
})

describe('draftRequest with a __proto__ key', () => {
  it('handles a __proto__ question id without polluting anything and accepts it', () => {
    const request = acceptedRequest(
      validDraft({ questionsText: '{"__proto__":{"type":"noul","instructions":"i"}}' }),
    )

    expect(Object.keys(request.questions)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).type).toBeUndefined()
    expect(({} as Record<string, unknown>).instructions).toBeUndefined()
  })
})

describe('draftRequest safety net', () => {
  it('turns a stack overflow into a body problem instead of throwing', () => {
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new RangeError('x')
    })

    const result = draftRequest(MODEL, validDraft())
    vi.restoreAllMocks()

    expect(result).toEqual({ ok: false, problems: [{ field: 'body', message: MESSAGE.nestedTooDeeply }] })
  })

  it('lets an error other than a RangeError through', () => {
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new TypeError('not a stack overflow')
    })

    expect(() => draftRequest(MODEL, validDraft())).toThrow(TypeError)
  })
})

describe('the messages shared with the server', () => {
  const NEAR_EMPTY_ID = withQuestions({ '': Q_NOUL })
  const HYPOTHESES_513 = withQuestions({
    a: { type: 'choice', instructions: 'i', criteria: optionsNamed(255) },
    b: { type: 'choice', instructions: 'i', criteria: optionsNamed(255) },
    c: Q_NOUL,
    d: Q_NOUL,
    e: Q_NOUL,
  })

  const CASES: Array<[string, SystemOneDraft, string, string]> = [
    ['state nesting', validDraft({ stateText: nestedText(33) }), 'state', MESSAGE.stateTooDeep],
    ['questions nesting', validDraft({ questionsText: nestedText(33) }), 'questions', MESSAGE.questionsTooDeep],
    ['question nesting', withQuestion(nested(33)), 'questions.q', MESSAGE.questionTooDeep],
    [
      'instructions nesting',
      withQuestion({ type: 'noul', instructions: nested(33) }),
      'questions.q.instructions',
      MESSAGE.instructionsTooDeep,
    ],
    ['criteria nesting', noulWithCriteria({ true: nested(32) }), 'questions.q.criteria', MESSAGE.criteriaTooDeep],
    ['body size', validDraft({ stateText: 'a'.repeat(MAX_BODY_CHARS + 1) }), 'body', MESSAGE.bodyTooLong],
    ['empty state', validDraft({ stateText: '' }), 'state', MESSAGE.stateEmpty],
    ['question count', validDraft({ questionsText: '{}' }), 'questions', MESSAGE.questionsCount],
    ['question id', NEAR_EMPTY_ID, 'questions.', MESSAGE.idLength],
    ['question shape', withQuestion(5), 'questions.q', MESSAGE.questionNotObject],
    [
      'unknown field',
      withQuestion({ type: 'noul', instructions: 'i', extra: 1 }),
      'questions.q.extra',
      MESSAGE.unknownField,
    ],
    ['type', withQuestion({ type: 'yesno', instructions: 'i' }), 'questions.q.type', MESSAGE.type],
    [
      'instructions required',
      withQuestion({ type: 'noul' }),
      'questions.q.instructions',
      MESSAGE.instructionsRequired,
    ],
    [
      'instructions length',
      withQuestion({ type: 'noul', instructions: '' }),
      'questions.q.instructions',
      MESSAGE.instructionsLength,
    ],
    ['noul criteria shape', noulWithCriteria(null), 'questions.q.criteria', MESSAGE.noulCriteriaShape],
    ['noul criteria.true', noulWithCriteria({ true: 5 }), 'questions.q.criteria.true', MESSAGE.noulTrue],
    ['noul criteria.false', noulWithCriteria({ false: true }), 'questions.q.criteria.false', MESSAGE.noulFalse],
    ['choice option count', choiceWithOptions(1), 'questions.q.criteria', MESSAGE.choiceCount],
    [
      'choice option name',
      withQuestion({ type: 'choice', instructions: 'i', criteria: { '': 'x', b: 'y' } }),
      'questions.q.criteria.',
      MESSAGE.optionName,
    ],
    [
      'choice option description',
      withQuestion({ type: 'choice', instructions: 'i', criteria: { o: 5, p: 'x' } }),
      'questions.q.criteria.o',
      MESSAGE.optionDescription,
    ],
    ['score level count', scoreWithLevels(1, 'q1'), 'questions.q1.criteria', MESSAGE.scoreCount],
    [
      'score level',
      withQuestion({ type: 'score', instructions: 'i', criteria: ['a', null] }),
      'questions.q.criteria.1',
      MESSAGE.scoreLevel,
    ],
    ['hypothesis total', HYPOTHESES_513, 'questions', MESSAGE.hypothesesTotal],
  ]

  it.each(CASES)('%s', (_rule, input, field, message) => {
    expectRefusedWith(input, field, message)
  })
})
