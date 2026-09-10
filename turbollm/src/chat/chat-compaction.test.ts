// Unit tests for chat-compaction.ts's pure logic (ADR-420). The async LLM-call half
// (compactConversation/maybeAutoCompact) is covered separately in Task 3's tests, which
// inject a fake fetch the same way chat-upstream.request-log.test.ts does — everything
// here is synchronous and needs no engine.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  withCurrentDate, shouldAutoCompact, lastCtxUsage, resolveCompactionCut,
  buildEngineMessages, pickCompactionCut, AUTO_COMPACT_THRESHOLD,
  compactConversation, maybeAutoCompact,
} from './chat-compaction.js'
import type { Conversation, Message } from './db.js'
import { ConversationStore } from './db.js'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Deps } from '../deps.js'

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

// ── compactConversation / maybeAutoCompact ──────────────────────────────────────────────

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `turbollm-chat-compaction-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Same shape as chat-upstream.request-log.test.ts's own jsonFetch — a fake fetchImpl that
 *  answers the ONE outbound chat-completions call callChatUpstream makes, so
 *  compactConversation never touches a real network or a real engine. */
function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

// resolveChatUpstream's LOCAL branch (chat-upstream.ts:87-104, the path taken whenever no
// requestedModel is passed — every call in this file) reads d.manager.status()/.target()/
// .currentOpts() and d.registry.active(), none of which the DB-only stub used elsewhere in
// this file provides. Mirrors chat-routes.persist.test.ts's own mkHarness() stub for exactly
// these fields — verified against that file rather than guessed. `ctxMax` is a parameter
// (default 8192) rather than hardcoded because several tests below need it deliberately
// SMALL — pickCompactionCut's tail budget is ~40% of it, and with the default 8192 every
// short fixture conversation in this file fits entirely inside that budget, making
// pickCompactionCut return null (nothing worth cutting) instead of exercising a real cut.
function fakeDeps(db: ConversationStore, ctxMax = 8192): Deps {
  return {
    db,
    store: { snapshot: () => ({ requestLog: { enabled: false } }) },
    gate: undefined,
    modelRouter: { resolveRemoteTarget: () => undefined },
    scanner: { get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'Test Model', ctx: ctxMax } }),
      target: () => 'http://127.0.0.1:8081',
      currentOpts: () => null,
    },
  } as unknown as Deps
}

test('compactConversation: summarizes the older pool, leaves a raw tail, and persists the cut', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with enough real content to count as real tokens`)
    const fetchImpl = jsonFetch({ choices: [{ message: { content: 'The user and assistant exchanged eight messages about testing.' } }] })
    // ctxMax deliberately small (200, via fakeDeps's second param): pickCompactionCut's tail
    // budget is ~40% of ctxMax, and these 8 short fixture messages would ALL fit inside the
    // tail budget of the default 8192 — meaning pickCompactionCut would return null and this
    // test would get nothing_to_compact instead of a real compaction. A small ctxMax forces a
    // genuine cut, exercising the real code path this test is named for.
    const result = await compactConversation(fakeDeps(db, 200), conv.id, { fetchImpl })
    assert.equal(result.summary, 'The user and assistant exchanged eight messages about testing.')
    assert.ok(result.tokensBefore > 0)
    const updated = db.getConversation(conv.id)!
    assert.equal(updated.compactionSummary, result.summary)
    assert.equal(updated.compactionUpToMessageId, result.upToMessageId)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('compactConversation: throws nothing_to_compact for a conversation too short to bother', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    db.addMessage(conv.id, 'user', 'hi')
    const fetchImpl = jsonFetch({ choices: [{ message: { content: 'irrelevant' } }] })
    await assert.rejects(() => compactConversation(fakeDeps(db), conv.id, { fetchImpl }), /nothing_to_compact/)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('compactConversation: a SECOND compaction compounds from the first cut, re-summarizing only the newly-uncovered pool', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    const msgs = Array.from({ length: 8 }, (_, i) => db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `first batch message ${i} with real content`))
    db.setConversationCompaction(conv.id, { summary: 'FIRST SUMMARY', upToMessageId: msgs[3].id, tokensBefore: 50 })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `second batch message ${i} with real content too`)

    let capturedBody: string | undefined
    const fetchImpl: typeof fetch = (async (_url, init) => {
      capturedBody = init?.body as string
      return new Response(JSON.stringify({ choices: [{ message: { content: 'SECOND SUMMARY' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await compactConversation(fakeDeps(db, 200), conv.id, { fetchImpl }) // small ctx — see the first compactConversation test's comment for why
    assert.equal(result.summary, 'SECOND SUMMARY')
    // The prompt sent to the model must have seeded the OLD summary as context, not just
    // re-summarized from scratch — otherwise a compounding compaction quietly loses
    // everything before the first cut.
    assert.ok(capturedBody?.includes('FIRST SUMMARY'))
    // And it must NOT include the first batch's raw message text — that's already covered
    // by FIRST SUMMARY, and re-including it would defeat the point of compounding.
    assert.ok(!capturedBody?.includes('first batch message 0'))
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('compactConversation: throws for a nonexistent conversation', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    await assert.rejects(() => compactConversation(fakeDeps(db), 'does-not-exist'), /not_found/)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('maybeAutoCompact: no-op (no events, no DB change) when under threshold', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    db.addMessage(conv.id, 'assistant', 'reply', { stats: { ctxUsed: 100, ctxMax: 8192 } })
    const events: string[] = []
    const fresh = db.getConversation(conv.id, true)!
    await maybeAutoCompact(fakeDeps(db), conv.id, fresh, async (phase) => { events.push(phase) })
    assert.deepEqual(events, [])
    assert.equal(db.getConversation(conv.id)!.compactionSummary, undefined)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('maybeAutoCompact: fires start/end events, actually compacts, and the conv object is mutated in place when over the 80% threshold', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with real content`)
    db.addMessage(conv.id, 'assistant', 'reply', { stats: { ctxUsed: 9000, ctxMax: 10000 } })
    const events: string[] = []
    const fresh = db.getConversation(conv.id, true)!
    const fetchImpl = jsonFetch({ choices: [{ message: { content: 'Summary text.' } }] })
    // Small ctx (200), same reason as the compactConversation tests above — the 8 fixture
    // messages must NOT all fit inside pickCompactionCut's tail budget, or this test would
    // silently degrade to exercising the no-op-because-nothing_to_compact path instead of a
    // real compaction, while still passing on its events-only assertion. See __fetchImplForTest's
    // doc comment above compactConversation for what this property actually is.
    const d = fakeDeps(db, 200)
    ;(d as unknown as { __fetchImplForTest?: typeof fetch }).__fetchImplForTest = fetchImpl
    await maybeAutoCompact(d, conv.id, fresh, async (phase) => { events.push(phase) })
    assert.deepEqual(events, ['start', 'end'])
    // The two assertions that actually distinguish "compacted" from "silently no-op'd":
    assert.equal(db.getConversation(conv.id)!.compactionSummary, 'Summary text.')
    assert.equal(fresh.compactionSummary, 'Summary text.') // mutated in place, per maybeAutoCompact's own doc comment
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('maybeAutoCompact: a failed summarization call is swallowed — the turn is never blocked (same best-effort contract as autoTitle)', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with real content`)
    db.addMessage(conv.id, 'assistant', 'reply', { stats: { ctxUsed: 9000, ctxMax: 10000 } })
    const events: string[] = []
    const fresh = db.getConversation(conv.id, true)!
    // Small ctx again — this test needs pickCompactionCut to succeed and callChatUpstream to
    // be the thing that actually fails (HTTP 500), not nothing_to_compact short-circuiting
    // before the network call is ever made.
    const d = fakeDeps(db, 200)
    ;(d as unknown as { __fetchImplForTest?: typeof fetch }).__fetchImplForTest = jsonFetch({}, 500)
    await assert.doesNotReject(() => maybeAutoCompact(d, conv.id, fresh, async (phase) => { events.push(phase) }))
    assert.deepEqual(events, ['start', 'end']) // still brackets the attempt even though it failed
    assert.equal(db.getConversation(conv.id)!.compactionSummary, undefined) // nothing persisted
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
