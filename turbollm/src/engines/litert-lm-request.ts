// What a chat request must carry for LiteRT-LM's servers to read it: upstream's `litert-lm serve` (desktop, Termux,
// python/litert_lm_cli/commands/serve) and the Android app's native port of it (TurboLLM-Android
// engines/litert-lm-server). TurboLLM shapes every request in llama.cpp's terms (thinking_budget_tokens,
// chat_template_kwargs), which `serve` never reads, so the user's choice never reached the model and the bundle's
// template default always decided. This is the one step every outbound path runs for a LiteRT-LM engine
// (compat.ts shapeForEngine), after the body is otherwise complete. No heavy imports: compat.ts loads it.
import { estimateTokens, REPLY_HEADROOM } from '../ext/context-limit'
import type { LitertlmSampler } from '../models/litertlm'
import type { Sampling } from '../models/profile'

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

// ── Sampling ──────────────────────────────────────────────────────────────────────────────
// LiteRT-LM takes sampling only per request: neither server has launch flags for it, so the Sampling a user saves on a
// model's settings (which llama.cpp gets as --temp/--top-p/--top-k) reached no LiteRT-LM model. And a request that
// sets any of temperature, top_p, top_k or seed replaces the bundle's own sampler: upstream's `serve` fills what it
// leaves out with top_k 1, top_p 0.95, temperature 1.0 (models/litertlm.ts, Sampling), so a thread's temperature alone
// decoded greedily and Qwen3's 20 / 0.95 / 0.6 was gone. Each request to a loaded model is therefore shaped here from
// what its load recorded (Manager.start, rememberLitertLmModel; keyed by the model path every request names).

/** What a LiteRT-LM model's requests carry from its load (StartOpts.litertLmRequest). */
export interface LitertLmRequestInfo {
  /** The sampling the user set for the model, in request fields (litertLmRequestSampling): only what they set. */
  sampling: Record<string, number | string[]>
  /** The bundle's own sampler (ModelEntry.sampler); absent when it declares none. */
  sampler?: LitertlmSampler
}

/** A model's saved Sampling (LoadProfile.sampling, only the fields the user set) as the request fields LiteRT-LM's
 *  servers read: temperature, top_p, top_k, the penalties and stop; and a Min P above 0 as min_p, which no LiteRT-LM
 *  applies, so that it is named as not applied (litertLmIgnoredFieldsNote, the gateway's X-Unapplied-Parameters, the
 *  Android server's own) rather than dropped: the dialogs no longer offer it for LiteRT-LM, but a value saved before
 *  stays in the profile. The repeat penalty goes as llama.cpp's repeat_penalty, as a thread's does (chat-routes.ts),
 *  since it is llama.cpp's: the Android server applies that name over llama.cpp's window, the last 64 tokens, and
 *  repetition_penalty over the whole reply. */
export function litertLmRequestSampling(s: Partial<Sampling>): Record<string, number | string[]> {
  const out: Record<string, number | string[]> = {}
  if (typeof s.temp === 'number') out.temperature = s.temp
  if (typeof s.topP === 'number') out.top_p = s.topP
  if (typeof s.topK === 'number') out.top_k = s.topK
  if (typeof s.minP === 'number' && s.minP > 0) out.min_p = s.minP
  if (typeof s.repeatPenalty === 'number') out.repeat_penalty = s.repeatPenalty
  if (typeof s.presencePenalty === 'number') out.presence_penalty = s.presencePenalty
  if (typeof s.frequencyPenalty === 'number') out.frequency_penalty = s.frequencyPenalty
  if (Array.isArray(s.stop) && s.stop.length > 0) out.stop = s.stop
  return out
}

/** "No top-k limit" for `serve`, which refuses a top_k below 1 ("top_k should be positive, but got 0", a 400) where
 *  TurboLLM's Top K 0 and llama.cpp's convention mean no limit, and the Android app's server takes it so: the largest
 *  k, which the CPU sampler clamps to the vocabulary (sampling_cpu_util.cc TopKTopPSampling). The same on a GPU: the
 *  Android server gives a GPU sampler the model's vocabulary, which it reads from the model's logits, and the largest
 *  k where it cannot, as here, where the vocabulary is not read; LiteRT-LM 0.18.0 sets no top_k limit of its own
 *  (GpuConfig::max_top_k is read nowhere), and `serve` samples on the CPU where no GPU sampler library is present. */
