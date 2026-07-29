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
import type { AgentRun, Message } from '../chat/db'
import { CodeRunManager, type SteerKind } from './code-run-manager'
import { compactCodeSession, disposeLspClientsForConv } from './code-session'
import { revertFileEdits } from './revert'
import { codeSessionExportFilename, serializeCodeSessionMarkdown } from './session-export'
import { commitGitChanges, getGithubCompareUrl, getGitStatus, pushGitBranch } from './git-actions'
import { runShellCommand, shellContextText } from './code-shell'
import { agentsMdPresence } from './persona'
import type { CodeMode } from './persona'
import { sessionAuth } from './session-auth'

type S = 200 | 201 | 202 | 400 | 404 | 409 | 500
function err(c: Context, s: S, code: string, msg: string) { return c.json({ error: { code, message: msg } }, s) }
async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

const VALID_MODES = new Set<CodeMode>(['auto', 'plan', 'ask'])

/** Pure validation for POST .../revert (founder bug report, 2026-07-17; corrected same day after
 *  live-testing against a real 40-message session — see the route below for the full story): is
 *  `messageId` a valid revert target in `messages`? Exported for direct unit testing without a
 *  live route/DB/CodeRunManager. Deliberately does NOT decide any cut point — a revert deactivates
 *  (is_active=0) `messageId` and everything after it (ConversationStore.deactivateMessagesFrom),
 *  which correctly discards the reverted range while leaving everything BEFORE it untouched,
 *  unlike the old clearedUpToMessageId-cursor approach this replaces. */
