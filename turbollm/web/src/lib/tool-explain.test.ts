import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeToolCall } from './tool-explain'

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

test('describeToolCall: run_python says how much code it is; the bar shows the code itself (GitHub #52)', () => {
  assert.equal(describeToolCall('run_python', { code: 'import pandas as pd\nprint(1)' }), 'Run Python in the sandbox (2 lines)')
  assert.equal(describeToolCall('run_python', { code: 'print(1)' }), 'Run Python in the sandbox (1 line)')
})