const NO_TOP_K_LIMIT = 2147483647

/** The LiteRT-LM models loaded, by model path, with whether their server is the Android app's native one. */
const loadedModels = new Map<string, LitertLmRequestInfo & { native: boolean }>()

/** Records what a LiteRT-LM model's requests carry, when it is loaded (Manager.start). */
export function rememberLitertLmModel(modelPath: string, info: LitertLmRequestInfo & { native: boolean }): void {
  loadedModels.set(modelPath, info)
}

/** What {@link rememberLitertLmModel} recorded for `modelPath`. */
export function litertLmModelInfo(modelPath: unknown): (LitertLmRequestInfo & { native: boolean }) | undefined {
  return typeof modelPath === 'string' ? loadedModels.get(modelPath) : undefined
}

const SAMPLER_FIELDS = ['temperature', 'top_p', 'top_k', 'seed'] as const
const isSet = (v: unknown): boolean => v !== undefined && v !== null

/** The model's saved sampling under the request's own (a thread's, an API client's), then, when the request sets any
 *  sampler field, the fields it still leaves out from the bundle's own sampler, so the model keeps what it prefers
 *  for them instead of `serve`'s 1 / 0.95 / 1.0. A bundle with none of its own gets nothing added: its servers' fill is
 *  the runtime's own default. `null` (an unset optional) is unset. Mutates `body`. */
export function shapeLitertLmSampling(body: Record<string, unknown>): void {
  const info = litertLmModelInfo(body.model)
  if (!info) return
  for (const [k, v] of Object.entries(info.sampling)) if (!isSet(body[k])) body[k] = v
  // Top K 0 (or below) is no limit: on `serve`, the largest k; the Android server maps it itself.
  if (!info.native && typeof body.top_k === 'number' && body.top_k <= 0) body.top_k = NO_TOP_K_LIMIT
  if (!info.sampler || !SAMPLER_FIELDS.some((k) => isSet(body[k]))) return
  const own = info.sampler
  if (!isSet(body.top_k) && own.topK !== undefined) body.top_k = own.topK
  if (!isSet(body.top_p) && own.topP !== undefined) body.top_p = own.topP
  if (!isSet(body.temperature) && own.temp !== undefined) body.temperature = own.temp
}

/** The note for fields a LiteRT-LM server does not apply: min_p on either (LiteRT-LM has no Min P sampling), and on
 *  upstream's `serve` the stop strings and the penalties too (it reads none of them; the Android app's server cuts the
 *  reply at a stop string and applies the penalties). A Min P the request leaves to the model's saved settings is named
 *  as theirs, with where to clear it and that the model must then be reloaded (its load recorded them,
 *  rememberLitertLmModel, so a Save without reloading still sends it); one the request sets from a chat thread's own
 *  settings (`fromThread`, the chat's) as the thread's, with where to clear it. Undefined when nothing set is ignored.
 *  Reads the body as {@link shapeLitertLmSampling} will send it. */
