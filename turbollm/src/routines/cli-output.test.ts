import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeCliStreamJson } from './cli-output'

test('parses a successful run: the final "result" event wins', () => {
  const stdout = [
    '{"type":"system","subtype":"init","session_id":"abc-123"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working..."}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Done: summarized 3 PRs.","session_id":"abc-123"}',
    '',
  ].join('\n')
  const parsed = parseClaudeCliStreamJson(stdout)
  assert.equal(parsed.success, true)
  assert.equal(parsed.resultText, 'Done: summarized 3 PRs.')
  assert.equal(parsed.sessionId, 'abc-123')
})

test('parses a failed run: is_error true still extracts the result text', () => {
  const stdout = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Tool denied: Bash"}'
  const parsed = parseClaudeCliStreamJson(stdout)
  assert.equal(parsed.success, false)
  assert.equal(parsed.resultText, 'Tool denied: Bash')
})

test('tolerates blank lines and non-JSON noise between events', () => {
  const stdout = [
    '',
    'not json at all',
    '{"type":"system","subtype":"init","session_id":"x"}',
    '',
    '{"type":"result","is_error":false,"result":"ok"}',
  ].join('\n')
  const parsed = parseClaudeCliStreamJson(stdout)
  assert.equal(parsed.success, true)
  assert.equal(parsed.resultText, 'ok')
})

test('falls back to raw stdout (truncated) when no "result" event is ever seen', () => {
  const parsed = parseClaudeCliStreamJson('{"type":"system","subtype":"init","session_id":"x"}')
  assert.equal(parsed.success, false)
  assert.match(parsed.resultText, /"type":"system"/)
})

test('falls back to a fixed placeholder when stdout is completely empty', () => {
  const parsed = parseClaudeCliStreamJson('')
  assert.equal(parsed.success, false)
  assert.equal(parsed.resultText, '(no output)')
})

test('whitespace-only stdout is treated as empty, not as raw text', () => {
  const parsed = parseClaudeCliStreamJson('   \n\n  \r\n ')
  assert.equal(parsed.success, false)
  assert.equal(parsed.resultText, '(no output)')
})

test('the LAST result event wins when more than one is emitted', () => {
  const stdout = [
    '{"type":"result","is_error":false,"result":"first"}',
    '{"type":"result","is_error":true,"result":"second"}',
  ].join('\n')
  const parsed = parseClaudeCliStreamJson(stdout)
  assert.equal(parsed.success, false)
  assert.equal(parsed.resultText, 'second')
})

test('a result event missing its result field yields empty text, not undefined', () => {
  const parsed = parseClaudeCliStreamJson('{"type":"result","is_error":false}')
  assert.equal(parsed.success, true)
  assert.equal(parsed.resultText, '')
  assert.equal(parsed.sessionId, undefined)
})

test('a non-string result field is not passed through as a non-string', () => {
  const parsed = parseClaudeCliStreamJson('{"type":"result","is_error":false,"result":{"nested":true}}')
  assert.equal(parsed.success, true)
  assert.equal(typeof parsed.resultText, 'string')
  assert.equal(parsed.resultText, '')
})

test('CRLF line endings (Windows CLI output) parse the same as LF', () => {
  const stdout = '{"type":"system","subtype":"init"}\r\n{"type":"result","is_error":false,"result":"ok"}\r\n'
  const parsed = parseClaudeCliStreamJson(stdout)
  assert.equal(parsed.success, true)
  assert.equal(parsed.resultText, 'ok')
})

test('the raw-stdout fallback is truncated rather than storing an unbounded transcript', () => {
  const noise = 'x'.repeat(5000)
  const parsed = parseClaudeCliStreamJson(noise)
  assert.equal(parsed.success, false)
  assert.equal(parsed.resultText.length, 2000)
})

test('a JSON line that is not an object (null, array, scalar) is skipped, never throws', () => {
  const stdout = ['null', '[1,2,3]', '"a string"', '42', '{"type":"result","is_error":false,"result":"ok"}'].join('\n')
  const parsed = parseClaudeCliStreamJson(stdout)
  assert.equal(parsed.success, true)
  assert.equal(parsed.resultText, 'ok')
})
