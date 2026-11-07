// Chat API routes (spec 07). Conversations CRUD + SSE streaming send + message actions.
import { readFile } from 'node:fs/promises'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'
import { resolveKey, grantKind, holdOpen, holdTurn, hostGate, isLocalOrAuthenticated } from '../auth'
import { getAdvertisedHost, getLanIp } from '../net'
import { CHAT_APPROVAL_WAIT_MINUTES } from '../config/config-bounds'
import { parseReasoningEffort, type ReasoningEffort } from './reasoning-effort'
import type { EmitSink } from './emit-sink.js'
import type { ChatRun, ChatRunMeta } from './chat-runs.js'
import type { ChatTurns } from './chat-turns.js'
import { buildEngineMessages, maybeAutoCompact, compactConversation, setAsideFrozenCut, userTurnContent, type EngineMessage } from './chat-compaction.js'

import type { ConversationStore, Message, PageOpts, ToolCallRecord } from './db'
import { InvalidCursorError } from './db'
import { buildSnapshot } from './chat-export'
import type { ExportFormat } from './chat-export'
import { pendingToolApprovalName, resolveToolApproval } from '../tools/approval-gate'
import { isMcpToolName, listsMcpTool, MCP_APPROVAL_REFUSED_MESSAGE } from '../tools/tool-registry'
import { SkillStore } from '../agents/skills'
import { saveSkillFromConversation, SKILL_AUTHORING_REFUSED } from '../agents/skill-jobs'
import { extractMemoryFacts } from './memory'
import { codeGateBlocks } from '../routines/routine-routes'
import { callChatUpstream, resolveChatUpstream, type ChatUpstream } from './chat-upstream'
import { servingEngineKind } from '../engines/serving'
import { runGenerationCore } from './generation-core'
import { nonStringField } from '../util/string-fields'

/** The per-request code-routine trust decision. Exported ONLY so it can be behaviourally
 *  pinned — both generation entry points must call this, never inline the expression.
 *
 *  I1: this used to be `!codeGateBlocks(c, d)` written out at both call sites, protected only by
 *  a structural test asserting on this file's source text. A reviewer defeated that with a
 *  vulnerability-preserving refactor — alias the import (`codeGateBlocks as codeGateBlocksStrict`)
 *  and shadow the name locally with a `() => false` — which left both producer lines byte-identical
 *  while making `isCodeAuthorized` unconditionally `true`, with the whole suite green. The five
 *  behavioural tests could not catch it either: they imported `codeGateBlocks` straight from
 *  `routine-routes.ts`, so they measured the real function while production measured the shadow.
 *  Naming the decision and exporting it lets those tests drive THIS function, out of THIS module,
 *  so any shadow/alias/rewrite of what it resolves to is a test failure rather than a green build. */
export function chatCodeAuthorization(c: Context, d: Deps): boolean {
  return !codeGateBlocks(c, d)
}

/** The approve route's refusal of a Code session's pending tool call to a caller codeAuth would
 *  not let into Code. */
const CODE_APPROVAL_REFUSED_MESSAGE = 'Allowing a Code tool call requires a valid API key from a non-host device.'

const COMPACTING_MESSAGE = 'This chat is being compacted. Try again when it finishes.'

/** The 409 for a chat whose in-flight slot is taken, or null when it is free: compaction_in_progress
 *  while a manual compaction holds it, otherwise generation_in_flight with the route's own text. */
function inflightRefusal(c: Context, d: Deps, convId: string, turnMessage: string) {
  const held = d.chatTurns.held(convId)
  if (!held) return null
  if (d.chatTurns.isCompaction(held)) return err(c, 409, 'compaction_in_progress', COMPACTING_MESSAGE)
  return err(c, 409, 'generation_in_flight', turnMessage)
}

/** A turn's body, releasing its in-flight entry however the body exits: runGeneration's own
 *  finally only covers a turn that reached it, and a throw before that (e.g. a malformed request
 *  body) left the chat answering 409 until a restart. */
function releasingInflight<T>(turns: ChatTurns, convId: string, ac: AbortController, cb: (arg: T) => Promise<void>): (arg: T) => Promise<void> {
  return async (arg) => {
    try { await cb(arg) } finally { turns.release(convId, ac) }
  }
}

/** Runs a turn in the daemon (the owner's rule: the web UI is a frontend, and closing, reloading
 *  or leaving the page, Android's Back or a dropped connection never stops a reply). Its in-flight
 *  entry and its run (chat-runs.ts) own it, not the request: the request that started it, like
 *  every GET .../stream after it, is only a viewer of the run's frames (respondWithChatRun). What
 *  stops it: Stop, deleting the chat, the engine kill switches (ChatTurns.abortAll), and its
 *  caller's way in going away (holdTurn): LAN access turned off or remote access stopped, which
 *  used to end the request and, with it, the turn, and now also the key revoked or a key now
 *  required, which never stopped a turn while it ran in its request. `c` is read here, before the
 *  response: the body must not read it (runGeneration and maybeAutoCompact take no Context). A
 *  throw before the turn reached runGeneration (which saves on every path) is told to the viewers
 *  as an `error` frame rather than becoming an unhandled rejection. */
function startDetachedTurn(c: Context, d: Deps, convId: string, ac: AbortController, meta: ChatRunMeta, body: (sink: EmitSink) => Promise<void>): ChatRun {
  const { run, sink } = d.chatRuns.start(convId, ac, meta)
  const release = holdTurn(c, d, () => d.chatTurns.stop(convId, ac))
  const turn: Promise<void> = releasingInflight(d.chatTurns, convId, ac, body)(sink)
    .catch(async (e) => {
      console.error(`[chat] turn for ${convId} failed`, e)
      await sink({ event: 'error', data: { code: 'turn_failed', message: 'The reply could not be generated.' } })
    })
    .finally(() => {
      release()
      d.chatRuns.end(run)
      d.chatTurns.untrackTurn(turn)
    })
  d.chatTurns.trackTurn(turn)
  return run
}

/** How often a viewer's stream gets an SSE comment while no frame is due (a turn waiting on an
 *  approval or a long tool call): a tunnel or proxy that cuts idle streams (Cloudflare's is about
 *  100 s) then leaves it open, instead of the page reconnecting every time. */
const KEEPALIVE_MS = 20_000

/** A run's frames as this response's SSE: from `fromSeq` (ChatRuns.subscribe's rules), then live
 *  until the run ends. Each frame carries its seq as `id:`, the page's resume cursor. Closing the
 *  response stops only this viewer. holdOpen ends the viewer once its own way in goes (a revoked
 *  key), as for Code's run stream; the turn is held to its own caller's (startDetachedTurn).
 *  `synthMeta`: a viewer attaching to a run already under way gets the run's meta first, un-id'd
 *  (as Code's stream does), so it can tell which reply the frames belong to even when frame 0 has
 *  left the window. A viewer that falls too far behind gets a `lagged` frame and is ended: it
 *  resumes from its cursor. `run` null: nothing to attach to, an empty stream. */
function respondWithChatRun(c: Context, d: Deps, run: ChatRun | null, fromSeq: number, opts: { synthMeta: boolean }): Response {
  return streamSSE(c, holdOpen(c, async (stream) => {
    if (!run) return
    const sub = d.chatRuns.subscribe(run, fromSeq)
    stream.onAbort(() => { sub.close() })
    let writing = false
    const write = async (msg: { id?: string; event: string; data: string }) => {
      writing = true
      try { await stream.writeSSE(msg) } finally { writing = false }
    }
    // Only between frames: a write still waiting (a stalled socket) needs no keepalive, and none
    // queues up behind it.
    const keepalive = setInterval(() => { if (!writing) void stream.write(': keepalive\n\n') }, KEEPALIVE_MS)
    keepalive.unref()
    try {
      if (opts.synthMeta && !run.ended) await write({ event: 'meta', data: JSON.stringify(run.meta) })
      for await (const ev of sub) await write({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) })
      if (sub.lagged()) await write({ event: 'lagged', data: '{}' })
    } finally {
      clearInterval(keepalive)
    }
  }))
}

// 503 joined the set with Turbo Link: a linked machine that is offline, or no longer
// advertising the model, is a REMOTE availability failure, not a local 409.
// 403 joined with ADR-422's N2 fix: a remote-access token is authenticated but
// deliberately refused a specific action (persisting a global tool policy).
type S = 200 | 201 | 202 | 400 | 403 | 404 | 409 | 500 | 503
function err(c: Context, s: S, code: string, msg: string) { return c.json({ error: { code, message: msg } }, s) }
async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

/** One page of a keyset-paged list, from the request's ?limit and ?cursor — or the 400 a
 *  cursor the list never issued gets. */
function listPage<T>(c: Context, read: (page: PageOpts) => T): T | Response {
  try {
    return read({ limit: Number(c.req.query('limit')), cursor: c.req.query('cursor') })
  } catch (e) {
    if (e instanceof InvalidCursorError) return err(c, 400, 'invalid_cursor', 'That cursor is not one this list issued.')
    throw e
  }
}

const STALE_MESSAGE = 'This message is no longer on the shown branch: the chat changed in another tab or device.'

/** A Code session's conversation through the chat routes, to a caller codeAuth refuses (see
 *  registerChatRoutes's conversationGate). Code's own refusal, in codeAuth's words. */
const CODE_CONVERSATION_REFUSED = 'A valid API key is required to access Code from a non-host device.'

/** "Allow for this chat" for a tool set to Deny in Settings, to a caller isLocalOrAuthenticated
 *  refuses (the approve route). */
