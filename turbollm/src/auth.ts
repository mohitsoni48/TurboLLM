// LAN auth enforcement (spec 06 §5). The daemon binds loopback-only by default
// (daemon.lanBind=false), so local dev and the embedded web UI need no key. Once
// the user flips the LAN-expose toggle (lanBind=true → bind 0.0.0.0), the listener
// is reachable from other machines and EVERY non-loopback request to the API /
// gateway surface must carry a valid API key. Loopback is always exempt so the
// local browser UI and `turbollm launch claude` keep working with no key.
//
// A Cloud Launch tunnel (ADR-045/152) breaks the loopback-as-trust assumption BY
// ADDRESS ALONE: cloudflared's local leg connects to 127.0.0.1 too, so a request
// that arrived over the public tunnel URL LOOKS identical to a trusted local caller
// by address. The fix is NOT "distrust all loopback whenever a tunnel is merely
// active" — that would also break the daemon's own local CLI tooling (`--stop`,
// `launch claude`), which has no way to hold a usable key (only hashes are ever
// stored). Verified empirically against a live cloudflared quick tunnel: Cloudflare's
// edge injects `cf-ray`/`cf-connecting-ip` on every request it proxies, and a direct
// local request carries neither — a remote caller can't spoof these away (Cloudflare's
// edge controls them, not the client), so `isTunneled` below is a precise per-REQUEST
// signal, not a whole-daemon flag.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'
import type { ApiKey } from './config/config'
import type { Deps } from './deps'

/** Loopback addresses that never require a key, in the forms Node surfaces them
 *  (IPv4, IPv6, and the IPv4-mapped-IPv6 form Windows/dual-stack sockets report). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** SHA-256 hex of the presented key — the SAME derivation used when keys are
 *  created (generateApiKey below). Stored config holds only this hash. Exported so the
 *  external API's auth path (ext/auth.ts) hashes a presented key with the IDENTICAL
 *  derivation used here, rather than risking the two ever drifting apart. */
export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Generate a new API key: a `tllm-`-prefixed 40-char random token, its SHA-256 hash
 *  (the only form persisted), and a display prefix. Shared by the `/api/v1/keys`
 *  create endpoint and the tunnel auto-provisioning below. */
export function generateApiKey(): { full: string; hash: string; prefix: string } {
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const buf = randomBytes(60)
  let key = ''
  for (let i = 0; i < 40; i++) key += charset[buf[i] % 62]
  const full = `tllm-${key}`
  const hash = createHash('sha256').update(full).digest('hex')
  return { full, hash, prefix: full.slice(0, 12) }
}

/** Provision a fresh, dedicated API key for a Cloud Launch tunnel session and return
 *  its full (unhashed) value — the only moment it's ever available, since the store
 *  keeps only the hash (same rule as every other key, spec 06 §5). Always generates a
 *  new one rather than reusing an existing key: an existing key's raw value can never
 *  be recovered to print it, and a fresh, clearly-named key is easy to find and revoke
 *  later from Developer → API Keys. */
