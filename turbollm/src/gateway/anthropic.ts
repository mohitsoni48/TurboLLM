// Anthropic ↔ OpenAI message translation (spec 06 §2).
import { randomUUID } from 'node:crypto'

// ─── Anthropic request types ───────────────────────────────────────────────

type ASystem = string | Array<{ type: string; text?: string }>
type ABlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
// 'system' is undocumented but real: Claude Code injects hook context (e.g. SessionStart)
// as a `role:'system'` entry directly into `messages`, not just via the top-level `system`
// field — mapToOpenAI folds every one of these into a single leading system message (see there).
type AMessage = { role: 'user' | 'assistant' | 'system'; content: string | ABlock[] }

export interface AnthropicRequest {
  model?: string
  messages: AMessage[]
  system?: ASystem
  max_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string }
  // 'enabled' with an explicit budget_tokens is the documented shape; 'adaptive' (no
  // budget_tokens, plus a display field) is a real shape confirmed live from Claude
  // Code (2026-07-23) — the type value isn't branched on below, only budget_tokens'
  // presence/validity, so any thinking-enabled type string is accepted.
  thinking?: { type: string; budget_tokens?: number; display?: string }
  metadata?: unknown
}

// ─── Mapping: Anthropic → OpenAI ──────────────────────────────────────────

/** JSON-Schema keywords stripped before forwarding a tool schema to the engine. All of them are
 *  pure *validation* hints — none changes which values are structurally valid — but llama.cpp's
 *  JSON-schema-to-grammar converter compiles every one of them into GBNF, where they cause parse
 *  failures that kill tool-calling for the ENTIRE request (a 400 "Failed to initialize samplers:
 *  failed to parse grammar"), not just the offending field. Two distinct failure modes, both hit
 *  live against Ornith 1.0 35B:
 *
 *  1. Invalid GBNF output — `format` (e.g. `format: 'date'` emits regex-style `\d` escapes GBNF
 *     doesn't support) and `pattern` (an arbitrary caller-supplied regex, a strictly bigger risk
 *     since any construct that doesn't translate cleanly — backreferences, lookaheads, unicode
 *     classes — fails the same way via a different tool each time).
 *
 *  2. Grammar-size explosion — the bound keywords compile into GBNF `{m,n}` repetition operators
 *     and enormous digit-range rules, and llama.cpp guards on rule-complexity × repetition
 *     ("number of rules that are going to be repeated multiplied by the new repetition exceeds
 *     sane defaults"). `maxItems: 255` becomes `(item){0,255}`; `maxLength: 255` becomes
 *     `char{1,255}`; `maximum: 9007199254740991` becomes a SINGLE rule thousands of elements
 *     long, densely nested with `[0-9]{15}`. That guard is reached far sooner than the numbers
 *     suggest on models whose chat template uses an XML tool-call format (Qwen3-Coder-style
 *     `<parameter=name>…</parameter>`, which Ornith/Qwen3.6 uses): llama.cpp emits a
 *     character-by-character "match until `</parameter>`" state machine per string argument, so
 *     a realistic Claude Code tool set (built-ins + MCP servers) already sits at ~5k rules
 *     BEFORE any repetition is applied. Measured on the real failing request: 3,822 of 5,127
 *     rules were those per-argument state machines. */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
])

/** Keys whose VALUE is a map of caller-chosen NAME -> schema, rather than a schema itself. Their
 *  keys are parameter names and must never be filtered as though they were schema keywords.
 *
 *  Missing this distinction silently deleted tool parameters: the strip below matched by key at
 *  every depth, so a tool with a parameter literally named `pattern` lost that parameter outright.
 *  That is not hypothetical — Claude Code's own Grep tool takes a REQUIRED `pattern` argument, and
 *  `format`/`maximum`/`minimum` are equally ordinary parameter names. Measured before the fix: a
 *  Grep-shaped schema carrying {pattern, path, format, maximum} reached the engine as {path}
 *  alone, while `required: ["pattern"]` still referenced the property that had just been removed —
 *  an internally contradictory schema advertising a tool the model cannot correctly call. */