export function resolveRevertCut(
  messages: Message[],
  messageId: string,
): { ok: true; revertText: string } | { ok: false; error: 'not_found' | 'not_a_user_message' | 'no_earlier_message' } {
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx === -1) return { ok: false, error: 'not_found' }
  if (messages[idx].role !== 'user') return { ok: false, error: 'not_a_user_message' }
  if (idx === 0) return { ok: false, error: 'no_earlier_message' }
  return { ok: true, revertText: messages[idx].content }
}

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
    running: undefined as boolean | undefined, // filled from CodeRunManager below when available
    createdAt: run.createdAt,
    repoRoot: run.repoRoot ?? '',
    codeAgent: run.codeAgent ?? 'turbollm',
    error: run.error,
    archivedAt: run.archivedAt,
    clearedUpToMessageId: run.clearedUpToMessageId,
    revertedFromMessageId: run.revertedFromMessageId,
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
    // Snapshot the global "Code agent" default (config.ts's code.defaultAgent) onto this run —
    // the ONE moment it's read; the session never re-reads it, same immutability as repoRoot.
    const codeAgent = d.store.snapshot().code.defaultAgent
    const run = db.createAgentRun({
      convId: conv.id,
      title: task.slice(0, 60),
      allowedTools: [],
      repoRoot,
      repoBranch: b.repoBranch,
      useWorktree: b.useWorktree,        // captured; NOT acted on in Phase 1 (fast-follow)
      worktreeBranch: b.worktreeBranch,  // captured; NOT acted on in Phase 1
      worktreeBase: b.worktreeBase,      // captured; NOT acted on in Phase 1
      codeAgent,
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
    const agentRuns = db.listAgentRuns().filter((r) => {
      const conv = db.getConversation(r.convId)
      if (conv?.kind !== 'code') return false
      if (filter === 'active') return !r.archivedAt
      if (filter === 'archived') return !!r.archivedAt
      return true
    })
    const rows = agentRuns.map((r) => {
      const row = toSidebarRow(r)
      row.mode = db.getConversation(r.convId)?.agentMode
      // Sidebar's own liveness signal (ADR-256) — same authoritative check the detail route
      // uses below, so a background session (tab not open) still shows as running.
      row.running = runs.isActive(r.id)
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
      // The active turn's current step checklist (ADR-255), so a reopened session shows live
      // progress immediately without waiting for the next update_todos frame. [] when none.
      todos: runs.todos(run.id),
      // Whether an AGENTS.md is actually loaded for this session (ADR-262's loaded-resources
      // header) — project (<repoRoot>/AGENTS.md) and/or global (~/.turbollm/agents.md). Computed
      // with the SAME lookup persona.ts injects into the prompt, so "shown as loaded" == "actually
      // fed to the model". Both false when the session has no repoRoot.
      hasAgentsMd: run.repoRoot
        ? agentsMdPresence(
          run.repoRoot,
          d.store.dir(),
          d.store.snapshot().code.agentsMdProjectCandidates,
          d.store.snapshot().code.agentsMdGlobalCandidates,
        )
        : { project: false, global: false },
    })
  })

  // ── export (Phase 3, ADR-251) ─────────────────────────────────────────────────
  // GET /api/v1/code/sessions/:id/export?format=markdown — Markdown-only for this pass (HTML is
  // a spec-15-§5 fast-follow; session-export.ts's serializer is written so that fast-follow can
  // reuse this same Markdown through the app's existing renderer instead of a second serializer).
  // Deliberately NOT blocked on an active run (unlike /compact, /archive, /delete above) —
  // exporting mid-generation is safe: this only reads what's already persisted in
  // `conv.messages`, so an in-flight turn's not-yet-saved content is naturally just absent from
  // the export rather than an error case to guard against.
  app.get('/api/v1/code/sessions/:id/export', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const conv = db.getConversation(run.convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Session conversation not found.')
    const format = c.req.query('format') === 'html' ? 'html' : 'markdown'
    if (format === 'html') return err(c, 400, 'unsupported_format', 'HTML export is not available yet — use format=markdown.')

    const md = serializeCodeSessionMarkdown(run, conv)
    const filename = codeSessionExportFilename(run.title, run.createdAt, 'md')
    c.header('Content-Disposition', `attachment; filename="${filename}"`)
    c.header('Content-Type', 'text/markdown; charset=utf-8')
    return c.body(md)
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

  // ── thinking budget (terminal-agent sessions only, ADR-284) ────────────────────
  // For a 'turbollm' session, thinking budget is a per-turn argument the composer sends with
  // each message (CodeSessionScreen.tsx's startCodeRun call) — nothing to PATCH server-side.
  // A terminal-agent session (pi/claude/opencode) has no such turn: the CLI drives its own
  // requests directly against the gateway, so the composer's ThinkingBudgetSlider (rendered by
  // TerminalToolbar.tsx) instead sets a LIVE override here that gateway.ts injects into every
  // subsequent request for this session (session-auth.ts) — takes effect immediately, no CLI
  // restart. -1/omitted = unlimited (no override forced), 0 = off, N>0 = a real token cap.
  app.patch('/api/v1/code/sessions/:id/thinking-budget', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const b = await body<{ tokens?: number }>(c)
    const tokens = typeof b.tokens === 'number' && Number.isFinite(b.tokens) ? Math.floor(b.tokens) : -1
    // -1 (unlimited) is stored as "no override" — sessionAuth's getThinkingBudgetForToken
    // returning null already means "don't touch what the CLI sent", the exact same behavior.
    sessionAuth.setThinkingBudget(run.id, tokens === -1 ? null : tokens)
    return c.json({ ok: true, tokens })
  })

  // ── last gateway usage (terminal-agent sessions only, ADR-284) ──────────────────
  // TerminalToolbar.tsx polls this for the same prompt/gen-token + t/s readout the chat
  // composer's footer already shows from lastRealStats — a terminal-agent session has no
  // per-turn message stats of its own (the CLI drives its own requests), so this reads the
  // most recent api_usage row the gateway attributed to this session instead (gateway.ts,
  // session-auth.ts). `usage: null` (not an error) whenever the session hasn't made a
  // gateway request yet — a perfectly normal, common state right after opening the terminal.
  app.get('/api/v1/code/sessions/:id/last-usage', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    return c.json({ usage: db.getLastApiUsageForSession(run.id) })
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
    disposeLspClientsForConv(run.convId)
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
  // WITHOUT touching the session's repo/worktree/branch or deleting anything — it DEACTIVATES
  // (is_active=0) every message up to and including the current last one (v34/ADR-261, the SAME
  // mechanism /revert uses), so getMessages()/getConversation() drop them from every consumer at
  // the source (the model's replay via resolveEffectiveHistory, session export, and the transcript
  // alike); clearedUpToMessageId records the cut so /resume knows the range. /resume REACTIVATES
  // (is_active=1) that same prefix and nulls the marker — the messages were never deleted, so it
  // restores the conversation exactly as it was. Both blocked while a run is active, same rationale
  // as /compact: clearing/resuming out from under a turn mid-flight against the OLD history frame
  // is confusing regardless of whether it would technically corrupt anything. ALSO blocked while
  // reverted (v33) — /clear and revert are two independent resumable hidden-states; stacking them
  // on one session would leave /resume ambiguous about which one it's undoing.
  app.post('/api/v1/code/sessions/:id/clear', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before clearing.')
    if (run.revertedFromMessageId) return err(c, 409, 'session_reverted', 'Resume this session before clearing — it currently has a reverted message pending.')
    const conv = db.getConversation(run.convId, true)
    const lastMsg = (conv?.messages ?? []).at(-1)
    if (!lastMsg) return err(c, 400, 'nothing_to_clear', 'Nothing to clear yet.')
    if (run.clearedUpToMessageId === lastMsg.id) return err(c, 400, 'nothing_to_clear', 'Already cleared up to the latest message.')
    // Real deactivation (v34, ADR-261): is_active=0 on the whole prefix up to AND including the
    // current last message — the SAME mechanism /revert uses — so cleared history disappears from
    // getMessages()/getConversation() at the source (session export, the model's own replay via
    // resolveEffectiveHistory, and the transcript), not just a client-side display slice that left
    // the rows is_active=1 (the export-leak bug this fixes). clearedUpToMessageId still records the
    // cut so /resume knows the exact range to reactivate.
    db.deactivateMessagesUpTo(run.convId, lastMsg.id)
    db.setClearedUpToMessageId(id, lastMsg.id)
    return c.json({ ok: true, clearedUpToMessageId: lastMsg.id })
  })

  app.post('/api/v1/code/sessions/:id/resume', (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before resuming.')
    // Undoes whichever of the two independent resumable hidden-states is active (v33) — they're
    // mutually exclusive (see /clear and /revert's own guards), so at most one is ever set.
    if (run.revertedFromMessageId) {
      db.reactivateMessagesFrom(run.convId, run.revertedFromMessageId)
      db.setRevertedFromMessageId(id, null)
      return c.json({ ok: true })
    }
    if (!run.clearedUpToMessageId) return err(c, 400, 'not_cleared', 'This session has not been cleared.')
    // Real reactivation (v34) — is_active=1 on the same prefix /clear deactivated, the mirror of the
    // /revert branch above. A turn added AFTER the clear has a higher seq than the cut, so it's
    // untouched; only the originally-cleared history comes back.
    db.reactivateMessagesUpTo(run.convId, run.clearedUpToMessageId)
    db.setClearedUpToMessageId(id, null)
    return c.json({ ok: true })
  })

  // ── revert to a user message ──────────────────────────────────────────────────
  // Rewinds the transcript to just before `messageId` by DEACTIVATING (is_active=0) it and every
  // message after it — ConversationStore.deactivateMessagesFrom, the same mechanism Chat's own
  // branching already relies on (getMessages() filters is_active=1 unconditionally, so a
  // deactivated message disappears from every consumer — transcript, resolveEffectiveHistory,
  // revertFileEdits below — with no separate cut-logic needed anywhere). Nothing is deleted;
  // /resume reactivates the same range. Returns messageId's original text so the caller can
  // refill the composer with it.
  //
  // Corrected 2026-07-17 (same day, live-tested against a real 40-message session): a first pass
  // reused clearedUpToMessageId (the /clear + /resume cursor) instead. That mechanism can only
  // express "hide everything BEFORE a point, show everything after" — backwards from what revert
  // needs (discard the reverted message and everything AFTER it, keep everything before), and
  // structurally incapable of that for any message that isn't already at the very end: reverting
  // to the session's actual last user message left that message's own reply orphaned and visible
  // with nothing above it, and reverting to an EARLIER message (the revert affordance appears on
  // every user message, not just the last — CodeTranscript.tsx) would have hidden the wrong half
  // of history entirely. Real per-message deactivation fixes both, and generalizes correctly to
  // any revert target, not just the last message.
  //
  // Optionally (revertFiles) also reverse-applies every 'edit' tool call's stored patch for the
  // discarded messages, walking any touched file back to its pre-edit content — see revert.ts.
  // ALSO blocked while cleared (v33) — same mutual-exclusion rationale as /clear's own guard.
  app.post('/api/v1/code/sessions/:id/revert', async (c) => {
    const id = c.req.param('id')
    const b = await body<{ messageId?: string; revertFiles?: boolean }>(c)
    const messageId = (b.messageId ?? '').trim()
    if (!messageId) return err(c, 400, 'invalid_input', 'messageId is required.')

    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before reverting.')
    if (run.clearedUpToMessageId) return err(c, 409, 'session_cleared', 'Resume this session before reverting — it currently has cleared messages pending.')
    // A second revert while one is already pending SUPERSEDES it rather than 409ing (founder
    // feedback, 2026-07-24 — the earlier hard stop cost real friction on "revert, try again,
    // doesn't work, revert further back", a common iterative-debugging pattern). Safe by
    // construction, not just by convention: the revert affordance only ever renders on a message
    // getMessages() actually returned, which filters is_active=1 — so any messageId this handler
    // receives is necessarily STILL ACTIVE, which by definition means it sits BEFORE the current
    // revertedFromMessageId cut (that cut and everything after it is already is_active=0 and thus
    // unreachable through the normal UI). "Revert again" can therefore only ever mean "revert
    // further back," never forward into already-hidden history — deactivateMessagesFrom below is
    // idempotent-safe to call again with an earlier cutoff.
    // /compact and /clear keep their own hard stop while reverted (line 381 above, and the
    // clearedUpToMessageId guard above) — losing hidden history to a compaction/clear is a bigger,
    // less-reversible deal than superseding one revert cursor with another.
    const conv = db.getConversation(run.convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Session conversation not found.')

    const messages = conv.messages ?? []
    const cut = resolveRevertCut(messages, messageId)
    if (!cut.ok) {
      if (cut.error === 'not_found') return err(c, 404, 'not_found', 'Message not found.')
      if (cut.error === 'not_a_user_message') return err(c, 400, 'invalid_input', 'Can only revert to a user message.')
      return err(c, 400, 'invalid_input', 'This is the first message in the session — nothing before it to revert to.')
    }

    let revertedFiles: string[] = []
    let failedFiles: string[] = []
    if (b.revertFiles) {
      // NOT messages.slice(idx) — `messages` came from getConversation's is_active=1 filter, so
      // it silently EXCLUDES any range a PRIOR revert already deactivated. Superseding a prior
      // chat-only revert (revertFiles=false) with a further-back one that DOES ask for file
      // reverts must still reach that earlier range's edit patches, or files it touched are
      // silently left edited on disk while the success toast below claims otherwise (found in
      // Opus PR review, pre-release gate for v1.9.0). getMessagesFromIncludingInactive walks the
      // real seq-ordered row range regardless of is_active — the same range deactivateMessagesFrom
      // itself operates on below.
      const rangeMessages = db.getMessagesFromIncludingInactive(run.convId, messageId)
      const result = revertFileEdits(rangeMessages, run.repoRoot)
      revertedFiles = result.reverted
      failedFiles = result.failed
    }

    db.deactivateMessagesFrom(run.convId, messageId)
    db.setRevertedFromMessageId(id, messageId)
    return c.json({ ok: true, revertedFromMessageId: messageId, revertText: cut.revertText, revertedFiles, failedFiles })
  })

  // ── git status / commit / push / PR-link (Phase 3, ADR-259) ───────────────────────────────
  // Real `git` subprocess calls in the session's own repoRoot — see git-actions.ts's own header
  // for the full scope note (commit+push only, no gh/GitHub-API call, push never forces).
  //
  // /git/status is read-only against the filesystem, so — unlike commit/push below — it does NOT
  // gate on runs.isActive(id): a live agent turn's own bash/edit tool calls are already reading
  // and writing that same working tree concurrently, and a `git status` racing with them is no
  // different from a human running one in a second terminal (same as a plain read, not a
  // conflicting mutation). Deliberately NOT gated on clearedUpToMessageId/revertedFromMessageId
  // either — those are conversation-history hidden-states, an orthogonal concern from the actual
  // git working tree.
  app.get('/api/v1/code/sessions/:id/git/status', async (c) => {
    const run = db.getAgentRun(c.req.param('id'))
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    const status = await getGitStatus(run.repoRoot)
    return c.json({ ok: true, status })
  })

  // Commit and push DO gate on runs.isActive(id) — same discipline as /compact, /clear, /revert
  // above: a live turn's own edit/write tool calls mutate this exact working tree, so staging or
  // committing concurrently risks capturing a file mid-write. (The pi tool-call approval gate,
  // waitForToolApproval/resolveToolApproval, is a different mechanism for a different shape of
  // action — it exists to gate the MODEL interrupting a live turn to ask permission for a tool
  // call; these are plain user-triggered REST actions with no live turn or toolCallId involved at
  // all, so the run_active 409 below — the same guard every other repo-mutating Code route already
  // uses — is the correct fit, not a bypass of the approval gate.)
  app.post('/api/v1/code/sessions/:id/git/commit', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before committing.')
    const b = await body<{ message?: string; files?: string[] }>(c)
    try {
      const result = await commitGitChanges(run.repoRoot, b.message ?? '', b.files)
      return c.json({ ok: true, ...result })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Commit failed.'
      if (/commit message is required/i.test(message)) return err(c, 400, 'invalid_input', message)
      if (/not a git repository/i.test(message)) return err(c, 400, 'not_a_git_repo', message)
      if (/nothing to commit|nothing staged/i.test(message)) return err(c, 400, 'nothing_to_commit', message)
      if (/outside the repo/i.test(message)) return err(c, 400, 'invalid_input', message)
      return err(c, 500, 'git_commit_failed', message)
    }
  })

  app.post('/api/v1/code/sessions/:id/git/push', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before pushing.')
    const result = await pushGitBranch(run.repoRoot)
    if (!result.ok) {
      const status = result.reason === 'diverged' ? 409 : 400
      return err(c, status, result.reason, result.message)
    }
    const compareUrl = await getGithubCompareUrl(run.repoRoot, result.branch)
    return c.json({ ok: true, remote: result.remote, branch: result.branch, compareUrl })
  })

  // Standalone lookup (independent of push) — lets the UI offer "Create PR" for a branch that
  // was already pushed by a previous session/turn, without pushing again.
  app.get('/api/v1/code/sessions/:id/git/compare-url', async (c) => {
    const run = db.getAgentRun(c.req.param('id'))
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    const status = await getGitStatus(run.repoRoot)
    if (!status.isRepo || status.detached || !status.branch) return c.json({ ok: true, compareUrl: null })
    const compareUrl = await getGithubCompareUrl(run.repoRoot, status.branch)
    return c.json({ ok: true, compareUrl })
  })

  // `!command` / `!!command` shell escape (ADR-258) — the USER runs a shell command in the session
  // repoRoot (via the same robust-bash wrapper the agent's own bash tool uses). Gated on
  // runs.isActive, same discipline as commit/push/compact/revert: a user command can mutate the
  // working tree, and `feedToModel` additionally writes a conversation message that a live turn's
  // history is mid-use of. `feedToModel` (the `!` variant) persists the command + its output as a
  // user message so the model sees it as context on the next turn (seedPriorHistory replays a user
  // message's content verbatim); `!!` passes false — the output is returned for a transcript-only
  // peek and nothing is persisted.
  app.post('/api/v1/code/sessions/:id/exec', async (c) => {
    const id = c.req.param('id')
    const run = db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    if (runs.isActive(id)) return err(c, 409, 'run_active', 'Stop or wait for the current run before running a command.')
    const b = await body<{ command?: string; feedToModel?: boolean }>(c)
    const command = (b.command ?? '').trim()
    if (!command) return err(c, 400, 'invalid_input', 'A command is required.')
    const feedToModel = b.feedToModel !== false // default true (the `!` variant); `!!` sends false

    let result
    try {
      result = await runShellCommand(command, run.repoRoot, id)
    } catch (e) {
      return err(c, 500, 'exec_failed', e instanceof Error ? e.message : 'Command failed to run.')
    }

    let messageId: string | undefined
    if (feedToModel) {
      const msg = db.addMessage(run.convId, 'user', shellContextText(result), {
        toolCalls: [{
          id: `shell-${Date.now()}`,
          name: 'shell',
          args: { command, exitCode: result.exitCode, timedOut: result.timedOut },
          result: result.output,
        }],
      })
      messageId = msg.id
    }
    return c.json({
      ok: true,
      command,
      output: result.output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      messageId,
    }, 200)
  })

  // ── stop the in-flight run (+ drop the queue) ─────────────────────────────────
  app.post('/api/v1/code/sessions/:id/stop', (c) => {
    const id = c.req.param('id')
    runs.stop(id)
    return c.json({ ok: true })
  })

  // ── "Send now" on a queued follow-up: stop the active turn, promote this one to run next ──
  // Unlike /stop, this does NOT drop the rest of the queue — see CodeRunManager.sendNow's own
  // comment for why a naive stop-then-requeue can't do this atomically with 2+ queued turns.
  app.post('/api/v1/code/sessions/:id/queue/:userMsgId/send-now', (c) => {
    const id = c.req.param('id')
    const userMsgId = c.req.param('userMsgId')
    const ok = runs.sendNow(id, userMsgId)
    return c.json({ ok })
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
    const b = await body<{ content?: string; promptOverride?: string; contextFiles?: string[]; thinkingBudget?: number; kind?: string }>(c)
    // How to deliver this message when a run is already active (Phase 1, ADR-246): 'steer'
    // redirects the CURRENTLY ACTIVE turn, 'followUp' queues a fresh turn behind it. Anything
    // else — including the field being omitted by the not-yet-updated frontend — defaults to
    // 'followUp', which is byte-for-byte today's behavior (zero change for existing callers).
    const kind: SteerKind = b.kind === 'steer' ? 'steer' : 'followUp'

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

    // The task for this turn: an explicit message body wins; otherwise the last user message
    // (the seeded task on the first run).
    const newContent = (b.content ?? '').trim()
    let userMsgId: string
    let task: string
    if (newContent) {
      userMsgId = db.addMessage(run.convId, 'user', newContent, { textAttachments: b.contextFiles }).id
      // promptOverride lets the CALLER separate "what's stored/shown" from "what's actually
      // prompted this turn" — the founder's own literal message must never be silently rewritten
      // (see CodeSessionScreen.tsx's skill-invocation picker, the one caller of this today), but
      // the model still needs an explicit nudge to invoke a picked skill. Future turns' history
      // replay always uses the STORED message (newContent), never the override, so past turns read
      // back as what the user actually said, not the synthetic nudge that steered that one turn.
      task = contextFilesBlock(b.contextFiles) + ((b.promptOverride ?? '').trim() || newContent)
    } else {
      const lastUser = (conv.messages ?? []).filter((m) => m.role === 'user').at(-1)
      if (!lastUser) return err(c, 400, 'no_task', 'No task to run.')
      userMsgId = lastUser.id
      task = contextFilesBlock(lastUser.textAttachments) + lastUser.content
    }

    // 'steer' tries to inject into the live turn (falling back to the queue if there's nothing to
    // steer); 'followUp' (the default) queues a fresh turn exactly as before. `steered` tells the
    // caller which happened — the frontend renders an injected message inline instead of as a
    // pending "Queued" chip.
    const enqueueParams = { convId: run.convId, repoRoot: run.repoRoot, task, userMsgId, thinkingBudget: b.thinkingBudget }
    if (kind === 'steer') {
      const { steered, queued } = await runs.steer(id, enqueueParams)
      return c.json({ ok: true, queued, steered, userMessageId: userMsgId }, 202)
    }
    const { queued } = runs.enqueue(id, enqueueParams)
    return c.json({ ok: true, queued, steered: false, userMessageId: userMsgId }, 202)
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
      // Current step checklist snapshot (ADR-255), so a mid-turn (re)connect shows live progress up
      // front. Only when non-empty — no point emitting an empty checklist on every connect.
      const currentTodos = runs.todos(id)
      if (currentTodos.length > 0) await stream.writeSSE({ event: 'todos', data: JSON.stringify({ todos: currentTodos }) })

      for await (const ev of sub) {
        // The `id:` field carries the seq so the client can reconnect with ?fromSeq=<last id>.
        await stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) })
      }
    })
  })
}
