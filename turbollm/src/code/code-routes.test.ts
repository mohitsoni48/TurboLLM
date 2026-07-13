// Unit tests for code-routes.ts's contextFilesBlock — the "Add context" file-picker's prompt
// nudge (paths only, never fetched content; the agent reads them itself via its own real,
// containment-checked read tool).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextFilesBlock } from './code-routes'

test('contextFilesBlock: returns "" for undefined', () => {
  assert.equal(contextFilesBlock(undefined), '')
})

test('contextFilesBlock: returns "" for an empty array', () => {
  assert.equal(contextFilesBlock([]), '')
})

test('contextFilesBlock: returns "" when every path is blank/whitespace', () => {
  assert.equal(contextFilesBlock(['  ', '']), '')
})

test('contextFilesBlock: lists each real path on its own line, trimmed', () => {
  const block = contextFilesBlock(['  /repo/src/a.ts  ', '/repo/src/b.ts'])
  assert.match(block, /- \/repo\/src\/a\.ts/)
  assert.match(block, /- \/repo\/src\/b\.ts/)
  assert.ok(!block.includes('  /repo/src/a.ts  '), 'paths are trimmed')
})

test('contextFilesBlock: drops blank entries but keeps the real ones', () => {
  const block = contextFilesBlock(['/repo/a.ts', '', '  ', '/repo/b.ts'])
  const lines = block.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(lines.length, 2)
})

test('contextFilesBlock: ends with a blank-line separator so it composes cleanly before the task text', () => {
  const block = contextFilesBlock(['/repo/a.ts'])
  assert.ok(block.endsWith('\n\n'))
})