const SCHEMA_NAME_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])

function stripUnsupportedSchemaKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaKeywords)
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue
      out[key] = SCHEMA_NAME_MAP_KEYS.has(key) ? stripSchemaNameMap(value) : stripUnsupportedSchemaKeywords(value)
    }
    return out
  }
  return schema
}

/** Recurse a name -> schema map: every NAME is kept verbatim (it's the caller's parameter name),
 *  and each VALUE goes through the normal strip, so bound keywords INSIDE a parameter's own schema
 *  are still removed — `properties: { pattern: { type: 'string', maxLength: 2000 } }` keeps the
 *  `pattern` parameter and drops its `maxLength`. */
function stripSchemaNameMap(map: unknown): unknown {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return stripUnsupportedSchemaKeywords(map)
  const out: Record<string, unknown> = {}
  for (const [name, sub] of Object.entries(map as Record<string, unknown>)) {
    out[name] = stripUnsupportedSchemaKeywords(sub)
  }
  return out
}

export function mapToOpenAI(req: AnthropicRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []

  // Collect EVERY system-role text into ONE combined message at index 0 — Claude Code sometimes
  // injects a role:'system' entry directly into `messages` (e.g. a SessionStart-hook context
  // block) IN ADDITION to the top-level `system` field. Emitting each at its own original position
  // (the prior behavior) produced an array like [system, user, assistant, system, ...] — a strict
  // jinja chat template (Qwen3.6/Ornith) rejects that outright with `raise_exception('System
  // message must be at the beginning')`, a real 400 hit live via a terminal-agent Claude Code
  // session. Folding every system-role text into one leading message satisfies that constraint
  // for any template while dropping no content.
  const systemParts: string[] = []
  if (req.system) {
    const text =
      typeof req.system === 'string'
        ? req.system
        : req.system
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text?: string }).text ?? '')
            .join('\n')
    if (text) systemParts.push(text)
  }
  for (const msg of req.messages) {
    if (msg.role !== 'system') continue
    const raw = msg.content
    const text =
      typeof raw === 'string'
        ? raw
        : raw.filter((b) => b.type === 'text').map((b) => (b as { text?: string }).text ?? '').join('\n')
    if (text) systemParts.push(text)
  }
  if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n\n') })

  for (const msg of req.messages) {
    if (msg.role === 'system') continue // already folded into the single leading system message above
    const raw = msg.content
    if (typeof raw === 'string') {
      messages.push({ role: msg.role, content: raw })
      continue
    }

    if (msg.role === 'user') {
      const toolResults: Record<string, unknown>[] = []
      const parts: unknown[] = []
      for (const b of raw) {
        if (b.type === 'tool_result') {
          const text =
            typeof b.content === 'string'
              ? b.content
              : ((b.content as Array<{ type: string; text?: string }>) ?? [])
                  .filter((x) => x.type === 'text')
                  .map((x) => x.text ?? '')
                  .join('\n')
          toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text })
        } else if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text })
        } else if (b.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          })
        }
      }
      // tool results must precede text parts (spec)
      messages.push(...toolResults)
      if (parts.length > 0) {
        const content =
          parts.length === 1 && (parts[0] as { type: string }).type === 'text'
            ? (parts[0] as { text: string }).text
            : parts
        messages.push({ role: 'user', content })
      }
    } else {
      let text = ''
      const toolCalls: unknown[] = []
      for (const b of raw) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use')
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })
      }
      const m: Record<string, unknown> = { role: 'assistant' }
      if (text) m.content = text
      if (toolCalls.length) m.tool_calls = toolCalls
      messages.push(m)
    }
  }

  const oai: Record<string, unknown> = {
    model: req.model ?? 'local',
    messages,
    stream: req.stream ?? false,
    max_tokens: req.max_tokens,
    // Reuse the cached KV prefix across turns. Agentic clients (Claude Code) resend a
    // large, stable system+tools prefix every turn; without prefix reuse the engine
    // reprocesses all of it each time, which is the dominant cost on a local model.
    cache_prompt: true,
  }
  if (req.stream) {
    oai.stream_options = { include_usage: true }
    // Ask llama-server for prompt-processing progress so the engine card can show a
    // live prefill % for gateway (Claude Code) traffic, same as in-app chat. These
    // progress chunks are consumed during translation and never reach the client.
    oai.return_progress = true
  }
  if (req.temperature != null) oai.temperature = req.temperature
  if (req.top_p != null) oai.top_p = req.top_p
  if (req.top_k != null) oai.top_k = req.top_k
  if (req.stop_sequences?.length) oai.stop = req.stop_sequences
  // SERVER tools (`{type:'web_search_20260209', name:'web_search'}` and friends) are executed by
  // the API PROVIDER, not by the model, and carry no `input_schema` at all. Forwarding one to the
  // engine produced a function with `parameters: undefined` — a tool the model can see and "call"
  // but that has no arguments and nothing behind it, which is exactly how Claude Code's WebSearch
  // came back empty every time (gateway.ts intercepts `web_search_*` before this and answers it
  // for real; anything else must simply not reach the engine). Identified by having a `type` and
  // no `input_schema`, so a normal client function tool can never be caught by this.
  const clientTools = (req.tools ?? []).filter((t) => {
    const raw = t as unknown as { type?: string; input_schema?: unknown }
    return !(typeof raw.type === 'string' && raw.input_schema == null)
  })
  if (clientTools.length) {
    oai.tools = clientTools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: stripUnsupportedSchemaKeywords(t.input_schema) },
    }))
    const tc = req.tool_choice
    if (tc)
      oai.tool_choice =
        tc.type === 'auto'
          ? 'auto'
          : tc.type === 'any'
            ? 'required'
            : { type: 'function', function: { name: tc.name } }
  }
  // Forward the caller's extended-thinking budget to the field the engine's sampler
  // actually reads (thinking_budget_tokens — mirrors chat-routes.ts's runGeneration).
  // Without this, a client with thinking enabled got no budget at all — the local
  // model reasoned unconstrained and could exhaust the entire max_tokens on thinking,
  // leaving zero tokens for the actual answer (a real "no response" bug, not a timeout
  // or crash — the request succeeds, it just never reaches visible text).
  //
  // Two real shapes seen in the wild, both must be handled:
  //  - {type:'enabled', budget_tokens:N} — an explicit budget; honor it exactly.
  //  - {type:'adaptive', ...} (Claude Code's actual request, confirmed live 2026-07-23:
  //    max_tokens 32000, thinking:{type:'adaptive',display:'omitted'}, no budget_tokens
  //    at all) — the client deliberately left the budget to the server/model. Real
  //    Anthropic models cap their own adaptive reasoning sensibly; a local model has no
  //    such built-in restraint, so leaving thinking_budget_tokens unset here reproduced
  //    the exact bug (thinking consumed the entire 32000-token budget, twice in a row,
  //    with zero tokens ever reaching visible text). Any thinking type with no usable
  //    budget_tokens gets a conservative default: half of max_tokens, guaranteeing the
  //    other half survives for the actual answer regardless of how verbose the model's
  //    reasoning is.
  if (req.thinking) {
    const requested = req.thinking.budget_tokens
    const hasMaxTokens = Number.isFinite(req.max_tokens) && (req.max_tokens ?? 0) > 0
    if (Number.isFinite(requested) && (requested ?? 0) > 0) {
      // `req.max_tokens` here already reflects the server-side maxTokens cap applied in
      // gateway.ts (clampMaxTokens runs before mapToOpenAI) — but the caller's requested
      // budget does not know about that cap. An explicit budget >= the (possibly-clamped)
      // max_tokens can reintroduce this exact bug via the explicit-budget path: thinking
      // consumes the whole capped response, leaving nothing for the actual answer. Bound
      // it to the same half-of-max_tokens invariant the no-budget default already relies on.
      oai.thinking_budget_tokens = hasMaxTokens
        ? Math.min(requested!, Math.floor(req.max_tokens! / 2))
        : requested
    } else if (hasMaxTokens) {
      oai.thinking_budget_tokens = Math.floor(req.max_tokens! / 2)
    }
  }
  return oai
}

