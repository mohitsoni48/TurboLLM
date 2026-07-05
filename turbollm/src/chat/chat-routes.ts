// Chat API routes (spec 07). Conversations CRUD + SSE streaming send + message actions.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { networkInterfaces } from 'node:os'
import type { Deps } from '../deps'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { feedChunk, flushState, initParseState } from './parser'
import { needsExtraPass } from './think-utils'

import type { ClaimVerdict, ConversationStore, MessageStats, ResearchMeta, ResearchSource, ToolCallRecord } from './db'
import { checkReply } from '../tools/research-referee.js'
import { buildSnapshot } from './chat-export'
import type { ExportFormat } from './chat-export'
import { executeToolCallWithApproval } from '../tools/execute-with-approval'
import { resolveToolApproval } from '../tools/approval-gate'
import { buildSaveSkillTool } from '../agents/agent-tools'
import { SkillStore } from '../agents/skills'
import { saveSkillFromConversation } from '../agents/skill-jobs'

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

type S = 200 | 201 | 202 | 400 | 404 | 409 | 500
function err(c: Context, s: S, code: string, msg: string) { return c.json({ error: { code, message: msg } }, s) }
async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

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
    const name = (b.name ?? '').trim()
    if (!name) return err(c, 400, 'invalid_input', 'Folder name required.')
    return c.json(db.createFolder(name), 201)
  })

  app.patch('/api/v1/folders/:id', async (c) => {
    const b = await body<{ name?: string }>(c)
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

  // ── conversations CRUD ─────────────────────────────────────────────────────

  app.get('/api/v1/conversations', (c) => {
    const q = c.req.query('q')
    return c.json({ conversations: db.listConversations(q, 'chat') })
  })

  app.post('/api/v1/conversations', async (c) => {
    const b = await body<{ title?: string; systemPrompt?: string; modelKey?: string; toolPolicy?: string; skillIds?: string[] }>(c)
    // Only keep ids that exist in the shared skill library; silently drop unknown ones.
    const validIds = new Set(new SkillStore(d.store.dir()).list().map((s) => s.id))
    const skillIds = Array.isArray(b.skillIds) ? b.skillIds.filter((sid) => validIds.has(sid)) : undefined
    const conv = db.createConversation({ title: b.title, systemPrompt: b.systemPrompt, modelKey: b.modelKey, toolPolicy: b.toolPolicy, skillIds })
    return c.json(conv, 201)
  })

  // Save this conversation as a reusable SKILL (Voyager-style distill from the
  // transcript). Detached → shared library, deduped by name.
  app.post('/api/v1/conversations/:id/save-skill', (c) => {
    const conv = db.getConversation(c.req.param('id'))
    if (!conv) return c.json({ error: { code: 'not_found', message: 'Conversation not found.' } }, 404)
    // Same background skill author the in-chat save_skill tool uses (skill-creator model).
    const taskId = saveSkillFromConversation(d, conv.id)
    return c.json({ ok: true, learning: !!taskId })
  })

  app.get('/api/v1/conversations/:id', (c) => {
    const conv = db.getConversation(c.req.param('id'), true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')
    return c.json(conv)
  })

  app.patch('/api/v1/conversations/:id', async (c) => {
    const b = await body<{ title?: string; systemPrompt?: string; sampling?: Record<string, unknown>; skillIds?: string[] }>(c)
    if (b.skillIds !== undefined) {
      const validIds = new Set(new SkillStore(d.store.dir()).list().map((s) => s.id))
      b.skillIds = b.skillIds.filter((sid) => validIds.has(sid))
    }
    const ok = db.updateConversation(c.req.param('id'), b)
    if (!ok) return err(c, 404, 'not_found', 'Conversation not found.')
    return c.json(db.getConversation(c.req.param('id'))!)
  })

  app.delete('/api/v1/conversations/:id', (c) => {
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
    const toolName = (b.toolName ?? '').trim()
    const decision = b.decision
    if (!toolName) return err(c, 400, 'invalid_input', 'toolName is required.')
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow_chat' && decision !== 'always_allow') {
      return err(c, 400, 'invalid_input', 'decision must be one of: allow, deny, allow_chat, always_allow.')
    }

    const conv = db.getConversation(convId)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    let decisionToApply: 'allow' | 'deny'
    if (decision === 'always_allow') {
      d.store.update((cfg) => {
        cfg.tools.toolPolicies = { ...(cfg.tools.toolPolicies ?? {}), [toolName]: 'allow' }
      })
      decisionToApply = 'allow'
    } else if (decision === 'allow_chat') {
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
    const b = await body<{ content?: string; images?: string[]; docContext?: string; textAttachments?: string[]; disableThinking?: boolean }>(c)
    const content = (b.content ?? '').trim()
    const images = b.images ?? []
    const textAttachments = b.textAttachments ?? []
    // A message is valid if it has typed text OR carries an image or file
    // attachment — image-only / file-only sends are allowed.
    if (!content && images.length === 0 && textAttachments.length === 0)
      return err(c, 400, 'invalid_input', 'Type a message or attach an image or file.')

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) return err(c, 409, 'model_not_loaded', 'Load a model first.')
    const target = d.manager.target()
    if (!target) return err(c, 409, 'model_not_loaded', 'Engine not running.')

    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'A generation is already running for this conversation.')

    // Persist user message — only the typed text is stored as content; images are
    // kept in attachments (the full doc context is folded into the engine prompt below).
    const userMsg = db.addMessage(convId, 'user', content, { attachments: images, textAttachments })

    // Create a placeholder assistant message
    db.addMessage(convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = db.getLastMessage(convId)!

    const ac = new AbortController()
    inflight.set(convId, ac)

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => { ac.abort(); inflight.delete(convId) })

      // Emit meta event
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ userMessageId: userMsg.id, assistantMessageId: assistantMsg.id }) })

      // Build messages array for engine
      const allMsgs = (conv.messages ?? []).filter(m => m.id !== assistantMsg.id)
      const engineMessages: { role: string; content: unknown }[] = []
      if (conv.systemPrompt) engineMessages.push({ role: 'system', content: conv.systemPrompt })
      for (const m of allMsgs) {
        engineMessages.push({ role: m.role, content: m.content })
      }
      // Fold any attached document text into the prompt; attach images as multimodal parts.
      const fullContent = b.docContext
        ? (content ? `${b.docContext}\n\n${content}` : b.docContext)
        : content
      const userContent: unknown = images.length
        ? [
            ...(fullContent ? [{ type: 'text', text: fullContent }] : []),
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ]
        : fullContent
      engineMessages.push({ role: 'user', content: userContent })

      await runGeneration(d, stream, { convId, conv, engineMessages, assistantMsg, ms, target, ac, disableThinking: b.disableThinking ?? false })
    })
  })

  // ── continue (regenerate last assistant response for the existing last user
  //    message, WITHOUT adding a new user message) ──────────────────────────────

  app.post('/api/v1/conversations/:id/continue', async (c) => {
    const convId = c.req.param('id')
    const b = await body<{ disableThinking?: boolean }>(c)

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) return err(c, 409, 'model_not_loaded', 'Load a model first.')
    const target = d.manager.target()
    if (!target) return err(c, 409, 'model_not_loaded', 'Engine not running.')

    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'A generation is already running for this conversation.')

    const lastUser = (conv.messages ?? []).filter((m) => m.role === 'user').at(-1)
    if (!lastUser) return err(c, 400, 'no_user_message', 'No user message to respond to.')

    // Create a placeholder assistant message
    db.addMessage(convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = db.getLastMessage(convId)!

    const ac = new AbortController()
    inflight.set(convId, ac)

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => { ac.abort(); inflight.delete(convId) })

      // Emit meta event (no new user message — reuse the existing last user message id)
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ userMessageId: lastUser.id, assistantMessageId: assistantMsg.id }) })

      // Build messages array for engine from the existing (already-trimmed) history.
      const allMsgs = (conv.messages ?? []).filter((m) => m.id !== assistantMsg.id)
      const engineMessages: { role: string; content: unknown }[] = []
      if (conv.systemPrompt) engineMessages.push({ role: 'system', content: conv.systemPrompt })
      for (const m of allMsgs) {
        engineMessages.push({ role: m.role, content: m.content })
      }

      await runGeneration(d, stream, { convId, conv, engineMessages, assistantMsg, ms, target, ac, disableThinking: b.disableThinking ?? false })
    })
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
    if (!b.content?.trim()) return err(c, 400, 'invalid_input', 'content required.')
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    if (msg.role !== 'user') return err(c, 400, 'invalid_input', 'Can only edit user messages.')
    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'Stop generation first.')
    db.updateMessage(msgId, { content: b.content.trim() })
    db.deleteMessagesAfterSeq(convId, msg.seq)
    return c.json({ messages: db.getMessages(convId) })
  })

  app.delete('/api/v1/conversations/:id/messages/:msgId', (c) => {
    const { id: convId, msgId } = c.req.param()
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    db.deleteMessage(msgId)
    return c.json({ ok: true })
  })

  app.post('/api/v1/conversations/:id/regenerate', (c) => {
    const convId = c.req.param('id')
    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'Stop generation first.')
    const last = db.getLastMessage(convId)
    if (last?.role === 'assistant') db.deleteMessage(last.id)
    return c.json({ ok: true })
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
    const lanIp = getLanIpForShare()
    const url = `http://${lanIp}:${cfg.daemon.port}/chat/${convId}`
    const onlyLocal = lanIp === '127.0.0.1'
    return c.json({ url, onlyLocal })
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

// ── LAN IP helper (F-023) ──────────────────────────────────────────────────────

function getLanIpForShare(): string {
  const nets = networkInterfaces()
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

// ── shared generation streaming ───────────────────────────────────────────────

type StreamHandle = Parameters<Parameters<typeof streamSSE>[1]>[0]
type ManagerStatus = ReturnType<Deps['manager']['status']>

interface GenerationCtx {
  convId: string
  conv: NonNullable<ReturnType<Deps['db']['getConversation']>>
  engineMessages: { role: string; content: unknown }[]
  assistantMsg: NonNullable<ReturnType<Deps['db']['getLastMessage']>>
  ms: ManagerStatus
  target: string
  ac: AbortController
  /** When true, instruct the engine to skip reasoning entirely (model answers
   *  directly). Mirrors the params autoTitle uses. */
  disableThinking: boolean
}

/**
 * Streams an assistant turn with optional agentic tool-calling loop. Posts to the
 * engine, relays delta/reasoning/progress/tool_call SSE events, parses inline <think>
 * tags, executes tool calls and loops (up to MAX_TOOL_ITER rounds), persists the final
 * message + stats, and fires auto-title. Shared by the messages and continue endpoints.
 */
async function runGeneration(d: Deps, stream: StreamHandle, ctx: GenerationCtx): Promise<void> {
  const { db } = d
  const { convId, conv, assistantMsg, ms, target, ac, disableThinking } = ctx

  // Map conversation sampling overrides (camelCase) to the engine's snake_case names.
  const convS = conv.sampling ?? {}
  const engineKind = d.registry.active()?.kind ?? ''
  // BUG-006: vLLM and SGLang reject `repeat_penalty` (the llama.cpp name) and require
  // `repetition_penalty` — the OpenAI-spec name. Map per engine kind.
  const repeatPenaltyKey = (engineKind === 'vllm' || engineKind === 'sglang') ? 'repetition_penalty' : 'repeat_penalty'
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

  // F-021: inject confidence-loop instruction into Research persona system prompt.
  // Appends to the existing system message (or inserts one if absent).
  const CONFIDENCE_INSTRUCTION =
    '\n\nAfter reviewing the search results, include a confidence assessment on a line by itself before your final answer: `[confidence: 0.XX]` where XX is your confidence (0.0–1.0) that your answer is accurate and current. If your confidence is below 0.8, call web_search again with a more specific query first. Maximum 3 search calls per response.'
  if (conv.toolPolicy === 'force_web_search') {
    const sysIdx = iterMessages.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      const existing = typeof iterMessages[sysIdx].content === 'string' ? iterMessages[sysIdx].content : ''
      iterMessages[sysIdx] = { ...iterMessages[sysIdx], content: existing + CONFIDENCE_INSTRUCTION }
    } else {
      iterMessages.unshift({ role: 'system', content: CONFIDENCE_INSTRUCTION.trim() })
    }
  }

  const MAX_TOOL_ITER = 10
  let toolIter = 0
  /** Number of web_search tool calls made this turn (caps confidence re-loop at 3). */
  let searchCallCount = 0
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
  let liveOut = 0

  d.manager.generationStart()
  try {
    // Get tool definitions once (or empty for engines that don't support tools)
    const baseToolDefs = d.tools ? await d.tools.buildToolDefinitions() : []
    // 'skill-creator' grants save_skill — the one tool a skill can add beyond the base
    // registry (every other skill is instructions text only). No-op unless enabled.
    const skillTools = enabledSkillIds.has('skill-creator')
      ? buildSaveSkillTool(() => {
          // In-chat skill author: read THIS conversation in the background and write a
          // SKILL.md to the shared library.
          const tid = saveSkillFromConversation(d, conv.id)
          return tid
            ? 'Started writing a skill from this conversation in the background. It will appear in the skill library shortly.'
            : 'There is nothing to turn into a skill yet.'
        })
      : undefined
    const toolDefs = skillTools ? [...baseToolDefs, ...skillTools.defs] : baseToolDefs

    outerLoop: while (toolIter <= MAX_TOOL_ITER) {
      toolIter++

      const reqBody: Record<string, unknown> = {
        model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model!.key,
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
      if (disableThinking) {
        reqBody.reasoning_budget = 0
        reqBody.chat_template_kwargs = { enable_thinking: false }
      }
      // Attach tools only to engines whose OpenAI server accepts a `tools` array as
      // passthrough. vLLM is strict: a `tools` array (which defaults tool_choice to
      // "auto") is REJECTED with HTTP 400 — "auto tool choice requires
      // --enable-auto-tool-choice and --tool-call-parser to be set" — unless the
      // server was launched with those flags (which we don't, and no built-in parser
      // matches Gemma's tool format). Sending tools there breaks ALL vLLM chat, so we
      // skip them. llama.cpp/forks accept them; mlx-lm ignores them harmlessly.
      const toolsSupported = engineKind !== 'vllm' && engineKind !== 'sglang' && toolDefs.length > 0
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

      const res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        duplex: 'half',
      })

      if (!res.ok || !res.body) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'engine_error', message: `Engine returned ${res.status}` }) })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      const cancelReader = () => void reader.cancel()
      if (ac.signal.aborted) {
        cancelReader()
      } else {
        ac.signal.addEventListener('abort', cancelReader, { once: true })
      }

      // Per-round state
      let roundContent = ''
      let parseState = initParseState()
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

          // Prompt progress
          const pp = chunk.prompt_progress as { processed?: number; total?: number; tps?: number } | undefined
          if (pp && pp.total) {
            const pct = Math.round((pp.processed ?? 0) / pp.total * 100)
            d.manager.setLiveGen({ phase: 'prompt', pct, outputTokens: 0 })
            await stream.writeSSE({ event: 'progress', data: JSON.stringify({ phase: 'prompt', processed: pp.processed, total: pp.total, pct, tps: pp.tps ?? 0 }) })
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
                await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ id: entry.id, name: entry.name, args: {}, status: 'pending' }) })
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
            await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: rc }) })
            continue
          }

          const raw_content = delta.content ?? ''
          if (!raw_content) continue

          const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
          parseState = nextState
          for (const ev of parseEvents) {
            if (ev.type === 'reasoning') {
              if (!thinkStart) thinkStart = Date.now()
              thinkEnd = Date.now()
              fullReasoning += ev.text
              await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: ev.text }) })
            } else {
              fullContent += ev.text
              roundContent += ev.text
              if (!ttftMs) ttftMs = Date.now() - requestStart
              d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
              await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: ev.text }) })
            }
          }
        }
      }
      ac.signal.removeEventListener('abort', cancelReader)

      // Flush lookahead buffer at end-of-stream.
      for (const ev of flushState(parseState)) {
        if (ev.type === 'reasoning') {
          fullReasoning += ev.text
          await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: ev.text }) })
        } else {
          fullContent += ev.text
          roundContent += ev.text
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: ev.text }) })
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

          let result: string
          let callError: string | undefined

          if (isSkillTool && skillTools) {
            // Emit pending event so the frontend can show "calling..."
            await stream.writeSSE({
              event: 'tool_call',
              data: JSON.stringify({ id: tc.id, name: tc.name, args: parsedArgs, status: 'pending' }),
            })
            try {
              result = skillTools.execute({ id: tc.id, name: tc.name, args: parsedArgs })
            } catch (e) {
              callError = (e as Error).message
              result = `Error: ${callError}`
            }
            await stream.writeSSE({
              event: 'tool_call',
              data: JSON.stringify({ id: tc.id, name: tc.name, args: parsedArgs, status: callError ? 'error' : 'done', result }),
            })
          } else {
            // Live foreground chat gets the real approval gate (interactive: true) — an
            // 'ask'-policy tool prompts the user via 'tool_call'/'awaiting_approval' and
            // waits for POST .../tool-calls/:toolCallId/approve to resolve it.
            const approved = await executeToolCallWithApproval({
              tools: d.tools,
              sink: (ev) => stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) }),
              convId,
              id: tc.id,
              name: tc.name,
              args: parsedArgs,
              globalPolicies: d.store.snapshot().tools.toolPolicies ?? {},
              // Re-read fresh on every iteration (not the `conv` snapshot captured at request
              // start) — otherwise a same-turn repeat tool call misses an "Allow for this
              // chat" decision the user just made via POST .../tool-calls/:id/approve.
              convOverrides: d.db.getToolOverrides(convId),
              signal: ac.signal,
              interactive: true,
            })
            result = approved.result
            callError = approved.error
          }

          // F-021: track web_search calls and accumulate research sources.
          if (tc.name === 'web_search' && !callError) {
            searchCallCount++
            // The result string embeds the structured data; also ask the registry
            // for the raw ResearchResult[] via a direct research call on the same
            // args (zero extra network cost — the registry already called it).
            // We parse what we can from the result string as a fallback.
            try {
              // Re-parse sources from result text: each [N] block has Domain/Relevance line
              const sourceMatches = [...result.matchAll(/\[(\d+)\] (.+?)\nSource: (\S+)\nDomain: (\S+) \| Relevance: ([\d.]+) \| Freshness: (\w+)\nKey passage: ([\s\S]+?)(?=\n\[|\s*$)/g)]
              for (const m of sourceMatches) {
                allResearchSources.push({
                  title: m[2].trim(),
                  url: m[3].trim(),
                  domain: m[4].trim(),
                  relevanceScore: parseFloat(m[5]),
                  freshnessSignal: (m[6].trim() as 'recent' | 'dated' | 'unknown'),
                  passage: m[7].trim(),
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
      // and search budget allows (max 3 web_search calls per turn).
      if (conv.toolPolicy === 'force_web_search' && fullContent && d.tools) {
        const confMatch = fullContent.match(/\[confidence:\s*([\d.]+)\]/i)
        if (confMatch) {
          const conf = parseFloat(confMatch[1])
          parsedConfidence = conf
          // Strip confidence marker from visible content regardless
          fullContent = fullContent.replace(/\[confidence:\s*[\d.]+\]\s*/gi, '').trim()

          if (conf < 0.8 && searchCallCount < 3) {
            console.log(`[chat] F-021: confidence ${conf} < 0.8 (searches: ${searchCallCount}/3) — re-entering search loop`)
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
        model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model!.key,
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
      if (disableThinking) {
        reqBody.reasoning_budget = 0
        reqBody.chat_template_kwargs = { enable_thinking: false }
      }

      const res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        duplex: 'half',
      })

      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        const cancelReader = () => void reader.cancel()
        if (ac.signal.aborted) {
          cancelReader()
        } else {
          ac.signal.addEventListener('abort', cancelReader, { once: true })
        }

        let parseState = initParseState()
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
            if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage
            if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings
            const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> | undefined
            if (!choices?.length) continue
            const delta = choices[0].delta ?? {}
            const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
            if (rc) {
              fullReasoning += rc
              await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: rc }) })
              continue
            }
            const raw_content = delta.content ?? ''
            if (!raw_content) continue
            const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
            parseState = nextState
            for (const ev of parseEvents) {
              if (ev.type === 'reasoning') {
                fullReasoning += ev.text
                await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: ev.text }) })
              } else {
                fullContent += ev.text
                if (!ttftMs) ttftMs = Date.now() - requestStart
                d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
                await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: ev.text }) })
              }
            }
          }
        }
        ac.signal.removeEventListener('abort', cancelReader)
        for (const ev of flushState(parseState)) {
          if (ev.type === 'reasoning') {
            fullReasoning += ev.text
            await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: ev.text }) })
          } else {
            fullContent += ev.text
            await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: ev.text }) })
          }
        }
      }
    }
  } catch (e: unknown) {
    const isAbort = (e as Error)?.name === 'AbortError'
    aborted = isAbort
    if (!isAbort) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'engine_stopped', message: (e as Error).message }) })
    }
  } finally {
    d.manager.generationEnd()
    inflight.delete(convId)
  }

  const totalMs = Date.now() - requestStart
  const thinkMs = thinkStart && thinkEnd ? thinkEnd - thinkStart : 0
  const ctxMax = ms.model?.ctx ?? 4096

  const stats: Partial<MessageStats> = {
    ttftMs,
    totalMs,
    thinkMs,
    // Full context occupancy: cache-reused prompt tokens still sit in the KV cache / context
    // window (they're skipped only for recomputation), so they must stay counted here.
    ctxUsed: (finalUsage.prompt_tokens ?? 0) + (finalUsage.completion_tokens ?? 0),
    ctxMax,
    model: ms.model?.name ?? '',
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
    stats.promptTokens = fullPrompt
    stats.genTokens    = finalUsage.completion_tokens ?? 0
    stats.genMs        = totalMs - ttftMs
    stats.tps          = stats.genMs > 0 ? Math.round((stats.genTokens / stats.genMs) * 1000 * 10) / 10 : 0
    stats.cachedTokens = cachedExplicit ?? 0
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

  try {
    d.manager.recordCompletion({
      inputTokens: stats.promptTokens,
      outputTokens: stats.genTokens,
      promptTps: stats.promptTps,
      genTps: stats.tps,
    })
  } catch { /* swallow — stats are best-effort */ }

  const finalMsg = db.getMessage(assistantMsg.id)!
  // The client may have already disconnected (cancelled turn / closed tab); writing to a
  // torn-down stream rejects. Swallow it — the assistant message is persisted above
  // regardless, and an unhandled rejection here would crash the daemon (and orphan the
  // engine), which is the root of the reported "requests never end / model stays loaded".
  try {
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ message: finalMsg }) })
  } catch { /* client gone — nothing to flush to */ }

  if (!aborted && conv.title === 'New chat' && d.store.snapshot().daemon.autoGenerateTitles) {
    setTimeout(() => { void autoTitle(d, convId, ctx.engineMessages, fullContent, target) }, 1000)
  }
}

// ── auto title generation ──────────────────────────────────────────────────

async function autoTitle(
  d: Deps,
  convId: string,
  prevMessages: { role: string; content: unknown }[],
  assistantReply: string,
  target: string,
): Promise<void> {
  try {
    const ms = d.manager.status()
    if (ms.state !== 'running') return
    const titleMessages = [
      ...prevMessages.slice(-2),
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
    const release = d.gate ? await d.gate.acquire('bg') : null
    let res: Response
    try {
      res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model?.key,
          messages: titleMessages,
          stream: false,
          temperature: 0.3,
          max_tokens: 32,
          reasoning_budget: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(20_000),
      })
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
  const target = d.manager.target()
  if (!target) return
  const msgs = (conv.messages ?? []).filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }))
  if (!msgs.length) return
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
  await autoTitle(d, convId, msgs.slice(0, -1), typeof lastAssistant?.content === 'string' ? lastAssistant.content : '', target)
}
