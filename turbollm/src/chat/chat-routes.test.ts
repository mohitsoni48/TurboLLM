// BUG-001 regression tests: Qwen3 / thinking models returning only <think>...</think>
// tokens after the tool-calling loop, leaving visible content empty.
//
// The fix: after the tool loop exits, strip <think> blocks from the accumulated
// content. If the visible content is empty/whitespace, make one extra inference
// pass with tool_choice:'none' and use that result as the final reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripThinkingBlocks, needsExtraPass } from './think-utils.js'
import { recentTitleTurns, reportFirstChat } from './chat-routes.js'
import { Emitter } from '../telemetry/emit.js'
import { readQueue } from '../telemetry/queue.js'

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

// ── reportFirstChat (onboarding_step: first_chat, ADR-323) ────────────────────
// Scaffolding mirrors telemetry/first-load.test.ts: a real temp data dir so the
// once-only ledger is exercised for real, and a real Emitter over a stub config.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-firstchat-'))
}

function makeEmitter(dir: string, level = 'anon'): Emitter {
  const cfg = { telemetry: { level, machineId: '44444444-4444-4444-4444-444444444444' } }
  return new Emitter({
    dataDir: dir,
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } as never,
    version: '1.9.9',
    os: 'win32/x64',
  })
}

function queued(dir: string): Record<string, unknown>[] {
  return readQueue(dir).map((q) => q.event)
}

test('reportFirstChat: a completed generation reports first_chat as ok', () => {
  const dir = tempDir()
  try {
    reportFirstChat(dir, makeEmitter(dir), 'ok')
    const events = queued(dir)

    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'onboarding_step')
    assert.deepEqual(events[0].payload, { step: 'first_chat', outcome: 'ok' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportFirstChat: an aborted generation reports cancelled, not fail', () => {
  const dir = tempDir()
  try {
    reportFirstChat(dir, makeEmitter(dir), 'cancelled')
    assert.deepEqual(queued(dir)[0].payload, { step: 'first_chat', outcome: 'cancelled' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportFirstChat: an engine error (early bad-response return, or a thrown mid-stream exception) reports fail', () => {
  // The two real call sites that pass 'fail': runGeneration's early return on a
  // non-ok engine response, and its catch block on a non-AbortError exception. A
  // user whose first-ever attempt hits either must not read as either "ok" (silently
  // wrong) or "never tried" (silently missing) — see the PR review that caught this.
  const dir = tempDir()
  try {
    reportFirstChat(dir, makeEmitter(dir), 'fail')
    assert.deepEqual(queued(dir)[0].payload, { step: 'first_chat', outcome: 'fail' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportFirstChat: fires exactly once across many generations, not on every reply', () => {
  // This runs at the end of EVERY generation — without the ledger claim an active
  // user's ordinary chatting would emit a "setup" event forever.
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportFirstChat(dir, e, 'ok')
    reportFirstChat(dir, e, 'ok')
    reportFirstChat(dir, e, 'cancelled')

    assert.equal(queued(dir).length, 1, 'first_chat means first, not every')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportFirstChat: an aborted FIRST chat still claims the once-key', () => {
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportFirstChat(dir, e, 'cancelled')
    reportFirstChat(dir, e, 'ok')

    const events = queued(dir)
    assert.equal(events.length, 1, 'the aborted attempt was still the first one')
    assert.deepEqual(events[0].payload, { step: 'first_chat', outcome: 'cancelled' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportFirstChat: a FAILED first chat still claims the once-key', () => {
  const dir = tempDir()
  try {
    const e = makeEmitter(dir)
    reportFirstChat(dir, e, 'fail')
    reportFirstChat(dir, e, 'ok')

    const events = queued(dir)
    assert.equal(events.length, 1, 'the failed attempt was still the first one')
    assert.deepEqual(events[0].payload, { step: 'first_chat', outcome: 'fail' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportFirstChat: consent off queues nothing and does not spend the claim', () => {
  const dir = tempDir()
  try {
    reportFirstChat(dir, makeEmitter(dir, 'off'), 'ok')
    assert.equal(queued(dir).length, 0)

    reportFirstChat(dir, makeEmitter(dir, 'anon'), 'ok')
    assert.equal(queued(dir).length, 1, 'opting in later must still capture the next chat')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportFirstChat: no emitter (telemetry not wired) is a silent no-op', () => {
  assert.doesNotThrow(() => reportFirstChat(tempDir(), undefined, 'ok'))
})
