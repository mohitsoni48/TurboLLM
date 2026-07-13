// Code API routes (Phase 1) — a real pi-SDK Code session surface. Mirrors chat-routes.ts
// conventions exactly (err()/body() helpers, an inflight AbortController map, streamSSE, the
// model-loaded 409 guard, the generation-in-flight 409 guard) so the existing frontend SSE
// parser (chat-api.ts) works unchanged.
//
//   POST  /api/v1/code/sessions              → create a session (conv kind:'code' + agent_run)
//   POST  /api/v1/code/sessions/:id/messages → start/queue a turn (daemon-owned; JSON, not SSE)
//   GET   /api/v1/code/sessions/:id/stream   → SSE: (re)connect to a run — replay buffer + live-tail
//   GET   /api/v1/code/sessions              → list sessions, mapped to sidebar rows
//   GET   /api/v1/code/sessions/:id          → one session + its conversation messages
//   PATCH /api/v1/code/sessions/:id/mode     → change auto/plan/ask for the NEXT run
//   POST  /api/v1/code/sessions/:id/compact  → manually summarize history-so-far (blocked while running)
//   POST  /api/v1/code/sessions/:id/stop     → abort the in-flight run + drop the queue
//   (approvals reuse the existing POST /api/v1/conversations/:id/tool-calls/:toolCallId/approve)
//
// Background / reconnectable runs (Task 5): a run's lifecycle is owned by CodeRunManager (the
// daemon), NOT by the HTTP request. POST /messages starts or queues a turn and returns
// immediately; the actual event stream is a SEPARATE GET /stream the client can open, close
// (navigate away), and reopen without ever aborting the run. See code-run-manager.ts.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'
import type { AgentRun } from '../chat/db'
import { CodeRunManager } from './code-run-manager'
import { compactCodeSession } from './code-session'
import { revertFileEdits } from './revert'
import type { CodeMode } from './persona'

type S = 200 | 201 | 202 | 400 | 404 | 409 | 500
function err(c: Context, s: S, code: string, msg: string) { return c.json({ error: { code, message: msg } }, s) }
async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

const VALID_MODES = new Set<CodeMode>(['auto', 'plan', 'ask'])

/** Formats attached context-file paths (the composer's "Add context" file picker) as a prompt
 *  instruction — PATHS only, never fetched/inlined content: the agent already has a real `read`
 *  tool, containment-checked the exact same way any other read call is, so pointing it at the
 *  file is simpler and strictly safer than a second, separate content-fetch path here. Returns
 *  '' when there are none, so it's a no-op to prepend unconditionally. */
export function contextFilesBlock(paths: string[] | undefined): string {
  const clean = (paths ?? []).map((p) => p.trim()).filter(Boolean)
  if (clean.length === 0) return ''
  return `Context file(s) the user attached — read them if relevant before proceeding:\n${clean.map((p) => `- ${p}`).join('\n')}\n\n`
}

/** agent_runs.status → sidebar SessionStatus (plan §2). 'merged' is unused in Phase 1. */
export function toSessionStatus(status: AgentRun['status']): 'merged' | 'review' | 'done' | 'aborted' {
  switch (status) {
    case 'done': return 'done'
    case 'failed':
    case 'cancelled':
    case 'interrupted': return 'aborted'
    case 'queued':
    case 'running':
    default: return 'review'
  }
}

/** Relative "2h ago" label for the sidebar. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/** Serialize a run to the sidebar row shape (MockCodeSession), plus a few extra fields the
 *  workspace view needs. Extra fields are harmless to the sidebar renderer. */
function toSidebarRow(run: AgentRun) {
  return {
    id: run.id,
    convId: run.convId,
    title: run.title,
    status: toSessionStatus(run.status),
    branch: run.repoBranch ?? '',
    when: relativeTime(run.createdAt),
    add: run.linesAdded ?? 0,
    del: run.linesRemoved ?? 0,
    mode: undefined as string | undefined, // filled from conv below when available
    createdAt: run.createdAt,
    repoRoot: run.repoRoot ?? '',
    error: run.error,
    archivedAt: run.archivedAt,
    clearedUpToMessageId: run.clearedUpToMessageId,
  }
}

