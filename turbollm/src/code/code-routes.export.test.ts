// Route-level tests for GET /api/v1/code/sessions/:id/export (Phase 3 test gap, spec 16 §5) —
// session-export.test.ts already covers the pure serializer/filename functions in isolation
// (19 tests); these exercise the actual HTTP route on a real Hono app + real ConversationStore
// (temp-dir SQLite, same discipline as db.timeline.test.ts / gateway.errors.test.ts's real-app
// testing), which the serializer-only tests can't reach: headers, status codes, and how the route
// composes with real DB state (a /clear'd session, an "active" run).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConversationStore } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { Deps } from '../deps'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** registerCodeRoutes's export handler only ever touches `d.db` (confirmed by reading the route:
 *  `const md = serializeCodeSessionMarkdown(run, conv); ...`, no reference to `d.manager`/
 *  `d.registry`/etc.), and CodeRunManager's constructor + reconcileOnStartup() (run once, eagerly,
 *  at registerCodeRoutes() time) likewise only touch `d.db` — so a real ConversationStore plus an
 *  unsound cast for the rest of Deps is sufficient, same minimal-double approach
 *  gateway.errors.test.ts already uses for a different route module. */
function makeApp(db: ConversationStore): { app: Hono } {
  const app = new Hono()
  const d = { db, version: 'test' } as unknown as Deps
  registerCodeRoutes(app, d)
  return { app }
}

function seedSession(db: ConversationStore, opts: { title?: string; repoRoot?: string } = {}) {
  const conv = db.createConversation({ kind: 'code', modelKey: 'model-a' })
  const run = db.createAgentRun({ convId: conv.id, title: opts.title ?? 'Fix the login bug', allowedTools: [], repoRoot: opts.repoRoot })
  return { conv, run }
}

test('GET .../export: 200 with real Content-Disposition/Content-Type headers and a Markdown body', async () => {
  const db = new ConversationStore(tmp('tllm-export-route-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db)
  db.addMessage(conv.id, 'user', 'Add a health check endpoint.')

  const res = await app.request(`/api/v1/code/sessions/${run.id}/export`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Type'), 'text/markdown; charset=utf-8')
  const disposition = res.headers.get('Content-Disposition') ?? ''
  assert.match(disposition, /^attachment; filename="Fix-the-login-bug-\d{4}-\d{2}-\d{2}\.md"$/)
  const body = await res.text()
  assert.match(body, /^# Fix the login bug/)
  assert.match(body, /Add a health check endpoint\./)
})

test('GET .../export: 404 for a session that does not exist', async () => {
  const db = new ConversationStore(tmp('tllm-export-route-'))
  const { app } = makeApp(db)

  const res = await app.request('/api/v1/code/sessions/does-not-exist/export')
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'not_found')
})

test('GET .../export?format=html: 400 unsupported_format (HTML export is not built yet)', async () => {
  const db = new ConversationStore(tmp('tllm-export-route-'))
  const { app } = makeApp(db)
  const { run } = seedSession(db)

  const res = await app.request(`/api/v1/code/sessions/${run.id}/export?format=html`)
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'unsupported_format')
})

test('GET .../export: succeeds even while the run\'s persisted status is "running" — the route has no active-run guard', async () => {
  // NOTE on scope: this drives the DB-persisted `status` column, not CodeRunManager's own
  // in-memory isActive() tracking (that state lives in a Map private to the CodeRunManager
  // instance registerCodeRoutes constructs internally — not independently injectable from a
  // route-level test without changing registerCodeRoutes's signature, out of scope here). What
  // this DOES prove: the export handler's source has zero reference to `runs`/`isActive` at all
  // (confirmed by reading code-routes.ts — unlike /compact, /clear, /revert, which all check
  // `runs.isActive(id)` before proceeding) — a persisted 'running' status is the closest
  // reachable proxy for "this session looks like it's mid-turn" without that deeper seam.
  const db = new ConversationStore(tmp('tllm-export-route-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db)
  db.addMessage(conv.id, 'user', 'Do the thing.')
  db.updateAgentRun(run.id, { status: 'running' })

  const res = await app.request(`/api/v1/code/sessions/${run.id}/export`)
  assert.equal(res.status, 200)
})

test('GET .../export on a /clear\'d session EXCLUDES the cleared history — matches what the user sees (v34/ADR-261, the export-leak fix)', async () => {
  // Answered product question (spec 16 §5 flagged it as undecided; the founder decided /clear should
  // truly clear). Task #31 made /clear DEACTIVATE (is_active=0) its prefix — the same mechanism
  // /revert uses — instead of only setting a display cursor. getMessages() (what getConversation(id,
  // true) and this export route read) filters is_active=1, so cleared history is now omitted at the
  // source: export matches the transcript, no longer leaking what the user hid. Drives the REAL
  // /clear route end-to-end (not just the DB helper), so the whole path is covered.
  const db = new ConversationStore(tmp('tllm-export-route-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db)
  db.addMessage(conv.id, 'user', 'An early attempt the user later cleared away.')

  const clearRes = await app.request(`/api/v1/code/sessions/${run.id}/clear`, { method: 'POST' })
  assert.equal(clearRes.status, 200)
  // A NEW turn after the clear — the visible tail export SHOULD include (and proof the clear only
  // deactivated the earlier prefix, not everything).
  db.addMessage(conv.id, 'user', 'The visible follow-up after /clear.')

  const res = await app.request(`/api/v1/code/sessions/${run.id}/export`)
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /The visible follow-up after \/clear\./, 'the visible post-clear tail is present')
  assert.doesNotMatch(body, /An early attempt the user later cleared away\./, 'the cleared pre-clear history is NO LONGER exported — the leak is fixed')
})

test('POST .../resume after a /clear brings the cleared history back into the export', async () => {
  const db = new ConversationStore(tmp('tllm-export-route-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db)
  db.addMessage(conv.id, 'user', 'A message that gets cleared then resumed.')

  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}/clear`, { method: 'POST' })).status, 200)
  assert.doesNotMatch(await (await app.request(`/api/v1/code/sessions/${run.id}/export`)).text(), /A message that gets cleared then resumed\./)

  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}/resume`, { method: 'POST' })).status, 200)
  assert.match(await (await app.request(`/api/v1/code/sessions/${run.id}/export`)).text(), /A message that gets cleared then resumed\./, 'resume reactivated the cleared message — it is exportable again')
})

// ── /clear <-> /revert mutual exclusion (final-gate coherence check, task #30) ───────────────────
// Both now deactivate messages (is_active=0): /clear a PREFIX (v34), /revert a SUFFIX (v33). They
// are two independent resumable hidden-states that must never overlap — each route refuses to start
// while the OTHER is pending, so /resume is never ambiguous about which one it's undoing. These
// route-level tests pin that invariant end-to-end (the guards existed but weren't route-tested).

test('POST .../revert is refused (409 session_cleared) while the session is /clear\'d', async () => {
  const db = new ConversationStore(tmp('tllm-clear-revert-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db, { repoRoot: '/repo' })
  db.addMessage(conv.id, 'user', 'first')
  db.addMessage(conv.id, 'assistant', 'reply')
  const target = db.addMessage(conv.id, 'user', 'second')

  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}/clear`, { method: 'POST' })).status, 200)
  const res = await app.request(`/api/v1/code/sessions/${run.id}/revert`, { method: 'POST', body: JSON.stringify({ messageId: target.id }), headers: { 'Content-Type': 'application/json' } })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { error?: { code?: string } }).error?.code, 'session_cleared')
})

test('POST .../clear is refused (409 session_reverted) while the session has a pending /revert', async () => {
  const db = new ConversationStore(tmp('tllm-clear-revert-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db, { repoRoot: '/repo' })
  db.addMessage(conv.id, 'user', 'first')
  db.addMessage(conv.id, 'assistant', 'reply')
  const target = db.addMessage(conv.id, 'user', 'second')
  db.addMessage(conv.id, 'assistant', 'second reply')

  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}/revert`, { method: 'POST', body: JSON.stringify({ messageId: target.id }), headers: { 'Content-Type': 'application/json' } })).status, 200)
  const res = await app.request(`/api/v1/code/sessions/${run.id}/clear`, { method: 'POST' })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { error?: { code?: string } }).error?.code, 'session_reverted')
})

