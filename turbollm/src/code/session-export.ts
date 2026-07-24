// Session export (Phase 3, ADR-251) — a pure serializer from a Code session's already-persisted
// AgentRun + Conversation (the same data CodeTranscript.tsx renders) to a Markdown document.
// Markdown-only for this pass (spec 15 §5 defers HTML as a fast-follow) — deliberately built so
// that fast-follow can reuse this exact output through the app's existing Markdown/rehypeHighlight
// renderer instead of a second serializer.
import type { AgentRun, Conversation, Message, MessageTimelineBlock, ToolCallRecord } from '../chat/db'

/** Cap on any single rendered chunk (tool result/error/diff) so one runaway tool output (e.g. a
 *  `cat` of a huge file) can't blow up the export into an unopenable multi-hundred-MB document.
 *  20k chars is generous for a human-readable transcript (a full screen of terminal output is a
 *  few hundred to a couple thousand chars) while still bounding worst case. Truncation is always
 *  flagged inline rather than silent. */
export const EXPORT_TRUNCATE_LIMIT = 20_000

function truncateForExport(text: string, limit = EXPORT_TRUNCATE_LIMIT): string {
  if (text.length <= limit) return text
  const cut = text.length - limit
  return `${text.slice(0, limit)}\n\n… [truncated — ${cut.toLocaleString()} more character${cut === 1 ? '' : 's'}] …`
}

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``
}

function renderReasoning(reasoning: string): string {
  if (!reasoning.trim()) return ''
  // <details> is valid GFM (renders collapsed) and degrades to plain readable text in any
  // markdown viewer that doesn't support it — safer than inventing a bespoke convention.
  return `<details>\n<summary>Reasoning</summary>\n\n${reasoning.trim()}\n\n</details>\n\n`
}

function renderToolCall(call: ToolCallRecord): string {
  const parts = [`### Tool call: \`${call.name}\``]
  const argsJson = (() => {
    try { return JSON.stringify(call.args, null, 2) } catch { return String(call.args) }
  })()
  if (argsJson && argsJson !== '{}') parts.push(fence('json', truncateForExport(argsJson)))
  if (call.diff) {
    parts.push(fence('diff', truncateForExport(call.diff)))
  } else if (call.error) {
    parts.push(`**Error:**\n\n${fence('text', truncateForExport(call.error))}`)
  } else if (call.result) {
    parts.push(fence('text', truncateForExport(call.result)))
  }
  return parts.join('\n\n')
}

/** True chronological interleave when `timeline` is present (Code messages always populate it —
 *  see db.ts's MessageTimelineBlock doc comment). Falls back to content-then-tool-calls for
 *  messages persisted before that field existed (older sessions) — still renders every field,
 *  just without the original interleave order, since that information no longer exists. */
function legacyTimeline(message: Message): MessageTimelineBlock[] {
  const blocks: MessageTimelineBlock[] = []
  if (message.content) blocks.push({ type: 'text', text: message.content })
  for (const call of message.toolCalls) blocks.push({ type: 'tool', id: call.id })
  return blocks
}

function renderAssistantMessage(message: Message): string {
  const toolsById = new Map(message.toolCalls.map((t) => [t.id, t]))
  const timeline = message.timeline?.length ? message.timeline : legacyTimeline(message)
  const parts: string[] = ['## Assistant']
  const reasoning = renderReasoning(message.reasoning)
  if (reasoning) parts.push(reasoning.trimEnd())
  for (const block of timeline) {
    if (block.type === 'text') {
      if (block.text.trim()) parts.push(block.text.trim())
    } else {
      const call = toolsById.get(block.id)
      if (call) parts.push(renderToolCall(call))
    }
  }
  if (parts.length === 1) parts.push('*(no content)*')
  return parts.join('\n\n')
}

function renderUserMessage(message: Message): string {
  const parts = ['## You', message.content.trim() || '*(empty message)*']
  if (message.textAttachments.length) {
    parts.push(`**Attached:** ${message.textAttachments.map((p) => `\`${p}\``).join(', ')}`)
  }
  return parts.join('\n\n')
}

function renderMessage(message: Message): string {
  return message.role === 'user' ? renderUserMessage(message) : renderAssistantMessage(message)
}

export interface SerializeOptions {
  /** ISO timestamp to stamp as "Exported". Defaults to now — overridable so callers (tests) get
   *  deterministic output without mocking the clock globally. */
  exportedAt?: string
}

/** The whole export: a metadata header (title, repo/branch, mode, status, created/exported) then
 *  every message in order. Zero-message sessions still produce a valid document (header only, plus
 *  a note) rather than an empty/error file — exporting a session that's still actively generating
 *  is likewise never an error here: this only ever reads what `conv.messages` already has
 *  persisted, so an in-flight turn's not-yet-saved content is naturally just absent, not a failure
 *  case the caller needs to guard against. */
export function serializeCodeSessionMarkdown(
  run: AgentRun,
  conv: Conversation,
  opts: SerializeOptions = {},
): string {
  const exportedAt = opts.exportedAt ?? new Date().toISOString()
  const title = run.title.trim() || 'Untitled Code session'
  const meta = [
    `- **Session ID:** ${run.id}`,
    run.repoRoot ? `- **Repo:** ${run.repoRoot}${run.repoBranch ? ` (branch: ${run.repoBranch})` : ''}` : undefined,
    `- **Mode:** ${conv.agentMode ?? 'auto'}`,
    `- **Status:** ${run.status}`,
    `- **Created:** ${run.createdAt}`,
    `- **Exported:** ${exportedAt}`,
  ].filter((line): line is string => !!line)

  const messages = (conv.messages ?? []).slice().sort((a, b) => a.seq - b.seq)
  const body = messages.length
    ? messages.map(renderMessage).join('\n\n---\n\n')
    : '*(no messages in this session yet)*'

  return `# ${title}\n\n${meta.join('\n')}\n\n---\n\n${body}\n`
}

/** Illegal-on-Windows characters (the strictest of the three target filesystems — see
 *  turbollm/CLAUDE.md's cross-platform rule) plus control chars. Whitelist approach (strip
 *  anything not alnum/space/underscore/dash) rather than a blacklist — mirrors the existing
 *  chat-export filename sanitizer (chat-routes.ts's GET .../export route) for consistency, and by
 *  construction can never let a `/`, `:`, or similar through regardless of what's added to the
 *  illegal-char list later. Non-ASCII/unicode titles are NOT preserved (stripped, same as the
 *  existing chat-export precedent) — an intentional simplification: a Windows-safe filename
 *  guarantee is worth more here than preserving unicode in a filename, and the title is never lost
 *  (it's still the export's own `# <title>` heading inside the document). */
const MAX_FILENAME_SLUG = 80

export function codeSessionExportFilename(title: string, createdAt: string, ext: string): string {
  const slug = title
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, MAX_FILENAME_SLUG)
    .replace(/-+$/, '') || 'code-session'
  const dateStr = createdAt.slice(0, 10) || new Date().toISOString().slice(0, 10)
  return `${slug}-${dateStr}.${ext}`
}