export function provisionTunnelApiKey(d: Deps): string {
  const { full, hash, prefix } = generateApiKey()
  const key: ApiKey = {
    id: randomUUID(),
    name: `tunnel-${new Date().toISOString()}`,
    hash,
    prefix,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  d.store.update((cfg) => cfg.apiKeys.push(key))
  return full
}

/** Pull the presented key from any of the accepted headers (spec 06 §5):
 *  the web-UI header, the Anthropic `x-api-key`, or `Authorization: Bearer`. Exported so
 *  gateway.ts can resolve a terminal-agent session's own token (session-auth.ts) from the
 *  SAME header set an Anthropic/OpenAI-protocol client actually sends it in, rather than a
 *  second, driftable parse. */
export function presentedKey(c: Context): string {
  const direct = c.req.header('X-TurboLLM-Auth') ?? c.req.header('x-api-key')
  if (direct && direct.trim()) return direct.trim()
  const authz = c.req.header('Authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(authz.trim())
  return m ? m[1].trim() : ''
}

/** True for requests we cannot tie to a credential surface and so let through
 *  even when enforcing: the SPA shell + its static assets (any path NOT under
 *  /api/ or /v1/) and the always-open health probe. A user must be able to load
 *  the page on the LAN to paste a key (spec 06 §5: `/healthz` always open). */
/** The Turbo Link façade's path prefix. Duplicated as a literal here rather than imported
 *  from link/ because link/link-auth.ts imports THIS module — the import would be a cycle.
 *  Pinned by link-auth.test.ts, which composes both middlewares in server.ts's real order. */
const LINK_API_PREFIX = '/api/link/v1/'

/** Does this request belong to the Turbo Link façade, which carries its OWN gate?
 *
 *  lanAuth runs over `*`, so it sits in front of the façade as well as everything else.
 *  That matters because a granted (link) token is deliberately refused by verifyKeyValue —
 *  so if lanAuth judged this prefix, every real peer would be 401'd before linkAuth ever
 *  ran, in exactly the configuration every Turbo Link host runs in (LAN open, key
 *  required). lanAuth therefore DELEGATES here instead of deciding.
 *
 *  Delegating is strictly stronger, never weaker: linkAuth (link/link-auth.ts) exempts
 *  NOTHING — not loopback, not "auth disabled", not a full-access key — and 401s anything
 *  it cannot resolve to a stored key, which is more than lanAuth would ever demand of this
 *  prefix. `registerLinkAuth` mounts it on precisely this path, immediately after lanAuth
 *  in createApp; a path under this prefix that the façade does not serve simply 404s. */
function isLinkFacade(c: Context): boolean {
  return c.req.path.startsWith(LINK_API_PREFIX)
}

function isExempt(c: Context): boolean {
  if (c.req.path === '/healthz') return true
  if (c.req.method !== 'GET') return false
  const p = c.req.path
  return !p.startsWith('/api/') && !p.startsWith('/v1/')
}

/** Best-effort: is the request from loopback? Returns `null` when the address
 *  cannot be determined (caller decides how to treat unknown — safer = remote
 *  when the listener is LAN-exposed). */
function isLoopback(c: Context): boolean | null {
  let addr: string | undefined
  try {
    addr = getConnInfo(c).remote.address
  } catch {
    addr = undefined
  }
  if (!addr) return null
  return LOOPBACK.has(addr)
}

/** True when THIS request actually traversed the Cloud Launch tunnel, as opposed to
 *  "a tunnel merely happens to be active elsewhere". Cloudflare's edge injects
 *  `cf-ray`/`cf-connecting-ip` on every request it proxies (verified empirically
 *  against a live quick tunnel) — a direct local request carries neither. A local
 *  caller forging these headers on their own request only makes THAT request MORE
 *  restricted (still needs a key), never less — it can't be used to impersonate a
 *  local caller from the remote side, since Cloudflare's edge (not the client)
 *  controls what a genuinely tunneled request carries. */
function isTunneled(c: Context, d: Deps): boolean {
  if (!d.tunnel?.active()) return false
  return !!(c.req.header('cf-ray') || c.req.header('cf-connecting-ip'))
}

/** True when a request is local to the daemon host: either the daemon is loopback-only
 *  bound (no LAN listener at all) or the request came from a loopback address. Use to
 *  gate **local-admin actions that execute a caller-supplied binary** (add/scan engine,
 *  build-from-source, CUDA download) so a LAN client can't trigger arbitrary execution
 *  even with a valid API key. Fails closed: an undetermined address while LAN-exposed
 *  is treated as remote. Also fails closed for any request that actually traversed a
 *  Cloud Launch tunnel (ADR-152, see isTunneled) — genuinely local access (the box's
 *  own terminal, `--stop`, `launch claude`) is unaffected. */
export function isLocalRequest(c: Context, d: Deps): boolean {
  if (isTunneled(c, d)) return false
  if (!d.store.snapshot().daemon.lanBind) return true // loopback-only bind → always local
  return isLoopback(c) === true
}

/** The gate every CREDENTIAL-MANAGEMENT route must carry: host-only while the LAN is open
 *  and unauthenticated (lanBind on, requireApiKey off), unrestricted once a key is required.
 *
 *  lanAuth's `bypassesAuth` deliberately lets that lanBind-on/requireApiKey-off combination
 *  through with NO credential at all (spec 06 §5's "opted into open LAN access"), which is
 *  fine for chat/models but would let any device that can merely load the page mint itself a
 *  durable key — a real self-escalation, since that key keeps working even after
 *  requireApiKey is later turned on. Once requireApiKey IS on, a non-host caller only reaches
 *  the handler at all by having already presented a valid key (lanAuth ran first), so
 *  self-service key management from another device is fine then.
 *
 *  Lives here rather than inside `registerApi` so `/api/v1/keys`, `/api/v1/connect/:cli` and
 *  Turbo Link's `/api/v1/links*` (ADR-376) share ONE predicate — the v1.9.0 pre-release
 *  review found this gate missing on `DELETE /api/v1/keys/:id`, and the phase-1 Turbo Link
 *  review found it missing again on `POST /api/v1/links/mint`, both because it was a private
 *  local function nothing new could reuse. */
export function hostGate(c: Context, d: Deps): boolean {
  return isLocalRequest(c, d) || d.store.snapshot().daemon.requireApiKey === true
}

/** Same decision as {@link isLocalRequest}, for the one surface that has no Hono `Context`:
 *  the raw `http.Server` 'upgrade' event a WebSocket handshake arrives on (registerTerminalWs).
 *  Takes the remote address and headers directly instead of pulling them off a Context. */
export function isLocalUpgrade(remoteAddress: string | undefined, headers: NodeJS.Dict<string | string[]>, d: Deps): boolean {
  const tunneled = !!d.tunnel?.active() && !!(headers['cf-ray'] || headers['cf-connecting-ip'])
  if (tunneled) return false
  if (!d.store.snapshot().daemon.lanBind) return true // loopback-only bind → always local
  return !!remoteAddress && LOOPBACK.has(remoteAddress)
}

/** Pure decision logic behind lanAuth, extracted so it's directly unit-testable —
 *  a real "this connection really is loopback" signal needs a live TCP socket,
 *  which isn't cheap to fake in a test, so the boolean combination itself is
 *  isolated here instead. True means "let the request through with no key check".
 *  `tunneled` is a per-REQUEST signal (see isTunneled) — when true, it forces
 *  enforcement UNCONDITIONALLY (ignores requireApiKey, and does NOT treat loopback
 *  as proof of a local caller), since a tunneled request looks loopback too (ADR-152). */
export function bypassesAuth(opts: {
  lanBind: boolean
  requireApiKey: boolean
  tunneled: boolean
  loopback: boolean | null
  exempt: boolean
}): boolean {
  const { lanBind, requireApiKey, tunneled, loopback, exempt } = opts
  if (!lanBind && !tunneled) return true // loopback-only, not a tunneled request: no enforcement
  if (!tunneled && !requireApiKey) return true // user opted into open (unauthenticated) LAN access
  if (loopback === true && !tunneled) return true // local clients never need a key
  if (exempt) return true // SPA/static assets + /healthz so a user can paste a key
  return false
}

/** Like {@link isLocalRequest}, but ALSO permits a remote client when the daemon requires
 *  an API key — `lanAuth` has already verified that key before the handler runs, so the
 *  caller is authenticated. Use for agent actions (which execute on the host) so a user can
 *  drive their own box from another device, while an OPEN (keyless) LAN still can't trigger
 *  remote code execution. Fails closed when the address is undetermined, and — like
 *  {@link isLocalRequest} — never treats a genuinely tunneled request (see isTunneled) as
 *  local by address alone: a Cloud Launch tunnel's local leg looks loopback too (ADR-152),
 *  so a tunneled caller must always go through the requireApiKey check below, never the
 *  bare loopback shortcut. */
export function isLocalOrAuthenticated(c: Context, d: Deps): boolean {
  const daemon = d.store.snapshot().daemon
  const tunneled = isTunneled(c, d)
  if (!daemon.lanBind && !tunneled) return true // loopback-only bind, not tunneled → always local
  if (isLoopback(c) === true && !tunneled) return true // local client
  return daemon.requireApiKey === true    // remote (or tunneled) allowed only behind required (verified) API key
}

/** Resolve the presented raw key to its stored ApiKey record, bumping lastUsedAt
 *  best-effort on a match. `verifyKeyValue` answers "is this key valid?"; this answers
 *  "WHICH key is this?", which Turbo Link needs because the capability grant lives on
 *  the record. Same hash comparison, same best-effort usage bump — deliberately not a
 *  second credential path. */
export function resolveKey(c: Context, d: Deps): ApiKey | undefined {
  const raw = presentedKey(c)
  if (!raw) return undefined
  const hash = hashKey(raw)
  const match = d.store.snapshot().apiKeys.find((k) => k.hash === hash)
  if (!match) return undefined
  try {
    d.store.update((mut) => {
      const k = mut.apiKeys.find((x) => x.id === match.id)
      if (k) k.lastUsedAt = new Date().toISOString()
    })
  } catch {
    /* swallow — usage tracking is best-effort */
  }
  return match
}

/** Is this stored key a Turbo Link FAÇADE-ONLY credential — usable only on `/api/link/v1`
 *  (resolveKey/linkAuth), and refused by every other credential path?
 *
 *  The rule itself (ADR-376 review): a key carrying a `grant` was minted FOR a peer, scoped to
 *  a capability set that only the façade knows how to honour. Every other auth surface compares
 *  the hash and nothing else, so without a refusal a token minted as "Inference only" could
 *  simply be pointed at the PUBLIC /v1/chat/completions instead of the façade, reach the
 *  ordinary auto-swap path, and load and evict models on the host at will — reducing
 *  models:wake / models:load to advice.
 *
 *  Deliberately keyed on the PRESENCE of a grant, never on its contents: "this credential was
 *  scoped for a peer" is the invariant, and a future capability must not be able to widen it by
 *  accident. An ungranted legacy key — which is every key minted before Turbo Link — is
 *  untouched and keeps working everywhere exactly as before.
 *
 *  Exported as ONE predicate rather than re-remembered per surface: the pre-merge review of
 *  PR #185 (finding I1) found the External Chat API's own credential path
 *  (`ext/auth.ts`'s resolveTenantFromKey) comparing hashes with no idea this rule existed,
 *  because it landed on main independently. Any NEW code that resolves a presented key to a
 *  stored record must call this — do not re-derive `!!key.grant` in a third place. */
export function isFacadeOnlyKey(key: Pick<ApiKey, 'grant'>): boolean {
  return !!key.grant
}

/** Checks a raw candidate key against stored API keys; bumps lastUsedAt best-effort on a
 *  match. The credential-check core shared by every auth surface — HTTP (verifyPresentedKey,
 *  which sources the raw value from headers) and the WebSocket upgrade handler (which sources
 *  it from a query param, since browsers can't set custom headers on a WebSocket handshake).
 *
 *  A key carrying a Turbo Link `grant` is refused here as though it did not match at all
 *  ({@link isFacadeOnlyKey}, ADR-376 review). Every surface downstream of THIS function —
 *  lanAuth over /v1/*, codeAuth over Code's real shell and filesystem access, the terminal
 *  WebSocket's pty upgrade — compares the hash and NOTHING else, so this is the choke point
 *  for all of them.
 *
 *  It is NOT the only one in the process, and the earlier version of this comment claiming
 *  "the single choke point" was wrong: the External Chat API (`ext/auth.ts`) landed on main
 *  with its own hash comparison and never routes through here. It calls
 *  {@link isFacadeOnlyKey} directly instead. Two enforcement points, ONE predicate — if you
 *  add a third credential path, call the predicate rather than re-deriving the rule. */
export function verifyKeyValue(key: string, d: Deps): boolean {
  if (!key) return false
  const hash = hashKey(key)
  const cfg = d.store.snapshot()
  const match = cfg.apiKeys.find((k) => k.hash === hash)
  if (!match) return false
  // Before the lastUsedAt bump on purpose: a refused credential must leave no trace of a
  // successful use, and must be indistinguishable from a wrong key.
  if (isFacadeOnlyKey(match)) return false
  // Best-effort lastUsedAt bump (spec 06 §5). Never block the request on it.
  try {
    d.store.update((mut) => {
      const k = mut.apiKeys.find((x) => x.id === match.id)
      if (k) k.lastUsedAt = new Date().toISOString()
    })
  } catch {
    /* swallow — usage tracking is best-effort */
  }
  return true
}

/** Checks the presented key (any of the accepted headers, see presentedKey) against stored API
 *  keys. Shared by lanAuth and codeAuth below so both enforce the identical credential check —
 *  only WHEN each one is triggered differs. */
export function verifyPresentedKey(c: Context, d: Deps): boolean {
  return verifyKeyValue(presentedKey(c), d)
}

/** LAN auth middleware (spec 06 §5). Register AFTER cors + the Server header and
 *  BEFORE the API/chat/gateway routes. Enforcement only kicks in when the daemon
 *  is LAN-exposed (lanBind=true); with the default loopback-only bind it is a pure
 *  pass-through, so local dev and the UI can never be locked out. */
export function lanAuth(d: Deps): MiddlewareHandler {
  return async (c, next) => {
    // Hand the façade to its own gate before any of the LAN reasoning below — see
    // isLinkFacade. Not folded into `isExempt`, whose meaning is "no credential surface
    // applies"; the opposite is true here, a STRICTER one does.
    if (isLinkFacade(c)) return next()

    const daemon = d.store.snapshot().daemon
    const allow = bypassesAuth({
      lanBind: daemon.lanBind,
      requireApiKey: daemon.requireApiKey,
      tunneled: isTunneled(c, d),
      loopback: isLoopback(c),
      exempt: isExempt(c),
    })
    if (allow) return next()
    if (verifyPresentedKey(c, d)) return next()

    return c.json(
      { error: { code: 'unauthorized', message: 'A valid API key is required for non-local access.' } },
      401,
    )
  }
}

/** Code-specific gate, INDEPENDENT of the global requireApiKey toggle above. Chat (and most of
 *  the app) can stay open on the LAN with no key — today's default, and lanAuth's job. Code is
 *  different: it executes real bash/edit/write against the user's own filesystem, so a
 *  non-host device must always present a valid API key to reach it, even when requireApiKey is
 *  off for everything else. A no-op for anything local to the host (isLocalRequest already
 *  covers the loopback-only-bind case AND correctly treats a genuinely tunneled request as
 *  non-local, ADR-152) — register this scoped to /api/v1/code/* only, AFTER lanAuth. */
export function codeAuth(d: Deps): MiddlewareHandler {
  return async (c, next) => {
    if (isLocalRequest(c, d)) return next()
    if (verifyPresentedKey(c, d)) return next()

    return c.json(
      { error: { code: 'unauthorized', message: 'A valid API key is required to access Code from a non-host device.' } },
      401,
    )
  }
}
