// turbollm/src/ext/generation.test.ts
//
// generation.ts's engine-wiring is not exercised by routes.runs.test.ts (that file injects a
// fake `makeBody` and never touches this module — see generation.ts's own header comment). This
// file targets the one piece of generation.ts that IS practical and worthwhile to unit-test in
// isolation: `loadFullHistory`'s pagination loop, which fixes a Critical bug a review found —
// `d.chatStore.listMessages(scope, chatId, {limit: N})` with no cursor returns the OLDEST page
// (`ORDER BY seq ASC`), so a single un-paginated call silently drops the newest messages —
// including the turn currently being generated — once a chat has more than one page's worth of
// history. `pageSize` is overridable specifically so this can be proven with a handful of
// messages instead of needing to push 200+ real rows through the store.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import {
  loadFullHistory, shouldFlushCheckpoint, FLUSH_INTERVAL_MS, FLUSH_MIN_CHARS,
  extractChunkUsage, buildUsagePatch,
} from './generation.js'

const SCOPE = { tenant: 'acme', owner: 'u1' }

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-gen-'))
  const conv = new ConversationStore(dir)
  const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
  return { chatStore, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('loadFullHistory pages past a single page and includes the newest (highest-seq) messages', async () => {
  const { chatStore, cleanup } = harness()
  try {
    const chat = await chatStore.createChat(SCOPE, { title: 'History paging' })
    const TOTAL = 11
    for (let i = 0; i < TOTAL; i++) {
      await chatStore.addMessage(SCOPE, chat.id, { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` })
    }

    // A page size of 2 forces 6 pages to cover 11 messages — proves the loop actually walks
    // `nextCursor` forward rather than returning (and stopping at) the first page.
    const all = await loadFullHistory(chatStore, SCOPE, chat.id, 2)

    assert.equal(all.length, TOTAL, 'every message must be returned, not just the first page')
    assert.deepEqual(all.map((m) => m.content), Array.from({ length: TOTAL }, (_, i) => `msg-${i}`),
      'messages must come back in seq order across the page boundary, with none dropped or duplicated')
    // This is exactly what the bug silently dropped: the highest-seq (newest) message.
    assert.equal(all[all.length - 1].content, `msg-${TOTAL - 1}`)
  } finally {
    cleanup()
  }
})

test('loadFullHistory returns everything in one call when the chat fits in a single page', async () => {
  const { chatStore, cleanup } = harness()
  try {
    const chat = await chatStore.createChat(SCOPE, { title: 'Small chat' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'hi' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: 'hello' })

    const all = await loadFullHistory(chatStore, SCOPE, chat.id)
    assert.deepEqual(all.map((m) => m.content), ['hi', 'hello'])
  } finally {
    cleanup()
  }
})

test('loadFullHistory on a chat with no messages returns an empty array', async () => {
  const { chatStore, cleanup } = harness()
  try {
    const chat = await chatStore.createChat(SCOPE, { title: 'Empty chat' })
    const all = await loadFullHistory(chatStore, SCOPE, chat.id, 2)
    assert.deepEqual(all, [])
  } finally {
    cleanup()
  }
})

// ── shouldFlushCheckpoint (C2 fix) ──────────────────────────────────────────────────────────
//
// The mid-stream checkpoint flush this backs (createMakeBody, in generation.ts) can't be
// exercised end-to-end here — there is no live model/engine to drive a real streaming
// generation in this environment (see generation.ts's own header comment; the file's contract
// is otherwise only exercised through the interface routes.runs.ts depends on, per its route
// tests, which inject a fake `makeBody`). What IS practical and worthwhile to test directly is
// the pure "should I flush now?" decision itself, since it was deliberately extracted out of the
// I/O-performing closure specifically so it could be.
test('shouldFlushCheckpoint: flushes once the char threshold is reached, well before the time threshold', () => {
  assert.equal(shouldFlushCheckpoint(10, FLUSH_MIN_CHARS), true)
  assert.equal(shouldFlushCheckpoint(10, FLUSH_MIN_CHARS + 1), true)
  assert.equal(shouldFlushCheckpoint(0, FLUSH_MIN_CHARS), true, 'char threshold alone is sufficient, even at 0 elapsed ms')
})

test('shouldFlushCheckpoint: flushes once the time threshold elapses, even with very little new content', () => {
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS, 1), true)
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS + 50, 1), true)
})

test('shouldFlushCheckpoint: does not flush before either threshold is reached', () => {
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS - 1, FLUSH_MIN_CHARS - 1), false)
  assert.equal(shouldFlushCheckpoint(100, 10), false)
  assert.equal(shouldFlushCheckpoint(0, 0), false)
})

test('shouldFlushCheckpoint: never flushes when there is nothing new, regardless of elapsed time', () => {
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS * 100, 0), false)
  assert.equal(shouldFlushCheckpoint(Number.MAX_SAFE_INTEGER, 0), false)
  // A negative "new chars" delta should never occur in practice, but must not be treated as
  // "new data" either — the guard is `<= 0`, not `=== 0`.
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS * 100, -5), false)
})

test('shouldFlushCheckpoint: respects overridden thresholds instead of the module defaults', () => {
  assert.equal(shouldFlushCheckpoint(999, 50, { intervalMs: 1000, minChars: 100 }), false)
  assert.equal(shouldFlushCheckpoint(1000, 50, { intervalMs: 1000, minChars: 100 }), true)
  assert.equal(shouldFlushCheckpoint(1, 100, { intervalMs: 1000, minChars: 100 }), true)
})

// ── extractChunkUsage / buildUsagePatch (final-review-round-3 Critical fix) ────────────────────
//
// Same rationale as shouldFlushCheckpoint above: there is no live model/engine in this
// environment to drive a real streaming generation end-to-end (see this file's header comment
// and generation.ts's own), so a genuine "does runGenerationLoop actually call updateMessage
// with usage, does it emit the SSE event at the right point" test is not feasible here without a
// fake-engine harness this test suite doesn't have. What IS practical and directly testable is
// the pure decision logic that was deliberately extracted out of the per-chunk parse loop and
// the patch-building closure specifically so it could be — mirroring the C2 fix's own precedent.
test('extractChunkUsage: captures a real usage object, exactly as the engine sends it (no field renaming)', () => {
  const chunk = { choices: [], usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 } }
  assert.deepEqual(extractChunkUsage(chunk), { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 })
})

test('extractChunkUsage: returns undefined when usage is absent — the ordinary case for every non-final chunk', () => {
  assert.equal(extractChunkUsage({ choices: [{ delta: { content: 'hi' } }] }), undefined)
  assert.equal(extractChunkUsage({}), undefined)
})

test('extractChunkUsage: treats null/non-object/array usage as absent rather than crashing or capturing garbage', () => {
  assert.equal(extractChunkUsage({ usage: null }), undefined)
  assert.equal(extractChunkUsage({ usage: 'not-an-object' }), undefined)
  assert.equal(extractChunkUsage({ usage: 42 }), undefined)
  assert.equal(extractChunkUsage({ usage: [1, 2, 3] }), undefined)
})

test('extractChunkUsage: still captures usage on a chunk whose choices array is empty — the exact chunk shape the old code silently discarded', () => {
  const chunk = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  assert.deepEqual(extractChunkUsage(chunk), { prompt_tokens: 10, completion_tokens: 5 })
})

test('buildUsagePatch: omits the usage key entirely when nothing has arrived yet, rather than sending {}', () => {
  const patch = buildUsagePatch(undefined)
  assert.deepEqual(patch, {})
  assert.equal('usage' in patch, false)
})

test('buildUsagePatch: includes the captured usage object once real data has arrived', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 20 }
  assert.deepEqual(buildUsagePatch(usage), { usage })
})

test('buildUsagePatch: spreads cleanly into a patch literal alongside other fields, either way', () => {
  const withUsage = { content: 'hi', status: 'complete' as const, ...buildUsagePatch({ prompt_tokens: 1 }) }
  assert.deepEqual(withUsage, { content: 'hi', status: 'complete', usage: { prompt_tokens: 1 } })

  const withoutUsage = { content: 'hi', status: 'streaming' as const, ...buildUsagePatch(undefined) }
  assert.deepEqual(withoutUsage, { content: 'hi', status: 'streaming' })
  assert.equal('usage' in withoutUsage, false)
})