const DENIED_TOOL_CHAT_ALLOW_REFUSED = 'This tool is set to Deny in Tool Permissions. Allowing it for a chat requires a valid API key from a non-host device.'

/** A change to an MCP-running chat routine's run conversation, to a caller the routine routes
 *  refuse that routine (see registerChatRoutes's conversationGate). */
const MCP_ROUTINE_CONVERSATION_REFUSED = 'Changing the conversation of a routine whose agent uses an MCP server tool requires a valid API key from a non-host device.'

/** Messages as the chat routes return them: without `docContext`, the attached documents' full
 *  text. It is stored so a Regenerate or a Save & Resend can send the turn again with its
 *  documents, which the daemon reads from the store; no client reads it, and the chat shows a
 *  document by its name (`textAttachments`). Returned, every GET /conversations/:id (which the web
 *  UI polls every 4 s) sent the full text of every document attached in the chat. */
function forClient(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.docContext === undefined) return m
    const { docContext: _docText, ...rest } = m
    return rest
  })
}

/** Edit-and-resend's branch (GitHub #52): the question `msg` and everything after it are frozen,
 *  not deleted, and `content` becomes the question's newest version, with the same images and
 *  documents. Shared by PUT /messages/:msgId and /continue { edit }. Returns the new version. */
function branchEditedQuestion(db: ConversationStore, convId: string, msg: Message, content: string): Message {
  // One transaction: an addMessage that failed after the freeze (disk full, an I/O error) left
  // the question and its tail deactivated with no new version shown in their place.
  return db.transaction(() => {
    db.freezeTail(convId, msg.seq, msg.id)
    db.deactivateMessage(msg.id)
    const variantGroup = db.getMessage(msg.id)!.variantGroup!
    return db.addMessage(convId, 'user', content, { variantGroup, attachments: msg.attachments, textAttachments: msg.textAttachments, docContext: msg.docContext })
  })
}

