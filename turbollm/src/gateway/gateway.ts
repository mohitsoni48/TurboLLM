// Gateway: /v1/* OpenAI-compatible pass-through + Anthropic translation (spec 06).
import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Deps } from '../deps'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { presentedKey } from '../auth'
import { sessionAuth } from '../code/session-auth'
import { mapToOpenAI, mapFromOpenAI, streamToAnthropic, type AnthropicRequest } from './anthropic'
import { applyAgentGuidance } from './agent-guidance'
import {
  extractSearchQuery,
  findServerTool,
  isNestedSearchRequest,
  runWebSearchServerTool,
  serverToolMessage,
  serverToolSseEvents,
} from './server-tools'

/** Resolve the Code session (if any) a gateway request belongs to, from the same token a
 *  terminal-launched CLI carries as its ANTHROPIC_AUTH_TOKEN / OpenAI-compatible apiKey
 *  (session-auth.ts, terminal-routes.ts). `codeSessionId` is null for the shared static token,
 *  a manually-run `turbollm launch`, or any other client — those get no per-session
 *  overrides/attribution. Returns `token` too so callers needn't re-parse headers to also look
 *  up the thinking-budget override. */
function resolveCodeSession(c: Context): { token: string; codeSessionId: string | null } {
  const token = presentedKey(c)
  return { token, codeSessionId: token ? sessionAuth.resolve(token) : null }
}

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

/** Best-effort extraction of a structured error from a failed engine (llama.cpp-family) HTTP
 *  response. These engines mirror the OpenAI `{error:{message,type}}` shape on failure; falls
 *  back to the raw body (truncated) when it isn't JSON-shaped, so a crash page or a plain-text
 *  panic still surfaces something readable instead of a blanket "Engine error." */
async function describeEngineError(res: Response): Promise<{ message: string; type?: string }> {
  const raw = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; type?: string } }
    if (parsed.error?.message) return { message: parsed.error.message, type: parsed.error.type }
  } catch { /* not JSON — fall through to raw */ }
  return { message: raw.slice(0, 2000) || `Engine returned HTTP ${res.status}.` }
}

/** Map an engine's real HTTP status to the closest Anthropic error `type` (spec 06) when the
 *  engine's own body didn't already carry one — lets Claude Code's own error handling react to
 *  the actual failure class (bad request vs. overloaded vs. generic) instead of every distinct
 *  cause surfacing identically as a hardcoded 'api_error'. */
function anthropicErrorType(status: number): string {
  if (status === 400) return 'invalid_request_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 503) return 'overloaded_error'
  return 'api_error'
}

/** Hono's `c.json(body, status)` only accepts its own narrow `ContentfulStatusCode` union, not
 *  a plain `number` — clamp an upstream engine's real status into a valid HTTP error range
 *  first (it's always >= 400 here, called only from a `!res.ok` branch) so a malformed or
 *  out-of-range status from a misbehaving engine can't crash response construction. */
