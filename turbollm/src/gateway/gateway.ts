// Gateway: /v1/* OpenAI-compatible pass-through + Anthropic translation (spec 06).
import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { createPatch } from 'diff'
import type { Deps } from '../deps'
import type { ToolCallRecord } from '../chat/db'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { presentedKey } from '../auth'
import { noteLocalActivity } from '../link/host-idle'
import { linkHeaders, proxyStream } from '../link/link-proxy'
import { formatRemoteId } from '../link/model-id'
import { sessionAuth } from '../code/session-auth'
import { classifyHarness } from '../telemetry/classify'
import { mapToOpenAI, mapFromOpenAI, streamToAnthropic, messageStartEvent, pingWhilePending, DEFAULT_PING_INTERVAL_MS, type AnthropicRequest, type StreamToolCall } from './anthropic'
import { analyzeTurn, applyAgentGuidance } from './agent-guidance'
import { appendNudges, appendSystemRules, declaresTools, openAiRequestView } from './openai-guidance'
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

/** Classify this request's client from its `User-Agent` header (spec 23 §3.5, Phase 5:
 *  the gateway read zero request headers before this) and report `harness_first_seen`
 *  as a side effect — one read per request, shared by both gateway entry points, so
 *  every code path that resolves a harness also contributes to that once-per-value
 *  ledger. `d.telemetry` is optional (tests / a middleware stub), and this must never
 *  affect the actual request, hence the swallow. */
