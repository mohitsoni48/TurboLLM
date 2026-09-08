// Where an in-app chat turn is actually generated (ADR-376 phase 2, final-review C-1).
//
// Before this module, chat had exactly one answer: `d.manager.target()`, the local engine.
// The picker offered remote rows anyway, and selecting one handed the qualified
// `<machine>/<model>` id to `POST /api/v1/engine/start` — the LOCAL engine loader — which
// aborted every in-flight generation, missed in the local scanner, and then either 409'd or
// (on a config carrying `devModel`) loaded a completely different local model with no
// indication that it was not the remote one. Half of the phase's own green criterion — "a
// remote model is usable from chat AND from `turbollm launch claude`" — did not exist, and
// the control that was supposed to deliver it failed destructively.
//
// So chat resolves its upstream HERE, once per turn, and every generation call in
// chat-routes.ts goes through `callChatUpstream`. Two rules make that safe:
//
//  1. **Nothing is re-implemented.** The remote decision is `ModelRouter.resolveRemoteTarget`
//     — the same resolution the gateway routes on — and the transport is `link-proxy.ts`,
//     the same streaming/header-rewrite/abort-propagation helper the gateway proxies with.
//     Three findings in this feature came from two implementations of one idea drifting
//     apart; a second chat-shaped proxy would have been the fourth.
//  2. **A remote turn writes nothing into local engine state.** Same rule the gateway's
//     `localAccounting` flag enforces: this machine did not run the tokens.
import { engineModelAlias } from '../engines/compat'
import { linkHeaders, proxyStream, type RemoteTarget } from '../link/link-proxy'
import type { Deps } from '../deps'
import { extractParams, summarizeRequest, drainOpenAiSseForLog, requestLogConfig } from '../observability/request-log'

/** Everything a chat turn needs to know about where it is being generated. */
export interface ChatUpstream {
  /** The `model` field to send. Local: the engine's alias, or the loaded key. Remote: the
   *  UNQUALIFIED key the host advertised — a `<machine>/` prefix names no machine there
   *  and would silently fall back to whatever the host has loaded. */
  modelField: string
  /** What the reply is LABELLED with. For a remote turn this is the host's model, never
   *  whatever this machine happens to have loaded. */
  modelName: string
  /** Context window, for the message's own context meter. */
  ctxMax: number
  /** Set only for a Turbo Link host. Its presence is the single "did this machine do the
   *  work?" test every local ledger in chat-routes.ts branches on. */
  remote?: RemoteTarget
  /** Local engine base URL. Empty for a remote turn — nothing may build a URL from it. */
  target: string
}

export type ChatUpstreamResult =
  | { ok: true; upstream: ChatUpstream }
  | { ok: false; status: 409 | 503; code: string; message: string }

const DEFAULT_CTX = 4096

/** Decide where THIS turn generates.
 *
 *  `requestedModel` is the id the composer sent. Empty/absent — every pre-Turbo-Link
 *  client, and every local chat — takes the unchanged local path.
 *
 *  A qualified id resolves through `resolveRemoteTarget`, which returns `undefined` unless
 *  the id names a machine this daemon actually links to. That is what keeps a LOCAL model
 *  key containing a slash (`unsloth/Qwen3-GGUF`) resolving locally, and it is why the
 *  decision lives in the router rather than in a `includes('/')` test here. Once the
 *  machine matches, every failure is terminal — it never degrades to a local model. */
export function resolveChatUpstream(d: Deps, requestedModel?: string): ChatUpstreamResult {
  const wanted = (requestedModel ?? '').trim()
  const route = wanted ? d.modelRouter?.resolveRemoteTarget?.(wanted) : undefined
  if (route) {
    if ('status' in route) {
      // The router's own message already names the machine and what to do about it
      // ("'rig' is not connected (unreachable). Reconnect it in Settings → Turbo Link.").
      return { ok: false, status: 503, code: 'remote_unavailable', message: route.message }
    }
    const remote = route.remote
    if (!remote) return { ok: false, status: 503, code: 'remote_unavailable', message: 'That machine could not be reached.' }
    // The advertised row, for the label and the context meter. Absent only in a race with a
    // link dropping — the request still goes out and fails loudly upstream if it has to.
    const advertised = d.remoteCatalog?.modelOn(remote.linkId, remote.modelKey)
    return {
      ok: true,
      upstream: {
        modelField: remote.modelKey,
        modelName: advertised?.name ?? remote.modelKey,
        ctxMax: advertised?.nativeCtx ?? DEFAULT_CTX,
        remote,
        target: '',
      },
    }
  }

  // ── Local, byte-for-byte the checks the two chat routes made inline before ──────────────
  const ms = d.manager.status()
  if (ms.state !== 'running' || !ms.model) {
    return { ok: false, status: 409, code: 'model_not_loaded', message: 'Load a model first.' }
  }
  const target = d.manager.target()
  if (!target) {
    return { ok: false, status: 409, code: 'model_not_loaded', message: 'Engine not running.' }
  }
  return {
    ok: true,
    upstream: {
      modelField: engineModelAlias(d.registry.active()?.kind ?? '', d.manager.currentOpts()?.modelPath) ?? ms.model.key,
      modelName: ms.model.name,
      ctxMax: ms.model.ctx ?? DEFAULT_CTX,
      target,
    },
  }
}