export function registerChatRoutes(app: Hono, d: Deps): void {
  const { db } = d
  // Startup reconcile (createApp, before the daemon listens), as Code's runs.reconcileOnStartup: a reply whose turn
  // died with the previous process (a restart, a crash, Android killing the app) was left an empty placeholder.
  const cutOff = db.abortUnfinishedReplies()
  if (cutOff > 0) console.log(`[chat] marked ${cutOff} ${cutOff === 1 ? 'reply' : 'replies'} cut off by the last daemon exit as stopped`)

  // ── folders CRUD (v10) ─────────────────────────────────────────────────────
  // Flat folders for grouping conversations in the sidebar. Grouping itself is done
  // client-side; these endpoints only manage folder records + membership moves.

  app.get('/api/v1/folders', (c) => {
    return c.json({ folders: db.listFolders() })
  })

  app.post('/api/v1/folders', async (c) => {
    const b = await body<{ name?: string }>(c)
    if (nonStringField(b, ['name'])) return err(c, 400, 'invalid_input', 'name must be a string.')
    const name = (b.name ?? '').trim()
    if (!name) return err(c, 400, 'invalid_input', 'Folder name required.')
    return c.json(db.createFolder(name), 201)
  })

  app.patch('/api/v1/folders/:id', async (c) => {
    const b = await body<{ name?: string }>(c)
    if (nonStringField(b, ['name'])) return err(c, 400, 'invalid_input', 'name must be a string.')
    const name = (b.name ?? '').trim()
    if (!name) return err(c, 400, 'invalid_input', 'Folder name required.')
    const ok = db.renameFolder(c.req.param('id'), name)
    if (!ok) return err(c, 404, 'not_found', 'Folder not found.')
    return c.json(db.getFolder(c.req.param('id'))!)
  })

  app.delete('/api/v1/folders/:id', (c) => {
    // Deleting a folder unassigns its member conversations (folder_id → NULL); it never
    // deletes the conversations themselves.
    const ok = db.deleteFolder(c.req.param('id'))
    if (!ok) return err(c, 404, 'not_found', 'Folder not found.')
    return c.json({ ok: true })
  })

  // ── auto-memory (Release 3) ────────────────────────────────────────────────

  // Newest first, a page at a time (?limit, 200 by default and at most; ?cursor, the previous
  // page's nextCursor, which is null on the last page).
  app.get('/api/v1/memory', (c) => {
    const page = listPage(c, (p) => db.listMemoryFactsPage(p))
    return page instanceof Response ? page : c.json(page)
  })

  app.delete('/api/v1/memory/:id', (c) => {
    const ok = db.deleteMemoryFact(c.req.param('id'))
    if (!ok) return err(c, 404, 'not_found', 'Fact not found.')
    return c.json({ ok: true })
  })

  // ── token usage dashboard (Release 3) ─────────────────────────────────────

  app.get('/api/v1/tokens/usage', (c) => {
    const q = c.req.query('range')
    const range = q === '30d' || q === '7d' ? q : 'all'
    return c.json(db.tokenUsageStats(range))
  })

  // ── conversations CRUD ─────────────────────────────────────────────────────

  // A Code session's conversation (kind 'code') is Code's own: its transcript holds the session's
  // bash output and file contents, and pi replays it into the model on the next turn. So every
  // route here that reads or changes one by id is held to codeAuth's bar (codeGateBlocks), as
  // /api/v1/code/* is: these routes are behind lanAuth only, so a keyless Serve identity, Access
  // JWT or open-LAN peer, or a remote token, that codeAuth refuses could read, export, rewrite and
  // delete a Code transcript (the session's agent run with it) once it had the id, which a stalled
  // ask-mode Code routine's run showed (routine-routes.ts forCodeGateRefused). One gate for every
  // route under the id, so a new one is covered too. Not the tool-call approve route: a Deny
  // there must stay open to anyone, so what it lets a caller decide on a Code conversation is
  // gated by decision in that route. api_key_required: the web client opens its key prompt on it.
  //
  // A chat routine's run conversation (kind 'agent', chat-runner.ts) is the routine's own in the
  // same way: an approved stalled run resumes from its persisted messages (buildResumeMessages)
  // and then runs every tool the agent lists, unattended. So for a routine whose agent lists an
  // MCP server tool, read live as chat-runner.ts and routine-routes.ts's chatAgentUsesMcp read it,
  // every route here that changes the conversation is held to the bar those routine routes hold
  // its prompt, run-now and approve to (codeGateBlocks). Without it such a caller rewrote a
  // stalled MCP routine's question (PUT .../messages/:msgId), and the owner's Approve then ran the
  // MCP tool on that text. Reads stay open, as the run's result does on the routine routes. A run
  // on an agent with no MCP tool stays as open as its routine, whose prompt such a caller may
  // edit and run anyway.
  const approveRoute = /^\/api\/v1\/conversations\/[^/]+\/tool-calls\/[^/]+\/approve$/
  const conversationGate: MiddlewareHandler = async (c, next) => {
    if (approveRoute.test(c.req.path)) return next()
    const id = c.req.param('id')
    const conv = id ? db.getConversation(id) : null
    if (conv?.kind === 'code' && codeGateBlocks(c, d)) {
      return err(c, 403, 'api_key_required', CODE_CONVERSATION_REFUSED)
    }
    const read = c.req.method === 'GET' || c.req.method === 'HEAD'
    if (!read && conv?.kind === 'agent' && runsMcpAgent(conv.agentId) && codeGateBlocks(c, d)) {
      return err(c, 403, 'api_key_required', MCP_ROUTINE_CONVERSATION_REFUSED)
    }
    return next()
  }
  /** Does the chat agent a routine run's conversation belongs to list an MCP server tool now? */
  const runsMcpAgent = (agentId: string | undefined) => {
    const agent = agentId ? d.store.snapshot().customAgents?.find((a) => a.id === agentId) : undefined
    return !!agent && listsMcpTool(agent.tools)
  }
  app.use('/api/v1/conversations/:id', conversationGate)
  app.use('/api/v1/conversations/:id/*', conversationGate)

  // Without `q`: most recently updated first, a page at a time (?limit, 200 by default and at
  // most; ?cursor, the previous page's nextCursor, null on the last page). A search (`q`) is one
  // capped result list, with nextCursor null.
  app.get('/api/v1/conversations', (c) => {
    const q = c.req.query('q')
    const page = q
      ? { conversations: db.listConversations(q, 'chat'), nextCursor: null }
      : listPage(c, (p) => db.listConversationsPage('chat', p))
    if (page instanceof Response) return page
    // `running`: a turn holds the chat's slot (ChatTurns.slotState), for the sidebar of a page that did not start it.
    const conversations = page.conversations.map((conv) => ({ ...conv, running: d.chatTurns.slotState(conv.id).runningReplyId !== null }))
    return c.json({ conversations, nextCursor: page.nextCursor })
  })

  app.post('/api/v1/conversations', async (c) => {
    const b = await body<{ title?: string; systemPrompt?: string; modelKey?: string; toolPolicy?: string; skillIds?: string[]; allowedTools?: string[]; sampling?: Record<string, number>; preserveThinking?: boolean }>(c)
    // Only keep ids that exist in the shared skill library; silently drop unknown ones.
    const validIds = new Set(new SkillStore(d.store.dir()).list().map((s) => s.id))
    const skillIds = Array.isArray(b.skillIds) ? b.skillIds.filter((sid) => validIds.has(sid)) : undefined
    // Tool allow-list baked in from a custom chat Agent (Customize → Agents). Not
    // validated against the live tool catalog — an MCP server disconnecting later
    // shouldn't retroactively corrupt the conversation's saved intent.
    const allowedTools = Array.isArray(b.allowedTools) ? b.allowedTools.filter((t) => typeof t === 'string') : undefined
    const sampling = (b.sampling && typeof b.sampling === 'object') ? b.sampling : undefined
    const preserveThinking = typeof b.preserveThinking === 'boolean' ? b.preserveThinking : undefined
    const conv = db.createConversation({ title: b.title, systemPrompt: b.systemPrompt, modelKey: b.modelKey, toolPolicy: b.toolPolicy, skillIds, allowedTools, sampling, preserveThinking })
    return c.json(conv, 201)
  })

  // Save this conversation as a reusable SKILL (Voyager-style distill from the
  // transcript). Detached → shared library, deduped by name.
  app.post('/api/v1/conversations/:id/save-skill', (c) => {
    // It writes a SKILL.md into the shared library, which every Code session's catalog lists and
    // auto mode can run with bash: the same host-side action as POST /api/v1/skills, so the same
    // isLocalOrAuthenticated gate. This route is behind lanAuth only (models:use for a remote
    // token), so without it a keyless Serve identity, Access JWT, open-LAN peer or remote token
    // that /skills and /skills/import refuse could plant a skill through here.
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'forbidden', SKILL_AUTHORING_REFUSED)
    const conv = db.getConversation(c.req.param('id'))
    if (!conv) return c.json({ error: { code: 'not_found', message: 'Conversation not found.' } }, 404)
    // Same background skill author the in-chat save_skill tool uses (skill-creator model).
    const taskId = saveSkillFromConversation(d, conv.id)
    return c.json({ ok: true, learning: !!taskId })
  })

  app.get('/api/v1/conversations/:id', (c) => {
    const conv = db.getConversation(c.req.param('id'))
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')
    // Every active message, each image as its short reference (2.7). Not paged within the conversation: a very long
    // chat still sends all its text on each open and poll (left for a later change).
    conv.messages = db.getMessagesForDisplay(conv.id)
    // The compaction as the turns see it: one cut on a branch the user left is not this
    // branch's, so the chat shows no divider, summary or Undo for it (Undo would delete the
    // other branch's compaction) and the meter shows its measured reading, no projection. (The
    // daemon's auto-compaction gate can judge this branch larger than that reading: see
    // maybeAutoCompact, which raises it to the estimated size of the full history replayed.)
    const shown = setAsideFrozenCut(db, conv)
    return c.json({ ...shown, messages: forClient(shown.messages ?? []), ...d.chatTurns.slotState(conv.id) })
  })

  // A chat image (attachments.ts), for the web UI to show. Under /api/v1 like the conversation that names it, so
  // lanAuth admits the same callers, and a remote-access token needs models:use (auth.ts requiredCapability). The id
  // is checked against the one shape the store writes, so it can only name a file in the attachments folder. Its
  // name is the hash of its bytes, so it never changes: cacheable for good.
  app.get('/api/v1/attachments/:id', async (c) => {
    const file = db.attachments.file(c.req.param('id'))
    const bytes = file ? await readFile(file.path).catch(() => null) : null
    if (!file || !bytes) return err(c, 404, 'not_found', 'Attachment not found.')
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': file.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  app.patch('/api/v1/conversations/:id', async (c) => {
    const b = await body<{ title?: string; systemPrompt?: string; sampling?: Record<string, unknown>; skillIds?: string[]; preserveThinking?: boolean }>(c)
    if (b.skillIds !== undefined) {
      const validIds = new Set(new SkillStore(d.store.dir()).list().map((s) => s.id))
      b.skillIds = b.skillIds.filter((sid) => validIds.has(sid))
    }
    const ok = db.updateConversation(c.req.param('id'), b)
    if (!ok) return err(c, 404, 'not_found', 'Conversation not found.')
    return c.json(db.getConversation(c.req.param('id'))!)
  })

  app.delete('/api/v1/conversations/:id', (c) => {
    // Stop a generation still running for it (a background chat deleted from the sidebar, or
    // from another device) — otherwise it keeps the engine busy, tool rounds and all, for a
    // conversation that no longer exists. Its own unwind releases the in-flight entry.
    d.chatTurns.abort(c.req.param('id'))
    const ok = db.deleteConversation(c.req.param('id'))
    if (!ok) return err(c, 404, 'not_found', 'Conversation not found.')
    return c.json({ ok: true })
  })

  // Dedicated move-to-folder route (v10). Kept separate from the generic conversation
  // PATCH so that route's patch surface (title/systemPrompt/sampling) stays unchanged.
  // Body: { folderId: string | null } — null moves the conversation out of any folder.
  app.patch('/api/v1/conversations/:id/folder', async (c) => {
    const b = await body<{ folderId?: string | null }>(c)
    const folderId = b.folderId ?? null
    const res = db.moveConversationToFolder(c.req.param('id'), folderId)
    if (!res.ok) {
      if (res.reason === 'folder_not_found') return err(c, 404, 'not_found', 'Folder not found.')
      return err(c, 404, 'not_found', 'Conversation not found.')
    }
    return c.json(db.getConversation(c.req.param('id'))!)
  })

  // ── tool-call approval gate ─────────────────────────────────────────────────

  // Lists the tools currently available to the chat loop (name + description only —
  // no parameters schema; the frontend just needs this to render Tool Permissions).
  app.get('/api/v1/tools', async (c) => {
    const defs = d.tools ? await d.tools.buildToolDefinitions() : []
    return c.json({ tools: defs.map((t) => ({ name: t.function.name, description: t.function.description ?? '' })) })
  })

  // Resolves a pending tool-call approval created by the shared approval-gate executor
  // (execute-with-approval.ts) while streaming a foreground chat response.
  app.post('/api/v1/conversations/:id/tool-calls/:toolCallId/approve', async (c) => {
    const { id: convId, toolCallId } = c.req.param()
    const b = await body<{ toolName?: string; decision?: string }>(c)
    if (nonStringField(b, ['toolName'])) return err(c, 400, 'invalid_input', 'toolName must be a string.')
    const toolName = (b.toolName ?? '').trim()
    const decision = b.decision
    if (!toolName) return err(c, 400, 'invalid_input', 'toolName is required.')
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow_chat' && decision !== 'always_allow') {
      return err(c, 400, 'invalid_input', 'decision must be one of: allow, deny, allow_chat, always_allow.')
    }

    const conv = db.getConversation(convId)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    // A Code session's ask-mode approvals (bash/edit/write and the owner's MCP tools,
    // code-session.ts) wait on the same gate under the Code conversation's id, and are answered
    // here. Every /api/v1/code/* route is behind codeAuth (isLocalRequest or a real, ungranted
    // key: isLocalOrAuthenticated), but this route is behind lanAuth only, so a keyless Serve
    // identity, Access JWT, open-LAN peer or remote token that knew the conversation and call ids
    // could let the host's pending Code bash/edit/write run. Approving one needs what opening Code
    // does; a deny runs nothing and stays open. api_key_required: the web client opens its key
    // prompt on it, as for the MCP refusal below.
    if (conv.kind === 'code' && decision !== 'deny' && !isLocalOrAuthenticated(c, d))
      return err(c, 403, 'api_key_required', CODE_APPROVAL_REFUSED_MESSAGE)

    // An MCP server tool runs with the owner's credentials (a stdio server is a command on this
    // machine), so letting one run is a host-side action: the isLocalOrAuthenticated rule that
    // adding the server (POST /api/v1/mcp/servers) and a chat turn calling it (runGeneration's
    // refuseMcp) are held to. Without it a keyless Serve identity, Access JWT, open-LAN peer or
    // remote token could approve the host's own pending MCP call, or save "Allow for this chat"
    // for an MCP tool ahead of the host's later turns (that write runs before the pending lookup
    // below). The name the pending call was registered with decides as well as the body's
    // toolName, which the caller picks (execute-with-approval.ts and code-session.ts record it).
    // A deny runs nothing and stays open. api_key_required: the web client opens its key prompt
    // on it, as for "Always Allow" below.
    if (decision !== 'deny' && !isLocalOrAuthenticated(c, d)) {
      const pendingName = pendingToolApprovalName(`${convId}:${toolCallId}`)
      if (isMcpToolName(toolName) || (pendingName !== undefined && isMcpToolName(pendingName)))
        return err(c, 403, 'api_key_required', MCP_APPROVAL_REFUSED_MESSAGE)
    }

    let decisionToApply: 'allow' | 'deny'
    if (decision === 'always_allow') {
      // N2 (Phase 5 final-review-fix re-review): `always_allow` persists a GLOBAL tool policy
      // to config.json for every future chat, host session included — a configuration change,
      // not a chat action. This route sits entirely under `requiredCapability`'s `models:use`
      // mapping (auth.ts), the product's own default and minimum remote-token scope, so
      // without this check a bare chat-only token reaching the internet could permanently
      // widen what tools run unattended on the host. A remote-kind grant still gets the same
      // practical outcome for its OWN live session via 'allow_chat' below — only the
      // persist-for-everyone effect is refused.
      if (grantKind(resolveKey(c, d) ?? { grant: undefined }) === 'remote') {
        return err(c, 403, 'forbidden', 'A remote access token cannot change tool permissions for every future chat — use "Allow for this chat" instead.')
      }
      // The same write as toolPolicies on PATCH /api/v1/settings, so the same hostGate. lanAuth
      // lets three callers through here with no key and no capability check (a Tailscale Serve
      // identity, a verified Cloudflare Access JWT, a peer on an open LAN), and the settings
      // route refuses them that field; this one let them set any tool to allow for every chat.
      // Every caller that passes may set toolPolicies through the settings route anyway, so the
      // write running before the pending-approval lookup (the invariant below) gives none of
      // them anything new. api_key_required, like the settings route's refusal: the web client
      // opens its key prompt on it, as nothing else asks a browser on an open LAN for a key.
      if (!hostGate(c, d)) {
        return err(c, 403, 'api_key_required', 'Allowing a tool for every future chat requires a valid API key — use "Allow for this chat" instead.')
      }
      d.store.update((cfg) => {
        cfg.tools.toolPolicies = { ...(cfg.tools.toolPolicies ?? {}), [toolName]: 'allow' }
      })
      decisionToApply = 'allow'
    } else if (decision === 'allow_chat') {
      // A tool the owner set to Deny in Settings: a global Deny wins over this chat's Allow
      // (resolveToolPolicy), but the override would stay saved and take effect the moment the
      // owner relaxes that Deny, so a caller who may not change tool policies (the
      // isLocalOrAuthenticated bar the MCP refusal above uses) may not save one for it either.
      if (d.store.snapshot().tools.toolPolicies?.[toolName] === 'deny' && !isLocalOrAuthenticated(c, d)) {
        return err(c, 403, 'api_key_required', DENIED_TOOL_CHAT_ALLOW_REFUSED)
      }
      db.setToolOverride(convId, toolName, 'allow')
      decisionToApply = 'allow'
    } else if (decision === 'allow') {
      decisionToApply = 'allow'
    } else {
      decisionToApply = 'deny'
    }

    // Invariant: the policy write above must happen before resolveToolApproval below.
    // A same-turn repeat tool call re-reads policies fresh on every iteration (generation.ts),
    // so resolving the gate first would let it observe the stale pre-approval policy and
    // re-prompt for a tool the user just marked "Always Allow" / "Allow for this chat".
    const key = `${convId}:${toolCallId}`
    const ok = resolveToolApproval(key, decisionToApply)
    if (!ok) return err(c, 404, 'not_found', 'No pending approval for this tool call (it may have already timed out or been resolved).')
    return c.json({ ok: true })
  })

  // ── streaming send (spec 07 §2) ────────────────────────────────────────────

  app.post('/api/v1/conversations/:id/messages', async (c) => {
    const convId = c.req.param('id')
    const b = await body<{ content?: string; images?: string[]; docContext?: string; textAttachments?: string[]; thinkingBudget?: number; reasoningEffort?: string; model?: string }>(c)
    // Trimmed here and in resolveChatUpstream (the model): anything but a string threw, a bare 500.
    const notString = nonStringField(b, ['content', 'model'])
    if (notString) return err(c, 400, 'invalid_input', `${notString} must be a string.`)
    const content = (b.content ?? '').trim()
    const images = b.images ?? []
    const textAttachments = b.textAttachments ?? []
    // Checked before anything is stored: a string passed the emptiness check below on its own
    // .length and was saved on the user row, which then broke the chat's view and every resend.
    const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
    if (!isStrings(images) || !isStrings(textAttachments) || (b.docContext != null && typeof b.docContext !== 'string'))
      return err(c, 400, 'invalid_input', 'images and textAttachments must be arrays of strings, and docContext a string.')
    // A message is valid if it has typed text OR carries an image or file
    // attachment — image-only / file-only sends are allowed.
    if (!content && images.length === 0 && textAttachments.length === 0)
      return err(c, 400, 'invalid_input', 'Type a message or attach an image or file.')
    // Each image to its file before the row names it (attachments.ts); the engine is sent data URLs (below).
    // Before the conversation is read and the busy check, so nothing they decide goes stale across this await.
    const storedImages = await db.attachments.save(images)

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    // Turbo Link (final-review C-1): `b.model` is the id the picker sent. A qualified
    // `<machine>/<model>` id that names a linked machine resolves to that HOST — the local
    // engine is not consulted, not loaded, and not required to be running. Anything else
    // (including a local key that happens to contain a slash) takes the unchanged local
    // path, which is what these same two checks did inline before.
    const resolved = resolveChatUpstream(d, b.model)
    if (!resolved.ok) return err(c, resolved.status, resolved.code, resolved.message)
    const upstream = resolved.upstream

    const busy = inflightRefusal(c, d, convId, 'A generation is already running for this conversation.')
    if (busy) return busy

    // Persist user message — only the typed text is stored as content; images are
    // kept in attachments (the full doc context is folded into the engine prompt below,
    // and kept in docContext so /continue can send this turn again with it).
    const userMsg = db.addMessage(convId, 'user', content, { attachments: storedImages, textAttachments, docContext: b.docContext })

    // Create a placeholder assistant message
    db.addMessage(convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = db.getLastMessage(convId)!

    const ac = new AbortController()
    d.chatTurns.claim(convId, ac, assistantMsg.id)

    // Phase 4 / C1: the code-flavor routine gate, decided HERE because this is the last point
    // that still has the Hono Context. `chatCodeAuthorization` wraps routine-routes.ts's own
    // `codeGateBlocks` — POST/PUT /api/v1/routines enforce the identical decision, so the chat
    // tool surface cannot become a softer door onto it. This route is behind lanAuth only (which
    // has an "open LAN" bypass codeAuth does not), so a keyless LAN caller must land on `false`
    // here. Call the named function; never re-inline the expression (see its doc comment, I1).
    const isCodeAuthorized = chatCodeAuthorization(c, d)

    // The turn runs in the daemon (startDetachedTurn); this response is its first viewer. Its
    // `meta` (frame 0) is the run's own, pushed before anything else.
    const run = startDetachedTurn(c, d, convId, ac, { userMessageId: userMsg.id, assistantMessageId: assistantMsg.id }, async (sink) => {
      // Auto-compact (ADR-420): checked BEFORE this turn's messages are built, using the
      // history as it stood before this turn's own user+placeholder rows were added —
      // exactly the "last completed turn's usage" the 80% threshold is meant to judge.
      // `upstream` is THIS turn's already-resolved upstream (local or linked host) and `ac`
      // is its abort — both are handed down rather than re-derived, so a Turbo Link chat
      // summarizes on the host it is actually talking to and Stop can interrupt the wait.
      await maybeAutoCompact(d, convId, conv, upstream, ac.signal, d.chatTurns.autoCompactionPhase(ac, async (phase) => { await sink({ event: 'compaction', data: { phase } }) }))

      // Build messages array for engine (chat-compaction.ts — folds in the compaction
      // summary + cut when one is resolvable; a plain passthrough when not).
      // setAsideFrozenCut: a cut left behind on another branch is not this branch's summary.
      const allMsgs = (conv.messages ?? []).filter(m => m.id !== assistantMsg.id)
      const engineMessages = buildEngineMessages(setAsideFrozenCut(db, conv), allMsgs, undefined, { reasoningField: reasoningAsField(d, upstream) })
      // Fold any attached document text into the prompt; attach images as multimodal parts.
      engineMessages.push({ role: 'user', content: userTurnContent(content, b.docContext, images) })
      // Every stored reference as its data URL, as /continue does: the history's, and this turn's when a caller sent
      // references it was shown (`attachment:<id>`) rather than the image itself. No engine understands a reference.
      await db.attachments.resolveImages(engineMessages)

      await runGeneration(d, sink, { convId, conv, engineMessages, assistantMsg, upstream, ac, thinkingBudget: b.thinkingBudget ?? -1, reasoningEffort: parseReasoningEffort(b.reasoningEffort), userText: content, isCodeAuthorized })
    })
    return respondWithChatRun(c, d, run, 0, { synthMeta: false })
  })

  // ── continue (regenerate last assistant response for the existing last user
  //    message, WITHOUT adding a new user message) ──────────────────────────────

  app.post('/api/v1/conversations/:id/continue', async (c) => {
    const convId = c.req.param('id')
    // `messageId` (with `regenerate`): the reply the client shows last, the one it means to replace.
    // `edit` (Save & Resend, what the web UI sends): the question to give a new version and answer.
    const b = await body<{ thinkingBudget?: number; reasoningEffort?: string; model?: string; regenerate?: boolean; messageId?: string; edit?: { messageId?: string; content?: string } }>(c)
    // resolveChatUpstream trims the model: anything but a string threw, a bare 500.
    if (nonStringField(b, ['model'])) return err(c, 400, 'invalid_input', 'model must be a string.')

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    // Same remote-or-local resolution as the /messages route above (C-1).
    const resolved = resolveChatUpstream(d, b.model)
    if (!resolved.ok) return err(c, resolved.status, resolved.code, resolved.message)
    const upstream = resolved.upstream

    const busy = inflightRefusal(c, d, convId, 'A generation is already running for this conversation.')
    if (busy) return busy

    // Save & Resend (`edit`): the question is branched only here, once nothing above refused the
    // turn, as Regenerate sets its reply aside below. Sent first as its own request (PUT), a
    // /continue the client then skipped (no model ready) or the daemon refused (a Turbo Link
    // machine asleep, the model gone) left the branch ending on the new question, unanswered: the
    // next send went out as user, user, which alternating-role templates reject on every later
    // turn of that branch. One the engine or the host gives once the turn has started puts the old
    // version and its tail back in runGeneration (edited).
    let edited: GenerationCtx['edited']
    if (b.edit) {
      if (b.regenerate) return err(c, 400, 'invalid_input', 'edit and regenerate cannot be combined.')
      const content = typeof b.edit.content === 'string' ? b.edit.content.trim() : ''
      if (!content) return err(c, 400, 'invalid_input', 'content required.')
      const msg = typeof b.edit.messageId === 'string' ? db.getMessage(b.edit.messageId) : null
      if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
      if (msg.role !== 'user') return err(c, 400, 'invalid_input', 'Only a question can be edited and resent.')
      // As in PUT: only a question on the shown branch.
      if (!msg.isActive) return err(c, 409, 'stale_message', STALE_MESSAGE)
      edited = { from: msg.id, to: branchEditedQuestion(db, convId, msg, content).id }
      conv.messages = db.getMessages(convId)
    }

    const lastUser = (conv.messages ?? []).filter((m) => m.role === 'user').at(-1)
    if (!lastUser) return err(c, 400, 'no_user_message', 'No user message to respond to.')

    // Regenerate (`regenerate: true`, what the web UI sends): the reply it replaces is set aside
    // only here, once nothing above refused the turn. Sent first as its own request
    // (/regenerate), a refusal here (a Turbo Link machine asleep, the model gone) left that reply
    // deactivated with no switcher to bring it back, and the history ending on a user turn. One the
    // engine or the host gives once the turn has started puts it back in runGeneration (replacedId).
    const replaced = b.regenerate ? (conv.messages ?? []).at(-1) : undefined
    // A stale tab or another device still showing an older last reply (a turn was added since)
    // would otherwise replace one it never showed. Without `messageId` (API clients), the last
    // row is replaced, as before.
    if (b.regenerate && b.messageId != null && b.messageId !== replaced?.id)
      return err(c, 409, 'stale_message', 'This reply is no longer the last message on the shown branch: the chat changed in another tab or device.')

    // Chat branching (GitHub #52): the new placeholder joins the variant_group of the reply it
    // replaces, so the client can render a ‹ 1/2 › sibling switcher instead of the old reply
    // simply having vanished.
    let variantGroup: string | undefined
    if (replaced?.role === 'assistant') {
      db.deactivateMessage(replaced.id)
      conv.messages = conv.messages!.filter((m) => m.id !== replaced.id)
      // The group of the reply just set aside (deactivateMessage creates it if it had none) —
      // not the row right after the question: with two replies in a row (a chat routine's
      // tool-call round, then its answer; an OpenAI import's tool-call turn), that row is the
      // first one, still active, so the new reply got no group and the one it replaced sat
      // alone in a group with no active member, which no switcher can reach.
      variantGroup = db.getMessage(replaced.id)!.variantGroup!
    } else {
      // Otherwise, a reply an earlier POST /regenerate deactivated (API clients), if any. Must
      // look specifically at the message immediately after the current active tail
      // (getNextMessageAfterSeq), NOT "whatever has the globally highest seq" — a conversation
      // with more than one branch point can have unrelated, higher-seq messages sitting inactive
      // in a completely different branch.
      const priorVariant = db.getNextMessageAfterSeq(convId, lastUser.seq)
      variantGroup = priorVariant && priorVariant.role === 'assistant' && !priorVariant.isActive
        ? (priorVariant.variantGroup ?? priorVariant.id)
        : undefined
    }

    // Create a placeholder assistant message
    db.addMessage(convId, 'assistant', '', { stats: { aborted: false }, variantGroup })
    const assistantMsg = db.getLastMessage(convId)!

    const ac = new AbortController()
    d.chatTurns.claim(convId, ac, assistantMsg.id)

    // Same per-request code-routine gate as the /messages route above — a regenerated turn can
    // emit tool calls too, so it must not be a softer door onto code-flavor routine authoring.
    const isCodeAuthorized = chatCodeAuthorization(c, d)

    // Run in the daemon, as the /messages route's (its meta reuses the existing last user message id).
    const run = startDetachedTurn(c, d, convId, ac, { userMessageId: lastUser.id, assistantMessageId: assistantMsg.id }, async (sink) => {
      // Auto-compact (ADR-420): checked BEFORE this turn's messages are built, using the
      // history as it stood before this turn's own user+placeholder rows were added —
      // exactly the "last completed turn's usage" the 80% threshold is meant to judge.
      // Same upstream/abort hand-down as the /messages route above — see its comment.
      await maybeAutoCompact(d, convId, conv, upstream, ac.signal, d.chatTurns.autoCompactionPhase(ac, async (phase) => { await sink({ event: 'compaction', data: { phase } }) }))

      // Build messages array for engine from the existing (already-trimmed) history
      // (chat-compaction.ts — folds in the compaction summary + cut when one is
      // resolvable; a plain passthrough when not).
      // `lastUser` is the turn being answered: it goes out with its images and documents, as
      // POST /messages first sent it — the text alone is not what the user asked about.
      const allMsgs = (conv.messages ?? []).filter((m) => m.id !== assistantMsg.id)
      const engineMessages = buildEngineMessages(setAsideFrozenCut(db, conv), allMsgs, lastUser.id, { reasoningField: reasoningAsField(d, upstream) })
      // Its stored images as the data URLs the first send carried (a local engine and a Turbo Link host alike).
      await db.attachments.resolveImages(engineMessages)

      await runGeneration(d, sink, { convId, conv, engineMessages, assistantMsg, upstream, ac, thinkingBudget: b.thinkingBudget ?? -1, reasoningEffort: parseReasoningEffort(b.reasoningEffort), replacedId: replaced?.role === 'assistant' ? replaced.id : undefined, edited, isCodeAuthorized })
    })
    return respondWithChatRun(c, d, run, 0, { synthMeta: false })
  })

  // ── stop (spec 07 §2) ──────────────────────────────────────────────────────

  // Stop is the one thing that stops a reply from a page now that closing or reloading it does not
  // (startDetachedTurn), so it also frees the chat at once, as the page's own disconnect did: a
  // message sent right after Stop would otherwise get 409 until a slow tool call returned.
  // `messageId` (what the web UI sends): stop only that reply, and only while it still holds the
  // chat; a turn another tab or device started since is not this caller's to stop. Without it (an
  // older page, an API client) whatever holds the chat is stopped, as before. `stopped` says
  // whether anything was.
  app.post('/api/v1/chat/stop', async (c) => {
    const b = await body<{ conversationId?: string; messageId?: string }>(c)
    const notString = nonStringField(b, ['conversationId', 'messageId'])
    if (notString) return err(c, 400, 'invalid_input', `${notString} must be a string.`)
    const convId = b.conversationId
    if (!convId) return err(c, 400, 'invalid_input', 'conversationId required.')
    const ac = d.chatTurns.held(convId)
    const target = ac && (b.messageId === undefined || (!d.chatTurns.isCompaction(ac) && d.chatTurns.replyOf(ac) === b.messageId)) ? ac : undefined
    if (target) d.chatTurns.stop(convId, target)
    return c.json({ ok: true, stopped: !!target })
  })

  // A viewer of a chat's running reply (the page reopened, reloaded, or on another tab or device),
  // or the rest of one it was following (a dropped connection; ?run=<reply id>&fromSeq=<next seq>).
  // Inherits conversationGate and models:use (auth.ts), as every route under the chat: a caller
  // attaches only where it can already read the chat. Without `run`, it attaches only to a turn
  // that still holds the chat: a stopped turn still unwinding in a tool call is not shown as
  // running, since its Stop has been answered, and a finished one is in the conversation already
  // (an empty stream). With `run`, it follows that reply to its end while the daemon still has it
  // (30 s after the end), and gets an empty stream after.
  app.get('/api/v1/conversations/:id/stream', (c) => {
    const convId = c.req.param('id')
    if (!db.getConversation(convId)) return err(c, 404, 'not_found', 'Conversation not found.')
    const runId = c.req.query('run') || undefined
    const n = Number.parseInt(c.req.query('fromSeq') ?? '', 10)
    const fromSeq = Number.isFinite(n) && n >= 0 ? n : 0
    const latest = d.chatRuns.latestRun(convId)
    const run = runId !== undefined
      ? d.chatRuns.find(convId, runId) ?? null
      : latest && !latest.ended && d.chatTurns.held(convId) === latest.ac ? latest : null
    return respondWithChatRun(c, d, run, fromSeq, { synthMeta: true })
  })

  // ── message actions B2 ─────────────────────────────────────────────────────

  app.put('/api/v1/conversations/:id/messages/:msgId', async (c) => {
    const { id: convId, msgId } = c.req.param()
    const b = await body<{ content?: string }>(c)
    if (nonStringField(b, ['content'])) return err(c, 400, 'invalid_input', 'content must be a string.')
    const trimmed = b.content?.trim()
    if (!trimmed) return err(c, 400, 'invalid_input', 'content required.')
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    const busy = inflightRefusal(c, d, convId, 'Stop generation first.')
    if (busy) return busy

    if (msg.role === 'assistant') {
      // GitHub #52: edit the model's own reply in place — just fixing text, not resending,
      // so no branching/truncation. (Regenerating a NEW reply is the separate /regenerate flow.)
      // Tag it "edited" so the UI can show that — this route is the ONLY place that ever
      // sets it, unlike the generation-completion save which writes content too.
      db.updateMessage(msgId, { content: trimmed, edited: true })
      return c.json({ messages: forClient(db.getMessages(convId)) })
    }

    // role === 'user': edit-and-resend now BRANCHES instead of destroying the downstream
    // history (GitHub #52) — the old message and everything after it is frozen, not deleted,
    // the same way /regenerate keeps a deactivated reply instead of deleting it.
    // Unchanged text branches too: the client follows every user-message edit with /continue
    // ("Save & Resend"), and an early return here let that answer the same turn a second time —
    // two replies in a row, which Regenerate can't undo and alternating-role templates reject.
    // Only a question on the shown branch: one a stale tab or another device still shows after
    // it was switched away would freeze THIS branch's newer version and its reply under it, and
    // switching back would then show two replies in a row.
    // The web UI's Save & Resend goes through /continue { edit } instead, which branches only once
    // the turn can run; a client that follows this PUT with /continue can still be left with the
    // new question unanswered when that /continue is refused.
    if (!msg.isActive) return err(c, 409, 'stale_message', STALE_MESSAGE)
    branchEditedQuestion(db, convId, msg, trimmed)
    return c.json({ messages: forClient(db.getMessages(convId)) })
  })

  app.delete('/api/v1/conversations/:id/messages/:msgId', (c) => {
    const { id: convId, msgId } = c.req.param()
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    db.deleteMessage(msgId)
    return c.json({ ok: true })
  })

  // Manual compaction (ADR-420) — the header button. Auto-compact (maybeAutoCompact,
  // called from the two turn-starting routes above) is the SAME underlying
  // compactConversation call; this route just exposes it standalone, outside a turn.
  app.post('/api/v1/conversations/:id/compact', async (c) => {
    const convId = c.req.param('id')
    const conv = db.getConversation(convId)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')
    // Resolved HERE, like the two turn routes, rather than left to compactConversation to
    // re-derive: a bare resolveChatUpstream(d) always lands on the local engine, which for a
    // Turbo Link chat means either a hard 'model_not_loaded' or a summary written by an
    // unrelated local model. `b.model` is the picker's CURRENT selection, same as the turn
    // routes read (final-review C-1 / I-A) and same as Code's own /compact (code-routes.ts).
    // Deliberately NOT falling back to `conv.modelKey`: that's frozen at conversation creation
    // while the model picker is global, so it drifts from whatever the chat is actually using —
    // reading it here would silently route (and for a remote pick, send the whole transcript)
    // to a host the chat may no longer be talking to (opus-review I-A′). There's no older
    // client to protect either: the daemon ships its own webdist bundle, so server and client
    // are always in lockstep.
    const b = await body<{ model?: string }>(c)
    if (nonStringField(b, ['model'])) return err(c, 400, 'invalid_input', 'model must be a string.')
    const resolved = resolveChatUpstream(d, b.model)
    if (!resolved.ok) return err(c, resolved.status, resolved.code, resolved.message)
    const busy = inflightRefusal(c, d, convId, 'Stop generation first.')
    if (busy) return busy
    // The compaction holds the conversation's in-flight slot, as a turn does, until it ends: up to
    // a 60 s gate wait plus a 60 s summary call. Only checked before, a version switch, an edit or
    // a Regenerate (from this tab or another) still ran meanwhile; the cut, picked from the branch
    // shown at the start, was then stored on a branch the chat had left, or a turn started a
    // second summarization. Registered like a turn, Stop, the engine kill switches and deleting
    // the chat abort it too. Tagged, so what it holds back answers compaction_in_progress rather
    // than a running turn's text (inflightRefusal).
    const ac = new AbortController()
    d.chatTurns.claimForCompaction(convId, ac)
    try {
      await compactConversation(d, convId, { upstream: resolved.upstream, signal: ac.signal })
    } catch (e) {
      const code = e instanceof Error ? e.message : 'compaction_failed'
      if (code === 'nothing_to_compact') return err(c, 400, 'nothing_to_compact', 'Not enough history yet to compact.')
      return err(c, 500, 'compaction_failed', 'Could not summarize this conversation.')
    } finally {
      d.chatTurns.release(convId, ac)
    }
    return c.json(db.getConversation(convId)!)
  })

  // Undo (ADR-420) — nulls the three compaction columns. No message is touched; this is a
  // pure metadata revert, matching clearConversationCompaction's own doc comment.
  app.delete('/api/v1/conversations/:id/compact', (c) => {
    const convId = c.req.param('id')
    if (!db.getConversation(convId)) return err(c, 404, 'not_found', 'Conversation not found.')
    // Not while a compaction runs (POST /compact, or a turn's own auto-compaction): it stores its
    // summary when it ends, over the columns cleared here, so an Undo made meanwhile was undone.
    // A turn past its compaction stores none, so Undo still goes ahead while a reply streams.
    const held = d.chatTurns.held(convId)
    if (held && (d.chatTurns.isCompaction(held) || d.chatTurns.isAutoCompacting(held))) return err(c, 409, 'compaction_in_progress', COMPACTING_MESSAGE)
    db.clearConversationCompaction(convId)
    return c.json(db.getConversation(convId)!)
  })

  app.post('/api/v1/conversations/:id/regenerate', (c) => {
    const convId = c.req.param('id')
    const busy = inflightRefusal(c, d, convId, 'Stop generation first.')
    if (busy) return busy
    const last = db.getLastMessage(convId)
    // Chat branching (GitHub #52): deactivate rather than delete — the old reply is kept
    // as a sibling variant, not destroyed. /continue (called next by the client) creates
    // the new reply and joins it to the same variant_group. The web UI no longer calls this:
    // it sends /continue { regenerate: true }, which deactivates only once the turn can run.
    if (last?.role === 'assistant') db.deactivateMessage(last.id)
    return c.json({ ok: true })
  })

  // Chat branching: list all siblings (active + inactive) for the ‹ 1/2 › switcher UI.
  app.get('/api/v1/conversations/:id/messages/:msgId/variants', (c) => {
    const { id: convId, msgId } = c.req.param()
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    if (!msg.variantGroup) return c.json({ variants: forClient([msg]) })
    return c.json({ variants: forClient(db.getMessageVariants(msg.variantGroup)) })
  })

  // Chat branching: switch which sibling in a variant group is the active one. This also
  // swaps the entire downstream tail (freeze the one we're leaving, restore the one we're
  // entering) — for an assistant-reply group too: /regenerate only acts on the last message,
  // but the chat can go on after it, so an older reply's variants each have their own tail.
  app.post('/api/v1/conversations/:id/messages/:msgId/activate', (c) => {
    const { id: convId, msgId } = c.req.param()
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    if (!msg.variantGroup) return err(c, 400, 'invalid_input', 'Message has no alternate versions.')
    const busy = inflightRefusal(c, d, convId, 'Stop generation first.')
    if (busy) return busy
    if (msg.isActive) return c.json({ messages: forClient(db.getMessages(convId)) }) // already active, no-op

    const currentActive = db.getMessageVariants(msg.variantGroup).find((v) => v.isActive)
    // A group with no active member is not on the shown branch (a stale tab or another device
    // still shows it): activating one would splice it, and its frozen tail, into this branch.
    if (!currentActive) return err(c, 409, 'stale_message', STALE_MESSAGE)
    // One transaction: a switch that failed partway (disk full, an I/O error) left this branch's
    // tail frozen with the version it belongs to still shown, or the other version's tail restored
    // next to it.
    const group = msg.variantGroup
    const ok = db.transaction(() => {
      db.freezeTail(convId, currentActive.seq, currentActive.id)
      db.restoreTail(msgId)
      return db.setActiveVariant(group, msgId)
    })
    if (!ok) return err(c, 500, 'internal', 'Could not switch branch.')
    return c.json({ messages: forClient(db.getMessages(convId)) })
  })

  // ── F-023: export / debug snapshot ────────────────────────────────────────
  // GET /api/v1/conversations/:id/export?format=debug|export
  // Returns the chat as a portable JSON snapshot. format=export adds a
  // Content-Disposition download header so the browser saves it as a file.
  app.get('/api/v1/conversations/:id/export', (c) => {
    const convId = c.req.param('id')
    const formatParam = c.req.query('format')
    const format: ExportFormat = formatParam === 'export' ? 'export' : 'debug'

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    const cfg = d.store.snapshot()
    const exportedAt = new Date().toISOString()
    const snap = buildSnapshot(conv as Parameters<typeof buildSnapshot>[0], cfg, d.version, exportedAt, format)
    const json = JSON.stringify(snap, null, 2)

    if (format === 'export') {
      const safeTitle = conv.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'chat'
      const dateStr = exportedAt.slice(0, 10)
      const filename = `${safeTitle}-${dateStr}.turbollm-chat.json`
      c.header('Content-Disposition', `attachment; filename="${filename}"`)
    }

    c.header('Content-Type', 'application/json')
    return c.body(json)
  })

  // ── F-023: share URL for a conversation ──────────────────────────────────
  // GET /api/v1/conversations/:id/share-url
  // Returns { url } — the LAN-accessible read-only link to this chat.
  app.get('/api/v1/conversations/:id/share-url', (c) => {
    const convId = c.req.param('id')
    const conv = db.getConversation(convId)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    const cfg = d.store.snapshot()
    // The port really bound, not daemon.port: `--port`/`--addr` (the Android app's 7000) win over config.
    const share = getShareTarget(d.bindPort ?? cfg.daemon.port)
    const url = `http://${share.host}:${share.port}/chat/${convId}`
    return c.json({ url, onlyLocal: share.onlyLocal })
  })

  // ── F-024 / F-036: import chat ────────────────────────────────────────────
  // POST /api/v1/conversations/import   (application/json)
  // Auto-detects the payload shape and routes to the correct import path:
  //   • Array                          → OpenAI bare-array format   (F-036)
  //   • Object with format=debug|export → proprietary .turbollm-chat.json (F-024)
  //   • Object with messages but no format → OpenAI object format   (F-036)
  // Returns { id } with 201 on success.
  app.post('/api/v1/conversations/import', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return err(c, 400, 'invalid_file', 'Body must be valid JSON.')
    }

    // ── Route: OpenAI bare-array format ──────────────────────────────────────
    if (Array.isArray(raw)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return importOpenAiMessages(c, db, raw as Array<Record<string, unknown>>, undefined, undefined) as any
    }

    if (typeof raw !== 'object' || raw === null) {
      return err(c, 400, 'invalid_file', 'Body must be a JSON array or object.')
    }

    const payload = raw as Record<string, unknown>

    // ── Route: proprietary .turbollm-chat.json (F-024) ──────────────────────
    if (payload.format === 'debug' || payload.format === 'export') {
      if (!Array.isArray(payload.messages)) {
        return err(c, 400, 'invalid_file', 'Missing "messages" array.')
      }
      if (typeof payload.chat_id !== 'string') {
        return err(c, 400, 'invalid_file', 'Missing "chat_id" field.')
      }
      if (typeof payload.title !== 'string') {
        return err(c, 400, 'invalid_file', 'Missing "title" field.')
      }

      const title = (payload.title as string) || 'Imported chat'
      const modelKey = typeof payload.model === 'string' ? payload.model : ''
      const personaId = typeof payload.persona === 'string' ? payload.persona : 'default'
      const toolPolicy = personaId === 'research' ? 'force_web_search' : undefined

      const newConv = db.createConversation({ title, modelKey, toolPolicy })

      const messages = payload.messages as Array<Record<string, unknown>>
      for (const m of messages) {
        const role = m.role as string
        if (role !== 'user' && role !== 'assistant') continue
        const content = typeof m.content === 'string' ? m.content : ''
        const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls as ToolCallRecord[] : undefined
        db.addMessage(newConv.id, role as 'user' | 'assistant', content, {
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        })
      }

      return c.json({ id: newConv.id }, 201)
    }

    // ── Route: OpenAI object format (has messages, no format field) (F-036) ──
    if (Array.isArray(payload.messages)) {
      const titleField = typeof payload.title === 'string' ? payload.title : undefined
      const modelField = typeof payload.model === 'string' ? payload.model : undefined
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return importOpenAiMessages(c, db, payload.messages as Array<Record<string, unknown>>, titleField, modelField) as any
    }

    return err(c, 400, 'invalid_file', 'Unrecognised format. Expected a .turbollm-chat.json file or an OpenAI-format JSON (array or object with "messages" array).')
  })
}