function resolveHarness(c: Context, d: Deps, protocol: 'anthropic' | 'openai'): string {
  const harness = classifyHarness(c.req.header('user-agent'))
  try { d.telemetry?.harnessFirstSeen(harness, protocol) } catch { /* best-effort */ }
  return harness
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

/** Classifies a `d.gate.acquire()` failure into one {status, type, message} shape shared by both
 *  the streaming (SSE `error` event, ADR-347 — `status` unused there, a stream is always 200 by
 *  the time it can fail this way) and non-streaming (JSON error response, where `status` is what
 *  the client actually sees) call sites, so `type`/`message` wording can't silently drift between
 *  them. The gate-acquire and fetch() SEQUENCES themselves remain two separate copies (streaming
 *  needs to open the SSE connection before either call; non-streaming doesn't) — this only
 *  centralizes how a failure from either gets described. */
function classifyGateError(e: unknown): { status: ContentfulStatusCode; type: string; message: string } {
  const aborted = (e as Error).message === 'gate_acquire_aborted'
  return aborted
    ? { status: 400, type: 'invalid_request_error', message: 'Client disconnected while queued for the engine.' }
    : { status: 503, type: 'overloaded_error', message: 'Timed out waiting for a free engine slot.' }
}

/** Same reasoning as classifyGateError, for a failed `fetch()` to the engine. */
function classifyFetchError(e: unknown, ac: AbortController): { status: ContentfulStatusCode; type: string; message: string } {
  const err = e as Error & { cause?: unknown }
  const isAbort = err.name === 'AbortError' || ac.signal.aborted
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : ''
  return {
    status: 500,
    type: 'api_error',
    message: isAbort
      ? 'Client disconnected before the engine responded.'
      : `${err.message || 'Engine unreachable.'}${cause}`,
  }
}

/** Test-only overrides for values otherwise hardcoded below (ADR-347 review follow-up) — the
 *  600s gate-acquire timeout and the 10s ping cadence can't otherwise be exercised by a fast
 *  unit test without either sleeping for real or never observing a ping/timeout at all. Omit in
 *  production; `registerGateway(app, d)` behaves exactly as before. */
export interface GatewayOptions {
  pingIntervalMs?: number
  gateAcquireTimeoutMs?: number
}

export function registerGateway(app: Hono, d: Deps, opts: GatewayOptions = {}): void {
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
  const gateAcquireTimeoutMs = opts.gateAcquireTimeoutMs ?? 600_000
  // ── POST /v1/messages — Anthropic translation (spec 06 §2) ───────────────

  app.post('/v1/messages', async (c) => {
    // The owner's own terminal agent. Turbo Link's façade never reaches this route, so
    // everything arriving here is by definition local (host-idle.ts).
    noteLocalActivity()
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
    const anthropicHarness = resolveHarness(c, d, 'anthropic')
    if (anthropicCodeSessionId) {
      // Coding-activity attribution, confirm half (see commitConfirmedCodeToolCalls): this
      // request's own history is what tells the daemon whether the edits it watched the engine
      // ask for on an earlier turn actually landed. Read here, before the request is touched in
      // any way, so it happens for every real turn including ones that later fail to route or
      // never reach the engine at all.
      commitConfirmedCodeToolCalls(d, anthropicCodeSessionId, req)
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
    /** Turbo Link (ADR-376): set only when the caller asked for `<machine>/<model>` and the
     *  router resolved it to an online linked host. Everything below stays structurally
     *  identical — only the URL, the headers and the outbound model id differ. */
    const remote = routeResult.remote

    const status = d.manager.status()
    // A remote answer must be labelled with the model the CALLER asked for. The local
    // manager's loaded model is a different model on a different machine, and reporting it
    // here would name the wrong weights in the response.
    const modelName = remote
      ? (req.model ?? 'remote')
      : status.state === 'running' ? (status.model?.name ?? req.model ?? 'local') : (req.model ?? 'local')

    // ── Agent behaviour scaffolding for external coding CLIs (see agent-guidance.ts) ──────
    // Loop detection/breaking, search-on-repeated-failure, and version+docs-before-a-dependency
    // all lived inside the in-process pi agent, so the terminal-agent CLI had none of them. They
    // are reconstructed here from the request's own history and applied to `req` before
    // translation. Gated on the request actually declaring tools: that is what distinguishes an
    // agentic client from someone pointing a plain chat app at the gateway, who has no tool loop
    // to break and did not ask for a coding agent's rules.
    // Real request origin (e.g. http://127.0.0.1:<port>), the same technique the /v1/* pass-through
    // route below already uses (`new URL(c.req.url)`) — this is exactly the base URL the CLI itself
    // is connected to, so the routine-creation hint (agent-guidance.ts) never names a wrong or
    // placeholder port.
    const requestOrigin = new URL(c.req.url).origin
    const guidance = req.tools?.length ? applyAgentGuidance(req, requestOrigin) : null

    const oaiBody = mapToOpenAI(req)
    // Terminal-agent reasoning-effort override (same mechanism as the thinking-budget one
    // above) — no equivalent field exists on the Anthropic-shaped `req`/mapToOpenAI, so this
    // is injected into the already-mapped OpenAI-shaped body's chat_template_kwargs instead.
    if (anthropicCodeSessionId) {
      const effortOverride = sessionAuth.getReasoningEffortForToken(anthropicToken)
      // 'off' collapses onto enable_thinking/thinking_budget_tokens instead of the literal
      // string "off" — see reasoning-effort.ts.
      if (effortOverride === 'off') {
        oaiBody.thinking_budget_tokens = 0
        oaiBody.chat_template_kwargs = { ...(oaiBody.chat_template_kwargs as Record<string, unknown> ?? {}), enable_thinking: false }
      } else if (effortOverride !== null) {
        oaiBody.chat_template_kwargs = { ...(oaiBody.chat_template_kwargs as Record<string, unknown> ?? {}), reasoning_effort: effortOverride }
      }
    }
    // The hard half of the loop breaker. pi refuses to EXECUTE the repeated call; the gateway is
    // not in an external CLI's execution path, so the equivalent lever is denying tool calls for
    // this one reply — the model physically cannot emit the same call a seventh time and has to
    // answer in text, which ends the loop.
    if (guidance?.forceTextOnly) oaiBody.tool_choice = 'none'
    // mlx-lm / vLLM serve under a fixed alias and reject the client's model id; mlx-vlm
    // instead requires the real currently-loaded model path in the field. Either way,
    // rewrite the outbound field (routing above already used the original id). No-op
    // for llama.cpp and its forks, which ignore the field entirely.
    // A remote request is aliased by the HOST's engine, not this one: the host runs the same
    // gatewayV1Handler behind its façade and applies its own engineModelAlias there. What it
    // needs from us is the unqualified key it advertised — `<machine>/` prefixed, it would name
    // no machine the host knows and silently fall back to whatever the host has loaded.
    if (remote) {
      (oaiBody as Record<string, unknown>).model = remote.modelKey
    } else {
      const oaiAlias = engineModelAlias(d.registry.active()?.kind ?? '', d.manager.currentOpts()?.modelPath)
      if (oaiAlias) (oaiBody as Record<string, unknown>).model = oaiAlias
    }

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

    // Propagate client cancellation to the engine: if Claude Code drops this turn, the
    // upstream request is aborted instead of running to completion and queuing behind
    // the engine's slots forever.
    const ac = clientAbort(c)

    /** The single outbound call both branches below make — local engine or Turbo Link host.
     *  Defined once so the streaming and non-streaming paths cannot drift on which URL,
     *  which credential, or which abort signal a remote request uses. `ac.signal` is the
     *  same client-abort chain the local path already used, so invariant 6 (a client
     *  disconnect must reach the generator) holds identically across the link. */
    const callUpstream = (): Promise<Response> => {
      const body = JSON.stringify(oaiBody)
      if (remote) {
        const headers = linkHeaders(remote, c.req.raw.headers)
        headers.set('content-type', 'application/json') // re-serialised body; never inherited
        return proxyStream(remote, '/v1/chat/completions', { method: 'POST', headers, body }, ac.signal)
      }
      return fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      })
    }

    if (req.stream) {
      // ── ADR-347: the gate wait above and the fetch() below are exactly as silent to the
      // client as the slow-prefill gap the keep-alive ping fix (ADR-342) closed — a Task-tool
      // sub-agent fanned out against a busy `--parallel 1` engine can queue behind
      // gate.acquire() for up to 600s with ZERO bytes reaching Claude Code, tripping its
      // idle-stream watchdog before generation even starts (plausibly the actual scenario
      // behind the founder's original report, caught in review on this same PR). Fixed by
      // opening the client's SSE connection and sending message_start FIRST — before queueing
      // at all — then pinging through both the queue wait and the fetch(), not just the
      // engine's own read loop the way the original fix did.
      const msgId = `msg_${randomUUID().replace(/-/g, '')}`
      return streamSSE(c, async (stream) => {
        let gateRelease: (() => void) | null = null
        let generationStarted = false
        // Client went away mid-stream (including while still queued or fetching) → abort so
        // nothing keeps waiting on a connection nobody will read the response of.
        stream.onAbort(() => ac.abort())
        const ping = () => stream.writeSSE({ event: 'ping', data: JSON.stringify({ type: 'ping' }) })
        // Outer catch-all: everything expected already writes its own well-formed SSE `error`
        // event and returns below — this only exists for whatever ISN'T expected (this callback
        // now does real work: gate/fetch/JSON, any of which could throw something new later). Not
        // using streamSSE's own `onError` third argument (hono/streaming): it unconditionally
        // ALSO writes its own `data: e.message` frame afterward — a bare string, not the
        // `{type:'error', error:{...}}` shape an Anthropic-protocol client expects — so passing
        // both would send two error events, one malformed.
        try {
          try {
            await stream.writeSSE(messageStartEvent(msgId, modelName))

            if (d.gate) {
              try {
                // Never proceed un-slotted on failure — that would silently breach the very
                // limit this exists to enforce, and intermittently, which is worse than a clean
                // error. onOrphan: if the client is already gone by the time a slot grants (a
                // ping write failed first, below), the grant must still be released rather than
                // silently leaked — an un-drained release permanently shrinks the daemon's
                // effective engine concurrency by one for its whole remaining life (review-caught,
                // ADR-347 follow-up).
                gateRelease = await pingWhilePending(
                  d.gate.acquire('bg', { signal: c.req.raw.signal, timeoutMs: gateAcquireTimeoutMs }),
                  ping,
                  pingIntervalMs,
                  (release) => release(),
                )
              } catch (e) {
                const { type, message } = classifyGateError(e)
                await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', error: { type, message } }) })
                return
              }
            }

            // Mark the completion in-flight so the engine card's live "Generating…" indicator
            // counts Claude-CLI (Anthropic-protocol) traffic too — paired with generationEnd in
            // the outer finally below (generationStarted guards it: never call generationEnd for
            // a start that never happened, e.g. a gate timeout above).
            d.manager.generationStart()
            generationStarted = true

            // For terminal-agent usage attribution/stats (ADR-284) — wall-clock request
            // duration, the simplest signal available without touching streamToAnthropic's own
            // callback shape (it doesn't currently surface the engine's per-request timings the
            // way the OpenAI-shaped helpers below already do). An approximation, not a
            // literally-measured prefill/gen split.
            const requestStart = Date.now()
            let res: Response
            try {
              res = await pingWhilePending(
                callUpstream(),
                ping,
                pingIntervalMs,
                // No onOrphan: an orphaned Response has nothing to release — its body is simply
                // never read and gets garbage-collected, unlike gate.acquire()'s grant above.
              )
            } catch (e) {
              const { type, message } = classifyFetchError(e, ac)
              await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', error: { type, message } }) })
              return
            }

            if (!res.ok || !res.body) {
              // Forward the engine's REAL status + whatever structured error it returned,
              // instead of flattening every distinct failure (bad request, model
              // incompatibility, overload, crash) to the same hardcoded 'api_error' — that
              // flattening is what made bugs #1-#4 in a Code session all read identically from
              // the terminal, with no way to tell them apart.
              const { message, type } = await describeEngineError(res)
              await stream.writeSSE({
                event: 'error',
                data: JSON.stringify({ type: 'error', error: { type: type ?? anthropicErrorType(res.status), message } }),
              })
              return
            }

            // Record session stats (B4) from the final usage the generator observes.
            // Fail-safe: the callback is only invoked best-effort and swallows nothing
            // that affects the client stream.
            const gen = streamToAnthropic(res.body, modelName, msgId, {
              onUsage: (u) => {
                try {
                  // The engine's own per-phase rates now ride along (ADR-300). This path —
                  // Anthropic streaming, i.e. every Claude Code request — was the one place
                  // that passed NO timings at all, so the engine card fell back to whatever the
                  // last non-gateway request left behind and a terminal-agent session's stats
                  // row had to divide both token counts by one wall-clock, reading decode ~6x
                  // too low.
                  d.manager.recordCompletion({
                    inputTokens: u.inputTokens, outputTokens: u.outputTokens,
                    promptTps: u.promptTps, genTps: u.genTps,
                  })
                  // Durable counterpart to the ephemeral session counter above (GitHub #71) —
                  // the session counter resets on engine restart and was never
                  // persisted/surfaced.
                  d.db.recordApiUsage({
                    source: 'anthropic', modelKey: req.model ?? null, promptTokens: u.inputTokens, genTokens: u.outputTokens,
                    codeSessionId: anthropicCodeSessionId, durationMs: Date.now() - requestStart,
                    promptTps: u.promptTps, genTps: u.genTps, harness: anthropicHarness,
                  })
                } catch { /* swallow — stats are best-effort */ }
              },
              // Live per-request progress for the engine card (prefill % + token count),
              // so Claude Code traffic shows the same live row as in-app chat.
              onLive: (live) => { try { d.manager.setLiveGen(live) } catch { /* best-effort */ } },
              // Coding-activity attribution for terminal-agent sessions — see
              // observeCodeSessionTurn. Nothing to attribute for any other client.
              onToolCalls: (calls) => {
                if (!anthropicCodeSessionId) return
                try { observeCodeSessionTurn(d, anthropicCodeSessionId, calls) } catch { /* swallow */ }
              },
              skipMessageStart: true, // already sent above, before the queue wait
            })
            // streamSSE flushes each chunk immediately through Node.js's HTTP layer.
            // Raw ReadableStream does not — chunks buffer until the response completes,
            // which makes Claude CLI (and any Anthropic-protocol client) appear "slow".
            for await (const evt of gen) {
              await stream.writeSSE({ event: evt.event, data: evt.data })
            }
          } finally {
            ac.abort() // also tear down the upstream on normal completion / write error
            if (generationStarted) d.manager.generationEnd()
            gateRelease?.()
          }
        } catch (e) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ type: 'error', error: { type: 'api_error', message: (e as Error)?.message || 'Internal gateway error.' } }),
          }).catch(() => {})
        }
      })
    }

    // ── Non-streaming: the client just waits for one whole response, so there's no
    // idle-connection watchdog to defeat — keeps the original un-pinged gate/fetch sequence. ──
    let gateRelease: (() => void) | null = null
    if (d.gate) {
      try {
        gateRelease = await d.gate.acquire('bg', { signal: c.req.raw.signal, timeoutMs: gateAcquireTimeoutMs })
      } catch (e) {
        const { status, type, message } = classifyGateError(e)
        return c.json({ type: 'error', error: { type, message } }, status)
      }
    }

    d.manager.generationStart()
    const requestStart = Date.now()
    let res: Response
    try {
      res = await callUpstream()
    } catch (e) {
      d.manager.generationEnd()
      gateRelease?.()
      const { status, type, message } = classifyFetchError(e, ac)
      return c.json({ type: 'error', error: { type, message } }, status)
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

    try {
      const oaiRes = (await res.json()) as Record<string, unknown>
      // session stats (B4) + durable #71 record, fail-safe
      recordOpenAiUsage(d, oaiRes, 'anthropic', req.model ?? null, anthropicCodeSessionId, Date.now() - requestStart, anthropicHarness)
      // Same coding-activity attribution the streaming branch gets. A non-streaming turn has no
      // per-delta reassembly to do — the engine already hands back whole `arguments` strings —
      // but it must not be the one shape of terminal-agent turn that silently records nothing.
      // Wrapped like the streaming branch's callback: `openAiToolCalls(oaiRes)` is evaluated as
      // an ARGUMENT, i.e. before the callee's own try, so its containment has to live out here
      // — this block has no catch of its own and a throw would reach the client as a bodyless
      // 500 in place of a perfectly good answer the engine already produced.
      if (anthropicCodeSessionId) {
        try { observeCodeSessionTurn(d, anthropicCodeSessionId, openAiToolCalls(oaiRes)) } catch { /* swallow */ }
      }
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
  //
  // The handler body lives in the exported gatewayV1Handler below rather than inline,
  // because the Turbo Link façade (link/link-routes.ts) mounts the SAME function behind
  // its capability gate. A second copy over there is exactly the fork the façade exists
  // to avoid — this codebase has already paid once for two implementations of one idea
  // drifting apart (admin probe() vs LinkManager.probeOnce).

  app.all('/v1/*', (c) => gatewayV1Handler(c, d))
}

/** Overrides for a caller that is NOT the public /v1/* mount. */
export interface GatewayV1Options {
  /** The /v1 path to act on, when the request arrived under a different prefix. The
   *  façade's POST /api/link/v1/chat/completions passes '/v1/chat/completions': without
   *  it this handler would see a non-chat path, skip every chat-specific step, and
   *  proxy the peer's request to <engine>/api/link/v1/chat/completions. */
  pathname?: string
  /** Where the request came from. 'link' means a Turbo Link peer: it must NOT count as
   *  the OWNER touching their own machine (host-idle.ts), or one peer's request would
   *  block the next peer's wake for the whole idle grace window. Defaults to 'local'. */
  origin?: 'local' | 'link'
}

/** The whole /v1/* surface: GET /v1/models synthesis, POST /v1/chat/completions (body
 *  rewrite, auto-swap routing, engine gate, usage accounting), and plain pass-through for
 *  everything else. Extracted verbatim from the inline registration above so the Turbo Link
 *  façade routes a peer through the identical code path a local client takes. */
export async function gatewayV1Handler(c: Context, d: Deps, opts: GatewayV1Options = {}): Promise<Response> {
  const url = new URL(c.req.url)
  // Every decision below keys off the /v1 path, not off the URL the client actually hit —
  // see GatewayV1Options.pathname. Defaults to the real one, so the public mount is unchanged.
  const pathname = opts.pathname ?? url.pathname

  // GET /v1/models: always synthesise the list from the WHOLE local library (not just
  // the loaded model), regardless of whether an engine is running — real key entries for
  // OpenAI-style consumers. The `claude-<key>` alias (whose id passes Claude Code's
  // discovery filter — it keeps only claude*/anthropic* ids — and which /v1/messages
  // strips back to the real key before routing) is only added when gateway.autoSwap is
  // on: picking a model from Claude Code's /model always requires a swap, so advertising
  // it while auto-swap is off would let the user pick a model that silently never loads.
  if (c.req.method === 'GET' && pathname === '/v1/models') {
    const autoSwap = d.store.snapshot().gateway.autoSwap
    const data: Array<Record<string, unknown>> = d.scanner.list().models.flatMap((m) => [
      { id: m.key, object: 'model', owned_by: 'turbollm' },
      ...(autoSwap ? [{ id: `claude-${m.key}`, object: 'model', display_name: `${m.name} — TurboLLM` }] : []),
    ])
    // Turbo Link (ADR-376 §1 decision 7): every model on every ONLINE linked host, under
    // its qualified `<machine>/<model>` id — the exact id ModelRouter.resolveRemote routes
    // on. Local ids above are untouched and stay bare; the qualifier is the only signal
    // that a request is remote, so there is no migration and nothing is renamed.
    //
    // `RemoteCatalog.models()` is what makes "an offline link contributes nothing" true:
    // it re-reads each link's LIVE status on every call, so a machine that dropped stops
    // being advertised immediately rather than at the next poll. A listed-but-unusable
    // model is worse than an absent one — the user picks it and every prompt 503s.
    //
    // Deliberately NOT gated on `autoSwap`: that gate exists because picking a local model
    // from a harness's picker always costs a local swap. A remote model costs none — it
    // runs on the other machine — so the user's local auto-swap preference has no bearing
    // on whether it can be offered.
    for (const row of d.remoteCatalog?.models() ?? []) {
      data.push({
        id: formatRemoteId(row.machine, row.model.key),
        object: 'model',
        owned_by: 'turbollm-link',
        display_name: `${row.model.name} — ${row.machine}`,
      })
    }
    return c.json({ object: 'list', data })
  }

  const isChat = c.req.method === 'POST' && pathname === '/v1/chat/completions'
  // What "the owner is using this machine" means for wake gating (host-idle.ts): a real
  // generation request from a local client. A Turbo Link peer routed through this same
  // function is explicitly NOT that — see GatewayV1Options.origin.
  if (isChat && opts.origin !== 'link') noteLocalActivity()

  // For chat completions: parse the body to extract the model field for
  // auto-swap routing (v0.6.0) and to apply the max_tokens cap if set.
  // For all other endpoints: skip body parsing and pass through untouched.
  let parsedBody: Record<string, unknown> | null = null
  if (isChat) {
    try { parsedBody = (await c.req.json()) as Record<string, unknown> } catch { parsedBody = null }
  }
  const { token: chatToken, codeSessionId: chatCodeSessionId } = resolveCodeSession(c)
  const chatHarness = resolveHarness(c, d, 'openai')

  // ── Agent scaffolding + coding-activity attribution for OPENAI-protocol harnesses ──────────
  // Everything below this comment used to exist only on /v1/messages, i.e. only for `claude`.
  // The split was never by agent — it was by PROTOCOL, so `pi`/`opencode`/DeepSeek Harness/
  // `kilo`/`openclaw`/`hermes` and every plain script silently ran without loop breaking,
  // search-on-repeated-failure, dependency discipline, the routine hint, or a tool-call
  // timeline. One adapter (openai-guidance.ts) reuses the SAME rules rather than forking them.
  //
  // `chatGuidance` is computed here (before the body is mutated below) but applied inside the
  // isChat body-rewrite block, so a non-chat passthrough pays nothing at all.
  // Built ONLY when something will actually read it. The view walks every message and JSON.parses
  // every historical tool call's `arguments`, synchronously on the daemon's single thread, once
  // per turn and growing with the conversation — pure waste for a plain chat client with no tools
  // and no Code session, which is exactly when both consumers below skip it.
  const chatNeedsView = isChat && !!parsedBody && (!!chatCodeSessionId || declaresTools(parsedBody))
  const chatView = chatNeedsView && parsedBody ? openAiRequestView(parsedBody) : null
  if (chatView && chatCodeSessionId) {
    // Confirm half of coding-activity attribution — the view's `tool_result` blocks are exactly
    // what this reads, so no second adapter is needed. Runs before the request is touched, for
    // the same reason as the Anthropic handler: it must happen for every real turn, including
    // ones that later fail to route or never reach the engine.
    commitConfirmedCodeToolCalls(d, chatCodeSessionId, chatView)
  }
  const chatGuidance = chatView && parsedBody && declaresTools(parsedBody)
    ? analyzeTurn(chatView, url.origin)
    : null

  const requestedModel = isChat ? ((parsedBody?.model as string | undefined) ?? '') : ''
  const routeResult = await d.modelRouter.route(requestedModel)
  if ('status' in routeResult) {
    return c.json(
      { error: { message: routeResult.message, type: 'model_not_loaded', code: 'model_not_loaded' } },
      503,
    )
  }
  const target = routeResult.target
  /** Turbo Link (ADR-376) — see the identical binding in the /v1/messages handler above. */
  const remote = routeResult.remote

  // ── Links do not chain (ADR-376, "Rejected — links that chain") ───────────────────────
  // This function is mounted TWICE: publicly at /v1/*, and behind the host's own façade
  // (link-routes.ts, `origin: 'link'`). Without this guard, a peer sending
  // `model: "ThirdBox/Qwen3"` to a host that itself has a link named ThirdBox would be
  // relayed onward by the host — using the HOST's link token, on the host's authority.
  // Capability sets would compose transitively in ways nobody can audit; a peer sees a
  // host's LOCAL models only.
  //
  // Deliberately a typed error rather than `remote = undefined`. Clearing it would make the
  // qualified id merely unresolved, which falls through to local resolution — and that is
  // exactly the invariant-5 hazard the router's guard exists to prevent: the peer would be
  // silently answered by the HOST's local model, wrong weights and no error at all.
  if (remote && opts.origin === 'link') {
    return c.json(
      {
        error: {
          message:
            `'${requestedModel}' names a machine linked to this one. A linked machine serves ` +
            `only its own local models — link it directly instead.`,
          type: 'invalid_request_error',
          code: 'link_chaining_unsupported',
        },
      },
      400,
    )
  }

  // Local: the caller's whole header set, minus `host`. Remote: an ALLOWLIST (invariant 7).
  // The peer's clients authenticate to THIS machine; their credential is meaningless on the
  // host and forwarding it would hand another box a secret it was never issued. The link
  // token replaces it, and is added nowhere else.
  const remotePath = pathname + url.search
  // Local branch only — the remote branch derives the façade URL inside proxyStream, so there
  // is exactly one place that knows how a link URL is spelled.
  const upstream = target + remotePath
  const headers = remote ? linkHeaders(remote, c.req.raw.headers) : new Headers(c.req.raw.headers)
  if (!remote) headers.delete('host')

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
      // (mlx-lm / vLLM) or that require the real loaded model path (mlx-vlm).
      // Routing above already used the caller's original id.
      // Turbo Link: the HOST aliases for its own engine behind its façade (it runs this very
      // function). What it needs is the unqualified key it advertised — the `<machine>/`
      // prefix names no machine there and would silently route to whatever it has loaded.
      if (parsedBody && remote) {
        parsedBody.model = remote.modelKey
      } else if (parsedBody) {
        const alias = engineModelAlias(d.registry.active()?.kind ?? '', d.manager.currentOpts()?.modelPath)
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
        // Same override mechanism, for reasoning_effort — see session-auth.ts. 'off'
        // collapses onto enable_thinking/thinking_budget_tokens (reasoning-effort.ts).
        const effortOverride = sessionAuth.getReasoningEffortForToken(chatToken)
        if (effortOverride === 'off') {
          parsedBody.thinking_budget_tokens = 0
          parsedBody.chat_template_kwargs = { ...(parsedBody.chat_template_kwargs as Record<string, unknown> ?? {}), enable_thinking: false }
        } else if (effortOverride !== null) {
          parsedBody.chat_template_kwargs = { ...(parsedBody.chat_template_kwargs as Record<string, unknown> ?? {}), reasoning_effort: effortOverride }
        }
      }
      // Apply the scaffolding computed above. Standing rules go on the system message (stable
      // for the whole session → the engine's reusable prompt prefix is unaffected after turn
      // one); situational nudges go on the trailing user/tool turn, where they cost no prefix
      // reuse and where the model actually acts on them. Same division as the Anthropic path.
      if (parsedBody && chatGuidance) {
        appendSystemRules(parsedBody, chatGuidance.system)
        appendNudges(parsedBody, chatGuidance.nudges)
        // The hard half of the loop breaker: at LOOP_ABORT_AFTER the model physically cannot
        // emit the same call again and has to answer in text, which ends the loop. `'none'` is
        // the OpenAI spelling of the Anthropic path's identical `oaiBody.tool_choice = 'none'`.
        if (chatGuidance.forceTextOnly) parsedBody.tool_choice = 'none'
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
    // proxyStream for the remote branch, not a bare fetch: it re-derives the façade URL from
    // the same helper the tests pin, and refuses to wake a host for a client that has already
    // gone away. `init.signal` is ac.signal, the client-abort chain (invariant 6).
    res = remote
      ? await proxyStream(remote, remotePath, init, ac.signal)
      : await fetch(upstream, init)
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
        ? recordOpenAiStreamUsage(d, b, 'openai', requestedModel || null, chatCodeSessionId, requestStart, chatHarness)
        : recordOpenAiJsonUsage(d, b, 'openai', requestedModel || null, chatCodeSessionId, requestStart, chatHarness)
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
}

// ── Coding-activity attribution for terminal-agent sessions ─────────────────

/** The only tool names that feed the Code launchpad's filesTouched/diff tiles. Claude Code sends
 *  them PascalCase (`Edit`/`Write`/`MultiEdit`, confirmed against a real transcript), so matching
 *  is case-insensitive; every other tool it has (Bash, Read, Grep, WebFetch, …) is deliberately
 *  ignored, exactly as on the in-process pi path, where only edit/write records carry a path. */
const CODE_ACTIVITY_TOOLS = new Set(['edit', 'write', 'multiedit'])

/** Reassembled tool calls off a NON-streaming OpenAI completion — the flat counterpart to
 *  streamToAnthropic's per-delta accumulation, for the same observer. An unparseable
 *  `arguments` string drops that one call rather than the whole turn's worth. */
function openAiToolCalls(oai: Record<string, unknown>): StreamToolCall[] {
  const raw = (oai.choices as Array<{ message?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)
    ?.[0]?.message?.tool_calls
  if (!Array.isArray(raw)) return []
  const calls: StreamToolCall[] = []
  for (const tc of raw) {
    try {
      calls.push({ id: tc.id ?? '', name: tc.function?.name ?? '', input: JSON.parse(tc.function?.arguments ?? '') })
    } catch { /* skip this one call */ }
  }
  return calls
}

/** Above this combined `old_string.length + new_string.length`, an edit's unified diff is skipped
 *  and the record kept diff-less. `createPatch` is Myers (O(N × D)) and fully SYNCHRONOUS on
 *  Node's single thread, so a large enough edit stalls the WHOLE daemon for its duration — the
 *  UI, engine-card polling, other Code sessions, every other gateway turn. Measured against this
 *  repo's own `diff@9`: 22 KB of input → 22 ms, 69 KB → 168 ms, 140 KB → 653 ms, degrading
 *  superlinearly past that. A "rewrite this whole block" Edit of that size fits comfortably
 *  inside a 32k-token response budget (~4 chars/token), so it is reachable in ordinary use, not
 *  a crafted input. Skipping costs only the "Diff shipped" contribution — the file still gets
 *  its filesTouched credit, exactly as MultiEdit already does below. */
const MAX_DIFF_INPUT_CHARS = 64 * 1024

/** The file an edit/write tool call targets, across every harness's own spelling.
 *
 *  ── Why this is not just `file_path` (hostile-QA finding, 2026-08-18) ──────────────────────────
 *  `file_path` is CLAUDE CODE's spelling and nothing else's. Read off the installed binaries:
 *    claude    `file_path`   (PascalCase tools: Edit/Write/MultiEdit)
 *    pi 0.84   `path`        (`dist/core/tools/edit.js`, `write.js`: `Type.Object({ path: … })`)
 *    opencode  `filePath`    (its edit tool: `Struct({ filePath: String… })`)
 *  Because this read `file_path` only, EVERY pi and opencode call fell through the `if (!path)
 *  continue` guard: nothing was ever added to `pendingCodeToolCalls`, so the tool-call timeline and
 *  the launchpad's filesTouched / "Diff shipped" tiles stayed empty for both harnesses while the run
 *  was still optimistically marked done. The whole point of porting attribution to the OpenAI path
 *  was those tiles, so the feature was dead on arrival for the two harnesses it was built for.
 *
 *  Order is claude-first only because it is the highest-traffic client; the spellings are disjoint,
 *  so precedence never actually decides anything. */
function editedPath(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'filePath', 'path']) {
    const v = input[key]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

/** The before/after text of a single-file edit, across each harness's spelling.
 *
 *  claude   `old_string` / `new_string`
 *  opencode `oldString`  / `newString`
 *  pi       an `edits: [{ oldText, newText }]` ARRAY — several replacements in one call, which is
 *           structurally MultiEdit rather than Edit. Exactly one element can be rendered as a
 *           unified diff honestly; for several, the fragments' line positions relative to each other
 *           are unknown, so this returns empty and the caller records the edit WITHOUT a diff. That
 *           mirrors the existing MultiEdit branch below: the file still gets filesTouched credit, and
 *           an omitted number beats a fabricated one nobody can tell is wrong. */
function editStrings(input: Record<string, unknown>): { oldString: string; newString: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const edits = input.edits
  if (Array.isArray(edits)) {
    if (edits.length !== 1) return { oldString: '', newString: '' }
    const e = (edits[0] ?? {}) as Record<string, unknown>
    return { oldString: str(e.oldText ?? e.old_string ?? e.oldString), newString: str(e.newText ?? e.new_string ?? e.newString) }
  }
  return {
    oldString: str(input.old_string ?? input.oldString),
    newString: str(input.new_string ?? input.newString),
  }
}

/** Test-only re-exports. These two functions decide whether ANY work is attributed for a harness,
 *  and reading the wrong field name silently zeroes the whole feature — so they are tested directly
 *  rather than only through a full streaming request. */
export const editedPathForTest = editedPath
export const editStringsForTest = editStrings

/** Edit/Write/MultiEdit calls a session's CLI has been TOLD to make but is not yet known to have
 *  actually made, keyed `codeSessionId -> tool_use id -> record`.
 *
 *  Why they can't be credited on sight: the gateway sees a call the instant the ENGINE emits it —
 *  before the CLI has run it, and before the user has been asked to permit it. Crediting there
 *  counts files that were never modified and diffs that were declined or that failed outright
 *  (an `Edit` whose `old_string` isn't found or isn't unique is the single most common local-model
 *  tool failure, and the model then RETRIES, so the same logical change lands 2-4 times). Those
 *  are precisely the two tiles this feature exists to populate, so an approximation there is worse
 *  than nothing. The in-process pi path has never had this problem — it only records a
 *  ToolCallRecord on a `tool_call` event whose status is already 'done'/'error'
 *  (code-run-manager.ts) — and this path is deliberately built to match it.
 *
 *  The outcome IS observable, just one turn later: an Anthropic-protocol client resends the whole
 *  conversation every request, so the request AFTER a tool_use carries that call's `tool_result`
 *  block (with `is_error` when it failed or was declined). commitConfirmedCodeToolCalls below
 *  reads it and commits only what really happened.
 *
 *  Pure in-memory and deliberately so, mirroring session-auth.ts: this is ephemeral state tied to
 *  a live CLI subprocess whose worst-case loss is one turn of tile credit, and a daemon restart
 *  has already killed the PTY that produced it. */
const pendingCodeToolCalls = new Map<string, Map<string, ToolCallRecord>>()

/** Ceiling on one session's un-confirmed records. In normal operation a turn's calls are all
 *  resolved by the very next request, so this map holds a handful of entries at a time; the cap
 *  only matters for calls whose result never arrives at all (the CLI is killed mid-turn, the
 *  user abandons a permission prompt), which would otherwise sit here until the daemon restarts.
 *  Oldest-first eviction, which is also age order — a record still unconfirmed after hundreds of
 *  later calls is never going to be. */
const MAX_PENDING_PER_SESSION = 256

/** Observe a turn a Code session's terminal-launched CLI just took: stash its file-touching tool
 *  calls as PENDING (see pendingCodeToolCalls — they are committed only once a later request
 *  confirms the CLI really applied them) and mark the run shipped.
 *
 *  Why this lives in the gateway at all: a terminal session's CLI executes its own edits inside
 *  its own subprocess and never reports them back, so nothing downstream of it can see them. The
 *  gateway is the one component that does — it is the HTTP intermediary the CLI asks for every
 *  token — and it already knows which session a request belongs to from the session-scoped bearer
 *  token (resolveCodeSession). Without this, a terminal session moved none of the "Coding
 *  activity" tiles no matter how much real work it did.
 *
 *  Two paths were considered and rejected before this one: the CLI's process-exit event (leaving
 *  the terminal tab is Ctrl+D, which does NOT quit the CLI — see TerminalView.tsx and ADR-298 —
 *  so it almost never fires in real use), and parsing Claude Code's own private on-disk JSONL
 *  transcript (undocumented, third-party, single-agent-only, and outside our data directory).
 *
 *  Wholly best-effort: any failure here is swallowed, because this is a side observation of a
 *  request whose actual job is to answer the CLI. */
function observeCodeSessionTurn(d: Deps, codeSessionId: string, calls: StreamToolCall[]): void {
  try {
    const run = d.db.getAgentRun(codeSessionId)
    if (!run) return

    let pending = pendingCodeToolCalls.get(codeSessionId)
    for (const call of calls) {
      const name = call.name.toLowerCase()
      if (!CODE_ACTIVITY_TOOLS.has(name)) continue
      // Without an id there is no `tool_result` to ever match this against, so it could only be
      // credited unconditionally — the exact thing the pending/confirm split exists to prevent.
      // A real client always sends one; the protocol needs it to address the result back.
      if (!call.id) continue
      // `input` came off the wire as JSON — narrow every field rather than trusting the shape.
      const input = (call.input ?? {}) as Record<string, unknown>
      const path = editedPath(input)
      if (!path) continue
      let record: ToolCallRecord
      if (name === 'write') {
        // No diff: codeStats() counts diff lines for 'edit' only, and a whole-file write has no
        // meaningful before-state here anyway. It still lands in filesTouched, which is the
        // entirety of what a write contributes on the pi path too.
        record = { id: call.id, name: 'write', args: { path } }
      } else if (name === 'edit') {
        const { oldString, newString } = editStrings(input)
        record = oldString.length + newString.length > MAX_DIFF_INPUT_CHARS
          ? { id: call.id, name: 'edit', args: { path } } // see MAX_DIFF_INPUT_CHARS
          : { id: call.id, name: 'edit', args: { path }, diff: createPatch(path, oldString, newString) }
      } else {
        // MultiEdit carries N independent {old_string,new_string} FRAGMENT pairs and no file
        // content, so there is no honest way to reconstruct one unified diff from it — the
        // fragments' line positions relative to each other are unknown. Recorded as an edit for
        // filesTouched credit with the diff deliberately omitted: an omitted number is a gap in
        // "Diff shipped", a fabricated one is a wrong number nobody can tell is wrong.
        record = { id: call.id, name: 'edit', args: { path } }
      }
      if (!pending) {
        pending = new Map<string, ToolCallRecord>()
        pendingCodeToolCalls.set(codeSessionId, pending)
      }
      pending.set(call.id, record)
    }
    while (pending && pending.size > MAX_PENDING_PER_SESSION) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      pending.delete(oldest)
    }

    // Optimistic, and deliberately so: observing ANY real turn on this session — even a
    // text-only reply or a pure Bash/Read turn — is what marks it shipped. The alternative is
    // waiting for a completion signal that in practice never arrives, because leaving the
    // terminal tab does not quit the CLI (ADR-298), so the overwhelming majority of real
    // sessions would stay 'queued' forever and never count toward "Tasks shipped". A run that
    // is genuinely still going simply gets marked again on its next turn. Unlike the tool-call
    // records above this needs no confirmation: the claim it makes is "this session did real
    // work", which the turn itself already proves regardless of how any one call turned out.
    //
    // It also removes a second, quieter wrong: CodeRunManager.reconcileOnStartup force-marks
    // every code run still 'queued'/'running' at daemon startup as 'interrupted'. A terminal
    // session that never left 'queued' was being labelled interrupted on the next restart no
    // matter how much work it had actually done.
    d.db.updateAgentRun(run.id, { status: 'done', endedAt: new Date().toISOString() })
  } catch { /* swallow — attribution is best-effort and must never affect the CLI's response */ }
}

/** Commit the pending records this INCOMING request proves the CLI actually applied, into the
 *  same table the in-process pi agent writes (`messages.tool_calls`) — so codeStats() still needs
 *  no knowledge that a second kind of agent exists.
 *
 *  An Anthropic-protocol client resends the entire conversation every turn, so a `tool_use` the
 *  gateway stashed on turn N reappears here as a `tool_result` block carrying its verdict. A
 *  result with `is_error: true` — the tool threw, its preconditions failed, or the user declined
 *  it at a permission prompt — retires the pending record WITHOUT crediting it; anything else
 *  commits it. Either way it leaves the pending map, so the same call can never be counted twice
 *  no matter how many later requests replay the same history.
 *
 *  Runs on every request for a resolved Code session, ahead of anything that touches the engine,
 *  and returns immediately when the session has nothing pending (the overwhelmingly common case
 *  — no scan of a large conversation happens for a client that isn't mid-edit). Best-effort like
 *  the rest of this feature: it must never affect the CLI's own response. */
function commitConfirmedCodeToolCalls(d: Deps, codeSessionId: string, req: AnthropicRequest): void {
  try {
    const pending = pendingCodeToolCalls.get(codeSessionId)
    if (!pending || pending.size === 0) return

    const confirmed: ToolCallRecord[] = []
    for (const msg of req.messages ?? []) {
      const raw = msg.content
      // Array.isArray rather than anthropic.ts's `typeof raw === 'string'` test: this runs before
      // the request has been validated at all, and one malformed message must cost at most its own
      // blocks, not throw out of the loop and strand the whole session's pending set.
      if (!Array.isArray(raw)) continue
      for (const block of raw) {
        if (block.type !== 'tool_result') continue
        const record = pending.get(block.tool_use_id)
        if (!record) continue
        pending.delete(block.tool_use_id)
        if (block.is_error !== true) confirmed.push(record)
      }
    }
    if (confirmed.length === 0) return

    // Looked up only now, not on entry: a request that confirms nothing must cost this session
    // no DB work at all, and a run row that has since disappeared simply drops the credit.
    const run = d.db.getAgentRun(codeSessionId)
    if (!run) return
    d.db.addMessage(run.convId, 'assistant', '', { toolCalls: confirmed })
  } catch { /* swallow — attribution is best-effort and must never affect the CLI's response */ }
}

// ── session-stats recording helpers (B4) ────────────────────────────────────

/** Record usage from a non-streaming OpenAI completion. Fail-safe. Also persists a durable
 *  `api_usage` row (GitHub #71) — `source`/`modelKey` distinguish gateway (external-client)
 *  traffic from in-app chat, which records into `messages` instead. `codeSessionId`/`durationMs`
 *  (ADR-284) attribute this row to a terminal-agent session for TerminalToolbar.tsx's stats. */
function recordOpenAiUsage(d: Deps, oai: Record<string, unknown>, source: 'anthropic' | 'openai', modelKey: string | null, codeSessionId: string | null = null, durationMs: number | null = null, harness: string | null = null): void {
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
      codeSessionId, durationMs, harness,
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
async function recordOpenAiJsonUsage(d: Deps, body: ReadableStream<Uint8Array>, source: 'anthropic' | 'openai', modelKey: string | null, codeSessionId: string | null = null, startedAt: number | null = null, harness: string | null = null): Promise<void> {
  try {
    const text = await new Response(body).text()
    const oai = JSON.parse(text) as Record<string, unknown>
    recordOpenAiUsage(d, oai, source, modelKey, codeSessionId, startedAt != null ? Date.now() - startedAt : null, harness)
    // Observe half of coding-activity attribution for OPENAI-protocol harnesses — the counterpart
    // to the Anthropic handler's own observeCodeSessionTurn call. Reuses `openAiToolCalls`, which
    // already existed for that path's OpenAI-shaped responses; nothing is forked.
    if (codeSessionId) {
      try { observeCodeSessionTurn(d, codeSessionId, openAiToolCalls(oai)) } catch { /* swallow */ }
    }
  } catch { /* swallow — stats are best-effort */ }
}

/** Reassemble tool calls from an OpenAI SSE stream's `choices[0].delta.tool_calls[]` fragments.
 *
 *  OpenAI streams a tool call in pieces: the first delta for a given `index` carries `id` and
 *  `function.name`, and every later delta for that same index appends a slice of
 *  `function.arguments` — so a single call's JSON arrives split across many chunks and must be
 *  concatenated before it can be parsed. Keyed by `index` (not `id`, which only appears once).
 *
 *  Mirrors streamToAnthropic's per-delta accumulation, which does the same job for the Anthropic
 *  path; kept separate because this one never has to emit Anthropic SSE events, only collect. */
class StreamingToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string; args: string }>()

  observe(chunk: Record<string, unknown>): void {
    const deltas = (chunk.choices as Array<{ delta?: { tool_calls?: Array<Record<string, unknown>> } }> | undefined)
      ?.[0]?.delta?.tool_calls
    if (!Array.isArray(deltas)) return
    for (const delta of deltas) {
      const index = typeof delta.index === 'number' ? delta.index : 0
      const entry = this.byIndex.get(index) ?? { id: '', name: '', args: '' }
      if (typeof delta.id === 'string' && delta.id) entry.id = delta.id
      const fn = (delta.function ?? {}) as { name?: unknown; arguments?: unknown }
      if (typeof fn.name === 'string' && fn.name) entry.name = fn.name
      if (typeof fn.arguments === 'string') entry.args += fn.arguments
      this.byIndex.set(index, entry)
    }
  }

  /** The completed calls, in stream order. A call whose accumulated `arguments` never became valid
   *  JSON is dropped — one bad call, not the whole turn (same rule as `openAiToolCalls`). */
  calls(): StreamToolCall[] {
    const out: StreamToolCall[] = []
    for (const [, entry] of [...this.byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (!entry.name) continue
      try { out.push({ id: entry.id, name: entry.name, input: JSON.parse(entry.args) }) } catch { /* skip */ }
    }
    return out
  }
}

/** Drain a teed copy of a streaming OpenAI SSE body to record final usage (B4) plus a
 *  durable `api_usage` row (GitHub #71). Never touches the client-facing stream; all
 *  errors are swallowed. `startedAt` — see recordOpenAiJsonUsage's doc comment; same reason. */
async function recordOpenAiStreamUsage(d: Deps, body: ReadableStream<Uint8Array>, source: 'anthropic' | 'openai', modelKey: string | null, codeSessionId: string | null = null, startedAt: number | null = null, harness: string | null = null): Promise<void> {
  try {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let promptTokens = 0
    let completionTokens = 0
    let promptTps = 0
    let genTps = 0
    let liveOut = 0 // running generated-token count for the live engine-card row
    // Only allocated for a resolved Code session — a plain script's stream pays nothing.
    const toolCalls = codeSessionId ? new StreamingToolCallAccumulator() : null
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
        toolCalls?.observe(chunk)
      }
    }
    if (codeSessionId && toolCalls) {
      try { observeCodeSessionTurn(d, codeSessionId, toolCalls.calls()) } catch { /* swallow */ }
    }
    d.manager.recordCompletion({ inputTokens: promptTokens, outputTokens: completionTokens, promptTps, genTps })
    d.db.recordApiUsage({
      source, modelKey, promptTokens, genTokens: completionTokens,
      codeSessionId, durationMs: startedAt != null ? Date.now() - startedAt : null, harness,
      // Accumulated from the stream's own `timings` above (0 when the engine reported none —
      // recordApiUsage stores that as null, and the reader falls back to the old derivation).
      promptTps, genTps,
    })
  } catch { /* swallow — stats are best-effort */ }
}
