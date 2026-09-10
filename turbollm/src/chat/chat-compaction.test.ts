// Unit tests for chat-compaction.ts's pure logic (ADR-420). The async LLM-call half
// (compactConversation/maybeAutoCompact) is covered separately in Task 3's tests, which
// inject a fake fetch the same way chat-upstream.request-log.test.ts does — everything
// here is synchronous and needs no engine.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  withCurrentDate, shouldAutoCompact, lastCtxUsage, resolveCompactionCut,
  buildEngineMessages, pickCompactionCut, AUTO_COMPACT_THRESHOLD,
} from './chat-compaction.js'
import type { Conversation, Message } from './db.js'

function makeMsg(role: 'user' | 'assistant', content: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    convId: 'conv-1', seq: 1, role, content, reasoning: '',
    attachments: [], textAttachments: [], toolCalls: [], stats: {},
    createdAt: '2026-09-09T00:00:00.000Z', variantGroup: null, isActive: true,
    branchOf: null, edited: false,
    ...overrides,
  }
}

function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1', title: 'Test', systemPrompt: '', modelKey: 'm', sampling: {},
    expertMode: false, kind: 'chat', preserveThinking: false,
    createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  }
}

// ── withCurrentDate (moved here from chat-routes.ts, unchanged behavior) ───────────────

