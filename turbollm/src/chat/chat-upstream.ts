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
 *  `fetchImpl` exists for tests; production passes nothing. */
export function callChatUpstream(
  upstream: ChatUpstream,
  body: unknown,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const payload = JSON.stringify(body)
  if (upstream.remote) {
    const headers = linkHeaders(upstream.remote)
    headers.set('content-type', 'application/json')
    return proxyStream(
      upstream.remote,
      '/v1/chat/completions',
      { method: 'POST', headers, body: payload },
      signal,
      fetchImpl,
    )
  }
  return fetchImpl(`${upstream.target}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal,
    // Required by undici whenever a body is present on some Node versions; harmless for a
    // string body and preserved from the call sites this replaced.
    duplex: 'half',
  } as RequestInit)
}
