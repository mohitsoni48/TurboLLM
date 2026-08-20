// OpenAI-protocol adapter for agent-guidance.ts.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The gateway's agent scaffolding (loop detection, loop breaking, search-on-repeated-failure,
// research-the-approach-first, dependency discipline, and the routine-creation hint) was written
// against the Anthropic protocol because the only external harness at the time was `claude`, which
// speaks `/v1/messages`. Every other harness TurboLLM supports — `pi`, `opencode`, `kilo`,
// `openclaw`, `hermes`, DeepSeek Harness, and any plain script — speaks OpenAI
// `/v1/chat/completions` instead, and so got NONE of it: the rules lived on the far side of a
// protocol boundary, not an agent boundary.
//
// `agent-guidance.ts` was already written client-agnostically — `webToolNames()` adapts every rule
// to whatever the client actually declared, and `SEARCH_TOOL_NAMES` already collapses `web_search`
// / `WebSearch` / `websearch` — so the rules themselves need no rewriting. What was missing is a
// translation of an OpenAI-shaped request into the shape those pure predicates already read.
//
// ── Design: a read-only VIEW, not a round-trip ──────────────────────────────────────────────────
// This module builds a throwaway `AnthropicRequest`-shaped view of the OpenAI body purely so
// `analyzeTurn()` can inspect it, then applies the resulting guidance DIRECTLY to the real OpenAI
// body. Nothing is translated back. That keeps one implementation of the rules (agent-guidance.ts,
// untouched) instead of two that drift, and it means the view only has to be faithful in the four
// things the predicates actually read: assistant tool calls, tool results and their success/
// failure, the declared tool names, and the trailing message's role.
//
// A happy consequence: `commitConfirmedCodeToolCalls` (gateway.ts) reads exactly the same
// `tool_result` blocks, so the same view drives coding-activity attribution for OpenAI clients
// with no second adapter.
import type { AnthropicRequest } from './anthropic'

/** OpenAI's `role: 'tool'` message has NO documented success/failure flag — the Anthropic protocol's
 *  `tool_result.is_error` (which `trailingToolFailures` counts, and which coding-activity
 *  attribution correlates against before crediting an edit) simply does not exist there.
 *
 *  Two non-standard spellings ARE emitted by real clients, so they are trusted FIRST when present:
 *  a boolean `is_error` or `error` directly on the tool message. Neither is in the OpenAI spec;
 *  both are cheap to honour and unambiguous when they appear.
 *
 *  Absent those, the fallback is this deliberately NARROW anchored match on the result text. It is
 *  a heuristic and is documented as one rather than presented as a protocol fact — but the failure
 *  modes are graceful in both directions, which is what makes a heuristic acceptable here:
 *    - false POSITIVE → one extra nudge telling the model to read the docs before retrying. That is
 *      advice, not an action; the worst case is a slightly longer prompt.
 *    - false NEGATIVE → rule 3 does not fire for that turn, i.e. exactly today's behaviour.
 *  Neither can corrupt a turn, block a tool, or mis-credit an edit — attribution treats "not known
 *  to have failed" as success only for CREDITING, and an uncredited edit is the safe direction.
 *
 *  Anchored at the start, and a generic failure WORD must be followed by a separator (`:`, `-`,
 *  `!`, or a bracketed code) rather than merely a word boundary. A word boundary alone was the
 *  first version and it was too loose — caught by this module's own test: a Read returning prose or
 *  source that opens with "Error handling is covered in section 4" matched, because `\b` is
 *  satisfied by the following space. Requiring the separator keeps the real forms ("Error: …",
 *  "ERROR!", "error [E0432]: …") and drops the prose. Self-evidencing phrases that cannot be
 *  anything but a failure ("Traceback", "permission denied", "ENOENT") need no separator. */
const TOOL_ERROR_TEXT =
  /^\s*(?:(?:error|exception|fatal|failed|failure)\s*(?:\[[^\]]*\])?\s*[:\-–—!]|traceback\b|permission denied|command not found|no such file or directory|enoent\b|econnrefused\b)/i

/** Flatten an OpenAI message `content` (string, or an array of content parts) to plain text.
 *  Only text is recovered — an image part contributes nothing, which is correct here: every
 *  predicate that reads this is looking for a shell command or an error string. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const t = (part as { text?: unknown }).text
        if (typeof t === 'string') return t
      }
      return ''
    })
    .join('')
}

/** Whether an OpenAI `role: 'tool'` message reports a failure. See TOOL_ERROR_TEXT. */
export function toolMessageIsError(msg: Record<string, unknown>): boolean {
  if (typeof msg.is_error === 'boolean') return msg.is_error
  if (typeof msg.error === 'boolean') return msg.error
  return TOOL_ERROR_TEXT.test(contentText(msg.content))
}

