// System One mapping (ADR-439, ADR-436 (1)): how a request's state, instructions and criteria
// become the text the engine scores, and how entailment probabilities become a distribution.
// Everything here is pure; no engine is involved and every number is synthetic.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  criterionTextOf,
  instructionTextOf,
  normalise,
  serialiseState,
  type Criterion,
  type Instructions,
  type StateValue,
} from './systemone'

function nested(depth: number): unknown[] {
  return JSON.parse('['.repeat(depth) + ']'.repeat(depth)) as unknown[]
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
