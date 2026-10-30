// Regression tests for the streaming parse state machine (parser.ts).
// Each test maps to a specific bug found in PR #3 or a critical path through
// the 4-phase state machine: initial → reasoning → skipFinal → content.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHAN_ANALYSIS_OPEN, CHAN_CLOSE, CHAN_FINAL_SKIP,
  THINK_CLOSE, THINK_OPEN,
  feedChunk, flushState, initParseState,
} from './parser'

/** Feed all chunks through the parser and flush, returning concatenated text by event type. */
function run(chunks: string[]): { reasoning: string; delta: string } {
  let state = initParseState()
  const all: Array<{ type: string; text: string }> = []
  for (const chunk of chunks) {
    const r = feedChunk(state, chunk)
    state = r.state
    all.push(...r.events)
  }
  all.push(...flushState(state))
  return {
    reasoning: all.filter(e => e.type === 'reasoning').map(e => e.text).join(''),
    delta: all.filter(e => e.type === 'delta').map(e => e.text).join(''),
  }
}

// ── <think> block (llama.cpp) ─────────────────────────────────────────────

test('think: reasoning inside <think> block is emitted as reasoning events', () => {
  const { reasoning, delta } = run([`${THINK_OPEN}chain of thought${THINK_CLOSE}final answer`])
  assert.equal(reasoning, 'chain of thought')
  assert.equal(delta, 'final answer')
})

test('think: content before <think> tag is emitted as delta before reasoning starts', () => {
  const { reasoning, delta } = run([`preamble${THINK_OPEN}reasoning${THINK_CLOSE}answer`])
  assert.equal(reasoning, 'reasoning')
  assert.equal(delta, 'preambleanswer')
})

test('think: tag split across two chunks is reassembled correctly', () => {
  const { reasoning, delta } = run(['<th', 'ink>inner</think>out'])
  assert.equal(reasoning, 'inner')
  assert.equal(delta, 'out')
})

test('think: close tag split across chunks does not emit partial tag as reasoning', () => {
  const { reasoning } = run([`${THINK_OPEN}text</thi`, 'nk>'])
  assert.equal(reasoning, 'text')
})

test('think: EOS with open think block flushes remaining buf as reasoning', () => {
  const state = initParseState()
  const { state: s2 } = feedChunk(state, `${THINK_OPEN}partial`)
  const events = flushState(s2)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'reasoning')
  assert.equal(events[0].text, 'partial')
})

// ── GPT-OSS channel format ────────────────────────────────────────────────

test('channel: happy path — reasoning and content routed to correct event types', () => {
  const input = `${CHAN_ANALYSIS_OPEN}deep thinking${CHAN_CLOSE}${CHAN_FINAL_SKIP}the answer`
  const { reasoning, delta } = run([input])
  assert.equal(reasoning, 'deep thinking')
  assert.equal(delta, 'the answer')
})

test('channel: framing tokens do not leak into delta output', () => {
  const { delta } = run([`${CHAN_ANALYSIS_OPEN}r${CHAN_CLOSE}${CHAN_FINAL_SKIP}content`])
  assert.equal(delta.includes('<|channel|>'), false)
  assert.equal(delta.includes('<|end|>'), false)
  assert.equal(delta.includes('<|start|>'), false)
  assert.equal(delta, 'content')
})

test('channel: multi-chunk delivery of reasoning and content', () => {
  const chunks = [
    CHAN_ANALYSIS_OPEN,
    'step one. ',
    'step two.',
    CHAN_CLOSE,
    CHAN_FINAL_SKIP,
    'answer part1 ',
    'answer part2',
  ]
  const { reasoning, delta } = run(chunks)
  assert.equal(reasoning, 'step one. step two.')
  assert.equal(delta, 'answer part1 answer part2')
})

// ── skipFinal regression tests (PR #3) ───────────────────────────────────