// ── F-036: OpenAI-format import helper ───────────────────────────────────────
// Shared by both the bare-array and object-with-messages paths.
// system messages are skipped (TurboLLM has no system-role message rows).
// Array content (OpenAI vision format) is coerced to a plain string by joining text parts.

function coerceContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // OpenAI vision format: [{ type: 'text', text: '...' }, { type: 'image_url', ... }]
    return content
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(content ?? '')
}

function deriveTitle(
  titleField: string | undefined,
  messages: Array<Record<string, unknown>>,
): string {
  if (titleField?.trim()) return titleField.trim().slice(0, 60)
  // Derive from first user (or any meaningful) message
  for (const m of messages) {
    const role = m.role as string
    if (role !== 'user' && role !== 'assistant') continue
    const text = coerceContent(m.content).trim()
    if (text) {
      const truncated = text.replace(/\s+/g, ' ').slice(0, 60)
      return truncated
    }
  }
  return 'Imported chat'
}

function importOpenAiMessages(
  c: Context,
  db: ConversationStore,
  messages: Array<Record<string, unknown>>,
  titleField: string | undefined,
  modelField: string | undefined,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // Filter to only user/assistant rows (skip system and unknown)
  const usable = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (usable.length === 0) {
    return err(c, 400, 'invalid_file', 'No usable messages found (must have at least one user or assistant message).')
  }

  const title = deriveTitle(titleField, messages)
  const modelKey = modelField ?? ''

  const newConv = db.createConversation({ title, modelKey })

  for (const m of usable) {
    const role = m.role as 'user' | 'assistant'
    const content = coerceContent(m.content)
    db.addMessage(newConv.id, role, content)
  }

  return c.json({ id: newConv.id }, 201)
}