export function litertLmIgnoredFieldsNote(body: Record<string, unknown>, opts: { fromThread?: boolean } = {}): string | undefined {
  const info = litertLmModelInfo(body.model)
  if (!info) return undefined
  const value = (k: string): unknown => (isSet(body[k]) ? body[k] : info.sampling[k])
  const ignored: string[] = []
  const minP = value('min_p')
  const hasMinP = typeof minP === 'number' && minP > 0
  // A Min P the request does not set is the one saved on the model, which the chat does not show: say whose it is.
  // So is one a thread sets, which the thread settings no longer show a slider for on LiteRT-LM (only a Clear).
  const savedMinP = hasMinP && !isSet(body.min_p)
  const threadMinP = hasMinP && !savedMinP && opts.fromThread === true
  if (hasMinP) ignored.push(savedMinP ? 'the Min P saved in this model\'s settings' : threadMinP ? 'this thread\'s Min P' : 'Min P')
  if (!info.native) {
    const stop = value('stop')
    if ((typeof stop === 'string' && stop) || (Array.isArray(stop) && stop.length > 0)) ignored.push('stop strings')
    const penalty = (k: string, off: number) => typeof value(k) === 'number' && value(k) !== off
    if (penalty('repetition_penalty', 1) || penalty('repeat_penalty', 1) || penalty('presence_penalty', 0) || penalty('frequency_penalty', 0)) {
      ignored.push('repetition, presence and frequency penalties')
    }
  }
  if (ignored.length === 0) return undefined
  const list = ignored.length === 1 ? ignored[0] : `${ignored.slice(0, -1).join(', ')} and ${ignored[ignored.length - 1]}`
  const clear = savedMinP
    ? ' Clear that Min P under Models → the model\'s Load settings and reload the model.'
    : threadMinP ? ' Clear that Min P in Thread settings.' : ''
  return info.native
    ? `LiteRT-LM has no Min P: this reply was sampled without ${savedMinP || threadMinP ? ignored[0] : 'it'}.${clear}`
    : `This LiteRT-LM server (litert-lm serve) does not apply ${list}: this reply was written without ` +
      `${ignored.length === 1 && hasMinP ? 'it' : 'them'}. The Android app's LiteRT-LM applies stop strings and ` +
      `penalties; no LiteRT-LM has Min P.${clear}`
}

/** The note for a temperature or top_p that has no effect: the model has no sampler of its own, so with no top_k the
 *  runtime's top_k 1 decides (greedy). Upstream's `serve` only; the Android app's server samples with no top-k limit
 *  there itself. Undefined when it does not apply. Reads the body as {@link shapeLitertLmSampling} will send it. */
export function litertLmSamplingNote(body: Record<string, unknown>): string | undefined {
  const info = litertLmModelInfo(body.model)
  if (!info || info.native || info.sampler) return undefined
  const value = (k: string): unknown => (isSet(body[k]) ? body[k] : info.sampling[k])
  if (isSet(value('top_k'))) return undefined
  const temperature = value('temperature')
  const topP = value('top_p')
  const samples = (typeof temperature === 'number' && temperature > 0) || (typeof topP === 'number' && topP < 1)
  if (!samples) return undefined
  return 'This model has no sampling settings of its own, so LiteRT-LM decodes it greedily (Top K 1): Temperature and ' +
    'Top P change nothing until Top K is set above 1 (in the thread settings or the model\'s settings).'
}

// ── tool_choice ───────────────────────────────────────────────────────────────────────────
// Neither LiteRT-LM server applied tool_choice: upstream's `serve` never reads it (its request parser has no such
// field), and the Android server forwarded the tools whatever it said. So "none" still showed the model every tool and
// let it call them: the gateway's loop breaker, which answers a terminal agent's sixth identical call with tool_choice
// "none" so the model has to answer in text, did nothing on LiteRT-LM and the agent looped on. "none" is honoured by
// sending no tools (the history's calls and results stay), which is what it means. A forced call ("required", a named
// function) is passed on as it is: `serve` ignores it and the model chooses.

/** tool_choice "none" sends no tools. Mutates `body`. */
export function shapeLitertLmToolChoice(body: Record<string, unknown>): void {
  const choice = body.tool_choice
  if (choice === 'none' || (isRecord(choice) && choice.type === 'none')) delete body.tools
}

/** Every LiteRT-LM request's shaping (thinking, sampling, tool_choice). Mutates and returns `body`. */
export function shapeLitertLmRequest<T extends Record<string, unknown>>(body: T): T {
  shapeLitertLmThinking(body)
  shapeLitertLmSampling(body)
  shapeLitertLmToolChoice(body)
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
 *  encoder's, sized apart), the calls an assistant message made, and its past reasoning (reasoning_content, which a
 *  template may show: counted, so the estimate does not fall short). */
function messageText(m: { role: string; content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }): { role: string; content: string } {
  let text = ''
  if (typeof m.content === 'string') text = m.content
  else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const t = part && typeof part === 'object' ? (part as { text?: unknown }).text : undefined
      if (typeof t === 'string') text += t
    }
  }
  if (m.tool_calls !== undefined) text += JSON.stringify(m.tool_calls)
  if (typeof m.reasoning_content === 'string') text += m.reasoning_content
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
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }>,
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