test('withCurrentDate: appends a date line to a non-empty prompt', () => {
  const now = new Date('2026-09-09T12:00:00Z')
  const out = withCurrentDate('Be helpful.', now)
  assert.match(out, /^Be helpful\.\n\nToday's date is 2026-09-09\./)
})

test('withCurrentDate: strips a stale baked-in date line before appending the fresh one', () => {
  const now = new Date('2026-09-09T12:00:00Z')
  const out = withCurrentDate("Today's date is 2026-01-01. Use it only when needed.\n\nBe helpful.", now)
  assert.equal((out.match(/Today's date is/g) ?? []).length, 1)
  assert.match(out, /2026-09-09/)
})

test('withCurrentDate: an empty prompt yields just the date line', () => {
  const now = new Date('2026-09-09T12:00:00Z')
  assert.equal(withCurrentDate('', now), "Today's date is 2026-09-09. Use it only when the request depends on the current date; otherwise ignore it.")
})

// ── shouldAutoCompact ────────────────────────────────────────────────────────────────

test('shouldAutoCompact: false under the 80% threshold', () => {
  assert.equal(shouldAutoCompact(7999, 10000), false)
})

test('shouldAutoCompact: false exactly AT the threshold (strictly greater-than, not >=)', () => {
  assert.equal(shouldAutoCompact(8000, 10000), false)
})

test('shouldAutoCompact: true just over the threshold', () => {
  assert.equal(shouldAutoCompact(8001, 10000), true)
})

test('shouldAutoCompact: false when ctxMax is 0 (no model loaded / unknown window)', () => {
  assert.equal(shouldAutoCompact(999999, 0), false)
})

test('AUTO_COMPACT_THRESHOLD is fixed at 0.8 (ADR-132) — not configurable', () => {
  assert.equal(AUTO_COMPACT_THRESHOLD, 0.8)
})

// ── lastCtxUsage ─────────────────────────────────────────────────────────────────────

test('lastCtxUsage: reads ctxUsed/ctxMax off the LAST assistant message that has them', () => {
  const messages = [
    makeMsg('user', 'hi'),
    makeMsg('assistant', 'hello', { stats: { ctxUsed: 100, ctxMax: 8192 } }),
    makeMsg('user', 'more'),
    makeMsg('assistant', 'reply', { stats: { ctxUsed: 500, ctxMax: 8192 } }),
  ]
  assert.deepEqual(lastCtxUsage(messages), { ctxUsed: 500, ctxMax: 8192 })
})

test('lastCtxUsage: zeros when no assistant message has recorded stats yet', () => {
  assert.deepEqual(lastCtxUsage([makeMsg('user', 'hi')]), { ctxUsed: 0, ctxMax: 0 })
})

test('lastCtxUsage: skips an assistant placeholder row with empty stats (mid-generation)', () => {
  const messages = [
    makeMsg('assistant', 'done', { stats: { ctxUsed: 300, ctxMax: 8192 } }),
    makeMsg('user', 'another'),
    makeMsg('assistant', '', { stats: { aborted: false } }), // fresh placeholder, no ctxUsed yet
  ]
  assert.deepEqual(lastCtxUsage(messages), { ctxUsed: 300, ctxMax: 8192 })
})

// ── resolveCompactionCut ─────────────────────────────────────────────────────────────

test('resolveCompactionCut: no cut set → summary null, rest is everything', () => {
  const messages = [makeMsg('user', 'a'), makeMsg('assistant', 'b')]
  const conv = makeConv()
  assert.deepEqual(resolveCompactionCut(conv, messages), { summary: null, rest: messages })
})

test('resolveCompactionCut: resolved cut → summary + only messages AFTER the cut', () => {
  const m1 = makeMsg('user', 'a'); const m2 = makeMsg('assistant', 'b'); const m3 = makeMsg('user', 'c')
  const conv = makeConv({ compactionSummary: 'earlier stuff', compactionUpToMessageId: m1.id })
  const { summary, rest } = resolveCompactionCut(conv, [m1, m2, m3])
  assert.equal(summary, 'earlier stuff')
  assert.deepEqual(rest.map((m) => m.id), [m2.id, m3.id])
})

test('resolveCompactionCut: UNRESOLVABLE cut (message not in active list) never drops the summary — replays every active message alongside it (ports Code\'s resolveEffectiveHistory fallback, not a lossy one)', () => {
  const m1 = makeMsg('user', 'a'); const m2 = makeMsg('assistant', 'b')
  const conv = makeConv({ compactionSummary: 'earlier stuff', compactionUpToMessageId: 'deleted-msg-id' })
  const { summary, rest } = resolveCompactionCut(conv, [m1, m2])
  assert.equal(summary, 'earlier stuff') // NOT null — the summary is never silently discarded
  assert.deepEqual(rest.map((m) => m.id), [m1.id, m2.id]) // ALL active messages, not a partial cut
})

// ── buildEngineMessages ──────────────────────────────────────────────────────────────

test('buildEngineMessages: no cut, no system prompt — plain passthrough', () => {
  const m1 = makeMsg('user', 'hi')
  const conv = makeConv({ systemPrompt: '' })
  const out = buildEngineMessages(conv, [m1])
  assert.deepEqual(out, [{ role: 'user', content: 'hi' }])
})

test('buildEngineMessages: system prompt gets the date-injected treatment', () => {
  const conv = makeConv({ systemPrompt: 'Be nice.' })
  const out = buildEngineMessages(conv, [])
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'system')
  assert.match(out[0].content as string, /^Be nice\.\n\nToday's date is/)
})

test('buildEngineMessages: with a resolved cut, emits system + summary-as-system + only the tail', () => {
  const m1 = makeMsg('user', 'old'); const m2 = makeMsg('assistant', 'new')
  const conv = makeConv({ systemPrompt: 'Be nice.', compactionSummary: 'User said old things.', compactionUpToMessageId: m1.id })
  const out = buildEngineMessages(conv, [m1, m2])
  assert.equal(out.length, 3)
  assert.equal(out[0].role, 'system') // date-injected system prompt
  assert.equal(out[1].role, 'system')
  assert.equal(out[1].content, 'Earlier conversation summary:\n\nUser said old things.')
  assert.deepEqual(out[2], { role: 'assistant', content: 'new' })
})

test('buildEngineMessages: preserveThinking folds reasoning into an assistant message ONLY for the raw tail, never for the summary', () => {
  const m1 = makeMsg('assistant', 'old reply', { reasoning: 'old thoughts' })
  const m2 = makeMsg('assistant', 'new reply', { reasoning: 'new thoughts' })
  const conv = makeConv({ preserveThinking: true, compactionSummary: 's', compactionUpToMessageId: m1.id })
  const out = buildEngineMessages(conv, [m1, m2])
  const tailMsg = out.find((o) => o.content === '<think>\nnew thoughts\n</think>\n\nnew reply')
  assert.ok(tailMsg, 'expected the tail message\'s reasoning to be folded in')
  assert.ok(!out.some((o) => typeof o.content === 'string' && o.content.includes('old thoughts')))
})

// ── pickCompactionCut ────────────────────────────────────────────────────────────────

test('pickCompactionCut: returns null when there are too few messages to bother', () => {
  const messages = [makeMsg('user', 'a'), makeMsg('assistant', 'b')]
  assert.equal(pickCompactionCut(messages, 8192), null)
})

test('pickCompactionCut: always keeps at least the last message in the tail, even if it alone exceeds budget', () => {
  const big = 'x'.repeat(100_000)
  const messages = [makeMsg('user', 'a'), makeMsg('assistant', 'b'), makeMsg('user', 'c'), makeMsg('assistant', big)]
  const picked = pickCompactionCut(messages, 100) // tiny budget
  assert.ok(picked)
  assert.equal(picked!.toSummarize.length, 3) // everything but the huge last message
  assert.equal(picked!.cutMessageId, messages[2].id)
})

test('pickCompactionCut: cutMessageId is the LAST message being summarized, and toSummarize+tail cover everything with no gap or overlap', () => {
  const messages = Array.from({ length: 10 }, (_, i) => makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message number ${i} with some real content`))
  // ctxMax=100 (not a larger, "rounder" number): these 10 fixture messages total ~145
  // estimated tokens, and a keepBudget any looser than this would fit the WHOLE pool inside
  // the tail, making pickCompactionCut return null instead of a real partial cut — which is
  // exactly what this test needs to exist to check the partition math on.
  const picked = pickCompactionCut(messages, 100)
  assert.ok(picked)
  const cutIdx = messages.findIndex((m) => m.id === picked!.cutMessageId)
  assert.equal(picked!.toSummarize.length, cutIdx + 1)
  assert.deepEqual(picked!.toSummarize.map((m) => m.id), messages.slice(0, cutIdx + 1).map((m) => m.id))
})

test('pickCompactionCut: returns null when the whole pool already fits the tail budget (nothing worth cutting)', () => {
  const messages = [makeMsg('user', 'a'), makeMsg('assistant', 'b'), makeMsg('user', 'c'), makeMsg('assistant', 'd')]
  assert.equal(pickCompactionCut(messages, 1_000_000), null)
})
