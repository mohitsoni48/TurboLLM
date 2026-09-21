// System One playground (ADR-439): the two editors' texts become the exact request that is POSTed
// and rendered as curl. The state editor accepts plain text; the questions editor must be JSON.
import { describe, expect, it } from 'vitest'
import type { SystemOneRequest } from '../../lib/systemone-types'
import { draftRequest, stateFromText } from './systemone-draft'
import type { DraftProblem } from './systemone-draft'

const MODEL = 'm'
const NOUL_QUESTIONS_TEXT = '{"q":{"type":"noul","instructions":"i"}}'

const nestedText = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth)

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
