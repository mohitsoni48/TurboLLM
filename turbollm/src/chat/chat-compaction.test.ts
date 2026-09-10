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
import type { ChatUpstream } from './chat-upstream.js'
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

/** What a turn route hands down: the upstream it ALREADY resolved for this turn. Mirrors what
 *  fakeDeps's fake local engine reports, so the local-path tests below behave exactly as they
 *  did when compactConversation re-resolved it internally. `ctxMax` must match the fakeDeps
 *  ctxMax used alongside it — pickCompactionCut now sizes the tail against the PASSED
 *  upstream's window, not d.manager's. */
function localUpstream(ctxMax = 8192): ChatUpstream {
  return { modelField: 'm', modelName: 'Test Model', ctxMax, target: 'http://127.0.0.1:8081' }
}

/** A linked-host upstream, shaped exactly as resolveChatUpstream's REMOTE branch builds one
 *  (chat-upstream.ts): unqualified modelField, the host's advertised ctx, and a RemoteTarget.
 *  `target` is empty — nothing may build a local URL from a remote turn. */
function remoteUpstream(ctxMax = 200): ChatUpstream {
  return {
    modelField: 'Qwen3-30B-A3B',
    modelName: 'Qwen3 30B A3B (rig)',
    ctxMax,
    remote: { linkId: 'link-rig', baseUrl: 'https://rig.example', token: 'link-token-abc', modelKey: 'Qwen3-30B-A3B' },
    target: '',
  }
}

/** Deps with NO usable local engine — every local-resolution dependency throws on contact.
 *  This is the whole point: `resolveChatUpstream`'s local branch calls `d.manager.status()`
 *  first thing, so any code path that re-resolves instead of using the upstream it was handed
 *  fails loudly here instead of silently summarizing a Turbo Link chat on this machine's model
 *  (or throwing model_not_loaded forever, which is what shipped before this fix). */
