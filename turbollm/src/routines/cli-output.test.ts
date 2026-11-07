import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeCliStreamJson, CliStreamJsonCollector, type ParsedCliResult } from './cli-output'

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

test('a non-string session_id is dropped rather than typed as a string', () => {
  const parsed = parseClaudeCliStreamJson('{"type":"result","is_error":false,"result":"ok","session_id":{"id":7}}')
  assert.equal(parsed.success, true)
  assert.equal(parsed.sessionId, undefined)
})

test('a null session_id is dropped rather than passed through', () => {
  const parsed = parseClaudeCliStreamJson('{"type":"result","is_error":false,"result":"ok","session_id":null}')
  assert.equal(parsed.sessionId, undefined)
})

test('a STRING "true" is_error is a failure, not a success', () => {
  const parsed = parseClaudeCliStreamJson('{"type":"result","is_error":"true","result":"boom"}')
  assert.equal(parsed.success, false)
  assert.equal(parsed.resultText, 'boom')
})

test('a non-boolean is_error of any shape fails closed', () => {
  assert.equal(parseClaudeCliStreamJson('{"type":"result","is_error":1,"result":"x"}').success, false)
  assert.equal(parseClaudeCliStreamJson('{"type":"result","is_error":null,"result":"x"}').success, false)
})

test('an absent is_error still reads as success', () => {
  const parsed = parseClaudeCliStreamJson('{"type":"result","result":"ok"}')
  assert.equal(parsed.success, true)
  assert.equal(parsed.resultText, 'ok')
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

// Scalability review 3.9: a routine's stdout used to be held whole for up to 10 minutes and parsed in
// one go. The collector must record EXACTLY what the whole-string parse would, however the pipe
// happens to chunk the bytes.

/** The pre-streaming parser, verbatim — the oracle the collector is held to. */
function wholeStringParse(stdout: string): ParsedCliResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  type Ev = { is_error?: unknown; result?: unknown; session_id?: unknown }
  let last = null as Ev | null
  for (const line of lines) {
    try {
      const v: unknown = JSON.parse(line)
      if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'result') last = v as Ev
    } catch { /* noise */ }
  }
  if (last) {
    return {
      success: last.is_error === undefined ? true : last.is_error === false,
      resultText: typeof last.result === 'string' ? last.result : '',
      sessionId: typeof last.session_id === 'string' ? last.session_id : undefined,
    }
  }
  const trimmed = stdout.trim()
  return { success: false, resultText: trimmed ? trimmed.slice(0, 2000) : '(no output)' }
}

/** Mulberry32 — a seeded PRNG so a failing split is reproducible. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function splitRandomly(text: string, rand: () => number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length;) {
    const size = 1 + Math.floor(rand() * 40)
    chunks.push(text.slice(i, i + size))
    i += size
  }
  return chunks
}

function collect(chunks: string[]): ParsedCliResult {
  const collector = new CliStreamJsonCollector()
  for (const chunk of chunks) collector.push(chunk)
  return collector.result()
}

const STREAMS: Record<string, string> = {
  'multi-event stream with a final result': [
    '{"type":"system","subtype":"init","session_id":"abc-123"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working… ünïcode ✓"}]}}',
    'a stray warning line',
    '{"type":"result","subtype":"success","is_error":false,"result":"first","session_id":"old"}',
    '{"type":"user","message":{"content":"tool output"}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Done: 3 PRs.","session_id":"abc-123"}',
    '',
  ].join('\n'),
  'CRLF and indentation': '  {"type":"system"}\r\n\t{"type":"result","is_error":true,"result":"boom"}\r\n',
  'result without a trailing newline': '{"type":"system"}\n{"type":"result","result":"tail"}',
  'non-string fields collapse': '{"type":"result","is_error":"true","result":{"a":1},"session_id":7}\n',
  'no result event, long noise': `\n\n   ${'x'.repeat(5000)}\nmore\n`,
  'no result event, short noise': '  just text  \n',
  empty: '',
  'whitespace only': ' \n\r\n \n',
}

for (const [name, stdout] of Object.entries(STREAMS)) {
  test(`collector matches the whole-string parse under random chunk splits: ${name}`, () => {
    const expected = wholeStringParse(stdout)
    assert.deepEqual(parseClaudeCliStreamJson(stdout), expected)
    for (let seed = 1; seed <= 200; seed++) {
      assert.deepEqual(collect(splitRandomly(stdout, prng(seed))), expected, `seed ${seed}`)
    }
  })
}

test('collector keeps no event history: a long run of events holds only the final result', () => {
  const collector = new CliStreamJsonCollector()
  for (let i = 0; i < 20000; i++) collector.push(`{"type":"assistant","message":{"n":${i}}}\n`)
  collector.push('{"type":"result","is_error":false,"result":"ok"}\n')
  assert.equal(collector.result().resultText, 'ok')
  assert.ok(collector.heldChars() < 5000, `held ${collector.heldChars()} chars`)
})

test('one multi-MB line fed in small chunks is parsed in linear time, not re-scanned per chunk', () => {
  const body = 'x'.repeat(10 * 1024 * 1024)
  const line = JSON.stringify({ type: 'result', is_error: false, result: body })
  const collector = new CliStreamJsonCollector()
  const started = Date.now()
  for (let i = 0; i < line.length; i += 1024) collector.push(line.slice(i, i + 1024))
  collector.push('\n')
  const elapsed = Date.now() - started
  assert.equal(collector.result().resultText.length, body.length)
  assert.ok(elapsed < 2000, `10 MB in 1 KB chunks took ${elapsed} ms (quadratic re-scan)`)
})

test('whitespace-only output is held bounded and still falls back to the placeholder', () => {
  const collector = new CliStreamJsonCollector()
  for (let i = 0; i < 100; i++) collector.push(' \n'.repeat(32 * 1024))
  assert.ok(collector.heldChars() < 10_000, `held ${collector.heldChars()} chars of whitespace`)
  assert.equal(collector.result().resultText, '(no output)')
})

test('leading whitespace before the raw fallback text is not counted against it', () => {
  const collector = new CliStreamJsonCollector()
  collector.push(' \n '.repeat(5000))
  collector.push('real text')
  assert.equal(collector.result().resultText, 'real text')
})
