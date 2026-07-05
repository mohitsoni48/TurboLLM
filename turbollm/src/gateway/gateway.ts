// Gateway: /v1/* OpenAI-compatible pass-through + Anthropic translation (spec 06).
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { mapToOpenAI, mapFromOpenAI, streamToAnthropic, type AnthropicRequest } from './anthropic'

/** An AbortController that fires when the CLIENT disconnects (Claude Code cancels a
 *  turn, hits ESC, times out, or closes). Wiring its signal into the upstream engine
 *  fetch is what stops abandoned requests from running to completion and clogging the
 *  engine's queue — the in-app chat path already does this; the gateway must too. */
function clientAbort(c: { req: { raw: Request } }): AbortController {
  const ac = new AbortController()
  const sig = c.req.raw.signal
  if (sig) {
    if (sig.aborted) ac.abort()
    else sig.addEventListener('abort', () => ac.abort(), { once: true })
  }
  return ac
}

export function registerGateway(app: Hono, d: Deps): void {
  // ── POST /v1/messages — Anthropic translation (spec 06 §2) ───────────────

  app.post('/v1/messages', async (c) => {
    // Parse body first — needed to extract model for auto-swap (v0.6.0) and
    // to validate max_tokens before potentially waiting for a model swap.
    let req: AnthropicRequest
    try {
      req = (await c.req.json()) as AnthropicRequest
    } catch {
      return c.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body.' } },
        400,
      )
    }
    // Claude Code's gateway model discovery only keeps /v1/models ids that start with
    // `claude`/`anthropic`, so we advertise local models as `claude-<key>` (see /v1/models
    // below). Strip that prefix in-place so both the router AND the outbound engine request
    // (mapToOpenAI reads req.model again) use the real key. The alias is only ever advertised
    // when gateway.autoSwap is on (see /v1/models below), so routing here still honors the
    // user's global auto-swap preference like every other request.
    if (req.model?.startsWith('claude-')) req.model = req.model.slice(7)
    if (!req.max_tokens) {
      return c.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is required.' } },
        400,
      )
    }
    // Enforce the global "max response tokens" cap on external (Claude Code) traffic.
    const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0
    req.max_tokens = clampMaxTokens(req.max_tokens, maxLimit) ?? req.max_tokens

    // Route to the requested model — may trigger an auto-swap (v0.6.0).
    const routeResult = await d.modelRouter.route(req.model ?? '')
    if ('status' in routeResult) {
      return c.json(
        { type: 'error', error: { type: 'api_error', message: routeResult.message } },
        routeResult.status,
      )
    }
    const target = routeResult.target

    const status = d.manager.status()
    const modelName = status.state === 'running' ? (status.model?.name ?? req.model ?? 'local') : (req.model ?? 'local')
    const oaiBody = mapToOpenAI(req)
    // mlx-lm / vLLM serve under a fixed alias and reject the client's model id; rewrite
    // the outbound field (routing above already used the original id). No-op for llama.cpp.
    const oaiAlias = engineModelAlias(d.registry.active()?.kind ?? '')
    if (oaiAlias) (oaiBody as Record<string, unknown>).model = oaiAlias

    // Mark the completion in-flight so the engine card's live "Generating…"
    // indicator counts Claude-CLI (Anthropic-protocol) traffic too. Each branch
    // below pairs this with generationEnd so the counter can never leak.
    d.manager.generationStart()

    // Propagate client cancellation to the engine: if Claude Code drops this turn, the
    // upstream request is aborted instead of running to completion and queuing behind
    // the engine's slots forever.
    const ac = clientAbort(c)

    let res: Response
    try {
      res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(oaiBody),
        signal: ac.signal,
      })
    } catch (e) {
      d.manager.generationEnd()
      return c.json(
        { type: 'error', error: { type: 'api_error', message: (e as Error).message || 'Engine error.' } },
        500,
      )
    }

    if (!res.ok || !res.body) {
      d.manager.generationEnd()
      const text = await res.text().catch(() => '')
      return c.json(
        { type: 'error', error: { type: 'api_error', message: text || 'Engine error.' } },
        500,
      )
    }

    if (req.stream) {
      const msgId = `msg_${randomUUID().replace(/-/g, '')}`
      // Record session stats (B4) from the final usage the generator observes.
      // Fail-safe: the callback is only invoked best-effort and swallows nothing
      // that affects the client stream.
      const gen = streamToAnthropic(
        res.body,
        modelName,
        msgId,
        (u) => {
          try {
            d.manager.recordCompletion({ inputTokens: u.inputTokens, outputTokens: u.outputTokens })
          } catch { /* swallow — stats are best-effort */ }
        },
        // Live per-request progress for the engine card (prefill % + token count),
        // so Claude Code traffic shows the same live row as in-app chat.
        (live) => { try { d.manager.setLiveGen(live) } catch { /* best-effort */ } },
      )
      // streamSSE flushes each chunk immediately through Node.js's HTTP layer.
      // Raw ReadableStream does not — chunks buffer until the response completes,
      // which makes Claude CLI (and any Anthropic-protocol client) appear "slow".
      return streamSSE(c, async (stream) => {
        // Client went away mid-stream → abort the engine fetch so it stops generating
        // (the generator's finally then cancels the upstream body reader).
        stream.onAbort(() => ac.abort())
        try {
          for await (const evt of gen) {
            await stream.writeSSE({ event: evt.event, data: evt.data })
          }
        } finally {
          ac.abort() // also tear down the upstream on normal completion / write error
          d.manager.generationEnd()
        }
      })
    }

    try {
      const oaiRes = (await res.json()) as Record<string, unknown>
      recordOpenAiUsage(d, oaiRes) // session stats (B4), fail-safe
      return c.json(mapFromOpenAI(oaiRes, modelName))
    } finally {
      d.manager.generationEnd()
    }
  })

  // ── POST /v1/messages/count_tokens (spec 06 §2) ───────────────────────────

  app.post('/v1/messages/count_tokens', async (c) => {
    let req: AnthropicRequest
    try {
      req = (await c.req.json()) as AnthropicRequest
    } catch {
      req = { messages: [] }
    }

    const target = d.manager.target()
    const oaiBody = mapToOpenAI(req)
    const promptText = ((oaiBody.messages as Array<Record<string, unknown>>) ?? [])
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
    const estimate = Math.ceil(promptText.length / 3.5)

    if (target) {
      try {
        const r = await fetch(`${target}/tokenize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: promptText }),
          signal: AbortSignal.timeout(5000),
        })
        if (r.ok) {
          const data = (await r.json()) as { tokens?: number[] }
          return c.json({ input_tokens: data.tokens?.length ?? estimate })
        }
      } catch {
        // fall through to estimate
      }
    }

    return c.json({ input_tokens: estimate })
  })

  // ── /v1/* OpenAI pass-through (spec 06 §1) ────────────────────────────────

  app.all('/v1/*', async (c) => {
    const url = new URL(c.req.url)

    // GET /v1/models: always synthesise the list from the WHOLE local library (not just
    // the loaded model), regardless of whether an engine is running — real key entries for
    // OpenAI-style consumers. The `claude-<key>` alias (whose id passes Claude Code's
    // discovery filter — it keeps only claude*/anthropic* ids — and which /v1/messages
    // strips back to the real key before routing) is only added when gateway.autoSwap is
    // on: picking a model from Claude Code's /model always requires a swap, so advertising
    // it while auto-swap is off would let the user pick a model that silently never loads.
    if (c.req.method === 'GET' && url.pathname === '/v1/models') {
      const autoSwap = d.store.snapshot().gateway.autoSwap
      const data = d.scanner.list().models.flatMap((m) => [
        { id: m.key, object: 'model', owned_by: 'turbollm' },
        ...(autoSwap ? [{ id: `claude-${m.key}`, object: 'model', display_name: `${m.name} — TurboLLM` }] : []),
      ])
      return c.json({ object: 'list', data })
    }

    const isChat = c.req.method === 'POST' && url.pathname === '/v1/chat/completions'

    // For chat completions: parse the body to extract the model field for
    // auto-swap routing (v0.6.0) and to apply the max_tokens cap if set.
    // For all other endpoints: skip body parsing and pass through untouched.
    let parsedBody: Record<string, unknown> | null = null
    if (isChat) {
      try { parsedBody = (await c.req.json()) as Record<string, unknown> } catch { parsedBody = null }
    }

    const requestedModel = isChat ? ((parsedBody?.model as string | undefined) ?? '') : ''
    const routeResult = await d.modelRouter.route(requestedModel)
    if ('status' in routeResult) {
      return c.json(
        { error: { message: routeResult.message, type: 'model_not_loaded', code: 'model_not_loaded' } },
        503,
      )
    }
    const target = routeResult.target

    const upstream = target + url.pathname + url.search
    const headers = new Headers(c.req.raw.headers)
    headers.delete('host')

    const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0
    // Cancel the upstream engine request if the client disconnects (same reason as
    // /v1/messages above) — abandoned OpenAI-protocol requests would otherwise keep
    // generating and occupy engine slots.
    const ac = clientAbort(c)
    const init: RequestInit & { duplex?: 'half' } = { method: c.req.method, headers, signal: ac.signal }

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (isChat) {
        // Body already parsed above for routing. Apply token cap if set.
        if (parsedBody && maxLimit > 0) {
          parsedBody.max_tokens = clampMaxTokens(parsedBody.max_tokens as number | undefined, maxLimit)
        }
        // Rewrite the outbound model id for engines that serve under a fixed alias
        // (mlx-lm / vLLM). Routing above already used the caller's original id.
        if (parsedBody) {
          const alias = engineModelAlias(d.registry.active()?.kind ?? '')
          if (alias) parsedBody.model = alias
        }
        headers.delete('content-length') // re-serialised body has a new length
        init.body = parsedBody ? JSON.stringify(parsedBody) : ''
      } else {
        init.body = c.req.raw.body
        init.duplex = 'half'
      }
    }

    const res = await fetch(upstream, init)

    // Best-effort session-stats recording (B4) for OpenAI chat completions, fully
    // fail-safe and non-intrusive: tee the body so the client still gets the exact
    // upstream stream/bytes unchanged while we sniff usage off the copy.
    if (res.ok && res.body && isChat) {
      try {
        const [a, b] = res.body.tee()
        // Mark in-flight + publish live token count to the engine card while the teed
        // copy drains, paired so the counter can't leak. (OpenAI clients don't get the
        // prefill % — injecting return_progress would pollute their stream.)
        d.manager.generationStart()
        void recordOpenAiStreamUsage(d, b).finally(() => d.manager.generationEnd())
        return new Response(a, { status: res.status, headers: res.headers })
      } catch {
        return new Response(res.body, { status: res.status, headers: res.headers })
      }
    }

    return new Response(res.body, { status: res.status, headers: res.headers })
  })
}

// ── session-stats recording helpers (B4) ────────────────────────────────────

/** Record usage from a non-streaming OpenAI completion. Fail-safe. */
function recordOpenAiUsage(d: Deps, oai: Record<string, unknown>): void {
  try {
    const usage = oai.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    const timings = oai.timings as { prompt_per_second?: number; predicted_per_second?: number } | undefined
    d.manager.recordCompletion({
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      promptTps: timings?.prompt_per_second,
      genTps: timings?.predicted_per_second,
    })
  } catch { /* swallow — stats are best-effort */ }
}

/** Drain a teed copy of a streaming OpenAI SSE body to record final usage (B4).
 *  Never touches the client-facing stream; all errors are swallowed. */
async function recordOpenAiStreamUsage(d: Deps, body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let promptTokens = 0
    let completionTokens = 0
    let promptTps = 0
    let genTps = 0
    let liveOut = 0 // running generated-token count for the live engine-card row
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') continue
        let chunk: Record<string, unknown>
        try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
        const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
        if (usage) {
          if (usage.prompt_tokens) promptTokens = usage.prompt_tokens
          if (usage.completion_tokens) completionTokens = usage.completion_tokens
        }
        const timings = chunk.timings as { prompt_per_second?: number; predicted_per_second?: number } | undefined
        if (timings) {
          if (timings.prompt_per_second) promptTps = timings.prompt_per_second
          if (timings.predicted_per_second) genTps = timings.predicted_per_second
        }
        // Live token count for the engine card (each content chunk ≈ one token).
        const delta = (chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string } }> | undefined)?.[0]?.delta
        if (delta && (delta.content || delta.reasoning_content)) {
          try { d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut }) } catch { /* best-effort */ }
        }
      }
    }
    d.manager.recordCompletion({ inputTokens: promptTokens, outputTokens: completionTokens, promptTps, genTps })
  } catch { /* swallow — stats are best-effort */ }
}