// ─── Reasoning extraction ──────────────────────────────────────────────────

// Extract <think>…</think> from content leading edge (spec 06 §3).
function extractThinkTag(content: string): { thinking: string; content: string } {
  const m = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/i)
  if (!m) return { thinking: '', content }
  return { thinking: (m[1] ?? '').trim(), content: content.slice(m[0].length) }
}

// ─── Mapping: OpenAI response → Anthropic ─────────────────────────────────

const FINISH: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
}

export function mapFromOpenAI(oai: Record<string, unknown>, modelName: string): Record<string, unknown> {
  const choices = (oai.choices as Array<{ message?: Record<string, unknown>; finish_reason?: string }>) ?? []
  const choice = choices[0] ?? {}
  const msg = (choice.message ?? {}) as Record<string, unknown>
  const blocks: unknown[] = []

  let reasoning = (msg.reasoning_content as string | null | undefined) ?? ''
  let content = (msg.content as string | null | undefined) ?? ''

  // Fall back to <think> tag extraction if no reasoning_content
  if (!reasoning && content) {
    const ex = extractThinkTag(content)
    reasoning = ex.thinking
    content = ex.content
  }

  if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning })
  if (content) blocks.push({ type: 'text', text: content })

  for (const tc of (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> ?? [])) {
    let input: unknown
    try {
      input = JSON.parse(tc.function.arguments)
    } catch {
      input = { _raw: tc.function.arguments }
    }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
  }

  const usage = oai.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: modelName,
    content: blocks,
    stop_reason: FINISH[choice.finish_reason ?? 'stop'] ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 },
  }
}