/** An `AnthropicRequest`-shaped view of an OpenAI chat-completions body, faithful in exactly the
 *  parts `analyzeTurn` and `commitConfirmedCodeToolCalls` read. Never sent anywhere.
 *
 *  Mapping:
 *   - assistant `tool_calls[]`  → `tool_use` blocks (`arguments` is a JSON *string* in OpenAI, so
 *     it is parsed; an unparseable one keeps the raw string as the input rather than dropping the
 *     call, since `toolCallSignature` only needs a stable value to compare repetitions).
 *   - `role: 'tool'`            → a USER message carrying one `tool_result` block. Anthropic
 *     transports tool results on the user turn, and `trailingToolFailures` / the nudge placement
 *     both scan user messages — mapping it to any other role would make both silently miss.
 *   - `role: 'system'`          → kept as `system` role. `toolCallHistory` ignores it; it is
 *     preserved only so message ordering (and therefore "the trailing message is a user turn")
 *     stays truthful.
 *   - `tools[].function.name`   → `tools[].name`, which is all `webToolNames` reads. */
export function openAiRequestView(body: Record<string, unknown>): AnthropicRequest {
  const rawMessages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  const messages: AnthropicRequest['messages'] = []

  for (const msg of rawMessages) {
    const role = msg.role

    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '',
          is_error: toolMessageIsError(msg),
          content: contentText(msg.content),
        }],
      })
      continue
    }

    if (role === 'assistant') {
      const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Array<Record<string, unknown>>) : []
      if (calls.length === 0) {
        messages.push({ role: 'assistant', content: contentText(msg.content) })
        continue
      }
      const blocks: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }> = []
      for (const call of calls) {
        const fn = (call.function ?? {}) as { name?: unknown; arguments?: unknown }
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''
        let input: unknown
        try { input = JSON.parse(args) } catch { input = args }
        blocks.push({
          type: 'tool_use',
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof fn.name === 'string' ? fn.name : '',
          input,
        })
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }

    if (role === 'system') {
      messages.push({ role: 'system', content: contentText(msg.content) })
      continue
    }

    // 'user' and anything unrecognised (a client-specific role) — treated as a user turn, which is
    // the conservative reading: it can only ever make a nudge land one turn later.
    messages.push({ role: 'user', content: contentText(msg.content) })
  }

  const rawTools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  const tools = rawTools
    .map((t) => {
      const fn = (t.function ?? {}) as { name?: unknown }
      // A bare `{name}` tool (no `function` wrapper) is also accepted — some clients send the
      // flattened form, and reading both costs one `??`.
      const name = typeof fn.name === 'string' ? fn.name : (typeof t.name === 'string' ? t.name : '')
      return { name, input_schema: {} }
    })
    .filter((t) => t.name !== '')

  return { messages, tools: tools.length > 0 ? tools : undefined }
}

/** True when this request looks like an AGENTIC client — it declared at least one tool. Mirrors the
 *  `req.tools?.length` gate the Anthropic handler already applies: someone pointing a plain chat
 *  app at the gateway has no tool loop to break and did not ask for a coding agent's rules. */
export function declaresTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0
}

/** Append standing rules to an OpenAI body's system prompt, IN PLACE.
 *
 *  OpenAI has no top-level `system` field — the system prompt is a leading `role: 'system'`
 *  message. Appending to the EXISTING one (rather than inserting a new message) is deliberate:
 *  it keeps the engine's reusable prompt prefix a single stable block, and some chat templates
 *  only honour the first system message. When there is no system message at all, one is
 *  prepended. */
export function appendSystemRules(body: Record<string, unknown>, rules: string[]): void {
  if (rules.length === 0) return
  const text = rules.join('\n\n')
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []

  const idx = messages.findIndex((m) => m.role === 'system')
  if (idx === -1) {
    messages.unshift({ role: 'system', content: text })
    body.messages = messages
    return
  }
  const existing = messages[idx]
  if (typeof existing.content === 'string') {
    existing.content = `${existing.content}\n\n${text}`
  } else if (Array.isArray(existing.content)) {
    existing.content = [...existing.content, { type: 'text', text }]
  } else {
    existing.content = text
  }
}

/** Append situational nudges to the LAST message, IN PLACE — but only when it is a user or tool
 *  turn, mirroring applyAgentGuidance's own rule.
 *
 *  A trailing ASSISTANT message means the client is prefilling a reply; injecting there would
 *  corrupt it, so the nudge is skipped and lands on the next turn instead. A trailing TOOL message
 *  is the OpenAI equivalent of Anthropic's tool-results-on-the-user-turn — the natural home for a
 *  reaction to those results, and the last thing the model reads. Its `content` must stay a plain
 *  string: a `role:'tool'` message with an array content is rejected by some engines, so the text
 *  is concatenated rather than pushed as a block. */
export function appendNudges(body: Record<string, unknown>, nudges: string[]): void {
  if (nudges.length === 0) return
  const text = nudges.join('\n\n')
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  const last = messages[messages.length - 1]
  if (!last) return

  if (last.role === 'tool') {
    last.content = `${contentText(last.content)}\n\n${text}`
    return
  }
  if (last.role !== 'user') return

  if (typeof last.content === 'string') {
    last.content = `${last.content}\n\n${text}`
  } else if (Array.isArray(last.content)) {
    last.content = [...last.content, { type: 'text', text }]
  } else {
    last.content = text
  }
}