// ── LAN share target (F-023) ───────────────────────────────────────────────────

/** Host + port to advertise in a chat share URL, and whether that URL is loopback-only
 *  (which the UI surfaces as "this link only works on this machine").
 *
 *  The operator's `TURBOLLM_ADVERTISED_HOST` override (see net.ts) wins over LAN
 *  auto-detection: running inside a container, `getLanIp()` returns the container-internal
 *  bridge address, which is unreachable from the phone the user wants to open the link on.
 *  An explicit override is by definition not loopback-only — the operator stated the
 *  address others should use — so `onlyLocal` is false whenever one is set. The override
 *  may name its own (published) port; without one, keep the daemon's. */
function getShareTarget(defaultPort: number): { host: string; port: number; onlyLocal: boolean } {
  const advertised = getAdvertisedHost()
  if (advertised) return { host: advertised.host, port: advertised.port ?? defaultPort, onlyLocal: false }
  const host = getLanIp() ?? '127.0.0.1'
  return { host, port: defaultPort, onlyLocal: host === '127.0.0.1' }
}

// ── shared generation streaming ───────────────────────────────────────────────


interface GenerationCtx {
  convId: string
  conv: NonNullable<ReturnType<Deps['db']['getConversation']>>
  engineMessages: EngineMessage[]
  assistantMsg: NonNullable<ReturnType<Deps['db']['getLastMessage']>>
  /** Where this turn generates — the local engine, or a linked host (chat-upstream.ts).
   *  `upstream.remote` is the single test for "another machine did the work", which every
   *  local ledger below branches on. */
  upstream: ChatUpstream
  ac: AbortController
  /** Reasoning token budget for this turn: -1 = unlimited (default), 0 = thinking off
   *  entirely, N>0 = a real sampler-enforced cap. Sent to the engine as
   *  `thinking_budget_tokens` (0 additionally sets `chat_template_kwargs.enable_thinking:
   *  false`, mirroring the params autoTitle uses). */
  thinkingBudget: number
  /** Qwen3.8's chat-template reasoning_effort control (low/medium/xhigh) — independent of
   *  thinkingBudget (see ReasoningEffortSelect.tsx). Undefined = don't send the field at
   *  all, which is also what an unrecognized/absent client value parses to
   *  (parseReasoningEffort), so a bad value never reaches the engine. */
  reasoningEffort: ReasoningEffort | undefined
  /** Release 3, auto-memory: the clean, just-typed user text (never docContext/attachments/
   *  tool output) for this turn. Undefined on regenerate — no new user text exists there,
   *  so extraction is skipped by design (also avoids re-extracting already-scanned text). */
  userText?: string
  /** Regenerate (/continue { regenerate: true }): the reply this turn set aside, which a turn the
   *  engine or linked host refuses before producing anything shows again (see restoreReplaced). */
  replacedId?: string
  /** Save & Resend (/continue { edit }): the question version this turn set aside with its tail
   *  (`from`) and the new version it answers (`to`). A turn the engine or linked host refuses
   *  before producing anything drops `to` and shows `from` and its tail again (restoreReplaced). */
  edited?: { from: string; to: string }
  /** Phase 4 / C1: whether THIS request's caller cleared the code-execution bar (host-local or a
   *  valid API key), computed by the route handler — the only place a Hono `Context` exists — and
   *  carried down here because runGeneration is Context-free by design. Forwarded verbatim to
   *  executeToolCallWithApproval, which hands it to ToolRegistry.executeTool; there only
   *  create_routine/update_routine/run_routine_now read it, and only for code-flavor routines.
   *  runGeneration itself reads it for save_skill and MCP server tools: the same bar as
   *  isLocalOrAuthenticated, which POST /api/v1/skills and /api/v1/mcp/servers hold their
   *  callers to. */
  isCodeAuthorized: boolean
}