// ─── Streaming: OAI SSE → Anthropic SSE events ────────────────────────────

export type SseEvent = { event: string; data: string }

type OAIDelta = {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

/** Final usage observed while translating a stream (B4 session stats). `promptTps`/`genTps` are
 *  the ENGINE's own per-phase rates (llama.cpp's `timings.prompt_per_second` /
 *  `predicted_per_second`), passed through untouched — undefined when the engine reported none.
 *  They exist here because prefill and decode are sequential phases: deriving either rate from
 *  the request's total wall-clock understates it by however long the other phase took (ADR-300). */
export type StreamUsage = { inputTokens: number; outputTokens: number; promptTps?: number; genTps?: number }

/** Live per-request progress published to the engine card while translating a
 *  gateway stream. Mirrors the manager's LiveGen shape without importing it. */
export type LiveProgress = { phase: 'prompt' | 'gen'; pct: number; outputTokens: number }

/** One fully-reassembled tool call observed while translating a stream. The engine emits a call
 *  as a RUN of deltas sharing one `tool_calls[].index` — the first carries `id`/`function.name`,
 *  every later one only a fragment of `function.arguments` — so neither the name nor the parsed
 *  input exists at any single point in the loop below; both have to be accumulated across the
 *  whole run and finalised at the end. The `input_json_delta` chunks the client receives are the
 *  raw fragments, deliberately forwarded unbuffered so the CLI can render a call as it arrives;
 *  this type is the side-channel copy for observers that need the WHOLE call (gateway.ts's Code
 *  session attribution — a terminal-launched CLI applies its edits in its own subprocess and
 *  never reports back, so the request stream is the only place the daemon ever sees them). */
export type StreamToolCall = { id: string; name: string; input: unknown }

export async function* streamToAnthropic(
  oaiStream: ReadableStream<Uint8Array>,
  modelName: string,
  msgId: string,
  onUsage?: (u: StreamUsage) => void,
  onLive?: (p: LiveProgress) => void,
  onToolCalls?: (calls: StreamToolCall[]) => void,
): AsyncGenerator<SseEvent> {
  let blockIdx = 0
  let inThinking = false
  let inText = false
  let activeToolIdx = -1
  // Keyed by the engine's own `tool_calls[].index`, which is what groups a call's deltas
  // together — NOT by blockIdx (that also advances for thinking/text blocks) and not by id
  // (absent on every delta after the first).
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  let stopReason = 'end_turn'
  let outputTokens = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let promptTps = 0
  let genTps = 0
  let liveOut = 0 // running generated-token count for the live engine-card row

  yield sse('message_start', {
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: modelName,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 1 },
    },
  })

  const reader = oaiStream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let failed = false

  try {
    outer: while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') break outer

        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(raw) as Record<string, unknown>
        } catch {
          continue
        }

        // Prompt-processing progress (return_progress): drives the live prefill % on
        // the engine card. Consumed here — never forwarded to the Anthropic client.
        const pp = chunk.prompt_progress as { processed?: number; total?: number } | undefined
        if (pp?.total) {
          onLive?.({ phase: 'prompt', pct: Math.round(((pp.processed ?? 0) / pp.total) * 100), outputTokens: 0 })
          continue
        }

        const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
        if (usage?.completion_tokens) outputTokens = usage.completion_tokens
        if (usage?.prompt_tokens) inputTokens = usage.prompt_tokens
        // Cache-reused prompt tokens: current llama.cpp reports `cache_n`; older builds used
        // `prompt_n_reuse`. Accept either so cache_read_input_tokens isn't silently stuck at 0.
        const timings = chunk.timings as {
          cache_n?: number; prompt_n_reuse?: number; prompt_per_second?: number; predicted_per_second?: number
        } | undefined
        const cacheN = timings?.cache_n ?? timings?.prompt_n_reuse
        if (cacheN != null) cacheReadTokens = cacheN
        // Same object already being read for cache_n — the real per-phase rates were sitting right
        // here unread, which is why a terminal-agent session's stats row had to derive them from
        // wall-clock and got decode ~6x too low (ADR-300).
        if (timings?.prompt_per_second) promptTps = timings.prompt_per_second
        if (timings?.predicted_per_second) genTps = timings.predicted_per_second

        const choices = chunk.choices as Array<{ delta?: OAIDelta; finish_reason?: string | null }> | undefined
        if (!choices?.length) continue
        const choice = choices[0]
        if (choice.finish_reason) stopReason = FINISH[choice.finish_reason] ?? 'end_turn'
        const delta: OAIDelta = choice.delta ?? {}

        // reasoning_content → thinking block
        if (delta.reasoning_content) {
          if (!inThinking) {
            inThinking = true
            yield cbStart(blockIdx, { type: 'thinking', thinking: '' })
          }
          yield cbDelta(blockIdx, { type: 'thinking_delta', thinking: delta.reasoning_content })
          onLive?.({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
        }

        // content → text block
        if (delta.content) {
          if (inThinking) {
            yield cbStop(blockIdx)
            inThinking = false
            blockIdx++
          }
          if (!inText) {
            inText = true
            yield cbStart(blockIdx, { type: 'text', text: '' })
          }
          yield cbDelta(blockIdx, { type: 'text_delta', text: delta.content })
          onLive?.({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
        }

        // tool_calls → tool_use blocks
        if (delta.tool_calls?.length) {
          if (inThinking) {
            yield cbStop(blockIdx)
            inThinking = false
            blockIdx++
          }
          if (inText) {
            yield cbStop(blockIdx)
            inText = false
            blockIdx++
          }
          for (const tc of delta.tool_calls) {
            // Side-channel accumulation, kept strictly ahead of (and independent of) the block
            // bookkeeping below so it can never perturb a single byte of the client's SSE output.
            // `id`/`name` are only filled in when still empty: they arrive on the FIRST delta of
            // a run and would be clobbered back to '' by the `?? ''` fallbacks on later ones.
            let acc = toolAcc.get(tc.index)
            if (!acc) {
              acc = { id: '', name: '', args: '' }
              toolAcc.set(tc.index, acc)
            }
            if (!acc.id && tc.id) acc.id = tc.id
            if (!acc.name && tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments

            if (tc.index !== activeToolIdx) {
              if (activeToolIdx >= 0) {
                yield cbStop(blockIdx)
                blockIdx++
              }
              activeToolIdx = tc.index
              yield cbStart(blockIdx, {
                type: 'tool_use',
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                input: {},
              })
            }
            if (tc.function?.arguments) {
              yield cbDelta(blockIdx, { type: 'input_json_delta', partial_json: tc.function.arguments })
            }
          }
        }
      }
    }
  } catch {
    failed = true
    yield sse('error', { error: { type: 'api_error', message: 'engine stopped' } })
  } finally {
    // cancel() (not releaseLock()) propagates teardown to the upstream engine body, so
    // a client that disconnects mid-stream actually stops the engine generating rather
    // than leaving the request occupying a slot. Safe to call after normal completion.
    await reader.cancel().catch(() => {})
  }

  if (!failed) {
    if (inThinking) {
      yield cbStop(blockIdx)
      blockIdx++
    }
    if (inText) {
      yield cbStop(blockIdx)
      blockIdx++
    }
    if (activeToolIdx >= 0) {
      yield cbStop(blockIdx)
      blockIdx++
    }
    // Anthropic usage fields are DISJOINT: the full prompt = input_tokens +
    // cache_read_input_tokens + cache_creation_input_tokens, and clients (incl.
    // Claude Code's context meter) sum them to size the context. llama.cpp's
    // `prompt_tokens` is the WHOLE prompt (cached + uncached), so report only the
    // non-cached remainder here — otherwise the cached prefix is counted twice and
    // the meter balloons (e.g. an agentic 100k prompt that's ~95k cached would read
    // as ~195k). Clamp at 0 in case cache_n ever exceeds prompt_tokens.
    const nonCachedInput = Math.max(0, inputTokens - cacheReadTokens)
    yield sse('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: nonCachedInput, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens },
    })
    yield sse('message_stop', {})
    // Best-effort session stats (B4): hand off the final usage. Never throws.
    if (onUsage) {
      try {
        onUsage({
          inputTokens,
          outputTokens,
          promptTps: promptTps > 0 ? promptTps : undefined,
          genTps: genTps > 0 ? genTps : undefined,
        })
      } catch { /* swallow */ }
    }
    // Best-effort observation of the turn's tool calls, finalised only here: an argument buffer
    // is only valid JSON once its LAST fragment has arrived, so nothing can be parsed mid-loop.
    // Fires on every completed stream, including one with no tool calls at all (an empty array)
    // — the observer's job is "a real turn happened", of which the calls are only one part; a
    // text-only reply must still reach it. A call whose buffer doesn't parse is dropped rather
    // than thrown on: the client has already received that call verbatim as input_json_delta
    // chunks and its own turn is unaffected by what an observer could or couldn't make of it.
    if (onToolCalls) {
      const calls: StreamToolCall[] = []
      for (const acc of toolAcc.values()) {
        try {
          calls.push({ id: acc.id, name: acc.name, input: JSON.parse(acc.args) })
        } catch { /* unparseable fragment run — skip this one call, keep the rest */ }
      }
      try { onToolCalls(calls) } catch { /* swallow */ }
    }
  }
}

// ─── SSE helpers ──────────────────────────────────────────────────────────

function sse(event: string, data: Record<string, unknown>): SseEvent {
  return { event, data: JSON.stringify({ type: event, ...data }) }
}

function cbStart(index: number, content_block: unknown): SseEvent {
  return {
    event: 'content_block_start',
    data: JSON.stringify({ type: 'content_block_start', index, content_block }),
  }
}

function cbDelta(index: number, delta: unknown): SseEvent {
  return {
    event: 'content_block_delta',
    data: JSON.stringify({ type: 'content_block_delta', index, delta }),
  }
}

function cbStop(index: number): SseEvent {
  return {
    event: 'content_block_stop',
    data: JSON.stringify({ type: 'content_block_stop', index }),
  }
}