function asClientStatus(status: number): ContentfulStatusCode {
  return (status >= 400 && status <= 599 ? status : 500) as ContentfulStatusCode
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

    // ── Anthropic SERVER-side tools (see server-tools.ts) ──────────────────────
    // Claude Code's WebSearch executes by calling US back with a `web_search_*` server tool and
    // reading `web_search_tool_result` blocks off the reply. We are the provider, so we run the
    // search — TurboLLM's own configured provider, the same one the in-app agent uses. Before
    // this, the server tool was forwarded to the engine as a function with no parameters and the
    // CLI got `results: []` with no error: web search silently returned nothing, every time.
    //
    // Handled here, ahead of routing and max_tokens validation, because none of that applies: no
    // engine request is made, so a search works even with no model loaded and can't be refused by
    // a max_tokens cap that was never going to be spent.
    // Gated on this being the CLI's own nested SEARCH call (the server tool is the request's ONLY
    // tool), not merely on a web-search tool being present. Intercepting on presence alone hijacks
    // an ordinary agentic turn that offers the model search alongside its real tools — it would be
    // answered with raw results and never reach the model. Caught in pre-release review.
    const serverTool = isNestedSearchRequest(req.tools) ? findServerTool(req.tools) : null
    if (serverTool?.kind === 'web_search') {
      const query = extractSearchQuery(req)
      const searchCfg = d.store.snapshot().tools.search
      const blocks = await runWebSearchServerTool(query, serverTool, searchCfg)
      const searchModel = req.model ?? 'local'
      if (req.stream) {
        return streamSSE(c, async (stream) => {
          for (const evt of serverToolSseEvents(searchModel, blocks)) {
            await stream.writeSSE({ event: evt.event, data: evt.data })
          }
        })
      }
      return c.json(serverToolMessage(searchModel, blocks))
    }

    // Terminal-agent thinking-budget override (ADR-284) — the composer's ThinkingBudgetSlider
    // for a terminal-agent session (TerminalToolbar.tsx) has no text turn of its own to attach
    // this to, so it's enforced here instead: whatever the daemon has stored for this session
    // (session-auth.ts, set via PATCH .../thinking-budget) wins over whatever Claude Code itself
    // sent, live, every request — no CLI restart involved. Only touches requests whose presented
    // token resolves to a Code session with an override actually set; every other client
    // (including a manually-run `turbollm launch claude`) is completely unaffected.
    const { token: anthropicToken, codeSessionId: anthropicCodeSessionId } = resolveCodeSession(c)
    if (anthropicCodeSessionId) {
      const override = sessionAuth.getThinkingBudgetForToken(anthropicToken)
      if (override !== null) {
        req.thinking = override > 0 ? { type: 'enabled', budget_tokens: override } : undefined
      }
    }

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

    // ── Agent behaviour scaffolding for external coding CLIs (see agent-guidance.ts) ──────
    // Loop detection/breaking, search-on-repeated-failure, and version+docs-before-a-dependency
    // all lived inside the in-process pi agent, so the terminal-agent CLI had none of them. They
    // are reconstructed here from the request's own history and applied to `req` before
    // translation. Gated on the request actually declaring tools: that is what distinguishes an
    // agentic client from someone pointing a plain chat app at the gateway, who has no tool loop
    // to break and did not ask for a coding agent's rules.
    const guidance = req.tools?.length ? applyAgentGuidance(req) : null

    const oaiBody = mapToOpenAI(req)
    // The hard half of the loop breaker. pi refuses to EXECUTE the repeated call; the gateway is
    // not in an external CLI's execution path, so the equivalent lever is denying tool calls for
    // this one reply — the model physically cannot emit the same call a seventh time and has to
    // answer in text, which ends the loop.
    if (guidance?.forceTextOnly) oaiBody.tool_choice = 'none'
    // mlx-lm / vLLM serve under a fixed alias and reject the client's model id; rewrite
    // the outbound field (routing above already used the original id). No-op for llama.cpp.
    const oaiAlias = engineModelAlias(d.registry.active()?.kind ?? '')
    if (oaiAlias) (oaiBody as Record<string, unknown>).model = oaiAlias

    // ── Concurrency: never exceed the engine's own slot count ─────────────────
    // Claude Code fans out background subagents, each of which is a full, independent request to
    // this endpoint. Before this, gateway traffic did not touch the gate at all (only chat's
    // autotitle, memory and the in-process pi agent did), so N subagents hit a `--parallel 1`
    // llama-server together. That is worse than it sounds: the requests do not just queue, they
    // evict each other's cached prompt prefix, so every one of them re-prefills from scratch —
    // and each waits on a held-open HTTP connection that Claude Code's own 300s timeout is
    // counting against.
    //
    // 'bg' priority: external agent traffic must yield to anything the user is waiting on
    // in-app. The client's own abort signal is passed so a cancelled turn stops waiting
    // immediately instead of holding its place in the queue.
    // Queue timeout deliberately far above the client's own: `cli-launch.ts` sets
    // ANTHROPIC_TIMEOUT to 300s, so in practice the CLIENT gives up first and its abort unqueues
    // this wait cleanly. That makes the timeout a leak-detector (gate.ts's original purpose)
    // rather than something a legitimately-queued subagent can trip.
    let gateRelease: (() => void) | null = null
    if (d.gate) {
      try {
        gateRelease = await d.gate.acquire('bg', { signal: c.req.raw.signal, timeoutMs: 600_000 })
      } catch (e) {
        // Never proceed un-slotted on failure — that would silently breach the very limit this
        // exists to enforce, and intermittently, which is worse than a clean error.
        const aborted = (e as Error).message === 'gate_acquire_aborted'
        return c.json(
          {
            type: 'error',
            error: aborted
              ? { type: 'invalid_request_error', message: 'Client disconnected while queued for the engine.' }
              : { type: 'overloaded_error', message: 'Timed out waiting for a free engine slot.' },
          },
          aborted ? 400 : 503,
        )
      }
    }

    // Mark the completion in-flight so the engine card's live "Generating…"
    // indicator counts Claude-CLI (Anthropic-protocol) traffic too. Each branch
    // below pairs this with generationEnd so the counter can never leak.
    d.manager.generationStart()

    // Propagate client cancellation to the engine: if Claude Code drops this turn, the
    // upstream request is aborted instead of running to completion and queuing behind
    // the engine's slots forever.
    const ac = clientAbort(c)

    // For terminal-agent usage attribution/stats (ADR-284) — wall-clock request duration, the
    // simplest signal available without touching streamToAnthropic's own callback shape (it
    // doesn't currently surface the engine's per-request timings the way the OpenAI-shaped
    // helpers below already do). An approximation, not a literally-measured prefill/gen split.
    const requestStart = Date.now()
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
      gateRelease?.()
      const err = e as Error & { cause?: unknown }
      const isAbort = err.name === 'AbortError' || ac.signal.aborted
      const cause = err.cause instanceof Error ? `: ${err.cause.message}` : ''
      return c.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: isAbort
              ? 'Client disconnected before the engine responded.'
              : `${err.message || 'Engine unreachable.'}${cause}`,
          },
        },
        500,
      )
    }

    if (!res.ok || !res.body) {
      d.manager.generationEnd()
      gateRelease?.()
      // Forward the engine's REAL status + whatever structured error it returned, instead of
      // flattening every distinct failure (bad request, model incompatibility, overload, crash)
      // to the same hardcoded 500/'api_error' — that flattening is what made bugs #1-#4 in a
      // Code session all read identically from the terminal, with no way to tell them apart.
      const { message, type } = await describeEngineError(res)
      return c.json(
        { type: 'error', error: { type: type ?? anthropicErrorType(res.status), message } },
        asClientStatus(res.status),
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
            // The engine's own per-phase rates now ride along (ADR-300). This path — Anthropic
            // streaming, i.e. every Claude Code request — was the one place that passed NO
            // timings at all, so the engine card fell back to whatever the last non-gateway
            // request left behind and a terminal-agent session's stats row had to divide both
            // token counts by one wall-clock, reading decode ~6x too low.
            d.manager.recordCompletion({
              inputTokens: u.inputTokens, outputTokens: u.outputTokens,
              promptTps: u.promptTps, genTps: u.genTps,
            })
            // Durable counterpart to the ephemeral session counter above (GitHub #71) — the
            // session counter resets on engine restart and was never persisted/surfaced.
            d.db.recordApiUsage({
              source: 'anthropic', modelKey: req.model ?? null, promptTokens: u.inputTokens, genTokens: u.outputTokens,
              codeSessionId: anthropicCodeSessionId, durationMs: Date.now() - requestStart,
              promptTps: u.promptTps, genTps: u.genTps,
            })
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
          gateRelease?.()
        }
      })
    }

    try {
      const oaiRes = (await res.json()) as Record<string, unknown>
      // session stats (B4) + durable #71 record, fail-safe
      recordOpenAiUsage(d, oaiRes, 'anthropic', req.model ?? null, anthropicCodeSessionId, Date.now() - requestStart)
      return c.json(mapFromOpenAI(oaiRes, modelName))
    } finally {
      d.manager.generationEnd()
      gateRelease?.()
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
    const { token: chatToken, codeSessionId: chatCodeSessionId } = resolveCodeSession(c)

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
        // Terminal-agent thinking-budget override (ADR-284) — OpenAI-protocol clients (pi/
        // opencode via this passthrough) reach the same `thinking_budget_tokens` field the
        // engine sampler reads directly (no Anthropic-shaped `thinking` object to translate,
        // unlike /v1/messages above). Same session-scoped-token gate as that handler.
        if (parsedBody && chatCodeSessionId) {
          const override = sessionAuth.getThinkingBudgetForToken(chatToken)
          if (override !== null) {
            if (override > 0) parsedBody.thinking_budget_tokens = override
            else delete parsedBody.thinking_budget_tokens
          }
        }
        // A streaming OpenAI response omits the final `usage` chunk unless the caller
        // opts in via `stream_options.include_usage` (standard OpenAI API behavior,
        // which llama.cpp's server mirrors) — without this, recordOpenAiStreamUsage
        // below silently sees no usage and GitHub #71 undercounts every streaming
        // OpenAI-protocol client that doesn't already request it. Only fills the gap
        // when the caller left it unset; never overrides an explicit choice.
        if (parsedBody?.stream === true && parsedBody.stream_options === undefined) {
          parsedBody.stream_options = { include_usage: true }
        }
        headers.delete('content-length') // re-serialised body has a new length
        init.body = parsedBody ? JSON.stringify(parsedBody) : ''
      } else {
        init.body = c.req.raw.body
        init.duplex = 'half'
      }
    }

    // Unguarded before this fix: a throw here (e.g. the client disconnecting while the
    // body was being parsed/routed above hands fetch an ALREADY-aborted signal, which
    // throws immediately with no network I/O — clientAbort() fires ac.abort() synchronously
    // when c.req.raw.signal.aborted is already true) escaped straight to Hono's default
    // error handler: a bodyless 500 with no diagnostic, and no client-facing error envelope
    // at all. Mirrors the /v1/messages handler's guard above.
    // Same engine-slot limit the Anthropic handler enforces above, for OpenAI-protocol clients
    // (opencode / kilo / pi / scripts) — they reach the identical single engine, so leaving this
    // path ungated would just move the pile-up rather than remove it. Only chat completions: a
    // /tokenize or /embeddings call isn't a generation and must never queue behind one.
    let chatGateRelease: (() => void) | null = null
    if (isChat && d.gate) {
      try {
        chatGateRelease = await d.gate.acquire('bg', { signal: c.req.raw.signal, timeoutMs: 600_000 })
      } catch (e) {
        const aborted = (e as Error).message === 'gate_acquire_aborted'
        return c.json(
          {
            error: aborted
              ? { message: 'Client disconnected while queued for the engine.', type: 'api_error', code: 'client_disconnected' }
              : { message: 'Timed out waiting for a free engine slot.', type: 'api_error', code: 'engine_busy' },
          },
          aborted ? 400 : 503,
        )
      }
    }

    const requestStart = Date.now()
    let res: Response
    try {
      res = await fetch(upstream, init)
    } catch (e) {
      chatGateRelease?.()
      const err = e as Error & { cause?: unknown }
      const isAbort = err.name === 'AbortError' || ac.signal.aborted
      const cause = err.cause instanceof Error ? `: ${err.cause.message}` : ''
      return c.json(
        {
          error: {
            message: isAbort
              ? 'Client disconnected before the engine responded.'
              : `${err.message || 'Engine unreachable.'}${cause}`,
            type: 'api_error',
            code: isAbort ? 'client_disconnected' : 'engine_unreachable',
          },
        },
        500,
      )
    }

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
        // The requester's own `stream` flag decides the drain shape: a non-streaming
        // OpenAI client (common for scripted/extension callers, `stream` false/absent)
        // gets ONE plain JSON body from the engine, not SSE `data:` lines — the SSE
        // parser would silently see no matches and record nothing (GitHub #71: this
        // gap would have made external-client tracking wrong for a common case).
        const drain = parsedBody?.stream === true
          ? recordOpenAiStreamUsage(d, b, 'openai', requestedModel || null, chatCodeSessionId, requestStart)
          : recordOpenAiJsonUsage(d, b, 'openai', requestedModel || null, chatCodeSessionId, requestStart)
        // Released when the teed copy finishes draining — i.e. when the engine has actually
        // stopped generating, NOT when this handler returns. Returning the streaming Response
        // hands bytes to the client while the engine is still busy, so releasing the slot here
        // would let the next queued request in on top of a still-running generation.
        void drain.finally(() => { d.manager.generationEnd(); chatGateRelease?.() })
        return new Response(a, { status: res.status, headers: res.headers })
      } catch {
        chatGateRelease?.()
        return new Response(res.body, { status: res.status, headers: res.headers })
      }
    }

    // Non-chat passthrough, or a chat response with no body to drain (an engine error) — nothing
    // will ever call the drain's finally, so the slot has to be given back right here.
    chatGateRelease?.()
    return new Response(res.body, { status: res.status, headers: res.headers })
  })
}

