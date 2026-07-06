import { test } from 'node:test'
import assert from 'node:assert/strict'

// tool-explain.ts pulls in MessageBubble.tsx -> stores/ui.ts, which reads localStorage at
// module load (theme init) — stub it so this file is importable under plain node:test (no DOM).
;(globalThis as unknown as { localStorage: Storage }).localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
} as Storage

const { describeToolCall } = await import('./tool-explain')

// Regression: a model emitting `queries: [...]` instead of the schema's `query` used to render
// as the literal string "undefined" in the tool-approval dialog. Mirrors resolveSearchQuery in
// src/tools/builtin.ts so the two can never drift apart.

test('describeToolCall: web_search reads the schema-correct singular query', () => {
  assert.equal(
    describeToolCall('web_search', { query: 'latest stable Node.js version' }),
    'Search the web for "latest stable Node.js version"',
  )
})

test('describeToolCall: web_search falls back to a plural queries array', () => {
  assert.equal(
    describeToolCall('web_search', { queries: ['latest stable Node.js version'] }),
    'Search the web for "latest stable Node.js version"',
  )
})

test('describeToolCall: web_search never renders the literal string "undefined"', () => {
  assert.equal(describeToolCall('web_search', {}), 'Search the web for ""')
})