export function registerCodeRoutes(app: Hono, d: Deps): void {
  const { db } = d

  // The daemon-owned run registry for this app instance (one per createApp). Owns each Code
  // run's AbortController + ring buffer, independent of any HTTP request. On startup, mark any
  // run left 'running'/'queued' by a previous (now-dead) process as interrupted.
  const runs = new CodeRunManager(d)
  runs.reconcileOnStartup()

  // ── create a session ─────────────────────────────────────────────────────────
  app.post('/api/v1/code/sessions', async (c) => {
    const b = await body<{
      repoRoot?: string; repoBranch?: string; modelKey?: string; mode?: string; task?: string
      useWorktree?: boolean; worktreeBranch?: string; worktreeBase?: string; contextFiles?: string[]
    }>(c)
    const repoRoot = (b.repoRoot ?? '').trim()
    const task = (b.task ?? '').trim()
    const mode = (b.mode ?? 'auto') as CodeMode
    if (!repoRoot) return err(c, 400, 'invalid_input', 'repoRoot is required.')
    if (!task) return err(c, 400, 'invalid_input', 'A task description is required.')
    if (!VALID_MODES.has(mode)) return err(c, 400, 'invalid_input', 'mode must be one of: auto, plan, ask.')

    const conv = db.createConversation({ kind: 'code', modelKey: b.modelKey })
    // Record the per-session mode on the conversation (reuses the agent_mode column).
    db.setConversationMode(conv.id, mode)
    const run = db.createAgentRun({
      convId: conv.id,
      title: task.slice(0, 60),
      allowedTools: [],
      repoRoot,
      repoBranch: b.repoBranch,
      useWorktree: b.useWorktree,        // captured; NOT acted on in Phase 1 (fast-follow)
      worktreeBranch: b.worktreeBranch,  // captured; NOT acted on in Phase 1
      worktreeBase: b.worktreeBase,      // captured; NOT acted on in Phase 1
    })
    // Seed the task as the first user message so re-opening the session shows it. Any attached
    // context-file paths are stored as textAttachments (shown as chips) — POST /messages folds
    // them into the actual prompt when this seeded task's turn runs (see contextFilesBlock).
    db.addMessage(conv.id, 'user', task, { textAttachments: b.contextFiles })
    return c.json({ sessionId: run.id, convId: conv.id }, 201)
  })

  // ── launchpad "Coding activity" stats ─────────────────────────────────────────
  // Real numbers (db.ts's codeStats) — replaces code-mock.ts's always-fake CODE_STATS.
  app.get('/api/v1/code/stats', (c) => {
    const q = c.req.query('range')
    const range = q === '30d' || q === '7d' ? q : 'all'
    return c.json(db.codeStats(range))
  })

  // ── list sessions (sidebar) ───────────────────────────────────────────────────
  // ?filter=active|archived|all — default 'active' (archived sessions hidden unless asked
  // for), mirrors the founder-requested All/Active/Archived sidebar filter.
  app.get('/api/v1/code/sessions', (c) => {
    const filter = (c.req.query('filter') ?? 'active') as 'active' | 'archived' | 'all'
    // Only code-kind runs — a run maps to a code conversation. Filter by the conv kind.
    const runs = db.listAgentRuns().filter((r) => {
      const conv = db.getConversation(r.convId)
      if (conv?.kind !== 'code') return false
      if (filter === 'active') return !r.archivedAt
      if (filter === 'archived') return !!r.archivedAt
      return true
    })
    const rows = runs.map((r) => {
      const row = toSidebarRow(r)
      row.mode = db.getConversation(r.convId)?.agentMode
      return row
    })
    return c.json({ sessions: rows })
  })

  // ── one session (for re-opening) ──────────────────────────────────────────────
  app.get('/api/v1/code/sessions/:id', (c) => {
    const run = db.getAgentRun(c.req.param('id'))
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const conv = db.getConversation(run.convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Session conversation not found.')
    return c.json({
      session: { ...toSidebarRow(run), mode: conv.agentMode },
      conversation: conv,
      doc: db.getRunDoc(run.id),
      // Whether a run is live in THIS daemon right now (not merely the persisted status, which
      // can be a stale 'running' from a crashed process — reconcileOnStartup fixes those, but
      // this is the authoritative signal the frontend uses to decide whether to reconnect).
      running: runs.isActive(run.id),
      // Tasks waiting behind the active turn — the server-side message queue, so its chips
      // survive a page reload / reconnect.
      queued: runs.queued(run.id),
    })
  })

  // ── change mode (auto/plan/ask) — live for the ask-approval gate ──────────────
  // A narrow, single-purpose update — kept separate from chat-routes.ts's generic
  // conversation PATCH for the same reason that route's own /folder split exists
  // (see its comment): a growing catch-all body vs. one clear-purpose route.
  // Writing the column here is the whole change: the /messages handler reads
  // `conv.agentMode` fresh to pick a run's START mode, AND runCodeSession's
  // tool_call hook re-reads it fresh on every tool call, so an auto↔ask switch
  // takes effect LIVE within a run already in flight (the founder wanted mode
  // "always switchable"). One structural exception: plan mode's toolset is baked
  // at session creation (mutating tools aren't registered), so switching TO/FROM
  // plan only takes effect on the NEXT run — see code-session.ts's tool_call hook.
  app.patch('/api/v1/code/sessions/:id/mode', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const b = await body<{ mode?: string }>(c)
    const mode = (b.mode ?? '') as CodeMode
    if (!VALID_MODES.has(mode)) return err(c, 400, 'invalid_input', 'mode must be one of: auto, plan, ask.')
    db.setConversationMode(run.convId, mode)
    return c.json({ ok: true, mode })
  })

  // ── rename ─────────────────────────────────────────────────────────────────
  // A sibling of the /mode route above, not a merge into it — same one-clear-purpose
  // rationale (see that route's comment): title and mode are unrelated concerns that
  // happen to both live on agent_runs, and a session's title is unrelated to what a
  // NEXT run does, so it doesn't belong folded into a route whose whole contract is
  // "affects the next run's behavior". Mirrors chat's conversation-rename UX exactly.
  app.patch('/api/v1/code/sessions/:id/title', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const b = await body<{ title?: string }>(c)
    const title = (b.title ?? '').trim()
    if (!title) return err(c, 400, 'invalid_input', 'title is required.')
    db.updateAgentRun(id, { title })
    return c.json({ ok: true, title })
  })

  // ── archive / unarchive ────────────────────────────────────────────────────
  // A session stays fully intact when archived (repo/messages/everything) — this only sets
  // archived_at, which the sidebar list (GET /sessions?filter=) uses to hide it by default.
  // Reuses the SAME agent_runs.archived_at column the older Hitman/background-agent layer
  // added — this is a genuinely separate concern (a Code session isn't a Hitman contract),
  // but the column's semantics ("hidden from the default list, not deleted") line up exactly,
  // so a second column would just be the same bit duplicated.
  app.post('/api/v1/code/sessions/:id/archive', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const b = await body<{ archived?: boolean }>(c)
    const archived = b.archived !== false
    // Only ARCHIVING is blocked while a run is active — same hazard as delete (hiding a
    // still-executing session from the default 'Active' filter makes it easy to lose track
    // of, even though the run itself isn't harmed). Unarchiving is always harmless, so it's
    // never blocked.
    if (archived && runs.isActive(id)) return err(c, 409, 'run_active', 'Stop the current run before archiving this session.')
    db.setAgentRunArchived(id, archived)
    return c.json({ ok: true, archived })
  })

  // ── delete ─────────────────────────────────────────────────────────────────
  // Permanent — messages, the working doc, and the agent_run + conversation rows are all
  // gone (db.deleteCodeSession). Blocked while a run is active so a live turn never deletes
  // out from under itself; the client is expected to stop the run first (or the user retries).
  app.delete('/api/v1/code/sessions/:id', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop the current run before deleting this session.')
    db.deleteCodeSession(id)
    return c.json({ ok: true })
  })

  // ── manual /compact ────────────────────────────────────────────────────────
  // Summarizes history-so-far into one summary (code-session.ts's compactCodeSession) so future
  // turns replay the summary instead of every raw message. Blocked while a run is active — it's
  // a separate, tool-less pi session so it wouldn't corrupt anything, but compacting history
  // out from under a turn that's mid-flight against the OLD history is confusing UX regardless.
  //
  // ALSO blocked while the session is /clear'd (found by review, not by hand): resolveEffectiveHistory
  // restricts a cleared session to only the post-clear messages, so compacting here would summarize
  // ONLY those and persist a new compactionUpToMessageId past the clear point — a later /resume
  // would then fall through to that (partial) compaction instead of the full raw history, silently
  // and permanently losing everything before the clear despite /resume's "restores exactly as it
  // was" contract. Requiring /resume before /compact keeps that contract airtight: compaction only
  // ever sees full history, and resume only ever undoes a clear, never a compaction that happened
  // to run while cleared.
  app.post('/api/v1/code/sessions/:id/compact', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before compacting.')
    if (run.clearedUpToMessageId) return err(c, 409, 'session_cleared', 'Resume this session before compacting — compacting a cleared session would lose the hidden history.')
    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) return err(c, 409, 'model_not_loaded', 'Load a model first.')
    const b = await body<{ instructions?: string }>(c)
    try {
      const result = await compactCodeSession({
        d, convId: run.convId, sessionId: id, repoRoot: run.repoRoot,
        customInstructions: b.instructions?.trim() || undefined,
      })
      return c.json({ ok: true, ...result })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (message === 'nothing_to_compact') return err(c, 400, 'nothing_to_compact', 'Nothing to compact yet — history is already short enough.')
      if (message === 'session_cleared') return err(c, 409, 'session_cleared', 'Resume this session before compacting — compacting a cleared session would lose the hidden history.')
      return err(c, 500, 'compact_failed', message)
    }
  })

  // ── /clear + /resume ───────────────────────────────────────────────────────
  // /clear hides the conversation so far (a blank slate for the model AND the transcript UI)
  // WITHOUT touching the session's repo/worktree/branch or deleting anything — it just sets
  // cleared_upto_message_id to the current last message, which resolveEffectiveHistory
  // (code-session.ts) and the frontend transcript both cut at. /resume un-hides it by setting
  // that marker back to null — the messages were never deleted, so resuming restores the
  // conversation exactly as it was. Both blocked while a run is active, same rationale as
  // /compact: clearing/resuming out from under a turn mid-flight against the OLD history frame
  // is confusing regardless of whether it would technically corrupt anything.
  app.post('/api/v1/code/sessions/:id/clear', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before clearing.')
    const conv = db.getConversation(run.convId, true)
    const lastMsg = (conv?.messages ?? []).at(-1)
    if (!lastMsg) return err(c, 400, 'nothing_to_clear', 'Nothing to clear yet.')
    if (run.clearedUpToMessageId === lastMsg.id) return err(c, 400, 'nothing_to_clear', 'Already cleared up to the latest message.')
    db.setClearedUpToMessageId(id, lastMsg.id)
    return c.json({ ok: true, clearedUpToMessageId: lastMsg.id })
  })

  app.post('/api/v1/code/sessions/:id/resume', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before resuming.')
    if (!run.clearedUpToMessageId) return err(c, 400, 'not_cleared', 'This session has not been cleared.')
    db.setClearedUpToMessageId(id, null)
    return c.json({ ok: true })
  })

  // ── revert to a user message ──────────────────────────────────────────────────
  // Rewinds the transcript to just before `messageId` (reusing the SAME clearedUpToMessageId
  // mechanism /clear + /resume already use — nothing is deleted, /resume still un-hides it) and
  // returns that message's original text so the caller can refill the composer with it.
  // Optionally (revertFiles) also reverse-applies every 'edit' tool call's stored patch for the
  // discarded messages, walking any touched file back to its pre-edit content — see revert.ts.
  app.post('/api/v1/code/sessions/:id/revert', async (c) => {
    const id = c.req.param('id')
    const b = await body<{ messageId?: string; revertFiles?: boolean }>(c)
    const messageId = (b.messageId ?? '').trim()
    if (!messageId) return err(c, 400, 'invalid_input', 'messageId is required.')

    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before reverting.')
    const conv = db.getConversation(run.convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Session conversation not found.')

    const messages = conv.messages ?? []
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return err(c, 404, 'not_found', 'Message not found.')
    if (messages[idx].role !== 'user') return err(c, 400, 'invalid_input', 'Can only revert to a user message.')
    if (idx === 0) return err(c, 400, 'invalid_input', 'This is the first message in the session — nothing before it to revert to.')

    const cutMessage = messages[idx - 1]
    const revertText = messages[idx].content

    let revertedFiles: string[] = []
    let failedFiles: string[] = []
    if (b.revertFiles) {
      const result = revertFileEdits(messages.slice(idx), run.repoRoot)
      revertedFiles = result.reverted
      failedFiles = result.failed
    }

    db.setClearedUpToMessageId(id, cutMessage.id)
    return c.json({ ok: true, clearedUpToMessageId: cutMessage.id, revertText, revertedFiles, failedFiles })
  })

  // ── stop the in-flight run (+ drop the queue) ─────────────────────────────────
  app.post('/api/v1/code/sessions/:id/stop', (c) => {
    const id = c.req.param('id')
    runs.stop(id)
    return c.json({ ok: true })
  })

  // ── start / queue a turn (daemon-owned; returns JSON, NOT a stream) ────────────
  // This ONLY starts (or queues) the run in CodeRunManager and returns immediately. The event
  // stream is fetched separately via GET /stream, so the run's lifetime is decoupled from any
  // one HTTP request — closing the tab or dropping the POST connection never aborts it.
  //
  // If a run is already active for the session, the new turn is QUEUED server-side (no 409):
  // that is how a follow-up submitted mid-run survives a disconnect and still fires in order.
  app.post('/api/v1/code/sessions/:id/messages', async (c) => {
    const id = c.req.param('id')
    const b = await body<{ content?: string; promptOverride?: string; contextFiles?: string[]; thinkingBudget?: number }>(c)

    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const conv = db.getConversation(run.convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Session conversation not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')

    // Fail fast with a clear message if there is no engine to run against right now. (A turn
    // that queues while a model is loaded but is then unloaded before it runs fails cleanly
    // inside the run instead — see code-run-manager.ts's turn executor.)
    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) return err(c, 409, 'model_not_loaded', 'Load a model first.')
    if (!d.manager.target()) return err(c, 409, 'model_not_loaded', 'Engine not running.')

    // The task for this turn: an explicit follow-up body wins; otherwise the last user message
    // (the seeded task on the first run).
    const followUp = (b.content ?? '').trim()
    let userMsgId: string
    let task: string
    if (followUp) {
      userMsgId = db.addMessage(run.convId, 'user', followUp, { textAttachments: b.contextFiles }).id
      // promptOverride lets the CALLER separate "what's stored/shown" from "what's actually
      // prompted this turn" — the founder's own literal message must never be silently rewritten
      // (see CodeSessionScreen.tsx's skill-invocation picker, the one caller of this today), but
      // the model still needs an explicit nudge to invoke a picked skill. Future turns' history
      // replay always uses the STORED message (followUp), never the override, so past turns read
      // back as what the user actually said, not the synthetic nudge that steered that one turn.
      task = contextFilesBlock(b.contextFiles) + ((b.promptOverride ?? '').trim() || followUp)
    } else {
      const lastUser = (conv.messages ?? []).filter((m) => m.role === 'user').at(-1)
      if (!lastUser) return err(c, 400, 'no_task', 'No task to run.')
      userMsgId = lastUser.id
      task = contextFilesBlock(lastUser.textAttachments) + lastUser.content
    }

    const { queued } = runs.enqueue(id, { convId: run.convId, repoRoot: run.repoRoot, task, userMsgId, thinkingBudget: b.thinkingBudget })
    return c.json({ ok: true, queued, userMessageId: userMsgId }, 202)
  })

  // ── (re)connect to a session's run stream (SSE) ───────────────────────────────
  // A GET the client opens on load (when a run is live) OR after POSTing a turn, and reopens
  // after any drop. `fromSeq` is the last event seq the client already saw; the manager replays
  // buffer.since(fromSeq) then live-tails. Disconnecting only closes this subscriber — the run
  // keeps executing server-side. When the session goes idle the stream ends and the client falls
  // back to the DB-persisted transcript (GET /sessions/:id).
  app.get('/api/v1/code/sessions/:id/stream', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')

    const fromSeqRaw = Number.parseInt(c.req.query('fromSeq') ?? '', 10)
    const fromSeq = Number.isFinite(fromSeqRaw) && fromSeqRaw >= 0 ? fromSeqRaw : 0

    return streamSSE(c, async (stream) => {
      const sub = runs.subscribe(id, fromSeq)
      stream.onAbort(() => { sub.close() })

      // Synthesize a `meta` frame for the in-flight turn up front, so a reconnect whose real
      // meta has aged out of the ring buffer still learns the active assistant message id
      // (idempotent if the buffer replays the real one too).
      const meta = runs.activeMeta(id)
      if (meta) await stream.writeSSE({ event: 'meta', data: JSON.stringify(meta) })
      // Current server-side queue snapshot, so the client's "Queued" chips are correct on connect.
      await stream.writeSSE({ event: 'queue', data: JSON.stringify({ queued: runs.queued(id) }) })

      for await (const ev of sub) {
        // The `id:` field carries the seq so the client can reconnect with ?fromSeq=<last id>.
        await stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) })
      }
    })
  })
}