// ── session-stats recording helpers (B4) ────────────────────────────────────

/** Record usage from a non-streaming OpenAI completion. Fail-safe. Also persists a durable
 *  `api_usage` row (GitHub #71) — `source`/`modelKey` distinguish gateway (external-client)
 *  traffic from in-app chat, which records into `messages` instead. `codeSessionId`/`durationMs`
 *  (ADR-284) attribute this row to a terminal-agent session for TerminalToolbar.tsx's stats. */
function recordOpenAiUsage(d: Deps, oai: Record<string, unknown>, source: 'anthropic' | 'openai', modelKey: string | null, codeSessionId: string | null = null, durationMs: number | null = null): void {
  try {
    const usage = oai.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    const timings = oai.timings as { prompt_per_second?: number; predicted_per_second?: number } | undefined
    d.manager.recordCompletion({
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      promptTps: timings?.prompt_per_second,
      genTps: timings?.predicted_per_second,
    })
    d.db.recordApiUsage({
      source, modelKey, promptTokens: usage?.prompt_tokens ?? 0, genTokens: usage?.completion_tokens ?? 0,
      codeSessionId, durationMs,
      // Already extracted for the engine card two lines up; persisting them is what lets the
      // stats row report the engine's real rates instead of deriving both from `durationMs`.
      promptTps: timings?.prompt_per_second, genTps: timings?.predicted_per_second,
    })
  } catch { /* swallow — stats are best-effort */ }
}

