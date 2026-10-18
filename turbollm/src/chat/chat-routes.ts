// Chat API routes (spec 07). Conversations CRUD + SSE streaming send + message actions.
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'
import { resolveKey, grantKind, hostGate, isLocalOrAuthenticated } from '../auth'
import { getAdvertisedHost, getLanIp } from '../net'
import { clampMaxTokens } from '../config/config'
import { feedChunk, flushState, initParseState, type ParseState } from './parser'
import { needsExtraPass } from './think-utils'
import { parseReasoningEffort, type ReasoningEffort } from './reasoning-effort'
import { sseSink, type EmitSink } from './emit-sink.js'
import { buildEngineMessages, maybeAutoCompact, compactConversation, setAsideFrozenCut, userTurnContent } from './chat-compaction.js'

import type { ClaimVerdict, ConversationStore, Message, MessageStats, ResearchMeta, ResearchSource, ToolCallRecord } from './db'
import { checkReply } from '../tools/research-referee.js'
import { buildSnapshot } from './chat-export'
import type { ExportFormat } from './chat-export'
import { executeToolCallWithApproval } from '../tools/execute-with-approval'
import { pendingToolApprovalName, resolveToolApproval } from '../tools/approval-gate'
import { isMcpToolName, listsMcpTool, MCP_APPROVAL_REFUSED_MESSAGE } from '../tools/tool-registry'
import { buildSaveSkillTool } from '../agents/agent-tools'
import { SkillStore } from '../agents/skills'
import { saveSkillFromConversation, SKILL_AUTHORING_REFUSED } from '../agents/skill-jobs'
import { extractMemoryFacts } from './memory'
import { codeGateBlocks } from '../routines/routine-routes'
import { emitBenchResult } from '../telemetry/runtime/typed-emit'
import { buildBenchResultConfig } from '../telemetry/events/perf'
import { shouldEmitBenchResult, benchRateLimitKey, MIN_GEN_TOKENS_FOR_BENCH } from '../telemetry/runtime/bench-rate-limit'
import { resolveProfile, type LoadProfile } from '../models/profile'
import type { ModelInfo } from '../engines/manager'
import { litertLmPrefillStats, litertLmTurnErrorMessage } from '../engines/litert-lm'
import { getModelProfile } from '../config/config'
import { getSysInfo } from '../sysinfo/sysinfo'
import { noteLocalActivity } from '../link/host-idle'
import { callChatUpstream, resolveChatUpstream, type ChatUpstream } from './chat-upstream'
import { servingEngine, servingEngineKind } from '../engines/serving'
import { redactLocalPaths } from '../util/redact-paths'
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

// Track in-flight abort controllers per conversation id.
const inflight = new Map<string, AbortController>()

/** Abort every in-flight chat generation. Called when the user takes over the engine
 *  (load / stop / restart) — those are kill switches: they must stop all other in-app
 *  model calls, not leave streams hanging against an engine that's going away. */
export function abortAllInFlightChats(): number {
  const n = inflight.size
  for (const ac of inflight.values()) ac.abort()
  inflight.clear()
  return n
}

/** The conversations with a generation in flight — exactly the chats abortAllInFlightChats()
 *  would abort. Read by the active-work probe (ADR-434 (i)(3)). */
export function inFlightChatIds(): string[] {
  return [...inflight.keys()]
}

/** Removes `convId`'s entry only while it is still `ac`'s own. A client disconnect or a kill
 *  switch drops the entry at once, but the aborted turn can keep unwinding for a long time
 *  (a tool call is not interrupted by the abort) — by the time it does, the entry may belong
 *  to the NEXT turn, which an unconditional delete would leave untracked: unreachable by Stop
 *  and the kill switches, invisible to inFlightChatIds, and no longer a 409 guard. */
function releaseInflight(convId: string, ac: AbortController): void {
  if (inflight.get(convId) === ac) inflight.delete(convId)
}

/** The in-flight entries POST /compact took. A manual compaction holds the chat's slot as a turn
 *  does, so every route refuses meanwhile, but with a turn's text ('Stop generation first.', 'A
 *  generation is already running') the web UI toasted it over a chat showing only its Compacting
 *  banner and no Stop. Keyed by the entry itself, not the chat, so the tag goes with it. */
const compactions = new WeakSet<AbortController>()
const COMPACTING_MESSAGE = 'This chat is being compacted. Try again when it finishes.'

/** The in-flight entries of turns whose own auto-compaction (maybeAutoCompact) is running. Only
 *  compaction Undo reads it (the other routes answer such a turn as a running one), since that
 *  compaction stores its summary over an Undo made meanwhile, as a manual one does. */
const autoCompactions = new WeakSet<AbortController>()
/** A turn's maybeAutoCompact phase callback: tags the turn's entry while its compaction runs,
 *  then tells the client. Tagged first, so a write that fails (client gone) still tags it;
 *  maybeAutoCompact sends 'end' after every 'start', the compaction failed or not. */
function autoCompactionPhase(ac: AbortController, write: (phase: 'start' | 'end') => Promise<void>) {
  return (phase: 'start' | 'end') => {
    if (phase === 'start') autoCompactions.add(ac)
    else autoCompactions.delete(ac)
    return write(phase)
  }
}

/** The 409 for a chat whose in-flight slot is taken, or null when it is free: compaction_in_progress
 *  while a manual compaction holds it, otherwise generation_in_flight with the route's own text. */
function inflightRefusal(c: Context, convId: string, turnMessage: string) {
  const held = inflight.get(convId)
  if (!held) return null
  if (compactions.has(held)) return err(c, 409, 'compaction_in_progress', COMPACTING_MESSAGE)
  return err(c, 409, 'generation_in_flight', turnMessage)
}

/** A turn route's streamSSE callback, releasing its in-flight entry however the callback
 *  exits: runGeneration's own finally only covers a turn that reached it, and a throw before
 *  that (e.g. a malformed request body) left the chat answering 409 until a restart. */
function releasingInflight<T>(convId: string, ac: AbortController, cb: (stream: T) => Promise<void>): (stream: T) => Promise<void> {
  return async (stream) => {
    try { await cb(stream) } finally { releaseInflight(convId, ac) }
  }
}