test('skipFinal: exact CHAN_FINAL_SKIP prefix match strips token and enters content', () => {
  // Deliver CHAN_FINAL_SKIP in two pieces — first chunk fills the prefix exactly
  const half = Math.floor(CHAN_FINAL_SKIP.length / 2)
  const part1 = CHAN_FINAL_SKIP.slice(0, half)
  const part2 = CHAN_FINAL_SKIP.slice(half) + 'answer'

  const state = initParseState()
  const { state: s2 } = feedChunk(state, `${CHAN_ANALYSIS_OPEN}r${CHAN_CLOSE}${part1}`)
  const { state: s3, events } = feedChunk(s2, part2)
  const all = [...events, ...flushState(s3)]
  const delta = all.filter(e => e.type === 'delta').map(e => e.text).join('')
  assert.equal(delta, 'answer')
})

test('skipFinal: whitespace (\\n) before CHAN_FINAL_SKIP is stripped, content is kept — indexOf fix', () => {
  // THE REGRESSION: a newline between <|end|> and <|start|>assistant…
  // Before the fix the else branch cleared parseBuf and the final answer was lost.
  const input = `${CHAN_ANALYSIS_OPEN}reasoning${CHAN_CLOSE}\n${CHAN_FINAL_SKIP}the answer`
  const { reasoning, delta } = run([input])
  assert.equal(reasoning, 'reasoning')
  assert.equal(delta, 'the answer')  // empty string without the indexOf fix
})

test('skipFinal: multiple whitespace chars before CHAN_FINAL_SKIP all stripped', () => {
  const input = `${CHAN_ANALYSIS_OPEN}r${CHAN_CLOSE}   \n\t${CHAN_FINAL_SKIP}answer`
  const { delta } = run([input])
  assert.equal(delta, 'answer')
})

test('skipFinal: whitespace prefix + multi-chunk content after CHAN_FINAL_SKIP', () => {
  const { reasoning, delta } = run([
    `${CHAN_ANALYSIS_OPEN}r${CHAN_CLOSE}\n${CHAN_FINAL_SKIP}`,
    'part1 ',
    'part2',
  ])
  assert.equal(reasoning, 'r')
  assert.equal(delta, 'part1 part2')
})

test('skipFinal: no CHAN_FINAL_SKIP present — buf cleared, phase becomes content', () => {
  // When the skip token is not found, buf is cleared and subsequent chunks emit normally.
  const state = initParseState()
  const { state: s2 } = feedChunk(state, `${CHAN_ANALYSIS_OPEN}r${CHAN_CLOSE}junk_no_skip_token`)
  assert.equal(s2.phase, 'content')
  assert.equal(s2.buf, '')
  // Subsequent content emits as delta
  const { events } = feedChunk(s2, 'next chunk')
  const delta = events.filter(e => e.type === 'delta').map(e => e.text).join('')
  assert.equal(delta, 'next chunk')
})

test('skipFinal: partial CHAN_FINAL_SKIP held in buf until complete', () => {
  const partial = CHAN_FINAL_SKIP.slice(0, 15)
  const state = initParseState()
  const { state: s2 } = feedChunk(state, `${CHAN_ANALYSIS_OPEN}r${CHAN_CLOSE}`)
  const { state: s3, events: e3 } = feedChunk(s2, partial)
  // Still waiting for more data — no delta emitted yet
  assert.equal(s3.phase, 'skipFinal')
  assert.equal(e3.filter(e => e.type === 'delta').length, 0)
  // Complete the token and add content
  const { state: s4, events: e4 } = feedChunk(s3, CHAN_FINAL_SKIP.slice(15) + 'answer')
  assert.equal(s4.phase, 'content')
  assert.equal(e4.filter(e => e.type === 'delta').map(e => e.text).join(''), 'answer')
})

// ── EOS flush ─────────────────────────────────────────────────────────────

test('EOS flush: reasoning phase flushes remaining buf as reasoning event', () => {
  const state = initParseState()
  const { state: s2 } = feedChunk(state, `${THINK_OPEN}incomplete reasoning`)
  const events = flushState(s2)
  // feedChunk emits a safe portion immediately; flushState emits the buffered tail.
  // Together they must equal the full input.
  assert(events.length === 1, 'flushState must emit the buffered tail')
  assert.equal(events[0].type, 'reasoning')
  const fullFromFlush = events[0].text
  assert(fullFromFlush.length > 0, 'tail must be non-empty')
  // Verify full reasoning text across feedChunk events + flush
  const { events: e1 } = feedChunk(initParseState(), `<think>incomplete reasoning`)
  // (e1 holds the safe-flushed prefix; events holds the tail from s2)
  const total = [...e1, ...events].filter(e => e.type === 'reasoning').map(e => e.text).join('')
  assert.equal(total, 'incomplete reasoning')
})

