// Where a Code turn is actually generated — the local engine, or a linked host (ADR-376).
//
// Code shipped with exactly one answer: `d.manager.target()`, the llama-server process on
// THIS machine, hard-wired into five pi provider registrations. So a Turbo Link install
// could chat with a linked machine's model but could not code with it, and the Code
// screen's picker didn't even list the remote rows — the one place a borrowed GPU is worth
// the most (a long agentic run) was the one place it wasn't offered.
//
// Nothing here is a second implementation of "is this id remote?". The decision is
// `resolveChatUpstream` — which is itself `ModelRouter.resolveRemoteTarget`, the same
// resolution the gateway routes on — so a LOCAL model key that happens to contain a slash
// (`unsloth/Qwen3-GGUF`) keeps resolving locally here for free, and a link that goes
// offline produces the same named, actionable message chat already gives. Three findings in
// Turbo Link came from two implementations of one idea drifting apart; this is deliberately
// a thin adapter over the existing one.
//
// What it adds is the pi-specific half: pi talks to a provider, not to a URL, so both the
// URL and the auth differ by destination. The local engine takes the static `agent-key`
// bearer it has always taken; a linked host is addressed at its Turbo Link FAÇADE
// (`buildUpstream`, the same helper `proxyStream` uses) and authenticates the SAME way every
// other link request does — `X-TurboLLM-Auth`, via pi's `headers` passthrough — and
// deliberately NOT as a bearer token, which is the host's own API-key credential and means
// something different there.
//
// The first shipped version of this got both of those wrong in one line: `<base>/v1` (the
// host's PUBLIC gateway mount, where a granted token is refused) with the token as `apiKey`
// (which the openai SDK sends as a bearer regardless of `authHeader`). It was never run
// against a live peer, so it was reported from the field as "chat over the link works, Code
// doesn't". code-over-link.test.ts now drives the real façade end to end.
import { resolveChatUpstream } from '../chat/chat-upstream'
import { buildUpstream, LINK_AUTH_HEADER, type RemoteTarget } from '../link/link-proxy'
import type { Deps } from '../deps'

/** The parts of a pi `registerProvider` config that differ by destination. Spread into each
 *  registration site so the five of them cannot drift apart. */
export interface CodePiProvider {
  baseUrl: string
  apiKey: string
  authHeader: boolean
  headers?: Record<string, string>
}

export interface CodeUpstream {
  /** The `model` id to declare to pi. Local: the engine's alias (vLLM exposes one) or the
   *  loaded key. Remote: the host's UNQUALIFIED key — a `<machine>/` prefix names no machine
   *  over there and would silently fall back to whatever the host has loaded. */
  modelId: string
  /** Display name, for pi's model metadata and the turn's own stats label. */
  modelName: string
  contextWindow: number
  /** Set only for a linked host. Its presence is the "this machine did not run the tokens"
   *  test — the local engine gate and the llama.cpp `/slots` prefill poller both branch on
   *  it, because neither has anything to do with a run happening on another box. */
  remote?: RemoteTarget
  /** Local engine base URL, `''` when remote. Nothing may build a URL from it unchecked. */
  target: string
  provider: CodePiProvider
}

/** Same fallback the Code path has always used when a loaded model reports no context. */
const FALLBACK_CTX = 8192

/** What `apiKey` is set to for a linked host, and why it is NOT the link token.
 *
 *  pi hands `apiKey` straight to the `openai` SDK client, which puts it on the wire as
 *  `Authorization: Bearer <apiKey>` on EVERY request — unconditionally, and independently of
 *  pi's own `authHeader` flag (which only controls whether pi adds a second one itself). So
 *  "authHeader: false" never prevented the bearer; it only prevented the duplicate. Putting
 *  the link token there would ship the peer's secret for the host in a header the host reads
 *  as its own API-key credential — the exact confusion this module's header comment forbids.
 *
 *  It cannot simply be empty either: pi throws `No API key for provider` for an empty
 *  `apiKey` unless an `authorization` header is present. So it is a fixed, non-secret
 *  placeholder — the façade authenticates from `X-TurboLLM-Auth` and never looks at this. */