// The sink guard and the engine-error type live with the loop (generation-core.ts); exported here as before.
export { resilientSink, EngineStreamError } from './generation-core'

/** Whether this turn's past reasoning goes to the engine as each message's `reasoning_content` rather than folded into
 *  its text (buildEngineMessages): this machine's LiteRT-LM engine, whose bundle templates decide what of it the model
 *  sees. A linked host's engine is not this machine's to judge: it keeps the fold. */
function reasoningAsField(d: Deps, upstream: ChatUpstream): boolean {
  return !upstream.remote && servingEngineKind(d) === 'litert-lm'
}

// The engine's error, read and shown as every path shows it (engines/engine-error.ts).
export { streamChunkError, engineErrorText } from '../engines/engine-error'

/** The whole generation turn: engine call(s), tool loop, and the ONE write-back that persists
 *  the reply. Exported ONLY so tests can drive it with a sink of their own — the persistence
 *  invariant this function owns (GitHub #177: generated output must survive a failing sink, an
 *  engine that dies mid-stream, and a Stop click) is not reachable through the route, whose sink
 *  is the turn's run (chat-runs.ts), which never fails. Not part of any public API. */
export async function runGeneration(d: Deps, emit: EmitSink, ctx: GenerationCtx): Promise<void> {
  const { db } = d
  const { convId, conv, assistantMsg, upstream, ac } = ctx
  // A remote turn's approval wait is not this machine's engine work (chatTurns.setApprovalWait).
  const localAccounting = !upstream.remote

  /** Regenerate (`ctx.replacedId`): /continue sets the old reply aside only once the turn can run,
   *  but the engine or a linked host can still refuse it after that: an HTTP error (a 503 while a
   *  model loads, a host that unloaded it), a fetch that throws (a host asleep since its last probe,
   *  an engine that died), an error chunk in the stream. Such a turn left the old reply behind the
   *  version switcher and an empty reply shown in its place. When the turn produced nothing (no
   *  text, reasoning or tool call, nothing still held back by the parser), the empty placeholder is
   *  deleted and the old reply shown again, before the error is sent, so the client's refetch on it
   *  already sees the reply back. Only while both rows are as this turn left them (a DELETE of
   *  either during the turn stands). Never throws: the core's catch calls it, where nothing may.
   *  Save & Resend (`ctx.edited`) the same: such a turn left the new question shown with an empty
   *  reply, and the old version and its replies behind the question's switcher. The new version is
   *  deleted with the placeholder, not kept beside the old one: switched to, it would show a
   *  question with no reply, and the next send would go out as user, user. */
  const restoreUnproduced = (): boolean => {
    if (!ctx.replacedId && !ctx.edited) return false
    try {
      const placeholder = db.getMessage(assistantMsg.id)
      if (!placeholder?.isActive) return false
      if (ctx.edited) {
        const from = db.getMessage(ctx.edited.from)
        const to = db.getMessage(ctx.edited.to)
        const group = from?.variantGroup
        if (!group || from.isActive || !to?.isActive || to.variantGroup !== group) return false
        db.transaction(() => {
          db.deleteMessage(assistantMsg.id)
          db.deleteMessage(to.id)
          db.restoreTail(from.id)
          db.setActiveVariant(group, from.id)
        })
        return true
      }
      const replaced = db.getMessage(ctx.replacedId!)
      const group = replaced?.variantGroup
      if (!group || placeholder.variantGroup !== group) return false
      db.transaction(() => {
        db.deleteMessage(assistantMsg.id)
        db.setActiveVariant(group, replaced.id)
      })
      return true
    } catch {
      return false // rolled back: the turn ends as before, its empty reply shown
    }
  }

  const outcome = await runGenerationCore(d, ctx, {
    sink: emit,
    persistence: {
      saveProgress: (reply) => { db.updateMessage(assistantMsg.id, reply) },
      trackProgressSave: (save) => {
        d.chatTurns.addReplySave(save)
        return () => d.chatTurns.removeReplySave(save)
      },
      restoreUnproduced,
      finalize: (reply) => {
        db.updateMessage(assistantMsg.id, reply)
        db.touchConversation(convId)
        return db.getMessage(assistantMsg.id)!
      },
    },
    // Live foreground chat gets the real approval gate (interactive: true) — an
    // 'ask'-policy tool prompts the user via 'tool_call'/'awaiting_approval' and
    // waits for POST .../tool-calls/:toolCallId/approve to resolve it.
    approval: {
      interactive: true,
      // Re-read fresh on every iteration (not the `conv` snapshot captured at request
      // start) — otherwise a same-turn repeat tool call misses an "Allow for this
      // chat" decision the user just made via POST .../tool-calls/:id/approve.
      convOverrides: () => db.getToolOverrides(convId),
      // How long the reply waits for its answers (Settings → Tool permissions), read as its
      // first call reaches its wait and shared by its calls (approvalBudget): a reply whose
      // calls nobody answers then goes on as after a deny instead of holding the chat (and on
      // Android the model and the wake lock), after one wait however often the model asks.
      approvalWaitMinutes: () => d.store.snapshot().tools.chatApprovalWaitMinutes ?? CHAT_APPROVAL_WAIT_MINUTES.default,
      // Parked on the approval meanwhile: the activity probe lists the chat as waiting.
      onApprovalWait: (waiting) => {
        d.chatTurns.setApprovalWait(ac, waiting, localAccounting)
      },
      // The real per-request trust decision this handler's route computed from its Hono
      // Context (see the `chatCodeAuthorization(c, d)` call sites) — never a hardcoded true.
      isCodeAuthorized: ctx.isCodeAuthorized,
      // An MCP call the model makes anyway, unoffered, is refused before any approval prompt.
      refuseMcp: !ctx.isCodeAuthorized,
    },
    onSettled: () => d.chatTurns.release(convId, ac),
    onSaveSkill: () => saveSkillFromConversation(d, convId),
  })
  // The placeholder is gone and the old reply back (restoreUnproduced): nothing to title or remember.
  if (outcome.restored) return
  const { aborted, content: fullContent } = outcome

  if (!aborted && conv.title === 'New chat' && d.store.snapshot().daemon.autoGenerateTitles) {
    d.chatTurns.afterReplyCall(convId, 1000, () => autoTitle(d, convId, ctx.engineMessages, fullContent, upstream))
  }

  // Release 3, auto-memory: extract durable facts from the just-typed user text (never
  // fires on regenerate, where ctx.userText is unset). Staggered slightly after autoTitle's
  // own setTimeout so the two out-of-band calls don't hit the engine on the exact same tick
  // — not load-bearing, both are fire-and-forget. Two-layer gate (2026-07-14): `experimental.
  // memory` is the master "is this feature unlocked at all" switch (Settings → Experimental);
  // `autoMemoryEnabled` is the finer opt-in within that (Settings → General's MemorySection,
  // which itself only renders when experimental.memory is on). Both must be true — the founder
  // was explicit that turning Memory off in Experimental must actually stop it acting, not just
  // hide its settings UI while extraction keeps running underneath.
  const daemonCfg = d.store.snapshot().daemon
  if (!aborted && ctx.userText && daemonCfg.experimental.memory && daemonCfg.autoMemoryEnabled) {
    d.chatTurns.afterReplyCall(convId, 1500, () => extractMemoryFacts(d, convId, ctx.userText!, upstream))
  }}