// 503 joined the set with Turbo Link: a linked machine that is offline, or no longer
// advertising the model, is a REMOTE availability failure, not a local 409.
// 403 joined with ADR-422's N2 fix: a remote-access token is authenticated but
// deliberately refused a specific action (persisting a global tool policy).
type S = 200 | 201 | 202 | 400 | 403 | 404 | 409 | 500 | 503
function err(c: Context, s: S, code: string, msg: string) { return c.json({ error: { code, message: msg } }, s) }
async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

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

  app.get('/api/v1/memory', (c) => c.json({ facts: db.listMemoryFacts() }))

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

  app.get('/api/v1/conversations', (c) => {
    const q = c.req.query('q')
    return c.json({ conversations: db.listConversations(q, 'chat') })
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
    const conv = db.getConversation(c.req.param('id'), true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')
    // The compaction as the turns see it: one cut on a branch the user left is not this
    // branch's, so the chat shows no divider, summary or Undo for it (Undo would delete the
    // other branch's compaction) and the meter shows its measured reading, no projection. (The
    // daemon's auto-compaction gate can judge this branch larger than that reading: see
    // maybeAutoCompact, which raises it to the estimated size of the full history replayed.)
    const shown = setAsideFrozenCut(db, conv)
    return c.json({ ...shown, messages: forClient(shown.messages ?? []) })
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
    inflight.get(c.req.param('id'))?.abort()
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

    const busy = inflightRefusal(c, convId, 'A generation is already running for this conversation.')
    if (busy) return busy

    // Persist user message — only the typed text is stored as content; images are
    // kept in attachments (the full doc context is folded into the engine prompt below,
    // and kept in docContext so /continue can send this turn again with it).
    const userMsg = db.addMessage(convId, 'user', content, { attachments: images, textAttachments, docContext: b.docContext })

    // Create a placeholder assistant message
    db.addMessage(convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = db.getLastMessage(convId)!

    const ac = new AbortController()
    inflight.set(convId, ac)

    // Phase 4 / C1: the code-flavor routine gate, decided HERE because this is the last point
    // that still has the Hono Context. `chatCodeAuthorization` wraps routine-routes.ts's own
    // `codeGateBlocks` — POST/PUT /api/v1/routines enforce the identical decision, so the chat
    // tool surface cannot become a softer door onto it. This route is behind lanAuth only (which
    // has an "open LAN" bypass codeAuth does not), so a keyless LAN caller must land on `false`
    // here. Call the named function; never re-inline the expression (see its doc comment, I1).
    const isCodeAuthorized = chatCodeAuthorization(c, d)

    return streamSSE(c, releasingInflight(convId, ac, async (stream) => {
      stream.onAbort(() => { ac.abort(); releaseInflight(convId, ac) })

      // Emit meta event
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ userMessageId: userMsg.id, assistantMessageId: assistantMsg.id }) })

      // Auto-compact (ADR-420): checked BEFORE this turn's messages are built, using the
      // history as it stood before this turn's own user+placeholder rows were added —
      // exactly the "last completed turn's usage" the 80% threshold is meant to judge.
      // `upstream` is THIS turn's already-resolved upstream (local or linked host) and `ac`
      // is its abort — both are handed down rather than re-derived, so a Turbo Link chat
      // summarizes on the host it is actually talking to and Stop can interrupt the wait.
      await maybeAutoCompact(d, convId, conv, upstream, ac.signal, autoCompactionPhase(ac, (phase) => stream.writeSSE({ event: 'compaction', data: JSON.stringify({ phase }) })))

      // Build messages array for engine (chat-compaction.ts — folds in the compaction
      // summary + cut when one is resolvable; a plain passthrough when not).
      // setAsideFrozenCut: a cut left behind on another branch is not this branch's summary.
      const allMsgs = (conv.messages ?? []).filter(m => m.id !== assistantMsg.id)
      const engineMessages = buildEngineMessages(setAsideFrozenCut(db, conv), allMsgs)
      // Fold any attached document text into the prompt; attach images as multimodal parts.
      engineMessages.push({ role: 'user', content: userTurnContent(content, b.docContext, images) })

      await runGeneration(d, sseSink(stream), { convId, conv, engineMessages, assistantMsg, upstream, ac, thinkingBudget: b.thinkingBudget ?? -1, reasoningEffort: parseReasoningEffort(b.reasoningEffort), userText: content, isCodeAuthorized })
    }))
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

    const busy = inflightRefusal(c, convId, 'A generation is already running for this conversation.')
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
    inflight.set(convId, ac)

    // Same per-request code-routine gate as the /messages route above — a regenerated turn can
    // emit tool calls too, so it must not be a softer door onto code-flavor routine authoring.
    const isCodeAuthorized = chatCodeAuthorization(c, d)

    return streamSSE(c, releasingInflight(convId, ac, async (stream) => {
      stream.onAbort(() => { ac.abort(); releaseInflight(convId, ac) })

      // Emit meta event (no new user message — reuse the existing last user message id)
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ userMessageId: lastUser.id, assistantMessageId: assistantMsg.id }) })

      // Auto-compact (ADR-420): checked BEFORE this turn's messages are built, using the
      // history as it stood before this turn's own user+placeholder rows were added —
      // exactly the "last completed turn's usage" the 80% threshold is meant to judge.
      // Same upstream/abort hand-down as the /messages route above — see its comment.
      await maybeAutoCompact(d, convId, conv, upstream, ac.signal, autoCompactionPhase(ac, (phase) => stream.writeSSE({ event: 'compaction', data: JSON.stringify({ phase }) })))

      // Build messages array for engine from the existing (already-trimmed) history
      // (chat-compaction.ts — folds in the compaction summary + cut when one is
      // resolvable; a plain passthrough when not).
      // `lastUser` is the turn being answered: it goes out with its images and documents, as
      // POST /messages first sent it — the text alone is not what the user asked about.
      const allMsgs = (conv.messages ?? []).filter((m) => m.id !== assistantMsg.id)
      const engineMessages = buildEngineMessages(setAsideFrozenCut(db, conv), allMsgs, lastUser.id)

      await runGeneration(d, sseSink(stream), { convId, conv, engineMessages, assistantMsg, upstream, ac, thinkingBudget: b.thinkingBudget ?? -1, reasoningEffort: parseReasoningEffort(b.reasoningEffort), replacedId: replaced?.role === 'assistant' ? replaced.id : undefined, edited, isCodeAuthorized })
    }))
  })

  // ── stop (spec 07 §2) ──────────────────────────────────────────────────────

  app.post('/api/v1/chat/stop', async (c) => {
    const b = await body<{ conversationId?: string }>(c)
    const convId = b.conversationId
    if (!convId) return err(c, 400, 'invalid_input', 'conversationId required.')
    const ac = inflight.get(convId)
    if (ac) ac.abort()
    return c.json({ ok: true })
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
    const busy = inflightRefusal(c, convId, 'Stop generation first.')
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
    const busy = inflightRefusal(c, convId, 'Stop generation first.')
    if (busy) return busy
    // The compaction holds the conversation's in-flight slot, as a turn does, until it ends: up to
    // a 60 s gate wait plus a 60 s summary call. Only checked before, a version switch, an edit or
    // a Regenerate (from this tab or another) still ran meanwhile; the cut, picked from the branch
    // shown at the start, was then stored on a branch the chat had left, or a turn started a
    // second summarization. Registered like a turn, Stop, the engine kill switches and deleting
    // the chat abort it too. Tagged, so what it holds back answers compaction_in_progress rather
    // than a running turn's text (inflightRefusal).
    const ac = new AbortController()
    compactions.add(ac)
    inflight.set(convId, ac)
    try {
      await compactConversation(d, convId, { upstream: resolved.upstream, signal: ac.signal })
    } catch (e) {
      const code = e instanceof Error ? e.message : 'compaction_failed'
      if (code === 'nothing_to_compact') return err(c, 400, 'nothing_to_compact', 'Not enough history yet to compact.')
      return err(c, 500, 'compaction_failed', 'Could not summarize this conversation.')
    } finally {
      releaseInflight(convId, ac)
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
    const held = inflight.get(convId)
    if (held && (compactions.has(held) || autoCompactions.has(held))) return err(c, 409, 'compaction_in_progress', COMPACTING_MESSAGE)
    db.clearConversationCompaction(convId)
    return c.json(db.getConversation(convId)!)
  })

  app.post('/api/v1/conversations/:id/regenerate', (c) => {
    const convId = c.req.param('id')
    const busy = inflightRefusal(c, convId, 'Stop generation first.')
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
    const busy = inflightRefusal(c, convId, 'Stop generation first.')
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
  engineMessages: { role: string; content: unknown }[]
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

/**
 * Streams an assistant turn with optional agentic tool-calling loop. Posts to the
 * engine, relays delta/reasoning/progress/tool_call SSE events, parses inline <think>
 * tags, executes tool calls and loops (up to MAX_TOOL_ITER rounds), persists the final
 * message + stats, and fires auto-title. Shared by the messages and continue endpoints.
 */

/**
 * `bench_result{source:'chat'}` (spec 23 §3.7, ADR-333, founder-directed
 * 2026-08-05): a real chat reply's own measured t/s, alongside the
 * synthetic autotune sweep bench_result already sent. llama.cpp's own
 * `predicted_per_second` is measured on EVERY generation already (`stats.tps`
 * above) — this only wires it to leave the machine, subject to the same
 * rate limit and short-run floor every real-run source shares
 * (`bench-rate-limit.ts`).
 *
 * Best-effort by contract (ADR-009): a lookup miss (model swapped mid-turn,
 * scanner not yet caught up) or any other failure here must never surface
 * to the user or affect the chat response already streamed.
 */
function reportChatBenchResult(d: Deps, ms: ModelInfo, stats: Partial<MessageStats>): void {
  try {
    if (!d.telemetry?.canSend('bench_result')) return
    if (stats.tps === undefined || stats.genTokens === undefined || stats.genTokens < MIN_GEN_TOKENS_FOR_BENCH) return

    const entry = d.scanner.get(ms.key)
    const engine = servingEngine(d)
    if (!entry || !engine) return

    const cfg = d.store.snapshot()
    const saved = getModelProfile(cfg, entry.key, engine.id) as Partial<LoadProfile> | undefined
    const profile = resolveProfile(entry, getSysInfo(), saved, undefined, cfg.modelDefaults)

    const key = benchRateLimitKey(entry.key, entry.quant, profile.ctx, profile.ngl, profile.nCpuMoe, profile.kvTypeK, 'chat')
    if (!shouldEmitBenchResult(d.store.dir(), key)) return

    const config = buildBenchResultConfig(entry, profile, engine.version, getSysInfo())
    emitBenchResult(
      d.telemetry,
      {
        source: 'chat',
        model: config.model,
        engine: config.engine,
        params: config.params,
        result: { tps: stats.tps, ttftMs: stats.ttftMs ?? 0, vramMb: null, outcome: 'ok' },
      },
      config.hw,
    )
  } catch {
    // Best-effort by contract (ADR-009).
  }
}

/** Wraps an emit sink so a DEAD CLIENT can never cost us generated output (GitHub #177).
 *
 *  Every `await emit(...)` in runGeneration writes to a live SSE stream, and writing to a
 *  torn-down stream REJECTS. Any one of those rejections used to unwind the whole function —
 *  past the single `db.updateMessage(...)` that persists `fullContent` at the end — leaving the
 *  placeholder assistant row (inserted empty, `stats: { aborted: false }`, before the first
 *  token) permanently blank with `aborted: false`. That is exactly the reporter's third bucket:
 *  rows that are empty but not flagged aborted, with the model's real output thrown away.
 *  The done-path emit was individually guarded for this reason; the error-path emit was not, and
 *  neither were the ten emits inside the streaming loops.
 *
 *  So the guard belongs on the SEAM, not on individual call sites: the first failure latches the
 *  client as gone and every later emit becomes a no-op. A dead client degrades to "keep
 *  generating, keep persisting, stop writing to the socket" instead of unwinding. Abort semantics
 *  are untouched — a real Stop click aborts via the AbortController (and a client disconnect via
 *  `stream.onAbort`), which is what sets `aborted: true`; this only stops write failures from
 *  being fatal. PURE-ish and exported so the latch behaviour is pinned by tests. */
export function resilientSink(sink: EmitSink): EmitSink & { clientGone: () => boolean } {
  let gone = false
  const wrapped = async (ev: { event: string; data: unknown }): Promise<void> => {
    if (gone) return
    try {
      await sink(ev)
    } catch {
      // Client is gone (cancelled turn / closed tab / reloaded). Nothing to flush to, ever
      // again on this stream — and an unhandled rejection here would crash the daemon.
      gone = true
    }
  }
  return Object.assign(wrapped, { clientGone: () => gone })
}

/** An error the engine reported INSIDE a 200 stream, as `data: {"error": ...}`. llama-server does this when a
 *  request fails after streaming began, and LiteRT-LM does it for every runtime failure (a prompt longer than the
 *  bundle's context, for one). Such a chunk has no `choices`, so the round loop skipped it and the turn ended as an
 *  empty message with no reason given. Also thrown for a non-OK response, so that one is handled (and the turn's
 *  earlier rounds saved) by the same catch. */
export class EngineStreamError extends Error {}

/** The error message an SSE chunk carries, if it is an error chunk: `{"error": "…"}` or `{"error": {"message": "…"}}`. */
export function streamChunkError(chunk: Record<string, unknown>): string | null {
  const err = chunk.error
  if (typeof err === 'string' && err.trim()) return err.trim()
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
    return JSON.stringify(err)
  }
  return null
}

/** An engine's error text as the chat shows it: the LiteRT-LM context hint where it applies, and local paths
 *  redacted (redactLocalPaths), since it reaches every client of the conversation, a Turbo Link peer's included. */
export function engineErrorText(d: Pick<Deps, 'manager' | 'store'>, engineKind: string, raw: string): string {
  return redactLocalPaths(d, engineKind === 'litert-lm' ? litertLmTurnErrorMessage(raw) : raw)
}

/** The whole generation turn: engine call(s), tool loop, and the ONE write-back that persists
 *  the reply. Exported ONLY so tests can drive it with a sink of their own — the persistence
 *  invariant this function owns (GitHub #177: generated output must survive a client that has
 *  gone away, an engine that dies mid-stream, and a Stop click) is not reachable through the
 *  route, whose sink is hard-wired to the live SSE stream. Not part of any public API. */
export async function runGeneration(d: Deps, rawEmit: EmitSink, ctx: GenerationCtx): Promise<void> {
  const { db } = d
  const { convId, conv, assistantMsg, upstream, ac, thinkingBudget, reasoningEffort } = ctx
  // GitHub #177: never let a write to a torn-down stream unwind past the persistence write
  // below. See resilientSink's doc comment — this is the invariant, not the individual
  // try/catch at the two emit sites that happened to have one.
  const emit = resilientSink(rawEmit)
  // A remote turn ran on ANOTHER machine: nothing below may write its numbers into this
  // one's engine state. Same rule the gateway's own remote branch follows (I-4) — the
  // peer's engine card must not read "Generating…" for work its engine is not doing, and
  // `hostIdleState` reads sessionStats().activeRequests, so a false busy here would block a
  // third machine's legitimate wake.
  const localAccounting = !upstream.remote

  // Map conversation sampling overrides (camelCase) to the engine's snake_case names.
  const convS = conv.sampling ?? {}
  const engineKind = servingEngineKind(d)
  // BUG-006: vLLM and SGLang reject `repeat_penalty` (the llama.cpp name) and require
  // `repetition_penalty` — the OpenAI-spec name. mlx-vlm's request schema (server/schemas.py)
  // only declares `repetition_penalty` too — `repeat_penalty` isn't rejected (the schema
  // allows extra fields) but is silently ignored, a no-op. Map per engine kind.
  const repeatPenaltyKey =
    (engineKind === 'vllm' || engineKind === 'sglang' || engineKind === 'mlx-vlm') ? 'repetition_penalty' : 'repeat_penalty'
  const SAMPLING_KEYS: Record<string, string> = {
    temp: 'temperature', topP: 'top_p', topK: 'top_k', minP: 'min_p',
    repeatPenalty: repeatPenaltyKey, presencePenalty: 'presence_penalty',
    frequencyPenalty: 'frequency_penalty',
  }
  const samplingOverride: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(SAMPLING_KEYS)) {
    if (camel in convS) samplingOverride[snake] = convS[camel]
  }
  for (const [k, v] of Object.entries(convS)) {
    if (!(k in SAMPLING_KEYS) && k !== 'stop') samplingOverride[k] = v
  }
  const stopStrings = convS.stop as string[] | undefined

  const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0

  // ── Agentic tool loop ──────────────────────────────────────────────────────
  // engineMessages is extended each round with tool results. Start from ctx copy
  // so the original array is never mutated (continue endpoint reuses it).
  const iterMessages: { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[] =
    ctx.engineMessages.map((m) => ({ role: m.role, content: m.content }))

  // Skills enabled for this conversation (the shared SKILL.md library, picked via
  // Thread settings or the '/' picker): inject their instructions into the system
  // prompt. No-op for a plain chat with no skills enabled — byte-identical to today.
  const enabledSkillIds = new Set(conv.skillIds ?? [])
  if (enabledSkillIds.size > 0) {
    const enabledSkills = new SkillStore(d.store.dir()).list().filter((s) => enabledSkillIds.has(s.id))
    if (enabledSkills.length) {
      // Full instructions, formatting intact — a real skill's procedure can run to
      // several KB and a 300-char preview was silently dropping nearly all of it.
      // MAX_SKILL_INSTRUCTIONS_CHARS is a safety cap against a pathological file,
      // not an everyday limit (real skills should always fit under it whole).
      const MAX_SKILL_INSTRUCTIONS_CHARS = 20_000
      const skillSys = 'Skills enabled for this chat (apply the relevant ones):\n\n' +
        enabledSkills.map((s) => `## ${s.name}\n${s.description}\n\n${s.instructions.trim().slice(0, MAX_SKILL_INSTRUCTIONS_CHARS)}`).join('\n\n---\n\n')
      const sysIdx = iterMessages.findIndex((m) => m.role === 'system')
      if (sysIdx >= 0) {
        const existing = typeof iterMessages[sysIdx].content === 'string' ? iterMessages[sysIdx].content : ''
        iterMessages[sysIdx] = { ...iterMessages[sysIdx], content: `${skillSys}\n\n${existing}`.trim() }
      } else {
        iterMessages.unshift({ role: 'system', content: skillSys })
      }
    }
  }

  // Search budget for a force_web_search turn. The Research persona plans 3–5 targeted
  // queries; at 3 the model got exactly ONE discretionary search (iterations 1–2 are
  // tool_choice-forced) and the confidence re-loop below had no room left to fire at all,
  // so the advertised strategy was not executable. 6 = 5 planned + at least one
  // confidence-driven refinement (ADR-230: quality over latency). SINGLE SOURCE OF TRUTH —
  // the instruction text the model is told and the guard the code enforces must never
  // disagree again, so both read this constant.
  const MAX_SEARCH_CALLS = 6
  // Bounds how many times a low-confidence answer may be folded back for refinement. The
  // re-loop does not force a tool call, so a model that keeps answering without searching
  // would otherwise never advance searchCallCount and would spin until MAX_TOOL_ITER.
  const MAX_CONFIDENCE_RETRIES = 2

  // F-021: inject confidence-loop instruction into Research persona system prompt.
  // Appends to the existing system message (or inserts one if absent).
  const CONFIDENCE_INSTRUCTION =
    `\n\nAfter reviewing the search results, include a confidence assessment on a line by itself before your final answer: \`[confidence: 0.XX]\` where XX is your confidence (0.0–1.0) that your answer is accurate and current. If your confidence is below 0.8, call web_search again with a more specific query first. Maximum ${MAX_SEARCH_CALLS} search calls per response.`
  if (conv.toolPolicy === 'force_web_search') {
    const sysIdx = iterMessages.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      const existing = typeof iterMessages[sysIdx].content === 'string' ? iterMessages[sysIdx].content : ''
      iterMessages[sysIdx] = { ...iterMessages[sysIdx], content: existing + CONFIDENCE_INSTRUCTION }
    } else {
      iterMessages.unshift({ role: 'system', content: CONFIDENCE_INSTRUCTION.trim() })
    }
  }

  // Outer ceiling on tool rounds. Worst case for a research turn that actually uses its
  // budget: 6 web_search rounds + up to 6 fetch_url/MCP rounds (the persona tells the model
  // to fetch_url any authoritative-looking result whose excerpt is thin) + 3 answer-
  // composition rounds (initial + MAX_CONFIDENCE_RETRIES refinements) = 15. 16 leaves one
  // round of headroom so a legitimate investigation is never truncated mid-flight. This is
  // a ceiling, not a target — ordinary chats still finish in 1–2 rounds and are unaffected.
  const MAX_TOOL_ITER = 16
  let toolIter = 0
  /** Number of web_search tool calls made this turn (caps the confidence re-loop). */
  let searchCallCount = 0
  /** Confidence-driven refinement passes taken this turn (capped at MAX_CONFIDENCE_RETRIES). */
  let confidenceRetries = 0
  /** Accumulated ResearchResult[] from all web_search calls this turn (F-021). */
  const allResearchSources: ResearchSource[] = []
  /** Confidence score parsed from model output (F-021); undefined for non-research turns. */
  let parsedConfidence: number | undefined

  // Accumulated across all tool iterations for persistence
  let fullContent = ''
  let fullReasoning = ''
  const allToolCalls: ToolCallRecord[] = []

  // Stats from the final (non-tool) round
  const requestStart = Date.now()
  let ttftMs = 0
  let thinkStart = 0
  let thinkEnd = 0
  let finalUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } = {}
  let finalTimings: Record<string, number> = {}
  let aborted = false
  // Distinct from `aborted`: a thrown, non-AbortError exception mid-stream (e.g. the
  // engine process died) is neither a success nor a user-initiated cancellation.
  // `aborted` alone can't tell the two apart (both leave AbortError-only checks
  // false/true respectively), and first_chat needs the real three-way split.
  let engineFailed = false
  let liveOut = 0
  /** The live round's parser state, or null once its end-of-stream flush has already run.
   *  GitHub #177: the streaming parser legitimately withholds up to 29 characters as lookahead
   *  (it cannot know yet whether they are the start of a `<|channel|>analysis…` tag), and that
   *  tail is only released by `flushState` at end-of-stream. An abort or an engine death THROWS
   *  out of the round loop before that flush ever runs, so every short interrupted reply — the
   *  common case when a user hits Stop early — had its text dropped on the floor even though the
   *  model really did produce it. Held here so the finalizer below can drain it. */
  let pendingParse: ParseState | null = null
  /** GitHub #52 item 9: the authoritative prompt-token count only arrives at the END of a round
   *  (`usage.prompt_tokens` / `timings.prompt_n`), so a mid-stream abort leaves it at 0 — the UI
   *  renders "0+147 tokens" and `ctxUsed` understates context by the entire prompt even though
   *  those prompt tokens really are sitting in the KV cache. The engine streams `prompt_progress`
   *  chunks WHILE it ingests the prompt (`{ processed, total }`, surfaced to the client as the
   *  `progress` event), and that `total` IS the prompt size — the same number `prompt_tokens`
   *  would have reported. Remember the last one seen and use it as the fallback. This is a
   *  measured value from the engine, never an invented one: it stays 0 when the engine sends no
   *  progress at all (e.g. `return_progress` unsupported), which is exactly today's behavior. */
  let lastPromptTotal = 0

  /** Regenerate (`ctx.replacedId`): /continue sets the old reply aside only once the turn can run,
   *  but the engine or a linked host can still refuse it after that: an HTTP error (a 503 while a
   *  model loads, a host that unloaded it), a fetch that throws (a host asleep since its last probe,
   *  an engine that died), an error chunk in the stream. Such a turn left the old reply behind the
   *  version switcher and an empty reply shown in its place. When the turn produced nothing (no
   *  text, reasoning or tool call, nothing still held back by the parser), the empty placeholder is
   *  deleted and the old reply shown again, before the error is sent, so the client's refetch on it
   *  already sees the reply back. Only while both rows are as this turn left them (a DELETE of
   *  either during the turn stands). Never throws: the catch below calls it, where nothing may.
   *  Save & Resend (`ctx.edited`) the same: such a turn left the new question shown with an empty
   *  reply, and the old version and its replies behind the question's switcher. The new version is
   *  deleted with the placeholder, not kept beside the old one: switched to, it would show a
   *  question with no reply, and the next send would go out as user, user. */
  let restored = false
  const restoreReplaced = (): boolean => {
    if ((!ctx.replacedId && !ctx.edited) || fullContent || fullReasoning || allToolCalls.length > 0 || pendingParse?.buf) return false
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

  // In-app chat is the owner using their own machine — the signal Turbo Link's wake
  // gate reads to refuse a peer's model swap (link/host-idle.ts). The gateway records
  // the terminal-agent paths; this is the only local path that never goes through it.
  // Still local activity even for a remote turn: the OWNER of this machine is at the
  // keyboard, which is exactly what the wake ledger records.
  noteLocalActivity()
  if (localAccounting) d.manager.generationStart()
  try {
    // Get tool definitions once (or empty for engines that don't support tools)
    // MCP server tools are left out (and refused below) for a caller that may not act on the host:
    // isCodeAuthorized is the same isLocalRequest || real-key decision as adding an MCP server.
    const baseToolDefs = d.tools ? await d.tools.buildToolDefinitions({ forGeneration: true, refuseMcp: !ctx.isCodeAuthorized }) : []
    // 'skill-creator' grants save_skill — the one tool a skill can add beyond the base
    // registry (every other skill is instructions text only). No-op unless enabled.
    // save_skill writes to the shared skill library, as POST /api/v1/skills and the Save as skill
    // route do, and both refuse a caller isLocalOrAuthenticated fails. isCodeAuthorized is that
    // same decision for this turn's caller (isLocalRequest || a real key), so a turn without it
    // is not offered save_skill, and a call the model makes anyway is refused here, before the
    // skill author starts (the tool skips the approval gate, so this is the only check).
    const skillTools = enabledSkillIds.has('skill-creator')
      ? buildSaveSkillTool(() => {
          if (!ctx.isCodeAuthorized) return `Error: ${SKILL_AUTHORING_REFUSED}`
          // In-chat skill author: read THIS conversation in the background and write a
          // SKILL.md to the shared library.
          const tid = saveSkillFromConversation(d, conv.id)
          return tid
            ? 'Started writing a skill from this conversation in the background. It will appear in the skill library shortly.'
            : 'There is nothing to turn into a skill yet.'
        })
      : undefined
    // Custom chat Agent tool allow-list (Customize → Agents), baked in at conversation
    // creation. Undefined (never set) = unrestricted — every untouched built-in persona's
    // conversations take this branch, so their tool list is byte-identical to before this
    // feature. An EXPLICIT empty array is different from unset, though — it means a
    // built-in deliberately fixed its tool list to none (e.g. the Blank persona: "raw model
    // output, no instructions injected" has to mean no tool-calling preamble too, not just
    // an empty system prompt — GitHub #52) — so it must actually filter down to zero tools,
    // not fall through to unrestricted the way a merely-absent list does.
    // Applied ONLY to the base (built-in + MCP) registry: skill-granted tools like
    // save_skill are never enumerated by /api/v1/tools (they only exist once their
    // skill is enabled), so they can never appear in the allow-list checklist — gating
    // them a second time here would silently strip save_skill from any agent that has
    // 'skill-creator' enabled. Enabling the skill IS the allow decision for its tools.
    const scopedBaseToolDefs = conv.allowedTools !== undefined
      ? baseToolDefs.filter((t) => conv.allowedTools!.includes(t.function.name))
      : baseToolDefs
    const toolDefs = skillTools && ctx.isCodeAuthorized ? [...scopedBaseToolDefs, ...skillTools.defs] : scopedBaseToolDefs

    outerLoop: while (toolIter <= MAX_TOOL_ITER) {
      toolIter++

      const reqBody: Record<string, unknown> = {
        model: upstream.modelField,
        messages: iterMessages,
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
        ...samplingOverride,
      }
      if (stopStrings?.length) reqBody.stop = stopStrings
      const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, maxLimit)
      if (cappedMax != null) reqBody.max_tokens = cappedMax
      else delete reqBody.max_tokens
      // GitHub #52: thinkingBudget (this turn) and preserveThinking (past turns) are
      // independent and can both be relevant at once, so merge rather than overwrite.
      // thinking_budget_tokens (not the unrecognized `reasoning_budget`) is the field the
      // engine's sampler actually reads — see reasoning-budget.cpp in the TurboQuant fork.
      const templateKwargs: Record<string, unknown> = {}
      if (thinkingBudget === 0) {
        reqBody.thinking_budget_tokens = 0
        templateKwargs.enable_thinking = false
      } else if (thinkingBudget > 0) {
        reqBody.thinking_budget_tokens = thinkingBudget
      }
      if (conv.preserveThinking) templateKwargs.preserve_thinking = true
      // Independent of thinkingBudget/enable_thinking above — only sent when the caller
      // passed a value that survived parseReasoningEffort (chat-routes.ts's body parsing),
      // so a client typo or an unsupported model can never make it into a request the
      // engine's chat template would raise_exception on. 'off' is this control's own way of
      // disabling thinking (see reasoning-effort.ts) — never forwarded as literal
      // reasoning_effort:"off"; it collapses onto the exact same fields thinkingBudget===0
      // above already sets.
      if (reasoningEffort === 'off') {
        reqBody.thinking_budget_tokens = 0
        templateKwargs.enable_thinking = false
      } else if (reasoningEffort) {
        templateKwargs.reasoning_effort = reasoningEffort
      }
      if (Object.keys(templateKwargs).length) reqBody.chat_template_kwargs = templateKwargs
      // Attach tools only to engines whose OpenAI server accepts a `tools` array as
      // passthrough. vLLM is strict: a `tools` array (which defaults tool_choice to
      // "auto") is REJECTED with HTTP 400 — "auto tool choice requires
      // --enable-auto-tool-choice and --tool-call-parser to be set" — unless the
      // server was launched with those flags (which we don't, and no built-in parser
      // matches Gemma's tool format). Sending tools there breaks ALL vLLM chat, so we
      // skip them. llama.cpp/forks accept them; mlx-lm ignores them harmlessly. mlx-vlm
      // also accepts them without erroring, but whether a tool call actually comes back
      // depends on the loaded model's chat template matching one of mlx-vlm's built-in
      // tool parsers (see the MLX-VLM catalog note) — not a crash risk, just a
      // per-architecture no-op some of the time.
      // LiteRT-LM is withheld until its server is verified to honor `tools` (PR #271
      // review): nothing in its CLI/docs shows tool-call support, and silently sending
      // the array risks agent/Code turns that look like they have tools but never call
      // them. Harmless either way: the model just answers without tools.
      const toolsSupported =
        engineKind !== 'vllm' && engineKind !== 'sglang' && engineKind !== 'litert-lm' && toolDefs.length > 0
      if (toolsSupported) reqBody.tools = toolDefs
      // Force web_search on the first two iterations when the conversation has a
      // force_web_search policy (e.g. Research persona). This guarantees at least
      // two distinct searches before the model composes its answer. Iteration 3+
      // use "auto" so the model can continue searching or finish as it sees fit.
      if (
        toolsSupported &&
        conv.toolPolicy === 'force_web_search' &&
        toolIter <= 2 &&
        toolDefs.some((t) => t.function.name === 'web_search')
      ) {
        reqBody.tool_choice = { type: 'function', function: { name: 'web_search' } }
      }

      const res = await callChatUpstream(upstream, reqBody, ac.signal, undefined, d)

      if (!res.ok || !res.body) {
        // The engine's own reason, when its error body has one, says far more than the status code.
        let reason = ''
        try {
          const text = await res.text()
          let parsed: Record<string, unknown> | null = null
          try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
          // `{"error": …}` (OpenAI, llama.cpp, LiteRT-LM), else `{"message": …}` (vLLM) / `{"detail": …}` (FastAPI),
          // else the raw text.
          const msg = parsed && typeof parsed === 'object'
            ? streamChunkError(parsed) ?? (typeof parsed.message === 'string' ? parsed.message : typeof parsed.detail === 'string' ? parsed.detail : null)
            : null
          reason = (msg ?? text).trim().slice(0, 500)
        } catch { /* no body */ }
        if (reason) reason = engineErrorText(d, engineKind, reason)
        // Thrown, not returned: the catch below sends it as engine_error, puts back a Regenerate's
        // or a Save & Resend's old turn when this one produced nothing (restoreReplaced), and
        // otherwise falls through to the one save. A return here skipped that save, so a later tool
        // round refused this way (its request past n_ctx with round 1's tool result in it, a 503
        // after a model swap, a linked host's host_busy) lost round 1's text, reasoning and tool
        // calls, all already streamed, and left the reply empty.
        throw new EngineStreamError(reason ? `Engine returned ${res.status}: ${reason}` : `Engine returned ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      // `.catch()` is load-bearing (GitHub #177): on abort, the fetch layer ERRORS the body
      // stream first (undici rejects the pending read with AbortError), and cancelling an
      // already-errored stream returns a REJECTED promise. Bare `void reader.cancel()` left that
      // floating — an unhandled rejection, i.e. a daemon crash mid-generation, which loses the
      // turn's output the same way the unguarded emits did.
      const cancelReader = () => { void reader.cancel().catch(() => {}) }
      if (ac.signal.aborted) {
        cancelReader()
      } else {
        ac.signal.addEventListener('abort', cancelReader, { once: true })
      }

      // Per-round state
      let roundContent = ''
      let parseState = initParseState()
      pendingParse = parseState
      let finishReason = ''
      // Accumulate streaming tool_calls by index (OpenAI format: fragmented across chunks)
      const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()
      // Indices we've already told the UI about (so the long tool-arg generation that
      // follows the model's text shows an inline "running…" step instead of looking frozen).
      const announcedToolCalls = new Set<number>()

      roundLoop: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break roundLoop

          let chunk: Record<string, unknown>
          try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
          const engineError = streamChunkError(chunk)
          if (engineError) {
            // Nothing more is read from this stream: hang up so the engine stops, and drop the abort hook with it.
            ac.signal.removeEventListener('abort', cancelReader)
            cancelReader()
            throw new EngineStreamError(engineErrorText(d, engineKind, engineError))
          }

          // Prompt progress
          const pp = chunk.prompt_progress as { processed?: number; total?: number; tps?: number } | undefined
          if (pp && pp.total) {
            // #52 item 9: the only prompt-token number that exists before the round ends.
            lastPromptTotal = pp.total
            const pct = Math.round((pp.processed ?? 0) / pp.total * 100)
            if (localAccounting) d.manager.setLiveGen({ phase: 'prompt', pct, outputTokens: 0 })
            await emit({ event: 'progress', data: { phase: 'prompt', processed: pp.processed, total: pp.total, pct, tps: pp.tps ?? 0 } })
            continue
          }

          if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage
          if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings

          const choices = chunk.choices as Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
            finish_reason?: string
          }> | undefined
          if (!choices?.length) continue

          if (choices[0].finish_reason) finishReason = choices[0].finish_reason
          const delta = choices[0].delta ?? {}

          // Accumulate streaming tool_call fragments (OpenAI: id+name only in first chunk,
          // arguments fragment across all chunks for that index).
          if (delta.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              if (!pendingToolCalls.has(tc.index)) {
                pendingToolCalls.set(tc.index, { id: '', name: '', argsBuffer: '' })
              }
              const entry = pendingToolCalls.get(tc.index)!
              if (tc.id && !entry.id) entry.id = tc.id
              if (tc.function?.name && !entry.name) entry.name = tc.function.name
              if (tc.function?.arguments) entry.argsBuffer += tc.function.arguments
              // The moment we know which tool this is, surface it as pending — the model
              // may stream a long argument body next, and silence there reads as a freeze.
              if (entry.id && entry.name && !announcedToolCalls.has(tc.index)) {
                announcedToolCalls.add(tc.index)
                await emit({ event: 'tool_call', data: { id: entry.id, name: entry.name, args: {}, status: 'pending' } })
              }
            }
            continue
          }

          // Reasoning content — llama-server uses `reasoning_content`, mlx-lm uses `reasoning`.
          const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
          if (rc) {
            if (!thinkStart) thinkStart = Date.now()
            thinkEnd = Date.now()
            fullReasoning += rc
            await emit({ event: 'reasoning', data: { delta: rc } })
            continue
          }

          const raw_content = delta.content ?? ''
          if (!raw_content) continue

          const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
          parseState = nextState
          pendingParse = parseState
          for (const ev of parseEvents) {
            if (ev.type === 'reasoning') {
              if (!thinkStart) thinkStart = Date.now()
              thinkEnd = Date.now()
              fullReasoning += ev.text
              await emit({ event: 'reasoning', data: { delta: ev.text } })
            } else {
              fullContent += ev.text
              roundContent += ev.text
              if (!ttftMs) ttftMs = Date.now() - requestStart
              liveOut++
              if (localAccounting) d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: liveOut })
              await emit({ event: 'delta', data: { delta: ev.text } })
            }
          }
        }
      }
      ac.signal.removeEventListener('abort', cancelReader)

      // Flush lookahead buffer at end-of-stream. Clearing `pendingParse` first is what stops the
      // interrupted-turn drain after the try/catch from flushing this same buffer a SECOND time
      // (flushState is pure — it does not consume the buffer it reads).
      pendingParse = null
      for (const ev of flushState(parseState)) {
        if (ev.type === 'reasoning') {
          fullReasoning += ev.text
          await emit({ event: 'reasoning', data: { delta: ev.text } })
        } else {
          fullContent += ev.text
          roundContent += ev.text
          await emit({ event: 'delta', data: { delta: ev.text } })
        }
      }

      // ── Tool call execution ──────────────────────────────────────────────
      if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && d.tools && toolIter <= MAX_TOOL_ITER) {
        const roundToolCalls = Array.from(pendingToolCalls.values())

        // Add the assistant message (with tool_calls) to iterMessages for the next round
        iterMessages.push({
          role: 'assistant',
          content: roundContent || null,
          tool_calls: roundToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsBuffer },
          })),
        })

        for (const tc of roundToolCalls) {
          let parsedArgs: Record<string, unknown>
          try { parsedArgs = JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown> }
          catch { parsedArgs = {} }

          // save_skill (from the 'skill-creator' skill) is pre-authorized by the user
          // having enabled that skill for this chat, so it bypasses the approval gate
          // and routes straight to its own executor. Everything else (normal chat
          // tools) still goes through the real approval gate below.
          const isSkillTool = skillTools?.names.has(tc.name) ?? false
          // The agent's allow-list (conv.allowedTools, scopedBaseToolDefs above) decides what may
          // RUN, not only what the model is offered: a model can name any tool, offered or not
          // (small models do hallucinate tool names), and the approval gate below ran such a call
          // whenever its policy allowed it, so an agent fixed to web_search still ran run_code or
          // an MCP tool. A base tool the list leaves out is answered as executeTool answers one
          // that does not exist. Skill tools are never on the list (see scopedBaseToolDefs).
          const unlisted = !isSkillTool && conv.allowedTools !== undefined && !conv.allowedTools.includes(tc.name)

          let result: string
          let callError: string | undefined

          if (unlisted) {
            result = `Error: unknown tool "${tc.name}"`
            await emit({
              event: 'tool_call',
              data: { id: tc.id, name: tc.name, args: parsedArgs, status: 'done', result },
            })
          } else if (isSkillTool && skillTools) {
            // Emit pending event so the frontend can show "calling..."
            await emit({
              event: 'tool_call',
              data: { id: tc.id, name: tc.name, args: parsedArgs, status: 'pending' },
            })
            try {
              result = skillTools.execute({ id: tc.id, name: tc.name, args: parsedArgs })
            } catch (e) {
              callError = (e as Error).message
              result = `Error: ${callError}`
            }
            await emit({
              event: 'tool_call',
              data: { id: tc.id, name: tc.name, args: parsedArgs, status: callError ? 'error' : 'done', result },
            })
          } else {
            // Live foreground chat gets the real approval gate (interactive: true) — an
            // 'ask'-policy tool prompts the user via 'tool_call'/'awaiting_approval' and
            // waits for POST .../tool-calls/:toolCallId/approve to resolve it.
            const approved = await executeToolCallWithApproval({
              tools: d.tools,
              sink: (ev) => emit({ event: ev.event, data: ev.data }),
              convId,
              id: tc.id,
              name: tc.name,
              args: parsedArgs,
              globalPolicies: d.store.snapshot().tools.toolPolicies ?? {},
              // Re-read fresh on every iteration (not the `conv` snapshot captured at request
              // start) — otherwise a same-turn repeat tool call misses an "Allow for this
              // chat" decision the user just made via POST .../tool-calls/:id/approve.
              convOverrides: d.db.getToolOverrides(convId),
              autoAllowAll: d.store.snapshot().tools.autoAllowAll ?? false,
              signal: ac.signal,
              interactive: true,
              // The real per-request trust decision this handler's route computed from its Hono
              // Context (see the `chatCodeAuthorization(c, d)` call sites) — never a hardcoded true.
              isCodeAuthorized: ctx.isCodeAuthorized,
              // An MCP call the model makes anyway, unoffered, is refused before any approval prompt.
              refuseMcp: !ctx.isCodeAuthorized,
            })
            result = approved.result
            callError = approved.error
          }

          // F-021: track web_search calls and accumulate research sources.
          if (tc.name === 'web_search' && !callError && !unlisted) {
            searchCallCount++
            // The result string embeds the structured data; also ask the registry
            // for the raw ResearchResult[] via a direct research call on the same
            // args (zero extra network cost — the registry already called it).
            // We parse what we can from the result string as a fallback.
            try {
              // Re-parse sources from result text: each [N] block has Domain/Relevance line.
              // LOCKSTEP: this regex must track the exact line emitted by execWebSearch in
              // tools/builtin.ts — if they drift, every source silently vanishes from the UI
              // and from the persisted message. `Published`/`Retrieved` were appended after
              // `Freshness`, so both trailing groups are optional and this parses the pre-date
              // format too. m[7] = published label, m[8] = retrieval date, m[9] = passage.
              const sourceMatches = [...result.matchAll(/\[(\d+)\] (.+?)\nSource: (\S+)\nDomain: (\S+) \| Relevance: ([\d.]+) \| Freshness: (\w+)(?: \| Published: ([^|\n]*?))?(?: \| Retrieved: ([\d-]+))?\nKey passage: ([\s\S]+?)(?=\n\[|\s*$)/g)]
              for (const m of sourceMatches) {
                allResearchSources.push({
                  title: m[2].trim(),
                  url: m[3].trim(),
                  domain: m[4].trim(),
                  relevanceScore: parseFloat(m[5]),
                  freshnessSignal: (m[6].trim() as 'recent' | 'dated' | 'unknown'),
                  passage: m[9].trim(),
                })
              }
            } catch { /* parsing is best-effort */ }
          }

          allToolCalls.push({ id: tc.id, name: tc.name, args: parsedArgs, result: callError ? undefined : result, error: callError })

          // Inject tool result into iterMessages
          iterMessages.push({ role: 'tool', content: result, tool_call_id: tc.id })
        }

        // Continue to next round
        continue outerLoop
      }

      // ── F-021: Confidence loop (no tool calls — model gave final answer) ─────
      // For Research persona: parse [confidence: 0.XX] from accumulated content,
      // strip it from visible reply, and trigger another search pass if < 0.8
      // and search budget allows (max MAX_SEARCH_CALLS web_search calls per turn).
      if (conv.toolPolicy === 'force_web_search' && fullContent && d.tools) {
        const confMatch = fullContent.match(/\[confidence:\s*([\d.]+)\]/i)
        if (confMatch) {
          const conf = parseFloat(confMatch[1])
          parsedConfidence = conf
          // Strip confidence marker from visible content regardless
          fullContent = fullContent.replace(/\[confidence:\s*[\d.]+\]\s*/gi, '').trim()

          if (conf < 0.8 && searchCallCount < MAX_SEARCH_CALLS && confidenceRetries < MAX_CONFIDENCE_RETRIES) {
            confidenceRetries++
            console.log(`[chat] F-021: confidence ${conf} < 0.8 (searches: ${searchCallCount}/${MAX_SEARCH_CALLS}, retry ${confidenceRetries}/${MAX_CONFIDENCE_RETRIES}) — re-entering search loop`)
            const toolDefs2 = await d.tools.buildToolDefinitions()
            if (toolDefs2.some((t) => t.function.name === 'web_search')) {
              // Fold the low-confidence answer back and ask the model to refine
              iterMessages.push({ role: 'assistant', content: fullContent })
              iterMessages.push({
                role: 'user',
                content: `Your confidence is ${conf}. Please search again with a more specific query to improve accuracy, then provide a revised answer with an updated [confidence: X.XX] line.`,
              })
              fullContent = ''
              continue outerLoop
            }
          }
        }
      }

      // No tool calls (or tools not available) — done
      break outerLoop
    }

    // ── BUG-001: Qwen3 empty-reply guard ──────────────────────────────────────
    // Thinking models sometimes produce ONLY <think>…</think> tokens in their
    // final pass after tool results, leaving visible content empty. Detect this
    // and make one extra inference pass with tool_choice:'none' so the model is
    // forced to emit a text answer.
    console.log(`[chat] tool loop finished after ${toolIter} iteration(s); visible content length: ${fullContent.trim().length}`)
    if (needsExtraPass(fullContent)) {
      console.log('[chat] BUG-001: final content is empty after stripping think blocks — making extra pass with tool_choice:none')
      iterMessages.push({ role: 'user', content: 'Please now write your final answer based on what you found.' })
      const reqBody: Record<string, unknown> = {
        model: upstream.modelField,
        messages: iterMessages,
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
        tool_choice: 'none',
        ...samplingOverride,
      }
      if (stopStrings?.length) reqBody.stop = stopStrings
      const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, maxLimit)
      if (cappedMax != null) reqBody.max_tokens = cappedMax
      else delete reqBody.max_tokens
      // GitHub #52: thinkingBudget (this turn) and preserveThinking (past turns) are
      // independent and can both be relevant at once, so merge rather than overwrite.
      // thinking_budget_tokens (not the unrecognized `reasoning_budget`) is the field the
      // engine's sampler actually reads — see reasoning-budget.cpp in the TurboQuant fork.
      const templateKwargs: Record<string, unknown> = {}
      if (thinkingBudget === 0) {
        reqBody.thinking_budget_tokens = 0
        templateKwargs.enable_thinking = false
      } else if (thinkingBudget > 0) {
        reqBody.thinking_budget_tokens = thinkingBudget
      }
      if (conv.preserveThinking) templateKwargs.preserve_thinking = true
      // Independent of thinkingBudget/enable_thinking above — only sent when the caller
      // passed a value that survived parseReasoningEffort (chat-routes.ts's body parsing),
      // so a client typo or an unsupported model can never make it into a request the
      // engine's chat template would raise_exception on. 'off' is this control's own way of
      // disabling thinking (see reasoning-effort.ts) — never forwarded as literal
      // reasoning_effort:"off"; it collapses onto the exact same fields thinkingBudget===0
      // above already sets.
      if (reasoningEffort === 'off') {
        reqBody.thinking_budget_tokens = 0
        templateKwargs.enable_thinking = false
      } else if (reasoningEffort) {
        templateKwargs.reasoning_effort = reasoningEffort
      }
      if (Object.keys(templateKwargs).length) reqBody.chat_template_kwargs = templateKwargs

      const res = await callChatUpstream(upstream, reqBody, ac.signal, undefined, d)

      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        // `.catch()` is load-bearing (GitHub #177) — see the identical guard in the main round
        // loop above: on abort the fetch layer errors the body stream first, and cancelling an
        // already-errored stream returns a REJECTED promise, which bare `void` left floating.
        const cancelReader = () => { void reader.cancel().catch(() => {}) }
        if (ac.signal.aborted) {
          cancelReader()
        } else {
          ac.signal.addEventListener('abort', cancelReader, { once: true })
        }

        let parseState = initParseState()
        pendingParse = parseState
        roundLoop: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') break roundLoop
            let chunk: Record<string, unknown>
            try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
            const engineError = streamChunkError(chunk)
            if (engineError) {
              // Nothing more is read from this stream: hang up so the engine stops, and drop the abort hook with it.
              ac.signal.removeEventListener('abort', cancelReader)
              cancelReader()
              throw new EngineStreamError(engineErrorText(d, engineKind, engineError))
            }
            if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage
            if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings
            // #52 item 9: the extra pass re-sends the whole conversation, so ITS prompt is the
            // one occupying context when it is interrupted. Captured (not emitted — this pass
            // has never streamed progress to the client and this fix does not change that).
            const pp2 = chunk.prompt_progress as { total?: number } | undefined
            if (pp2?.total) lastPromptTotal = pp2.total
            const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> | undefined
            if (!choices?.length) continue
            const delta = choices[0].delta ?? {}
            const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
            if (rc) {
              fullReasoning += rc
              await emit({ event: 'reasoning', data: { delta: rc } })
              continue
            }
            const raw_content = delta.content ?? ''
            if (!raw_content) continue
            const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
            parseState = nextState
            pendingParse = parseState
            for (const ev of parseEvents) {
              if (ev.type === 'reasoning') {
                fullReasoning += ev.text
                await emit({ event: 'reasoning', data: { delta: ev.text } })
              } else {
                fullContent += ev.text
                if (!ttftMs) ttftMs = Date.now() - requestStart
                liveOut++
                if (localAccounting) d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: liveOut })
                await emit({ event: 'delta', data: { delta: ev.text } })
              }
            }
          }
        }
        ac.signal.removeEventListener('abort', cancelReader)
        pendingParse = null
        for (const ev of flushState(parseState)) {
          if (ev.type === 'reasoning') {
            fullReasoning += ev.text
            await emit({ event: 'reasoning', data: { delta: ev.text } })
          } else {
            fullContent += ev.text
            await emit({ event: 'delta', data: { delta: ev.text } })
          }
        }
      }
    }
  } catch (e: unknown) {
    const isAbort = (e as Error)?.name === 'AbortError'
    aborted = isAbort
    if (!isAbort) {
      engineFailed = true
      restored = restoreReplaced() // a Stop (isAbort) keeps what it stopped
      // Belt and braces on top of resilientSink (GitHub #177): this emit is the one that used
      // to throw INSIDE the catch block, which no `finally` can contain — the rejection escaped
      // the whole function and skipped the `db.updateMessage` below, discarding everything the
      // model had already generated. Nothing after this point may be allowed to throw.
      try {
        const code = e instanceof EngineStreamError ? 'engine_error' : 'engine_stopped'
        await emit({ event: 'error', data: { code, message: (e as Error).message } })
      } catch { /* client gone — the message is still persisted below */ }
    }
  } finally {
    if (localAccounting) d.manager.generationEnd()
    releaseInflight(convId, ac)
  }
  // The placeholder is gone and the old reply back (restoreReplaced): nothing to fill in, title or
  // count.
  if (restored) return

  // GitHub #177: drain whatever the parser was still holding when the round was cut short (see
  // `pendingParse`). Non-null ONLY on the interrupted paths — a round that reached its own
  // end-of-stream flush nulls it first, so this can never double-count a normal turn.
  if (pendingParse) {
    for (const ev of flushState(pendingParse)) {
      if (ev.type === 'reasoning') {
        fullReasoning += ev.text
      } else {
        fullContent += ev.text
        // Counted like any other streamed delta so the #52 `liveOut` token fallback below
        // doesn't report "0 tokens" for a message that plainly has content.
        liveOut++
      }
    }
    pendingParse = null
  }

  const totalMs = Date.now() - requestStart
  const thinkMs = thinkStart && thinkEnd ? thinkEnd - thinkStart : 0
  const ctxMax = upstream.ctxMax

  // An aborted stream (Stop clicked, or the client disconnected mid-generation) can be cut off
  // before the engine's final usage/timings chunk ever arrives, leaving completion_tokens at its
  // default 0 — even though real output WAS generated, IS persisted (fullContent below), and WILL
  // sit in context for the next turn. liveOut (incremented per streamed delta, above) is the one
  // number we still have in that case; fall back to it instead of silently reporting "0 tokens"
  // for a message that plainly has content (GitHub #52: "when you interrupt a model's response,
  // the token count remains as 0+0, yet the model still sees the message in context, and the
  // total token count remains unchanged").
  const genTokensFallback = finalUsage.completion_tokens || liveOut
  // The prompt half of the same problem (GitHub #52 item 9). `genTokens` has had its liveOut
  // fallback for a while; `promptTokens` had none, so an interrupted turn rendered "0+147
  // tokens" and ctxUsed was short by the ENTIRE prompt — the number the next turn's context
  // budget is judged against. lastPromptTotal is the engine's own streamed prompt size (see its
  // declaration); 0 when the engine never reported one, which reproduces the old behavior
  // rather than fabricating a count.
  const promptTokensFallback = finalUsage.prompt_tokens || lastPromptTotal

  const stats: Partial<MessageStats> = {
    ttftMs,
    totalMs,
    thinkMs,
    // Full context occupancy: cache-reused prompt tokens still sit in the KV cache / context
    // window (they're skipped only for recomputation), so they must stay counted here.
    // Not for a turn that failed before the engine reported its prompt's size: a send refused
    // on its first round (400 exceed_context_size_error, a 503 while a model loads) has no
    // measurement, and the 0 it wrote became the reading maybeAutoCompact judges the next turn
    // by, so a chat refused for its size was never compacted again. With no ctxUsed the gate
    // reads the last reply that has one (lastCtxUsage).
    ...(engineFailed && !promptTokensFallback ? {} : { ctxUsed: promptTokensFallback + genTokensFallback }),
    ctxMax,
    model: upstream.modelName,
    aborted,
  }
  const fullPrompt = finalUsage.prompt_tokens ?? 0
  const cachedExplicit = finalUsage.prompt_tokens_details?.cached_tokens
  if (finalTimings.prompt_n) {
    const processed = finalTimings.prompt_n
    stats.promptTokens = fullPrompt || processed
    stats.promptMs     = finalTimings.prompt_ms
    stats.promptTps    = finalTimings.prompt_per_second
    stats.genTokens    = finalTimings.predicted_n
    stats.genMs        = finalTimings.predicted_ms
    stats.tps          = finalTimings.predicted_per_second
    stats.cachedTokens = cachedExplicit ?? Math.max(0, (fullPrompt || processed) - processed)
  } else {
    // No final timings — the interrupted/failed case. `fullPrompt` is 0 here whenever the usage
    // chunk never landed, which is precisely when the streamed prompt total has to stand in.
    stats.promptTokens = promptTokensFallback
    stats.genTokens    = genTokensFallback
    stats.genMs        = totalMs - ttftMs
    stats.tps          = stats.genMs > 0 ? Math.round((stats.genTokens / stats.genMs) * 1000 * 10) / 10 : 0
    stats.cachedTokens = cachedExplicit ?? 0
    // LiteRT-LM sends token counts but no timings, so derive prefill from TTFT. Only for a single-round turn: with tool
    // calls, `ttftMs` spans earlier rounds too and would understate the speed. Only for the LOCAL engine: a Turbo Link
    // host's engine is not this machine's, and its own stats stand.
    if (localAccounting && engineKind === 'litert-lm' && allToolCalls.length === 0) {
      const pf = litertLmPrefillStats(finalUsage.prompt_tokens, ttftMs)
      if (pf) {
        stats.promptMs = pf.promptMs
        stats.promptTps = pf.promptTps
      }
    }
  }

  // F-022: run the heuristic referee on Research persona replies before persisting.
  // Pure string/regex — synchronous, < 5ms, no IO.
  let refereeVerdicts: ClaimVerdict[] | undefined
  if (conv.toolPolicy === 'force_web_search' && fullContent && allResearchSources.length > 0) {
    try {
      refereeVerdicts = checkReply(fullContent, allResearchSources)
    } catch { /* swallow — referee is best-effort */ }
  }

  // F-021: persist research metadata alongside the message.
  const researchMeta: ResearchMeta | undefined =
    conv.toolPolicy === 'force_web_search' && (parsedConfidence !== undefined || allResearchSources.length > 0 || refereeVerdicts !== undefined)
      ? {
          confidence: parsedConfidence,
          sources: allResearchSources.length > 0 ? allResearchSources : undefined,
          refereeVerdicts: refereeVerdicts && refereeVerdicts.length > 0 ? refereeVerdicts : undefined,
        }
      : undefined

  db.updateMessage(assistantMsg.id, { content: fullContent, reasoning: fullReasoning, toolCalls: allToolCalls, stats, researchMeta })
  db.touchConversation(convId)
  // Both are LOCAL measurements of LOCAL hardware. A remote turn's t/s describes the
  // HOST's GPU: reporting it as a bench_result for this machine's config would poison the
  // fleet-wide bench corpus, and folding it into this manager's session averages is the
  // very contamination I-4 closed on the gateway path.
  if (localAccounting) {
    const loaded = d.manager.status().model
    if (!aborted && !engineFailed && loaded) reportChatBenchResult(d, loaded, stats)
    try {
      d.manager.recordCompletion({
        inputTokens: stats.promptTokens,
        outputTokens: stats.genTokens,
        promptTps: stats.promptTps,
        genTps: stats.tps,
      })
    } catch { /* swallow — stats are best-effort */ }
  }

  const finalMsg = db.getMessage(assistantMsg.id)!
  // The client may have already disconnected (cancelled turn / closed tab); writing to a
  // torn-down stream rejects. Swallow it — the assistant message is persisted above
  // regardless, and an unhandled rejection here would crash the daemon (and orphan the
  // engine), which is the root of the reported "requests never end / model stays loaded".
  try {
    await emit({ event: 'done', data: { message: finalMsg } })
  } catch { /* client gone — nothing to flush to */ }

  if (!aborted && conv.title === 'New chat' && d.store.snapshot().daemon.autoGenerateTitles) {
    setTimeout(() => { void autoTitle(d, convId, ctx.engineMessages, fullContent, upstream) }, 1000)
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
    setTimeout(() => { void extractMemoryFacts(d, convId, ctx.userText!, upstream) }, 1500)
  }
}

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
