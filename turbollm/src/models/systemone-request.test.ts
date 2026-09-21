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