// ── auto title generation ──────────────────────────────────────────────────

/** PURE: the last `n` actual conversation turns to ground title generation in — excludes the
 *  injected system prompt (capability boilerplate + persona + personalization + auto-memory
 *  facts, see buildSystemPrompt). For a BRAND NEW conversation — exactly when auto-title fires —
 *  engineMessages is just [system, user], so a plain `.slice(-n)` grabs the memory-stuffed
 *  system message right alongside the real first message. A model handed a hefty "what I know
 *  about you" block next to one short user turn often titled the chat off THAT instead of what
 *  was actually asked (GitHub: "gets title based on memory and not based on msg I send"). */
export function recentTitleTurns(messages: { role: string; content: unknown }[], n = 2): { role: string; content: unknown }[] {
  return messages.filter((m) => m.role !== 'system').slice(-n)
}

async function autoTitle(
  d: Deps,
  convId: string,
  prevMessages: { role: string; content: unknown }[],
  assistantReply: string,
  upstream: ChatUpstream,
): Promise<void> {
  try {
    // The local-engine guard is exactly that — local. A remote turn's title is generated on
    // the host, which has its own model up; this machine's engine may legitimately be
    // stopped, and returning here would leave every remote conversation called "New chat".
    if (!upstream.remote && d.manager.status().state !== 'running') return
    const titleMessages = [
      ...recentTitleTurns(prevMessages),
      { role: 'assistant', content: assistantReply.slice(0, 500) },
      {
        role: 'user',
        // /no_think disables thinking on Qwen-style templates; chat_template_kwargs
        // below covers the rest; any leaked <think> is stripped from the output.
        content: 'Generate a concise 3-6 word title for this conversation. Reply with ONLY the title — no quotes, no punctuation, no preamble. /no_think',
      },
    ]
    // Title generation is a LOW-PRIORITY afterthought — acquire the engine gate at 'bg' so
    // any foreground chat or agent run preempts it (it never blocks real work), and release
    // as soon as the small call returns.
    // The local engine's slot queue is for local work — a remote title costs this machine
    // nothing but a socket (final-review I-3, same rule as the gateway).
    const release = d.gate && !upstream.remote ? await d.gate.acquire('bg') : null
    let res: Response
    try {
      res = await callChatUpstream(upstream, {
        model: upstream.modelField,
        messages: titleMessages,
        stream: false,
        temperature: 0.3,
        max_tokens: 32,
        thinking_budget_tokens: 0,
        chat_template_kwargs: { enable_thinking: false },
      }, AbortSignal.timeout(20_000), undefined, d)
    } finally {
      release?.()
    }
    if (!res.ok) return
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let raw = data.choices?.[0]?.message?.content ?? ''
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() // strip any leaked reasoning
    let title = raw.replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!?]+$/, '').trim().slice(0, 60)
    // Fallback: a snippet of the first user message if the model gave nothing usable.
    if (!title) {
      const firstUser = prevMessages.find((m) => m.role === 'user')?.content
      if (typeof firstUser === 'string') {
        title = firstUser.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 60)
      }
    }
    if (title && d.db.getConversation(convId)?.title === 'New chat') {
      d.db.updateConversation(convId, { title })
    }
  } catch { /* silently ignore */ }
}

/** Auto-title a conversation from its persisted transcript (used by agent runs, which
 *  don't go through the chat message endpoint). No-op unless the title is still default
 *  and the setting is on. Best-effort. */
export async function autoTitleFromConversation(d: Deps, convId: string): Promise<void> {
  const conv = d.db.getConversation(convId, true)
  if (!conv || conv.title !== 'New chat' || !d.store.snapshot().daemon.autoGenerateTitles) return
  // Agent runs are always local — they execute on this machine's own filesystem — so this
  // resolves the local engine, exactly as the `d.manager.target()` call it replaces did.
  const resolved = resolveChatUpstream(d)
  if (!resolved.ok) return
  const msgs = (conv.messages ?? []).filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }))
  if (!msgs.length) return
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
  await autoTitle(d, convId, msgs.slice(0, -1), typeof lastAssistant?.content === 'string' ? lastAssistant.content : '', resolved.upstream)
}