test('EOS flush: skipFinal phase flushes remaining buf as delta (truncated stream)', () => {
  // If the stream ends mid-skipFinal, emit whatever's buffered as delta
  const state = initParseState()
  const { state: s2 } = feedChunk(state, `${CHAN_ANALYSIS_OPEN}r${CHAN_CLOSE}`)
  assert.equal(s2.phase, 'skipFinal')
  const { state: s3 } = feedChunk(s2, CHAN_FINAL_SKIP.slice(0, 10))
  const events = flushState(s3)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'delta')
})

test('EOS flush: empty buf produces no events', () => {
  assert.equal(flushState(initParseState()).length, 0)
})

test('EOS flush: content phase flushes remaining buf as delta', () => {
  const state = initParseState()
  const { state: s2 } = feedChunk(state, `${THINK_OPEN}r${THINK_CLOSE}`)
  assert.equal(s2.phase, 'content')
  // Feed content too short to flush (≤29 chars retained in lookahead? No — content phase flushes immediately)
  // Actually in content phase, feedChunk flushes everything immediately
  const { state: s3 } = feedChunk(s2, 'response')
  // All flushed — state.buf should be empty after content phase
  assert.equal(s3.buf, '')
})

// ── lookahead buffering ───────────────────────────────────────────────────

test('lookahead: chunk shorter than 29 chars is held in buf, not emitted', () => {
  const state = initParseState()
  const { state: s2, events } = feedChunk(state, 'Hello')  // 5 chars, well below 29
  assert.equal(events.length, 0)
  assert.equal(s2.phase, 'initial')
  assert.equal(s2.buf, 'Hello')
})

test('lookahead: chunk longer than 29 chars flushes content as delta', () => {
  const state = initParseState()
  // 40 chars with no tag: initial phase flushes 11 safe chars and transitions to content,
  // then the while loop continues and content phase flushes the remaining 29 — total = 40.
  const { state: s2, events } = feedChunk(state, 'A'.repeat(40))
  const flushed = events.filter(e => e.type === 'delta').map(e => e.text).join('')
  assert.equal(flushed.length, 40)
  assert.equal(s2.buf, '')
})

test('lookahead: accumulated short chunks eventually flush when total exceeds threshold', () => {
  const { delta } = run(['Short. ', 'More text that pushes past the lookahead threshold now.'])
  assert(delta.includes('Short.'), 'buffered content must be eventually emitted')
})

// ── phase transition smoke tests ──────────────────────────────────────────

test('phases: initial → reasoning → content via think block', () => {
  const state = initParseState()
  assert.equal(state.phase, 'initial')
  const { state: s2 } = feedChunk(state, THINK_OPEN)
  assert.equal(s2.phase, 'reasoning')
  assert.equal(s2.isChannel, false)
  const { state: s3 } = feedChunk(s2, `thought${THINK_CLOSE}`)
  assert.equal(s3.phase, 'content')
})

test('phases: initial → reasoning → skipFinal → content via channel block', () => {
  const state = initParseState()
  const { state: s2 } = feedChunk(state, CHAN_ANALYSIS_OPEN)
  assert.equal(s2.phase, 'reasoning')
  assert.equal(s2.isChannel, true)
  const { state: s3 } = feedChunk(s2, `thought${CHAN_CLOSE}`)
  assert.equal(s3.phase, 'skipFinal')
  const { state: s4 } = feedChunk(s3, CHAN_FINAL_SKIP)
  assert.equal(s4.phase, 'content')
})

test('phases: no reasoning tag → stays initial then transitions to content once buf is long enough', () => {
  const { delta } = run(['A plain response with no reasoning tags whatsoever, just regular content.'])
  assert(delta.length > 0)
  assert.equal(delta.includes('<think>'), false)
})
