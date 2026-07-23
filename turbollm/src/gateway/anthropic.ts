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
// field — see mapToOpenAI's per-message role handling below.
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

export function mapToOpenAI(req: AnthropicRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []

  if (req.system) {
    const text =
      typeof req.system === 'string'
        ? req.system
        : req.system
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text?: string }).text ?? '')
            .join('\n')
    if (text) messages.push({ role: 'system', content: text })
  }

  for (const msg of req.messages) {
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
    } else if ((msg.role as string) === 'system') {
      // Claude Code sometimes injects a `role: 'system'` entry directly into `messages`
      // (e.g. a SessionStart-hook context block), separate from the top-level `system`
      // field. Falling through to the assistant branch below relabeled this as something
      // the ASSISTANT had already said — which made the model see a conversation that
      // looked already finished, so it emitted an immediate end-of-turn with zero output
      // (a real "no response" bug, confirmed via a live capture of an actual Claude Code
      // request: a `role:'system'` message as messages[1], mis-mapped to `role:'assistant'`,
      // reproduced a stream with output_tokens:1 and no content blocks at all).
      const text = raw
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text?: string }).text ?? '')
        .join('\n')
      if (text) messages.push({ role: 'system', content: text })
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
  if (req.tools?.length) {
    oai.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
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

/** Final usage observed while translating a stream (B4 session stats). */
export type StreamUsage = { inputTokens: number; outputTokens: number }

/** Live per-request progress published to the engine card while translating a
 *  gateway stream. Mirrors the manager's LiveGen shape without importing it. */
export type LiveProgress = { phase: 'prompt' | 'gen'; pct: number; outputTokens: number }

export async function* streamToAnthropic(
  oaiStream: ReadableStream<Uint8Array>,
  modelName: string,
  msgId: string,
  onUsage?: (u: StreamUsage) => void,
  onLive?: (p: LiveProgress) => void,
): AsyncGenerator<SseEvent> {
  let blockIdx = 0
  let inThinking = false
  let inText = false
  let activeToolIdx = -1
  let stopReason = 'end_turn'
  let outputTokens = 0
  let inputTokens = 0
  let cacheReadTokens = 0
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
        const timings = chunk.timings as { cache_n?: number; prompt_n_reuse?: number } | undefined
        const cacheN = timings?.cache_n ?? timings?.prompt_n_reuse
        if (cacheN != null) cacheReadTokens = cacheN

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
      try { onUsage({ inputTokens, outputTokens }) } catch { /* swallow */ }
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
