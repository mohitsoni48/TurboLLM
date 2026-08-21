// Turbo Link, peer side (ADR-376 phase 2): the outbound half of a federated inference
// request. Invariants 6 and 7 live here.
//
// The gateway resolves a qualified `<machine>/<model>` id to a `remote` descriptor
// (model-router.ts) and then proxies through these three helpers instead of hitting a
// local engine. They are deliberately tiny and side-effect free so the gateway's own
// structure — gate acquisition, error classification, SSE relay — is untouched by the
// remote branch.

/** The routing descriptor `RouteResult.remote` carries. Structural, not an import, so this
 *  module has no dependency on the router (and tests can hand it a literal). */
export interface RemoteTarget {
  linkId: string
  baseUrl: string
  token: string
  modelKey: string
}

/** The host's Turbo Link façade prefix. A peer NEVER talks to the host's public `/v1/*`
 *  mount: that route is unauthenticated-by-link, ungated for wake, and would bypass the
 *  capability check the façade exists to enforce. */
const FACADE_PREFIX = '/api/link'

/** Map a local gateway path onto the host's façade URL.
 *
 *  `/v1/chat/completions` → `<base>/api/link/v1/chat/completions`. The base's trailing
 *  slash is normalised away: a tunnel URL pasted from a browser address bar routinely
 *  carries one, and `https://h//api/link/...` is a 404 on some proxies rather than a
 *  harmless duplicate. */
export function buildUpstream(remote: Pick<RemoteTarget, 'baseUrl'>, path: string): string {
  const base = remote.baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${FACADE_PREFIX}${suffix}`
}

/** Headers that may travel from the caller to the host, lower-cased.
 *
 *  This is an ALLOWLIST on purpose (invariant 7). A denylist would guarantee that the next
 *  credential header anyone adds to the local gateway — a new vendor key, a session token,
 *  a cookie — silently leaks to another machine the moment it is introduced. Nothing here
 *  can carry a secret, and nothing else travels. */
const FORWARDED = ['content-type', 'accept'] as const

/** Build the outbound header set for a link request.
 *
 *  Two distinct leaks are closed at once:
 *   - the caller's OWN credential (`X-TurboLLM-Auth`, `x-api-key`, `Authorization`) was
 *     issued for THIS machine and must never be handed to another one; and
 *   - the LINK token is the peer's secret for the host, and must never appear in anything
 *     the peer's own clients can observe. It is added here and only here. */
export function linkHeaders(remote: Pick<RemoteTarget, 'token'>, incoming?: Headers): Headers {
  const out = new Headers()
  if (incoming) {
    for (const name of FORWARDED) {
      const v = incoming.get(name)
      if (v) out.set(name, v)
    }
  }
  out.set('X-TurboLLM-Auth', remote.token)
  return out
}

/** Issue the upstream request and hand back the host's Response with its body UNTOUCHED.
 *
 *  Two properties matter and both are load-bearing:
 *
 *   1. **The body is a stream, never buffered.** Reading it here to re-wrap it would
 *      collapse the host's token-by-token SSE into one blob delivered at the end, which is
 *      exactly the live t/s and TTFT that "remote models are first-class" exists to deliver.
 *   2. **The client's abort reaches the host** (invariant 6). Without it, a peer whose
 *      client walks away leaves the host generating into a dead socket while holding its
 *      GPU — on a shared box indistinguishable from a hang. `fetch` also rejects
 *      immediately on an already-aborted signal, so a client that vanished during routing
 *      never wakes the host's engine at all.
 *
 *  `fetchImpl` exists so tests can drive this without a socket; production passes nothing. */
export async function proxyStream(
  remote: RemoteTarget,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // Checked explicitly rather than left to `fetch`: the host must not be woken — and a
  // wake-capable link must not spend the host's idle grace — for a request whose client
  // is already gone. Global `fetch` would reject here anyway; an injected one need not.
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  return fetchImpl(buildUpstream(remote, path), { ...init, signal })
}
