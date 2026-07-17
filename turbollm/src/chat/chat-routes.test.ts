// BUG-001 regression tests: Qwen3 / thinking models returning only <think>...</think>
// tokens after the tool-calling loop, leaving visible content empty.
//
// The fix: after the tool loop exits, strip <think> blocks from the accumulated
// content. If the visible content is empty/whitespace, make one extra inference
// pass with tool_choice:'none' and use that result as the final reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripThinkingBlocks, needsExtraPass } from './think-utils.js'
import { recentTitleTurns } from './chat-routes.js'

// ── stripThinkingBlocks ───────────────────────────────────────────────────────

test('stripThinkingBlocks: removes a single <think> block', () => {
  const input = '<think>some chain of thought</think>The actual answer.'
  assert.equal(stripThinkingBlocks(input), 'The actual answer.')
})

test('stripThinkingBlocks: removes multiple <think> blocks', () => {
  const input = '<think>step 1</think>middle<think>step 2</think>end'
  assert.equal(stripThinkingBlocks(input), 'middleend')
})

test('stripThinkingBlocks: case-insensitive tag match', () => {
  const input = '<THINK>hidden</THINK>visible'
  assert.equal(stripThinkingBlocks(input), 'visible')
})

test('stripThinkingBlocks: multiline think block is removed', () => {
  const input = '<think>\nline one\nline two\n</think>\nFinal answer.'
  assert.equal(stripThinkingBlocks(input).trim(), 'Final answer.')
})

test('stripThinkingBlocks: no think block returns input unchanged', () => {
  const input = 'Plain response with no thinking.'
  assert.equal(stripThinkingBlocks(input), input)
})

test('stripThinkingBlocks: only think block yields empty string after trim', () => {
  const input = '<think>only reasoning, no visible content</think>'
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

test('stripThinkingBlocks: whitespace-only after stripping yields empty after trim', () => {
  const input = '<think>reasoning</think>   \n  '
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

// ── needsExtraPass ───────────────────────────────────────────────────────────

test('needsExtraPass: returns true when content is only a <think> block', () => {
  assert.equal(needsExtraPass('<think>deep thoughts</think>'), true)
})

test('needsExtraPass: returns true when content is whitespace only', () => {
  assert.equal(needsExtraPass('   \n\t  '), true)
})

test('needsExtraPass: returns true when content is empty string', () => {
  assert.equal(needsExtraPass(''), true)
})

test('needsExtraPass: returns false when visible content exists after stripping', () => {
  assert.equal(needsExtraPass('<think>reasoning</think>Here is my answer.'), false)
})

test('needsExtraPass: returns false for plain text with no thinking tokens', () => {
  assert.equal(needsExtraPass('The capital of France is Paris.'), false)
})

test('needsExtraPass: returns false when think block is followed by non-whitespace', () => {
  assert.equal(needsExtraPass('<think>step</think>\n\nActual answer here.'), false)
})

// ── recentTitleTurns ──────────────────────────────────────────────────────────
// GitHub: "the AI generated chat title is broken. It gets title based on memory and not based
// on msg I send." For a brand-new conversation (exactly when auto-title fires), engineMessages
// is just [system, user] — a plain slice(-2) grabbed the memory-stuffed system prompt right
// alongside the real first message.

test('recentTitleTurns: excludes the injected system prompt for a brand-new conversation', () => {
  const engineMessages = [
    { role: 'system', content: 'You are TurboLLM...\n\nWhat you know about the user from past conversations:\n- Likes cats\n- Works in finance' },
    { role: 'user', content: 'How do I center a div in CSS?' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[0].content, 'How do I center a div in CSS?')
})

test('recentTitleTurns: still takes the last N when there IS real history (no system message present)', () => {
  const engineMessages = [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second turn' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.deepEqual(turns.map((t) => t.content), ['first reply', 'second turn'])
})

test('recentTitleTurns: a system message is excluded even when mixed in with real history', () => {
  const engineMessages = [
    { role: 'system', content: 'hidden capability + memory block' },
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first reply' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.ok(turns.every((t) => t.role !== 'system'))
  assert.deepEqual(turns.map((t) => t.content), ['first turn', 'first reply'])
})

test('recentTitleTurns: empty input yields empty output, no throw', () => {
  assert.deepEqual(recentTitleTurns([]), [])
})
