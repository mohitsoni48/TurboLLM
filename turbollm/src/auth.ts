// LAN auth enforcement (spec 06 §5). The daemon binds loopback-only by default
// (daemon.lanBind=false), so local dev and the embedded web UI need no key. Once
// the user flips the LAN-expose toggle (lanBind=true → bind 0.0.0.0), the listener
// is reachable from other machines and EVERY non-loopback request to the API /
// gateway surface must carry a valid API key. Loopback is always exempt so the
// local browser UI and `turbollm launch claude` keep working with no key.
//
// Remote access (ADR-422, formerly the Cloud Launch tunnel of ADR-045/152) breaks the
// loopback-as-trust assumption BY ADDRESS ALONE: every provider's local leg connects to
// 127.0.0.1 too, so a request that arrived over the public URL LOOKS identical to a
// trusted local caller by address. The fix is NOT "distrust all loopback whenever remote
// access is merely active" — that would also break the daemon's own local CLI tooling
// (`--stop`, `launch claude`), which has no way to hold a usable key (only hashes are ever
// stored). `isTunneled` below instead keys off which LOCAL TCP port the connection arrived
// on: the ingress listener binds a dedicated loopback port that only a provider's local leg
// ever connects to, and a client cannot choose which of the daemon's sockets it lands on —
// unlike a header, which only worked for Cloudflare because its edge (not the client)
// controlled it.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'
import type { ApiKey } from './config/config'
import type { Deps } from './deps'
import { hasCapability } from './link/capabilities'
import type { LinkCapability, LinkGrant } from './link/types'
import { fetchJwks, verifyAccessJwt } from './remote/access-jwt'
import { tailscaleIdentity } from './remote/identity'

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

/** Provision a fresh, dedicated API key and return its full (unhashed) value — the
 *  only moment it's ever available, since the store keeps only the hash (same rule as
 *  every other key, spec 06 §5). Always generates a new one rather than reusing an
 *  existing key: an existing key's raw value can never be recovered to print it, and a
 *  fresh, clearly-named key is easy to find and revoke later from Developer → API Keys.
 *  `label` names the reason it was minted (shown as `<label>-<ISO timestamp>` in
 *  Developer → API Keys) — defaults to the original Cloud Launch tunnel caller's own
 *  naming; `--print-token` (cli.ts) passes `'print-token'` so the two are distinguishable
 *  in the key list. */
