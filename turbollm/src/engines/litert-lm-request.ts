// What a chat request must carry for LiteRT-LM's servers to read it: upstream's `litert-lm serve` (desktop, Termux,
// python/litert_lm_cli/commands/serve) and the Android app's native port of it (TurboLLM-Android
// engines/litert-lm-server). TurboLLM shapes every request in llama.cpp's terms (thinking_budget_tokens,
// chat_template_kwargs), which `serve` never reads, so the user's choice never reached the model and the bundle's
// template default always decided. This is the one step every outbound path runs for a LiteRT-LM engine
// (compat.ts shapeForEngine), after the body is otherwise complete. No heavy imports: compat.ts loads it.

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