const LINK_PLACEHOLDER_KEY = 'turbo-link'

/**
 * Resolve where THIS Code turn generates, or throw.
 *
 * `requestedModel` is the id the picker sent. Empty/absent — every pre-Turbo-Link client,
 * and every ordinary local session — takes the unchanged local path, including its two
 * `model_not_loaded` guards.
 *
 * Throws `Error('model_not_loaded')` for the local case (the string the Code routes and
 * run manager already branch on), and for a remote one the router's own sentence, which
 * names the machine and the fix ("'rig' is not connected (unreachable). Reconnect it in
 * Settings → Turbo Link."). A remote failure NEVER degrades to a local model: silently
 * running an agentic turn — one that edits files and runs commands — on a different model
 * than the user picked is worse than refusing.
 */
export function resolveCodeUpstream(d: Deps, requestedModel?: string): CodeUpstream {
  const res = resolveChatUpstream(d, requestedModel)
  if (!res.ok) throw new Error(res.code === 'model_not_loaded' ? 'model_not_loaded' : res.message)
  const u = res.upstream
  const contextWindow = u.ctxMax > 0 ? u.ctxMax : FALLBACK_CTX
  if (u.remote) {
    return {
      modelId: u.modelField,
      modelName: u.modelName || 'Remote Model',
      contextWindow,
      remote: u.remote,
      target: '',
      provider: {
        // THE FAÇADE, not the host's public `/v1` mount. pi's openai client appends
        // `/chat/completions` to this, so `<base>/v1` addressed `<host>/v1/chat/completions`
        // — the public gateway — where a link token is refused outright: it carries a
        // `grant`, `isFacadeOnlyKey` makes `verifyKeyValue` treat it as no match at all, and
        // lanAuth 401s in the LAN-open/key-required configuration every Turbo Link host runs
        // in (pinned by link-auth.test.ts, "a GRANTED link token is refused by lanAuth on the
        // public /v1/* gateway"). That is precisely why chat over a link worked while Code
        // did not: chat's transport is `proxyStream`, which derives the URL from
        // `buildUpstream`; Code was the one caller that spelled a link URL by hand.
        //
        // Built with `buildUpstream` rather than a second literal so there stays exactly ONE
        // place that knows how a link URL is spelled — which also normalises the trailing
        // slash a tunnel URL pasted from a browser address bar routinely carries (`https://h/`
        // → `https://h//v1/...`, a 404 on some proxies).
        //
        // Reaching the façade is not merely cosmetic: the public mount would bypass
        // `requireCapability('models:use')`, the model allowlist, the wake gate and the
        // link-chaining refusal — so on a host running LAN-open WITHOUT a required key, the
        // old URL would have silently *worked* while ignoring the entire capability grant.
        baseUrl: buildUpstream(u.remote, '/v1'),
        apiKey: LINK_PLACEHOLDER_KEY,
        // The link token travels as X-TurboLLM-Auth (linkHeaders, link-proxy.ts) and NOT as
        // a bearer: `Authorization` on the host is its own API-key credential, a different
        // secret with different scope, and presenting a link token there would either be
        // rejected or — worse — accepted as something it is not. `authHeader: false` stops
        // pi adding one; `LINK_PLACEHOLDER_KEY` stops the openai SDK adding one from apiKey.
        authHeader: false,
        headers: { [LINK_AUTH_HEADER]: u.remote.token },
      },
    }
  }
  return {
    modelId: u.modelField,
    modelName: u.modelName || 'Local Model',
    contextWindow,
    target: u.target,
    provider: { baseUrl: `${u.target}/v1`, apiKey: 'agent-key', authHeader: true },
  }
}
