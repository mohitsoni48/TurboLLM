import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSearchQuery } from './builtin'

// ── resolveSearchQuery ────────────────────────────────────────────────────────
// Regression: a model emitting `queries: [...]` instead of the schema's `query` used to
// resolve to '', which surfaced as a literal "undefined" in the approval dialog (tool-explain.ts
// mirrors this same fallback) and an empty search server-side.

test('resolveSearchQuery: reads the schema-correct singular query', () => {
  assert.equal(resolveSearchQuery({ query: 'latest stable Node.js version' }), 'latest stable Node.js version')
})

test('resolveSearchQuery: falls back to the first entry of a plural queries array', () => {
  assert.equal(resolveSearchQuery({ queries: ['latest stable Node.js version', 'second query'] }), 'latest stable Node.js version')
})

test('resolveSearchQuery: query takes precedence when both are present', () => {
  assert.equal(resolveSearchQuery({ query: 'a', queries: ['b'] }), 'a')
})

test('resolveSearchQuery: empty when neither shape is present', () => {
  assert.equal(resolveSearchQuery({}), '')
})

test('resolveSearchQuery: empty when queries is present but not an array of strings', () => {
  assert.equal(resolveSearchQuery({ queries: [42] }), '')
  assert.equal(resolveSearchQuery({ queries: 'not-an-array' }), '')
})