/** Drain a teed copy of a NON-streaming OpenAI JSON body (a single response, not SSE) to
 *  record usage — the `/v1/*` pass-through's counterpart to `recordOpenAiStreamUsage` for
 *  requests where the caller didn't set `stream: true`. Never touches the client-facing
 *  stream; all errors are swallowed. `startedAt` (Date.now() at the ORIGINAL fetch call) —
 *  duration is computed here, at true completion, not at the call site (which fires before
 *  this drain even starts). */
async function recordOpenAiJsonUsage(d: Deps, body: ReadableStream<Uint8Array>, source: 'anthropic' | 'openai', modelKey: string | null, codeSessionId: string | null = null, startedAt: number | null = null): Promise<void> {
  try {
    const text = await new Response(body).text()
    const oai = JSON.parse(text) as Record<string, unknown>
    recordOpenAiUsage(d, oai, source, modelKey, codeSessionId, startedAt != null ? Date.now() - startedAt : null)
  } catch { /* swallow — stats are best-effort */ }
}

/** Drain a teed copy of a streaming OpenAI SSE body to record final usage (B4) plus a
 *  durable `api_usage` row (GitHub #71). Never touches the client-facing stream; all
 *  errors are swallowed. `startedAt` — see recordOpenAiJsonUsage's doc comment; same reason. */
async function recordOpenAiStreamUsage(d: Deps, body: ReadableStream<Uint8Array>, source: 'anthropic' | 'openai', modelKey: string | null, codeSessionId: string | null = null, startedAt: number | null = null): Promise<void> {
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
    d.db.recordApiUsage({
      source, modelKey, promptTokens, genTokens: completionTokens,
      codeSessionId, durationMs: startedAt != null ? Date.now() - startedAt : null,
      // Accumulated from the stream's own `timings` above (0 when the engine reported none —
      // recordApiUsage stores that as null, and the reader falls back to the old derivation).
      promptTps, genTps,
    })
  } catch { /* swallow — stats are best-effort */ }
}