export function provisionTunnelApiKey(d: Deps, label = 'tunnel'): string {
  const { full, hash, prefix } = generateApiKey()
  const key: ApiKey = {
    id: randomUUID(),
    name: `${label}-${new Date().toISOString()}`,
    hash,
    prefix,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  d.store.update((cfg) => cfg.apiKeys.push(key))
  return full
}

/** Mint the capability-scoped credential a remote-access URL is shared with (ADR-422).
 *
 *  Always a fresh key rather than reusing one: a stored key's raw value can never be
 *  recovered to show it again (only the hash is kept), and a clearly-named one is easy to
 *  find and revoke later in Developer → API Keys. Returns the raw value, which is the only
 *  moment it exists in readable form. */
export function provisionRemoteApiKey(d: Deps, grant: LinkGrant): string {
  const { full, hash, prefix } = generateApiKey()
  const key: ApiKey = {
    id: randomUUID(),
    name: `remote-${new Date().toISOString()}`,
    hash,
    prefix,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    grant: { ...grant, kind: 'remote' },
  }
  d.store.update((cfg) => cfg.apiKeys.push(key))
  return full
}

/** Revoke every remote-access token. Called when remote access is turned off: a credential
 *  that outlives the URL it was minted for is a credential nobody is thinking about any
 *  more. Scoped by grant KIND, so a Turbo Link peer's token and an ordinary user key are
 *  both untouched. Returns how many were removed. */
export function revokeRemoteKeys(d: Deps): number {
  let removed = 0
  d.store.update((cfg) => {
    const before = cfg.apiKeys.length
    cfg.apiKeys = cfg.apiKeys.filter((k) => grantKind(k) !== 'remote')
    removed = before - cfg.apiKeys.length
  })
  return removed
}

/** Is the address the listener was bound to a loopback-only bind — i.e. unreachable from
 *  any other machine, so nothing outside this host can ever hit the API? Distinct from
 *  {@link LOOPBACK}, which classifies a REQUEST's remote address; this classifies the
 *  daemon's own listen host, which is spelled differently (`localhost`, any `127.x.x.x`,
 *  bracketed IPv6 as `--addr` accepts it). Anything unrecognised — `0.0.0.0`, `::`, a
 *  specific LAN address, a hostname — counts as non-loopback, which is the safe direction:
 *  it only ever leads to provisioning a credential, never to skipping enforcement. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** Mint the ONE bootstrap API key a headless install needs, or return null if it isn't
 *  needed. Call once at startup, with the address actually bound.
 *
 *  The problem this solves: `requireApiKey` defaults to true (config.ts), which is
 *  invisible on a desktop install because `bypassesAuth` short-circuits to "no
 *  enforcement" on a loopback-only bind. A container is the opposite case — it MUST bind
 *  `0.0.0.0` for `docker run -p` to publish anything at all — so enforcement is live from
 *  the first boot, and the only route to a key (`POST /api/v1/keys`, behind
 *  {@link hostGate}) requires either being local to the host or already holding a key.
 *  Someone with `docker logs` and nothing else is locked out of their own daemon with no
 *  way in. The key is printed once by the caller, which is the only moment it exists in
 *  readable form (the store keeps only the hash, same rule as every other key).
 *
 *  Deliberately once-ever, keyed on "zero keys have EVER been minted": on any later boot a
 *  key exists, and re-minting would quietly pile up credentials nobody asked for while
 *  re-printing something the operator may already have distributed. `requireApiKey` off
 *  means nothing is enforced, so no key is needed then either. This never disables or
 *  relaxes enforcement — it only makes the credential obtainable. */
export function provisionBootstrapApiKey(d: Deps, bindHost: string): string | null {
  if (isLoopbackBindHost(bindHost)) return null
  const cfg = d.store.snapshot()
  if (cfg.daemon.requireApiKey !== true) return null
  if (cfg.apiKeys.length > 0) return null
  const { full, hash, prefix } = generateApiKey()
  const key: ApiKey = {
    id: randomUUID(),
    name: `bootstrap-${new Date().toISOString()}`,
    hash,
    prefix,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  d.store.update((mut) => mut.apiKeys.push(key))
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

/** The LOCAL port this connection arrived on, or undefined when it can't be determined.
 *
 *  Mirrors how @hono/node-server's own getConnInfo resolves its binding
 *  (`c.env.server ? c.env.server : c.env`, then `.incoming.socket`) — verified against the
 *  installed 2.1.0 dist. Unlike a header, a client cannot choose which of the daemon's
 *  sockets its connection landed on, which is the whole point (ADR-422). */
export function localPort(c: Context): number | undefined {
  try {
    const env = c.env as {
      server?: { incoming?: { socket?: { localPort?: number } } }
      incoming?: { socket?: { localPort?: number } }
    }
    const bindings = env?.server ? env.server : env
    return bindings?.incoming?.socket?.localPort
  } catch {
    return undefined
  }
}

/** True when THIS request actually arrived over remote access, as opposed to "remote access
 *  merely happens to be on". Keyed off the dedicated loopback ingress socket (ADR-422,
 *  spec 30 §2.2), which every provider's local leg connects to and nothing else does.
 *
 *  Replaces ADR-153's cf-ray/cf-connecting-ip check. That check was only ever safe because
 *  Cloudflare's edge controlled the header; Tailscale Funnel, ngrok and a user-run frp inject
 *  no equivalent, so a header-based signal would have read every one of them as a trusted
 *  loopback caller and waved them through with no key at all. The socket cannot be forged in
 *  either direction. */
function isTunneled(c: Context, d: Deps): boolean {
  const ingress = d.remote?.ingressPort()
  if (ingress === undefined) return false
  return localPort(c) === ingress
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
 *  and unauthenticated (lanBind on, requireApiKey off), otherwise open to any caller who has
 *  ALREADY presented a real, stored key for THIS request.
 *
 *  lanAuth's `bypassesAuth` deliberately lets that lanBind-on/requireApiKey-off combination
 *  through with NO credential at all (spec 06 §5's "opted into open LAN access"), which is
 *  fine for chat/models but would let any device that can merely load the page mint itself a
 *  durable key — a real self-escalation, since that key keeps working even after
 *  requireApiKey is later turned on.
 *
 *  C1 (Phase 5 final review): this used to read `daemon.requireApiKey === true` as proof the
 *  caller was authenticated, which was true only as long as the ONLY way past `lanAuth`
 *  without a key was being local. Tasks 20/21 (Tailscale/Cloudflare Access identity) added
 *  `return next()` paths in `lanAuth` that let a request through with NO key presented at
 *  all — so once `requireApiKey` was on (the shipped default), an unauthenticated tailnet
 *  member or Access user could reach `POST /api/v1/keys` and mint a permanent, unscoped,
 *  un-revocable-by-`/stop` credential.
 *
 *  N1 (Phase 5 final-review-fix re-review): the first fix here called `resolveKey` directly,
 *  which matches on hash ALONE and does not apply the grant-kind rule every other credential
 *  path applies ({@link isFacadeOnlyKey}: "any NEW code that resolves a presented key to a
 *  stored record must call this — do not re-derive `!!key.grant` in a third place"). That
 *  traded C1's hole in the default config (`requireApiKey: true`) for the SAME hole in a
 *  different one (`lanBind: true, requireApiKey: false` — the open-LAN case this gate's own
 *  first paragraph exists to protect): a `remote`-kind token, or even a Turbo Link façade-only
 *  token, resolves to a real stored key and so passed `hostGate` there, letting the exact
 *  chat-only token this feature publishes mint itself a permanent full-access credential and
 *  revoke every other key on the box. `verifyPresentedKey(c, d)` — called here with NO
 *  `ingress` flag, so it defaults to false — is the existing, already-correct answer: it
 *  refuses ANY granted key (`link` or `remote` kind) unconditionally, and accepts only a real,
 *  ungranted, stored key. That is exactly "did THIS request present an ordinary credential" —
 *  the question this gate actually needs asked — without reopening the grant-kind rule this
 *  file's own doc comments say has already caused two prior incidents (ADR-376's original
 *  finding, and this one).
 *
 *  Lives here rather than inside `registerApi` so `/api/v1/keys`, `/api/v1/connect/:cli` and
 *  Turbo Link's `/api/v1/links*` (ADR-376) share ONE predicate — the v1.9.0 pre-release
 *  review found this gate missing on `DELETE /api/v1/keys/:id`, and the phase-1 Turbo Link
 *  review found it missing again on `POST /api/v1/links/mint`, both because it was a private
 *  local function nothing new could reuse. */
export function hostGate(c: Context, d: Deps): boolean {
  return isLocalRequest(c, d) || verifyPresentedKey(c, d)
}

/** Same decision as {@link isLocalRequest}, for the one surface that has no Hono `Context`:
 *  the raw `http.Server` 'upgrade' event a WebSocket handshake arrives on
 *  (registerTerminalWs). Takes the socket's remote address and LOCAL port directly instead
 *  of pulling them off a Context — the local port is the ingress signal (ADR-422). */
export function isLocalUpgrade(
  remoteAddress: string | undefined,
  socketLocalPort: number | undefined,
  _headers: NodeJS.Dict<string | string[]>,
  d: Deps,
): boolean {
  const ingress = d.remote?.ingressPort()
  const tunneled = ingress !== undefined && socketLocalPort === ingress
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

/** Which enforcement path a stored key's grant belongs to (ADR-422).
 *
 *  A grant with no `kind` is a LINK grant: every grant minted before ADR-422 was minted for
 *  a Turbo Link peer, and reading absent as anything else would silently widen tokens
 *  already in the field. */
export function grantKind(key: Pick<ApiKey, 'grant'>): 'none' | 'link' | 'remote' {
  if (!key.grant) return 'none'
  return key.grant.kind === 'remote' ? 'remote' : 'link'
}

/** The capability a request needs, or null when this path is not something a scoped remote
 *  token may reach at all.
 *
 *  Null is DENY, never "no check required" — an unmapped path is one nobody has reasoned
 *  about for a remote caller, and defaulting those open is how ADR-376's `/v1/*` defect
 *  happened. Engine add/scan/build appear nowhere here on purpose: ADR-139 settled that no
 *  remote caller executes a caller-supplied binary, valid token or not, and isLocalRequest
 *  already refuses them independently. */
export function requiredCapability(method: string, path: string): LinkCapability | null {
  const m = method.toUpperCase()
  const read = m === 'GET' || m === 'HEAD'
  if (path.startsWith('/v1/')) return 'models:use'
  // I4 (Phase 5 final review): narrowed from a bare `startsWith('/api/v1/chat')`, which also
  // matched `/api/v1/chat-agents*` and so mapped a chat-agent-definition WRITE — capable of
  // rewriting a built-in agent's system prompt/tool allow-list, or deleting a custom one — to
  // the minimum capability the product ever mints (`models:use`, config.ts's default
  // tokenGrant). Chat-agents get their own, deliberate mapping just below instead.
  if (path === '/api/v1/chat' || path.startsWith('/api/v1/chat/')) return 'models:use'
  // A chat-agent-definition READ is as low-risk as reading the model list; a WRITE rewrites
  // what a model is told to do (system prompt, tool allow-list) or deletes a saved one — that
  // is a configuration change, not a chat action (I4).
  if (path.startsWith('/api/v1/chat-agents')) return read ? 'models:use' : 'config:write'
  // I3 (Phase 5 final review): permanent, irreversible deletion of a model's own file(s) from
  // disk (scanner.delete -> rmSync) is never authorized for a remote grant, at ANY capability
  // — unlike load/unload (`models:load`, below) or a model's saved presets (M6, unreviewed but
  // lower-stakes, deliberately left as-is). Matched narrowly — exactly one path segment after
  // `/models/`, no further subpath — so it catches only `DELETE /api/v1/models/:key`.
  if (m === 'DELETE' && /^\/api\/v1\/models\/[^/]+$/.test(path)) return null
  if (path === '/api/v1/models' || path.startsWith('/api/v1/models/')) return read ? 'models:use' : 'models:load'
  if (path.startsWith('/api/v1/downloads')) return read ? 'downloads:read' : 'downloads:write'
  if (path.startsWith('/api/v1/settings')) return read ? 'config:read' : 'config:write'
  if (path === '/api/v1/status') return 'config:read'
  // C2 (Phase 5 final review): the actual chat surface the web SPA calls — conversations
  // (send/edit/regenerate/branch/tool-approval/folder-move/save-skill/export/share/import),
  // folders, auto-memory, the tool catalog, and (read-only) hardware info. None of it touches
  // model files, daemon settings or downloads, so it is exactly what `models:use` is for.
  // Without this, a token minted from the Phase 5 UI's own picker (`models:use` at minimum)
  // could reach `/v1/*` and `/api/v1/models` and nothing else — every real chat screen 403'd,
  // including the feature's own headline "scan the QR, chat from your phone" journey.
  // Deliberately NOT `/api/v1/status` or `/api/v1/settings`, above — see their own comments:
  // status carries the engine's launchCommand (absolute binary/model paths) and raw stderr
  // (which routinely echoes paths too) — a genuine filesystem-detail boundary, not an
  // oversight this fix widens.
  if (path === '/api/v1/sysinfo') return 'models:use'
  if (path === '/api/v1/tools') return 'models:use'
  if (path === '/api/v1/memory' || path.startsWith('/api/v1/memory/')) return 'models:use'
  if (path === '/api/v1/folders' || path.startsWith('/api/v1/folders/')) return 'models:use'
  if (path === '/api/v1/conversations' || path.startsWith('/api/v1/conversations/')) return 'models:use'
  return null
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
export function verifyKeyValue(key: string, d: Deps, opts?: { ingress?: boolean }): boolean {
  if (!key) return false
  const hash = hashKey(key)
  const cfg = d.store.snapshot()
  const match = cfg.apiKeys.find((k) => k.hash === hash)
  if (!match) return false
  // Before the lastUsedAt bump on purpose: a refused credential must leave no trace of a
  // successful use, and must be indistinguishable from a wrong key.
  //
  // The ADR-422 exception, and the ONLY one: a `remote`-kind grant is honoured when the
  // request genuinely arrived on the ingress socket. A `link`-kind grant is still refused
  // absolutely — ADR-376's rule is extended here, never loosened — and every caller that
  // does not pass `ingress` (codeAuth over Code's real shell, the terminal WebSocket
  // upgrade, ext/auth.ts's own path) keeps refusing both kinds, because the default is
  // false. Capability enforcement for an accepted remote token is the CALLER's job; this
  // function answers "is this credential usable here at all".
  if (isFacadeOnlyKey(match) && !(opts?.ingress === true && grantKind(match) === 'remote')) return false
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
export function verifyPresentedKey(c: Context, d: Deps, opts?: { ingress?: boolean }): boolean {
  return verifyKeyValue(presentedKey(c), d, opts)
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

    // Tailscale Serve identity (ADR-422 §6.1): a tailnet-authenticated user needs no shared
    // secret. Gated on BOTH the ingress socket and the active provider actually being Serve —
    // Funnel sends no identity headers, so anything claiming one there is a forgery attempt.
    if (isTunneled(c, d) && d.store.snapshot().remoteAccess.provider === 'tailscale-serve' && tailscaleIdentity(c)) {
      return next()
    }

    // Cloudflare Access (ADR-422 §6.2). When requireAccess is on, a valid assertion is the
    // ONLY way through on ingress — the bearer token is replaced, not supplemented. When it
    // is off, a valid assertion is accepted in addition to a token.
    //
    // C3/I6 (Phase 5 final review): gated on `ra.provider === 'cloudflare-named'`, matching
    // Task 20's own discipline one block above (which this block originally lacked).
    // `accessTeamDomain`/`accessAud` are plain persisted strings that survive a provider
    // switch (config.ts keeps them, and the settings PATCH updates them independently of
    // `provider`), so without this check a leftover Access config from a past
    // `cloudflare-named` setup either bricks auth on every OTHER provider (`requireAccess:
    // true` — the error names a Cloudflare product the user isn't even using) or lets a
    // captured/replayed Access JWT bypass auth entirely on them (`requireAccess: false`, since
    // this block's `next()` skips the capability check too). It also made `requireAccess`
    // silently unenforced on Tailscale Serve (I6): Task 20's own provider-gated block ran
    // first and won, so an operator who believed "Access is mandatory" got an unauthenticated
    // pass-through instead.
    const ra = d.store.snapshot().remoteAccess
    if (isTunneled(c, d) && ra.provider === 'cloudflare-named' && ra.cloudflare.accessTeamDomain && ra.cloudflare.accessAud) {
      const assertion = c.req.header('Cf-Access-Jwt-Assertion') ?? ''
      let verified = false
      if (assertion) {
        const jwks = await fetchJwks(ra.cloudflare.accessTeamDomain).catch(() => null)
        if (jwks) {
          const res = await verifyAccessJwt(assertion, {
            teamDomain: ra.cloudflare.accessTeamDomain,
            aud: ra.cloudflare.accessAud,
            jwks,
          })
          verified = res.ok
        }
      }
      if (verified) return next()
      // I2 (Phase 5 final review): `requireAccess: true` must refuse whenever control reaches
      // here WITHOUT a genuinely verified assertion, for ANY reason — none presented, one that
      // failed verification, or a JWKS fetch that itself failed. The previous structure only
      // refused the "no assertion at all" case; a JUNK assertion sent during a JWKS outage hit
      // neither branch and silently fell through to the ordinary bearer check instead, so the
      // "the bearer token is replaced, not supplemented" guarantee held for an attacker who
      // sent nothing and evaporated for one who sent garbage.
      if (ra.cloudflare.requireAccess) {
        return c.json({ error: { code: 'unauthorized', message: 'Cloudflare Access sign-in is required.' } }, 401)
      }
    }

    const ingress = isTunneled(c, d)
    if (!verifyPresentedKey(c, d, { ingress })) {
      return c.json(
        { error: { code: 'unauthorized', message: 'A valid API key is required for non-local access.' } },
        401,
      )
    }
    // A scoped remote token is additionally held to its capability set. An ordinary
    // (ungranted) key skips this entirely and behaves exactly as it always has.
    const resolved = ingress ? resolveKey(c, d) : undefined
    if (resolved && grantKind(resolved) === 'remote') {
      const need = requiredCapability(c.req.method, c.req.path)
      if (!need || !hasCapability(resolved, need)) {
        return c.json(
          { error: { code: 'forbidden', message: 'This access token is not allowed to do that.', capability: need } },
          403,
        )
      }
    }
    return next()
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