/** The ONE outbound chat-completions call, local engine or linked host.
 *
 *  The remote arm is `proxyStream` + `linkHeaders` — not a bare fetch — so a chat turn
 *  inherits, unchanged and untested-twice, the properties the gateway path already has:
 *  the body stays a stream (token-by-token SSE, not one blob at the end), the caller's own
 *  credential never travels, the link token is added in exactly one place, and an abort
 *  reaches the host instead of leaving it generating into a dead socket.
 *
 *  `fetchImpl` exists for tests; production passes nothing.
 *
 *  `d` (optional — every existing caller keeps working unchanged if omitted) enables the
 *  developer request log (issue #211 follow-up), captured HERE rather than at each of this
 *  function's callers (chat-routes.ts's main turn loop, its regenerate branch, and its title
 *  generator, plus memory.ts's auto-memory distillation) — this docstring's own claim, "the
 *  ONE outbound call", is exactly why one capture point here covers all of them instead of
 *  four separate ones that could drift. Every one of those is tagged `source: 'chat'` alike;
 *  they aren't distinguished further (title-gen and memory calls are real engine work too, and
 *  a developer debugging "why is my engine busy" benefits from seeing them, not having them
 *  silently filtered out). */
export function callChatUpstream(
  upstream: ChatUpstream,
  body: unknown,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  d?: Deps,
): Promise<Response> {
  const payload = JSON.stringify(body)
  const call = upstream.remote
    ? (() => {
        const headers = linkHeaders(upstream.remote!)
        headers.set('content-type', 'application/json')
        return proxyStream(
          upstream.remote!,
          '/v1/chat/completions',
          { method: 'POST', headers, body: payload },
          signal,
          fetchImpl,
        )
      })
    : () => fetchImpl(`${upstream.target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal,
        // Required by undici whenever a body is present on some Node versions; harmless for a
        // string body and preserved from the call sites this replaced.
        duplex: 'half',
      } as RequestInit)

  // Same double-count avoidance every federated ledger in this codebase follows (gateway.ts's
  // `localAccounting`): a Turbo Link turn is already captured once, on the HOST's own gateway
  // behind its façade — logging it again here, on the PEER that only forwarded it, would show
  // every federated chat turn twice.
  if (!d?.requestLog || upstream.remote) return call()
  const rlCfg = requestLogConfig(d)
  if (!rlCfg.enabled) return call()

  const reqBody = body as Record<string, unknown>
  const captureBody = !!rlCfg.captureBodies
  const logId = d.requestLog.start({
    source: 'chat',
    harness: null,
    codeSessionId: null,
    modelKey: upstream.modelField || null,
    remote: null,
    stream: reqBody?.stream === true,
    params: extractParams(reqBody),
    counts: summarizeRequest(reqBody),
    ...(captureBody ? { requestBody: payload } : {}),
  })
  const startedAt = Date.now()

  return call().then(
    (res) => {
      if (!res.ok || !res.body) {
        d.requestLog!.finalize(logId, { status: res.status, error: { code: 'engine_error', message: `Engine returned HTTP ${res.status}.` }, durationMs: Date.now() - startedAt })
        return res
      }
      const [a, b] = res.body.tee()
      const drain = reqBody?.stream === true
        ? drainOpenAiSseForLog(b, { captureBody, startedAt }).then((r) => {
            d.requestLog!.finalize(logId, {
              status: res.status, promptTokens: r.promptTokens, completionTokens: r.completionTokens,
              promptTps: r.promptTps, genTps: r.genTps, ttftMs: r.ttftMs, finishReason: r.finishReason,
              durationMs: Date.now() - startedAt,
              responseBody: captureBody ? JSON.stringify({ content: r.responseText }) : undefined,
            })
          })
        : new Response(b).text().then((text) => {
            let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
            let finishReason: string | null = null
            try {
              const oai = JSON.parse(text) as { usage?: typeof usage; choices?: Array<{ finish_reason?: string }> }
              usage = oai.usage
              finishReason = oai.choices?.[0]?.finish_reason ?? null
            } catch { /* not JSON — log status/timing only */ }
            d.requestLog!.finalize(logId, {
              status: res.status, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens,
              finishReason, durationMs: Date.now() - startedAt,
              responseBody: captureBody ? text : undefined,
            })
          })
      drain.catch(() => {
        d.requestLog!.finalize(logId, { status: res.status, error: { code: 'drain_error', message: 'Failed to read the response for the request log.' }, durationMs: Date.now() - startedAt })
      })
      return new Response(a, { status: res.status, headers: res.headers })
    },
    (e) => {
      d.requestLog!.finalize(logId, { status: null, error: { code: 'engine_unreachable', message: (e as Error)?.message || 'Engine unreachable.' }, durationMs: Date.now() - startedAt })
      throw e
    },
  )
}