test('POST .../revert while already reverted SUPERSEDES (200, not 409) when reverting further back', async () => {
  const db = new ConversationStore(tmp('tllm-revert-supersede-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db, { repoRoot: '/repo' })
  const first = db.addMessage(conv.id, 'user', 'first')
  db.addMessage(conv.id, 'assistant', 'reply one')
  const second = db.addMessage(conv.id, 'user', 'second')
  db.addMessage(conv.id, 'assistant', 'reply two')
  const third = db.addMessage(conv.id, 'user', 'third')
  db.addMessage(conv.id, 'assistant', 'reply three')

  // First revert — cuts back to 'third'.
  const r1 = await app.request(`/api/v1/code/sessions/${run.id}/revert`, { method: 'POST', body: JSON.stringify({ messageId: third.id }), headers: { 'Content-Type': 'application/json' } })
  assert.equal(r1.status, 200)
  assert.equal(db.getAgentRun(run.id)?.revertedFromMessageId, third.id)

  // Second revert, further back to 'second' — must SUPERSEDE, not 409. 'second' is still
  // is_active=1 (it's before the first cut), so it's exactly the case the UI can actually submit.
  const r2 = await app.request(`/api/v1/code/sessions/${run.id}/revert`, { method: 'POST', body: JSON.stringify({ messageId: second.id }), headers: { 'Content-Type': 'application/json' } })
  assert.equal(r2.status, 200)
  assert.equal(db.getAgentRun(run.id)?.revertedFromMessageId, second.id)

  // 'first' stays active (before both cuts); 'second' and everything after is now deactivated.
  const conv2 = db.getConversation(conv.id, true)!
  const active = new Set((conv2.messages ?? []).map((m) => m.id))
  assert.ok(active.has(first.id))
  assert.ok(!active.has(second.id))
  assert.ok(!active.has(third.id))
})

test('the mutual-exclusion lock releases: /clear → /resume → /revert all succeed in sequence', async () => {
  const db = new ConversationStore(tmp('tllm-clear-revert-'))
  const { app } = makeApp(db)
  const { conv, run } = seedSession(db, { repoRoot: '/repo' })
  db.addMessage(conv.id, 'user', 'first')
  db.addMessage(conv.id, 'assistant', 'reply')
  const target = db.addMessage(conv.id, 'user', 'second')

  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}/clear`, { method: 'POST' })).status, 200)
  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}/resume`, { method: 'POST' })).status, 200)
  // With the clear resolved, a revert is allowed again (proving the guard is a live state, not a
  // permanent lock) — reverting to the now-reactivated 'second' user message.
  const revert = await app.request(`/api/v1/code/sessions/${run.id}/revert`, { method: 'POST', body: JSON.stringify({ messageId: target.id }), headers: { 'Content-Type': 'application/json' } })
  assert.equal(revert.status, 200)
})
