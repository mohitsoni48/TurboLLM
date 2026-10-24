// What a chat request must carry for LiteRT-LM's servers to read it: upstream's `litert-lm serve` (desktop, Termux,
// python/litert_lm_cli/commands/serve) and the Android app's native port of it (TurboLLM-Android
// engines/litert-lm-server). TurboLLM shapes every request in llama.cpp's terms (thinking_budget_tokens,
// chat_template_kwargs), which `serve` never reads, so the user's choice never reached the model and the bundle's
// template default always decided. This is the one step every outbound path runs for a LiteRT-LM engine
// (compat.ts shapeForEngine), after the body is otherwise complete. No heavy imports: compat.ts loads it.
import { estimateTokens, REPLY_HEADROOM } from '../ext/context-limit'

/** The reasoning_effort values LiteRT-LM reads (serve's openai_common.parse_thinking_config, 0.18.0; the Android
 *  server accepts the same): 'none' turns thinking off, every other turns it on with no token budget (serve has no
 *  way to pass one; the Android server takes a budget from thinking_budget_tokens). */
export const LITERT_LM_REASONING_EFFORTS: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

/** The level a request that turns thinking on without naming one is sent with: OpenAI's default. Any on-level is the
 *  same to `serve` (ThinkingConfig(enable_thinking=True, thinking_token_budget=-1)). */
const ON_LEVEL = 'medium'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Sets the top-level `reasoning_effort` LiteRT-LM reads from what the body says about thinking, when it names none:
 *    - its own reasoning_effort: kept (an API client's value reaches the server as it is: the server answers an
 *      unknown one with a 400 naming it); TurboLLM's own 'off' is 'none'
 *    - thinking off (thinking_budget_tokens 0, chat_template_kwargs.enable_thinking false, a level 'off'): 'none'
 *    - a level the user chose (chat_template_kwargs.reasoning_effort, a value LiteRT-LM accepts): that level
 *    - thinking on (a positive budget, enable_thinking true): 'medium'
 *    - nothing said: nothing, so the bundle's template decides (automatic).
 *  The llama.cpp-shaped fields stay: the Android server reads them too (a budget, which `serve` cannot take).
 *  Mutates `body`. */
export function shapeLitertLmThinking(body: Record<string, unknown>): void {
  const own = body.reasoning_effort
  if (own === null) delete body.reasoning_effort // an unset optional (LiteLLM sends null): nothing said
  else if (own !== undefined) {
    if (typeof own === 'string' && own.toLowerCase() === 'off') body.reasoning_effort = 'none'
    return
  }
  const kwargs = isRecord(body.chat_template_kwargs) ? body.chat_template_kwargs : {}
  const budget = typeof body.thinking_budget_tokens === 'number' ? body.thinking_budget_tokens : undefined
  const level = typeof kwargs.reasoning_effort === 'string' ? kwargs.reasoning_effort.toLowerCase() : undefined
  if (budget === 0 || kwargs.enable_thinking === false || level === 'off' || level === 'none') body.reasoning_effort = 'none'
  else if (level !== undefined && LITERT_LM_REASONING_EFFORTS.has(level)) body.reasoning_effort = level
  else if ((budget !== undefined && budget > 0) || kwargs.enable_thinking === true) body.reasoning_effort = ON_LEVEL
}

/** Every LiteRT-LM request's shaping (shapeLitertLmThinking, and what later steps add). Mutates and returns `body`. */
export function shapeLitertLmRequest<T extends Record<string, unknown>>(body: T): T {
  shapeLitertLmThinking(body)
  return body
}

// ── Tools ─────────────────────────────────────────────────────────────────────────────────
// Both servers take a request's tools (upstream's `serve` streams the model's calls back as OpenAI tool_calls; the
// Android server passes them to the runtime the same way), and the bundle's chat template shows them to the model
// when it reads them (models/litertlm.ts llmMetadataToolCalls). The chat, the extension API and routines withheld
// them from every LiteRT-LM model instead, whatever the model; these decide per model and per request.

/** The note for a model whose template never shows it the tools. */
export const LITERT_LM_NO_TOOL_CALLING_NOTE =
  'This model cannot call tools: its chat template never shows them to it, so this reply was written without web ' +
  'search, fetch, MCP or other tools. Load a model that calls tools to use them.'

/** The note for the Research persona on LiteRT-LM: `serve` ignores a forced (named) tool choice, and the Android
 *  server refuses one it cannot honour, so the daemon sends none. */
export const LITERT_LM_RESEARCH_NOTE =
  'This model decides for itself whether to search: LiteRT-LM cannot force the Research persona\'s web searches.'

/** The text of a message as the template renders it, for a size estimate: text parts only (an image is the
 *  encoder's, sized apart), and the calls an assistant message made. */
function messageText(m: { role: string; content?: unknown; tool_calls?: unknown }): { role: string; content: string } {
  let text = ''
  if (typeof m.content === 'string') text = m.content
  else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const t = part && typeof part === 'object' ? (part as { text?: unknown }).text : undefined
      if (typeof t === 'string') text += t
    }
  }
  if (m.tool_calls !== undefined) text += JSON.stringify(m.tool_calls)
  return { role: m.role, content: text }
}

/** The tools a LiteRT-LM model is sent with this request, and a note when it is sent none of them:
 *    - a model whose template never shows it tools (`toolCalls` false) gets none: sending them changes nothing it
 *      sees, and the user is told why web search and the rest do nothing;
 *    - a model that takes them gets them all, unless they do not fit in its context with the conversation (estimated
 *      as ext/context-limit.ts does, a reply's headroom kept). A bundle's context is often 4096 tokens and TurboLLM's
 *      own tools take about 3,600 by that estimate, which would turn a chat that works into "Input token ids are too
 *      long": then none, and the user is told what would make room. Not some of them: which would be TurboLLM's pick.
 *  `ctx` 0 (unknown) is not checked. Tools the model is not sent are the user's to see, never silently dropped. */
export function litertLmToolsFor<T>(
  model: { toolCalls?: boolean } | undefined,
  tools: readonly T[],
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_calls?: unknown }>,
  ctx: number,
): { tools: T[]; note?: string } {
  if (tools.length === 0) return { tools: [] }
  if (model?.toolCalls === false) return { tools: [], note: LITERT_LM_NO_TOOL_CALLING_NOTE }
  if (ctx > 0) {
    const toolTokens = estimateTokens([{ role: 'tools', content: JSON.stringify(tools) }])
    const used = estimateTokens(messages.map(messageText))
    if (used + toolTokens + REPLY_HEADROOM > ctx) {
      return {
        tools: [],
        note: `The tools (about ${toolTokens.toLocaleString('en-US')} tokens) do not fit in this model's ` +
          `${ctx.toLocaleString('en-US')}-token context with this conversation, so this reply was written without them. ` +
          'An agent with fewer tools, a larger context in the model\'s settings (where the model allows one) or a new ' +
          'chat makes room for them.',
      }
    }
  }
  return { tools: [...tools] }
}