function noLocalEngineDeps(db: ConversationStore): Deps {
  const boom = (): never => { throw new Error('local engine resolution must not happen when an upstream was passed in') }
  return {
    db,
    store: { snapshot: () => ({ requestLog: { enabled: false } }) },
    gate: undefined,
    modelRouter: { resolveRemoteTarget: boom },
    scanner: { get: () => undefined },
    registry: { active: boom },
    manager: { status: boom, target: boom, currentOpts: boom },
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
    // upstream + signal are what the turn route hands down (it has both already). A never-
    // aborted controller stands in for "the user did not press Stop" in every test here
    // except the abort test further down, which uses a real one.
    await maybeAutoCompact(fakeDeps(db), conv.id, fresh, localUpstream(), new AbortController().signal, async (phase) => { events.push(phase) })
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
    await maybeAutoCompact(d, conv.id, fresh, localUpstream(200), new AbortController().signal, async (phase) => { events.push(phase) })
    assert.deepEqual(events, ['start', 'end'])
    // The two assertions that actually distinguish "compacted" from "silently no-op'd":
    assert.equal(db.getConversation(conv.id)!.compactionSummary, 'Summary text.')
    assert.equal(fresh.compactionSummary, 'Summary text.') // mutated in place, per maybeAutoCompact's own doc comment
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('maybeAutoCompact: a rejecting emitCompactionEvent callback does not crash the function or block the actual compaction', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with real content`)
    db.addMessage(conv.id, 'assistant', 'reply', { stats: { ctxUsed: 9000, ctxMax: 10000 } })
    const fresh = db.getConversation(conv.id, true)!
    // Small ctx again — same reason as the other maybeAutoCompact tests: needs a real cut so
    // compactConversation actually runs (and writes to the DB) rather than short-circuiting.
    const d = fakeDeps(db, 200)
    ;(d as unknown as { __fetchImplForTest?: typeof fetch }).__fetchImplForTest = jsonFetch({ choices: [{ message: { content: 'Summary text.' } }] })
    // The real caller (a later task) wires this to stream.writeSSE, which can reject on a
    // disconnected client — simulate that here.
    const rejectingEmit = async () => { throw new Error('client disconnected') }
    await assert.doesNotReject(() => maybeAutoCompact(d, conv.id, fresh, localUpstream(200), new AbortController().signal, rejectingEmit))
    // The actual compaction must still have happened despite the emit failures.
    assert.equal(db.getConversation(conv.id)!.compactionSummary, 'Summary text.')
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
    await assert.doesNotReject(() => maybeAutoCompact(d, conv.id, fresh, localUpstream(200), new AbortController().signal, async (phase) => { events.push(phase) }))
    assert.deepEqual(events, ['start', 'end']) // still brackets the attempt even though it failed
    assert.equal(db.getConversation(conv.id)!.compactionSummary, undefined) // nothing persisted
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ── Turbo Link: the passed-in upstream is the one that runs (final-review I-1) ───────────
//
// Every test above this point runs against fakeDeps, whose `modelRouter.resolveRemoteTarget`
// returns undefined — so until these two tests existed, nothing in this branch ever exercised
// a REMOTE upstream, which is exactly how "compaction silently re-resolves the local engine"
// survived eight clean task reviews. The proof shape here is deliberate: the Deps stub has no
// working local engine at all, so a re-resolution cannot quietly succeed and pass anyway.

test('compactConversation: an explicitly-passed REMOTE upstream is used verbatim — the summarization goes to the linked host and the local engine is never consulted', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'rig/Qwen3-30B-A3B' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with enough real content to count as real tokens`)

    let calledUrl: string | undefined
    let calledBody: string | undefined
    let authHeader: string | null | undefined
    const fetchImpl: typeof fetch = (async (url: unknown, init: RequestInit | undefined) => {
      calledUrl = String(url)
      calledBody = init?.body as string
      // link-proxy.ts's linkHeaders() builds a real Headers instance and proxyStream spreads
      // the init through unchanged, so this is a Headers, not a plain object.
      authHeader = (init?.headers as Headers | undefined)?.get('X-TurboLLM-Auth') ?? null
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Remote summary.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    // noLocalEngineDeps throws from manager/registry/modelRouter — so this can only succeed if
    // the passed-in upstream was used INSTEAD of a fresh (always-local) resolution.
    const result = await compactConversation(noLocalEngineDeps(db), conv.id, { upstream: remoteUpstream(200), fetchImpl })

    assert.equal(result.summary, 'Remote summary.')
    // Went out over the Turbo Link façade (link-proxy.ts's buildUpstream), not a local engine URL.
    assert.equal(calledUrl, 'https://rig.example/api/link/v1/chat/completions')
    assert.equal(authHeader, 'link-token-abc') // ...carrying the link token, i.e. the real remote transport
    // ...and asked for the HOST's model, not whatever this machine has loaded.
    assert.equal((JSON.parse(calledBody!) as { model: string }).model, 'Qwen3-30B-A3B')
    // The cut persists exactly as it does on the local path.
    const updated = db.getConversation(conv.id)!
    assert.equal(updated.compactionSummary, 'Remote summary.')
    assert.equal(updated.compactionUpToMessageId, result.upToMessageId)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('maybeAutoCompact: hands the upstream it was given straight through — a Turbo Link turn auto-compacts on its own host, never re-resolving locally', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'rig/Qwen3-30B-A3B' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with real content`)
    db.addMessage(conv.id, 'assistant', 'reply', { stats: { ctxUsed: 9000, ctxMax: 10000 } })
    const fresh = db.getConversation(conv.id, true)!

    let calledUrl: string | undefined
    const fetchImpl: typeof fetch = (async (url: unknown) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Remote summary.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const d = noLocalEngineDeps(db)
    ;(d as unknown as { __fetchImplForTest?: typeof fetch }).__fetchImplForTest = fetchImpl
    await maybeAutoCompact(d, conv.id, fresh, remoteUpstream(200), new AbortController().signal, async () => {})

    assert.equal(calledUrl, 'https://rig.example/api/link/v1/chat/completions')
    // maybeAutoCompact swallows every failure, so the DB write is the only honest proof it did
    // not fall through to the local path (which would have thrown and been silently absorbed).
    assert.equal(db.getConversation(conv.id)!.compactionSummary, 'Remote summary.')
    assert.equal(fresh.compactionSummary, 'Remote summary.')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ── the turn's Stop reaches both halves of the wait (final-review I-3) ───────────────────

test('compactConversation: the gate acquire carries the caller\'s abort signal and a bounded timeout, and the slot is always released', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with real content`)
    const acquired: Array<{ priority: string; opts?: { signal?: AbortSignal; timeoutMs?: number } }> = []
    let releases = 0
    // fakeDeps sets `gate: undefined`, so no test used to reach the acquire at all — this stub
    // is what makes the acquire's arguments observable.
    const d = fakeDeps(db, 200)
    ;(d as unknown as { gate: unknown }).gate = {
      acquire: async (priority: 'fg' | 'bg', opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
        acquired.push({ priority, opts })
        return () => { releases++ }
      },
    }
    const ac = new AbortController()
    await compactConversation(d, conv.id, { upstream: localUpstream(200), signal: ac.signal, fetchImpl: jsonFetch({ choices: [{ message: { content: 'Summary text.' } }] }) })

    assert.equal(acquired.length, 1)
    assert.equal(acquired[0].priority, 'bg')          // never fg — compaction is background work
    assert.equal(acquired[0].opts?.signal, ac.signal) // Stop can give up on a queued wait
    assert.equal(acquired[0].opts?.timeoutMs, 60_000) // NOT gate.ts's 180s default
    assert.equal(releases, 1)                         // released even though the call succeeded through a finally
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('compactConversation: an aborted caller signal reaches the summarization call itself, and nothing is persisted', async () => {
  const root = makeTmpRoot()
  const db = new ConversationStore(root)
  try {
    const conv = db.createConversation({ title: 'Test', modelKey: 'local-model' })
    for (let i = 0; i < 8; i++) db.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `message ${i} with real content`)
    // A real fetch rejects on an aborted signal; the fakes elsewhere in this file ignore it, so
    // this one checks it explicitly — that check IS the assertion.
    const fetchImpl: typeof fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      if ((init?.signal as AbortSignal | undefined)?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'should never be reached' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(() => compactConversation(fakeDeps(db, 200), conv.id, { upstream: localUpstream(200), signal: ac.signal, fetchImpl }))
    assert.equal(db.getConversation(conv.id)!.compactionSummary, undefined)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
