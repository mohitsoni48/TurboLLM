// LAN auth enforcement (spec 06 §5). The daemon binds loopback-only by default
// (daemon.lanBind=false), so local dev and the embedded web UI need no key. Once
// the listener is reachable from other machines (the LAN-expose toggle, lanBind=true
// → bind 0.0.0.0, or a non-loopback `--addr`/`daemon.host` — see isLanExposed),
// EVERY non-loopback request to the API / gateway surface must carry a valid API key
// (requireApiKey, on by default). Loopback is exempt so the local browser UI and
// `turbollm launch claude` keep working with no key, but only a loopback caller whose
// Host names this machine (DNS rebinding, see hostNamesThisMachine) and, on Android, that
// carries the app's secret (see appSecretPresented); anyone else is judged like a LAN
// peer, and on a loopback-only bind needs a key even with requireApiKey off. lanAuth
// also refuses a browser's cross-site writes to /api/* on any bind.
//
// Remote access (ADR-422, formerly the Cloud Launch tunnel of ADR-045/152) breaks the
// loopback-as-trust assumption BY ADDRESS ALONE: every provider's local leg connects to
// 127.0.0.1 too, so a request that arrived over the public URL LOOKS identical to a
// trusted local caller by address. The fix is NOT "distrust all loopback whenever remote
// access is merely active" — that would also break the daemon's own local CLI tooling
// (`--stop`, `launch claude`), which has no way to hold a usable key (only hashes are ever
// stored). `isTunneled` below instead keys off which LOCAL TCP port the connection arrived
// on: every provider's local leg targets a dedicated loopback ingress port, and a remote client
// cannot choose which of the daemon's sockets it lands on — unlike a header, which only worked
// for Cloudflare because its edge (not the client) controlled it. Arriving on the ingress only
// ever makes a request STRICTER (tunneled, never local); it says nothing about who sent it, since
// any local process or a DNS-rebinding page can connect to that 127.0.0.1 port too, so no header
// is trusted for arriving there alone (see remote/identity.ts).
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'
import { requestId as requestIdMiddleware } from 'hono/request-id'
import type { ApiKey } from './config/config'
import type { Deps } from './deps'
import { extError, requestId as makeRequestId } from './ext/errors'
import { hasCapability } from './link/capabilities'
import type { LinkCapability, LinkGrant } from './link/types'
import { fetchJwks, verifyAccessJwt } from './remote/access-jwt'
import { tailscaleIdentity } from './remote/identity'

/** Loopback addresses that never require a key, in the forms Node surfaces them
 *  (IPv4, IPv6, and the IPv4-mapped-IPv6 form Windows/dual-stack sockets report). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Is this a socket peer address on this machine's loopback, by the same rule as every gate here? */
export function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && LOOPBACK.has(addr)
}

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

/** Is the main listener reachable from other machines? True when LAN access is switched on
 *  (`daemon.lanBind`) OR when the address actually bound is not loopback: `--addr 0.0.0.0:…`
 *  and `daemon.host` bind such an address without ever setting lanBind, and keying every gate
 *  below off the flag alone left that daemon listening on all interfaces with no auth at all
 *  (while `--help` promised key enforcement). `bindHost` is recorded by cli.ts on every
 *  successful bind, so an in-place rebind keeps this current. Read this, never `lanBind`, for
 *  an auth decision. */
export function isLanExposed(d: Deps): boolean {
  if (d.store.snapshot().daemon.lanBind) return true
  return d.bindHost !== undefined && !isLoopbackBindHost(d.bindHost)
}

/** Does a request's Host header name this machine — a loopback name or the exact address the
 *  daemon is bound to? Loopback trust assumes the browser that sent a request believes it is
 *  talking to THIS machine. A DNS-rebinding page (an attacker's hostname re-resolved to
 *  127.0.0.1) arrives from a loopback address and is same-origin as far as the browser is
 *  concerned, so only its Host header gives it away. `*.localhost` always resolves to loopback
 *  in browsers and has no public zone, so no attacker can serve a page under it. An absent Host
 *  (HTTP/1.0, Node test harnesses) passes: every browser sends one.
 *
 *  Also passed: the names container runtimes give the host ({@link CONTAINER_HOST_NAMES}; only for a
 *  request no browser sent, `browser`, see there) and any
 *  IP literal: rebinding needs a DNS name to re-resolve, and a page served from an IP is
 *  same-origin only with that IP, never with 127.0.0.1. Except the unspecified address
 *  (`0.0.0.0`, `[::]`) and the IPv4-mapped ones (`[::ffff:127.0.0.1]`, which a browser writes
 *  `[::ffff:7f00:1]`): they reach this machine's loopback (the unspecified one on Linux and
 *  macOS), but only 127/8 and `[::1]` are "potentially trustworthy" URLs, so browsers send no
 *  Fetch Metadata to these, and a page on any site that targets them looks exactly like the UI
 *  (lanAuth's cross-site check can't see it on a GET). The daemon's own clients never use them:
 *  the banner, the browser it opens and the snippets say 127.0.0.1 (or the LAN address). Some
 *  names kept below get no Fetch Metadata in some browser either (WebKit's `localhost.`, a
 *  container name), which is why the one GET that changes state also needs the UI's header. */
function hostNamesThisMachine(host: string | undefined, browser: boolean, d: Deps): boolean {
  if (!host) return true
  const name = hostHeaderName(host)
  if (/^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return false // 0/8, as tools/security.ts treats it
  if (name.startsWith('[')) {
    // Any spelling of [::] or of an IPv4-mapped address: the URL parser writes both one way.
    let v6 = name
    try {
      v6 = new URL(`http://${name}`).hostname
    } catch {
      // Not an IPv6 literal; judged below like any other name.
    }
    if (v6 === '[::]' || v6.startsWith('[::ffff:')) return false
  }
  if (isLoopbackBindHost(name) || name.endsWith('.localhost')) return true
  if (CONTAINER_HOST_NAMES.has(name) && !browser) return true
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) || /^\[[0-9a-f:.]*:[0-9a-f:.]*\]$/.test(name)) return true
  const unbracket = (s: string) => s.replace(/^\[|\]$/g, '')
  return d.bindHost !== undefined && unbracket(name) === unbracket(d.bindHost.trim().toLowerCase())
}

/** The names container runtimes give the host, whose connections arrive on the host's own
 *  loopback, so a containerised client such as Open WebUI reaches a loopback-bound daemon through
 *  them: Docker Desktop (and Colima, OrbStack, Rancher Desktop) `host.docker.internal` /
 *  `gateway.docker.internal`, Podman `host.containers.internal`, Lima `host.lima.internal`,
 *  OrbStack's own `host.orb.internal`, Rancher Desktop's own `host.rancher-desktop.internal`.
 *  Exactly these, not every `*.internal`: the zone has no public DNS, but whoever answers the
 *  victim's DNS queries (a hostile Wi-Fi or router) can answer for any name in it and rebind it.
 *  That holds for these six too, so they name this machine only for a request no browser sent
 *  ({@link fromBrowser}): the clients they exist for (SDKs, curl, Open WebUI's server side) send
 *  no Origin, Referer, Sec-Fetch-Site or Sec-Fetch-Dest (Node's fetch adds a Sec-Fetch-Mode of
 *  its own, so that one is not counted), while a page a hostile resolver points one of them at
 *  127.0.0.1 runs in a browser, which adds Origin to every write and every WebSocket handshake.
 *  Trusted on the Host alone, such a page in Firefox or Safari (no Fetch Metadata to these plain
 *  http names) minted a permanent key with POST /api/v1/keys, added an MCP server that runs a
 *  command, and opened terminals. A browser on one of these names is judged like any other
 *  foreign Host (LAN rules: a key). Not closed: a same-origin GET that drops its Referer
 *  (referrer policy no-referrer) carries none of these headers, so such a page can still read
 *  what a keyless GET answers; the one GET that changes state needs the UI's header, which
 *  counts as a browser's. */
const CONTAINER_HOST_NAMES = new Set([
  'host.docker.internal',
  'gateway.docker.internal',
  'host.containers.internal',
  'host.lima.internal',
  'host.orb.internal',
  'host.rancher-desktop.internal',
])

/** The name a Host header carries: lowercased, the port and a trailing dot dropped. `[v6]:port`
 *  keeps its brackets, `name:port` loses everything after the colon. */
function hostHeaderName(host: string): string {
  const h = host.trim().toLowerCase()
  return (h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d*$/, '')).replace(/\.$/, '')
}

/** Is a request's Host the MagicDNS name and port Tailscale Serve serves this daemon under?
 *  Serve's proxy passes the browser's Host through to the ingress, so genuine tailnet traffic
 *  carries `<machine>.<tailnet>.ts.net` plus Serve's public port when it isn't 443 (exactly the
 *  host of the URL the provider started). A page that DNS-rebinds its own name to 127.0.0.1 can
 *  reach the ingress port too, and set any header it likes there, but its Host is its own name
 *  with the ingress port: it would need to answer DNS for the served name (MagicDNS off, a
 *  hostile resolver) AND the ingress port would have to equal Serve's public port. Read from the
 *  live URL, else the one persisted on the last connect (cli.ts): the URL is null during a
 *  reconnect's backoff, while Serve's entry, which outlives our process, keeps serving. The
 *  persisted one only if Serve saved it: saved by another provider, it is that tunnel's own
 *  name, which a custom tunnel the user still runs into the ingress carries on every request.
 *  No URL, no trust. */
function namesServedHost(host: string | undefined, d: Deps): boolean {
  const ra = d.store.snapshot().remoteAccess
  const url = d.remote?.url?.() || (ra?.lastUrlProvider === 'tailscale-serve' ? ra.lastUrl : '')
  // A DNS name and an optional port, nothing the URL parser would read as userinfo or a path.
  if (!host || !url || !/^[a-z0-9.-]+(:\d+)?$/i.test(host.trim())) return false
  try {
    const served = new URL(url)
    const got = new URL(`${served.protocol}//${host.trim()}`) // so `:443` reads as the default port
    return served.hostname !== '' && hostHeaderName(got.hostname) === hostHeaderName(served.hostname) && got.port === served.port
  } catch {
    return false
  }
}

/** Does a process on this machine already get keyless loopback trust on the main listener?
 *  Only then may lanAuth honour a Tailscale Serve identity: the ingress is a plain 127.0.0.1
 *  listener, so any local process can send that header and the served Host (see identity.ts),
 *  and it must not get more that way than it already has. True on desktop (no app secret) when
 *  the main listener can be reached over loopback: the default bind, a loopback one or a
 *  wildcard. Bound to one specific address (`--addr 192.168.1.10:6996`, `daemon.host`), the
 *  box's own processes are LAN peers that need a key, so tailnet users need the remote token. */
function localProcessesTrusted(d: Deps): boolean {
  if (process.env.TURBOLLM_APP_SECRET) return false // Android: loopback trust needs the app's secret
  const h = d.bindHost?.trim().toLowerCase()
  return h === undefined || isLoopbackBindHost(h) || h === '0.0.0.0' || h === '::' || h === '[::]'
}

/** The cookie and header that carry {@link appSecretPresented}'s secret. */
const APP_SECRET_COOKIE = 'turbollm_app'
const APP_SECRET_HEADER = 'x-turbollm-app'
/** Sent by the web UI on the one state-changing GET, `/api/v1/connect/:cli` (see lanAuth). Not a
 *  secret: only proof that the request is not a simple cross-site one. */
const UI_HEADER = 'x-turbollm-ui'

/** Headers only a browser adds to a request: Origin (to every write, every CORS request and every
 *  WebSocket handshake), Referer (unless the page's referrer policy drops it), Fetch Metadata
 *  (only to "potentially trustworthy" URLs) and the web UI's own {@link UI_HEADER}. A CLI, an SDK
 *  or a server-side client sends none of them. Sec-Fetch-Mode is left out on purpose: Node's
 *  built-in fetch (undici) adds `cors` to every request and its WebSocket `websocket` to every
 *  handshake, so every Node client on it (the OpenAI JS SDK, clients/ts, anything built on them)
 *  sends it from a container, and counting it would take keyless loopback trust on these names
 *  from all of them. A browser that sends Fetch Metadata always sends Sec-Fetch-Site and
 *  Sec-Fetch-Dest with it, so leaving it out misses no browser request. */
const BROWSER_HEADERS = ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user', UI_HEADER]

/** Did a browser send this request, by {@link BROWSER_HEADERS}? `header` looks a lowercase header
 *  name up: Hono's `c.req.header` or a raw handshake's headers. For {@link CONTAINER_HOST_NAMES}. */
function fromBrowser(header: (name: string) => string | undefined): boolean {
  return BROWSER_HEADERS.some((h) => !!header(h))
}

/** Does a loopback caller prove it is the app that started this daemon? Only asked when
 *  `TURBOLLM_APP_SECRET` is set, which only TurboLLM-Android does (a fresh random value per
 *  launch): on a phone every installed app shares 127.0.0.1, so a loopback address says nothing
 *  about who is calling, and loopback trust would hand any of them the whole API. The app's
 *  WebView presents the secret as a cookie (the only thing it can attach to every request,
 *  WebSocket handshakes included), its native code as a header. Unset (desktop, npm, Docker) →
 *  always true, so loopback trust is exactly what it was. */
function appSecretPresented(cookie: string | undefined, header: string | undefined): boolean {
  const secret = process.env.TURBOLLM_APP_SECRET
  if (!secret) return true
  const candidates = header ? [header.trim()] : []
  for (const part of (cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === APP_SECRET_COOKIE) candidates.push(part.slice(eq + 1).trim())
  }
  // Digests, not the raw strings: timingSafeEqual needs equal lengths, and a length check of its
  // own would leak the secret's length.
  const want = createHash('sha256').update(secret).digest()
  return candidates.some((v) => timingSafeEqual(createHash('sha256').update(v).digest(), want))
}

function hasAppSecret(c: Context): boolean {
  return appSecretPresented(c.req.header('cookie'), c.req.header(APP_SECRET_HEADER))
}

/** The answer to the app's `GET /api/v1/app-proof?nonce=` (server.ts), or null when there is none
 *  to give: no secret set, a nonce that is not 32-128 lowercase hex characters, or a socket whose
 *  local end can't be read. Any app on the phone can listen on the daemon's port while the daemon
 *  does not (before it binds at launch, or for a moment while a LAN toggle rebinds), and the
 *  secret stays valid for the daemon's whole life, so the app asks for this before it sends the
 *  secret anywhere. HMAC-SHA256 under the secret: only the daemon it was given to can answer the
 *  app's fresh nonce, and the answer is no use as the secret. The local address and port it was
 *  asked on are part of the message, so another app holding 127.0.0.1:7000 cannot relay the
 *  app's nonce to this daemon on some other socket (the remote-access ingress port) and pass the
 *  answer back. Same binding lookup as {@link localPort}. */
export function appSecretProof(c: Context): string | null {
  const secret = process.env.TURBOLLM_APP_SECRET
  const nonce = c.req.query('nonce')
  if (!secret || !nonce || !/^[0-9a-f]{32,128}$/.test(nonce)) return null
  let socket: { localAddress?: string; localPort?: number } | undefined
  try {
    type Bindings = { incoming?: { socket?: { localAddress?: string; localPort?: number } } }
    const env = c.env as Bindings & { server?: Bindings }
    socket = (env?.server ? env.server : env)?.incoming?.socket
  } catch {
    socket = undefined
  }
  if (!socket?.localAddress || !socket.localPort) return null
  // A dual-stack listener reports IPv4 loopback as ::ffff:127.0.0.1.
  const at = `${socket.localAddress.replace(/^::ffff:/i, '')}:${socket.localPort}`
  return createHmac('sha256', secret).update(`turbollm-app-proof\n${at}\n${nonce}`).digest('hex')
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

/** True for requests we cannot tie to a credential surface and so let through
 *  even when enforcing: the SPA shell + its static assets (any GET whose path is
 *  neither /api nor /v1 nor under them) and the always-open health probe. A user
 *  must be able to load the page on the LAN to paste a key (spec 06 §5: `/healthz`
 *  always open). */
function isExempt(c: Context): boolean {
  if (c.req.path === '/healthz') return true
  if (c.req.method !== 'GET') return false
  const p = c.req.path
  // The bare prefixes too: the gateway's app.all('/v1/*') also matches '/v1', so a keyless
  // GET /v1?<query> reached gatewayV1Handler and proxied to the engine.
  const under = (prefix: string) => p === prefix || p.startsWith(`${prefix}/`)
  return !under('/api') && !under('/v1')
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
 *  spec 30 §2.2), which every provider's local leg connects to. Other local processes (and a
 *  DNS-rebinding page) can connect there too, so this marks a request as tunneled, never as
 *  coming from a provider: it may only make a request stricter.
 *
 *  Replaces ADR-153's cf-ray/cf-connecting-ip check. That check was only ever safe because
 *  Cloudflare's edge controlled the header; Tailscale Funnel, ngrok and a user-run frp inject
 *  no equivalent, so a header-based signal would have read every one of them as a trusted
 *  loopback caller and waved them through with no key at all. The socket cannot be forged in
 *  either direction.
 *
 *  Fails CLOSED, not open, when remote access is live but `localPort()` can't read it: it
 *  returns `true` (treat as tunneled) rather than `false`. `localPort()` reads an undocumented
 *  `@hono/node-server` internal under a `^2.1.0` caret range — verified correct against the
 *  installed version today, but a future patch/minor bump could silently reshape it, and
 *  `localPort()` swallows that as `undefined` rather than throwing. Reading "undetermined" as
 *  "not tunneled" would be catastrophic here: a tunneled connection's REMOTE address is
 *  loopback by construction (the provider's local leg proxies through 127.0.0.1), so
 *  `isLocalRequest` would then also read it as genuinely local and grant it trust reserved for
 *  the box's own local-admin actions (add/scan engine, build-from-source — arbitrary binary
 *  execution). Reading "undetermined" as "tunneled" instead just asks an actually-local caller
 *  for a key it may not always have — a loud, debuggable failure instead of a silent one. */
export function isTunneled(c: Context, d: Deps): boolean {
  const ingress = d.remote?.ingressPort()
  if (ingress === undefined) return false
  const port = localPort(c)
  if (port === undefined) return true
  return port === ingress
}

/** True only when this request provably arrived on the remote-access ingress socket: its local
 *  port was read, and it is the ingress port. The trust only a tunneled request gets (a
 *  remote-access token, a Tailscale Serve identity, a Cloudflare Access login in place of a key)
 *  needs this, not {@link isTunneled}: that one reads an unreadable port as tunneled, which only
 *  makes a request stricter (no loopback trust), and read as proof of the ingress it handed that
 *  trust to a request on the main listener, where any LAN peer or local process can send the Serve
 *  header and a remote token is no credential. Unreadable while remote access is live, a request
 *  is thus judged as tunneled for what it loses and as on the main listener for what it gains:
 *  it needs an ordinary key (and, while Access is required, the verified login as well). */
function arrivedOnIngress(c: Context, d: Deps): boolean {
  const ingress = d.remote?.ingressPort()
  return ingress !== undefined && localPort(c) === ingress
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
  if (!hostNamesThisMachine(c.req.header('host'), fromBrowser((h) => c.req.header(h)), d)) return false // DNS rebinding — see hostNamesThisMachine
  if (!hasAppSecret(c)) return false // another app on the phone — see appSecretPresented
  if (!isLanExposed(d)) return true // loopback-only bind → always local
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
 *  of pulling them off a Context — the local port is the ingress signal (ADR-422).
 *
 *  Unlike a REST call, a WebSocket handshake gets no CORS check: a page on any site can open
 *  ws://127.0.0.1:<port>/… and its Host header is genuine, so the checks above pass it. So a
 *  handshake a browser marks as cross-site (Fetch Metadata, else its Origin against its Host,
 *  the same {@link isCrossSite} rule as lanAuth's cross-site writes) gets no loopback trust
 *  either: it needs a `key`. Otherwise the secrecy of a terminal id was the only thing between
 *  any website and a live shell, and https://turbollm.dev could list those ids.
 *
 *  Same fail-closed discipline as {@link isTunneled}: when remote access is live (`ingress`
 *  is defined) but the socket's local port is somehow undetermined, this must NOT read as
 *  "not tunneled" — that would let a tunneled connection (loopback by construction on its
 *  remote address) fall through to the loopback check below and be trusted as local. */
export function isLocalUpgrade(
  remoteAddress: string | undefined,
  socketLocalPort: number | undefined,
  headers: NodeJS.Dict<string | string[]>,
  d: Deps,
): boolean {
  const ingress = d.remote?.ingressPort()
  if (ingress !== undefined) {
    if (socketLocalPort === undefined) return false
    if (socketLocalPort === ingress) return false
  }
  // DNS rebinding — see hostNamesThisMachine. A refused handshake still gets in with a `key`.
  const host = headers.host
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined)
  if (!hostNamesThisMachine(one(host), fromBrowser((h) => one(headers[h])), d)) return false
  if (crossSite(one(headers['sec-fetch-site']), one(headers.origin), one(host))) return false
  // Another app on the phone — see appSecretPresented. The WebView's handshake carries the cookie.
  const cookie = headers.cookie
  const app = headers[APP_SECRET_HEADER]
  if (!appSecretPresented(typeof cookie === 'string' ? cookie : undefined, typeof app === 'string' ? app : undefined)) return false
  if (!isLanExposed(d)) return true // loopback-only bind → always local
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

/** The gate on the routes that EXECUTE something on the host (agent actions: MCP servers,
 *  builds, engine add/scan/zip/release/update, skills). Like {@link isLocalRequest},
 *  but ALSO open to a non-host caller that has presented a real, stored, ungranted API key on
 *  THIS request, so a user can drive their own box from another device while an OPEN (keyless)
 *  LAN still can't trigger remote code execution. The same bar as {@link hostGate} and
 *  {@link codeAuth}: whoever may not mint a key or open Code may not spawn a command either.
 *
 *  It used to answer `daemon.requireApiKey === true` for every non-local caller, on the premise
 *  that lanAuth had then already verified a key. lanAuth has two exits that let a request through
 *  with NO key at all: a Tailscale Serve identity and a verified Cloudflare Access JWT. So a
 *  tailnet member or Access-policy member, refused a key by hostGate and Code by codeAuth, could
 *  still add a stdio MCP server (a command the daemon spawns at once) or run a build: command
 *  execution as the daemon user. The key check here runs without the `ingress` flag, so a
 *  remote-access token is refused as well (see verifyKeyValue), as it is on Code. A tunneled
 *  request is never local by address (isLocalRequest, ADR-152/ADR-422), and an undetermined
 *  address while LAN-exposed is remote, so both still need the key. */
export function isLocalOrAuthenticated(c: Context, d: Deps): boolean {
  return isLocalRequest(c, d) || verifyPresentedKey(c, d)
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
  touchLastUsed(d, match)
  return match
}

/** How stale a key's `lastUsedAt` may get before a use rewrites it. Every bump is a full,
 *  synchronous config.json rewrite on the event loop, and an authenticated LAN/remote UI polls
 *  several times a second (twice per request for a remote token or a LAN Code call), so
 *  bumping on every use rewrote the whole config continuously. The value is only ever shown
 *  as "last used N minutes ago". */
const LAST_USED_RESOLUTION_MS = 60_000

/** Best-effort lastUsedAt bump (spec 06 §5), skipped while the stored value is recent. A
 *  value in the future (clock moved back) counts as stale, so it cannot freeze. */
function touchLastUsed(d: Deps, match: ApiKey): void {
  const last = match.lastUsedAt ? Date.parse(match.lastUsedAt) : NaN
  if (Number.isFinite(last) && Math.abs(Date.now() - last) < LAST_USED_RESOLUTION_MS) return
  try {
    d.store.update((mut) => {
      const k = mut.apiKeys.find((x) => x.id === match.id)
      if (k) k.lastUsedAt = new Date().toISOString()
    })
  } catch {
    /* swallow — usage tracking is best-effort */
  }
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

/** The External Chat API tenant a stored key authenticates (spec 27 §10): its `tenant`, or
 *  'local' (this install's own data) for a key that names none, which is every key TurboLLM
 *  mints. ext/auth.ts's resolveTenantFromKey reads it through this, so the ext API and the
 *  refusal below agree on which keys are tenant keys. */
export function keyTenant(key: Pick<ApiKey, 'tenant'>): string {
  return key.tenant ?? 'local'
}

/** Is this stored key an External Chat API tenant key — usable only on `/api/ext/v1`
 *  (ext/auth.ts), and refused by every other credential path?
 *
 *  The same rule as {@link isFacadeOnlyKey}, for the other credential that is issued for one
 *  surface: a key with a non-local tenant is added to config.json for a backend that serves
 *  that tenant's users, scoped by `scopes` (as narrow as chats:read), and only the ext API reads
 *  either field. It carries no `grant`, so every internal check took it for an owner key: it
 *  minted permanent keys, added stdio MCP servers, read the settings, opened Code and its
 *  terminal, and got every Turbo Link capability. lanAuth still lets it through to
 *  `/api/ext/v1` (verifyKeyValue's `ext` flag), as a backend on another machine reaches that
 *  API over the LAN or a tunnel. */
export function isExtOnlyKey(key: Pick<ApiKey, 'tenant'>): boolean {
  return keyTenant(key) !== 'local'
}

/** The External Chat API's path prefix, the one surface where lanAuth accepts a tenant key
 *  ({@link isExtOnlyKey}). Duplicated as a literal like LINK_API_PREFIX: ext/ imports this
 *  module. */
const EXT_API_PREFIX = '/api/ext/v1'

function isExtApi(c: Context): boolean {
  return c.req.path === EXT_API_PREFIX || c.req.path.startsWith(`${EXT_API_PREFIX}/`)
}

/** The ext API's request-id middleware (ext/routes.chats.ts mounts the same one on /api/ext/v1),
 *  for {@link lanRefusal}. */
const extRequestId = requestIdMiddleware({ generator: () => makeRequestId() })

/** lanAuth's refusal, in the ext API's own error envelope on {@link isExtApi} (ext/errors.ts:
 *  `type` 'auth', a `request_id` and `retryable`, all required by the OpenAPI document's Error
 *  schema). lanAuth runs before the ext API's gate (extAuth), so a backend on the LAN or behind
 *  a tunnel with a missing or revoked key got `{ code, message }` alone, which the TS client
 *  reads as type 'internal' with no request id, while a same-machine caller got extAuth's 'auth'.
 *  hono/request-id is mounted on /api/ext/v1 after lanAuth, so it is run here first: a caller's
 *  own valid X-Request-Id names the refusal and comes back in the header, as it does for a
 *  same-machine caller refused by extAuth; otherwise the id is a fresh req_ one. */
async function lanRefusal(c: Context, status: 401 | 403, code: 'unauthorized' | 'forbidden', message: string): Promise<Response> {
  if (isExtApi(c)) {
    await extRequestId(c, async () => {})
    return extError(c, 'auth', code, message, { status })
  }
  return c.json({ error: { code, message } }, status)
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
 *  remote-access token executes a caller-supplied binary, whatever its capabilities, and
 *  isLocalOrAuthenticated refuses one independently (it accepts only an ungranted key). */
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
  // lower-stakes, deliberately left as-is; the engine flags and files a profile or preset
  // carries need an ungranted key anyway, launchFieldsRefusal). Matched narrowly — exactly one
  // path segment after `/models/`, no further subpath — so it catches only
  // `DELETE /api/v1/models/:key`.
  if (m === 'DELETE' && /^\/api\/v1\/models\/[^/]+$/.test(path)) return null
  if (path === '/api/v1/models' || path.startsWith('/api/v1/models/')) return read ? 'models:use' : 'models:load'
  if (path.startsWith('/api/v1/downloads')) return read ? 'downloads:read' : 'downloads:write'
  if (path.startsWith('/api/v1/settings')) return read ? 'config:read' : 'config:write'
  if (path === '/api/v1/status') return 'config:read'
  // ADR-434 (i)(3): the work a model load would interrupt (chat titles, Code sessions, routine
  // names). Only a caller that may load models needs the confirmation this feeds, and routine
  // names are not a `models:use` read. Read-only surface: a write maps to nothing.
  if (path === '/api/v1/activity') return read ? 'models:load' : null
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
  // The text classification playground's run (api/systemone-job.ts): /v1/systemone as a job the page can leave, so
  // held to what /v1/* is. GET reads the last answer, so it takes the same capability as asking: a token that may
  // not ask may not read what someone else asked either.
  if (path === '/api/v1/jev/playground/run') return 'models:use'
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
 *  for all of them. An External Chat API tenant key ({@link isExtOnlyKey}) is refused the same
 *  way, unless `ext` says lanAuth is judging a request for /api/ext/v1.
 *
 *  It is NOT the only one in the process, and the earlier version of this comment claiming
 *  "the single choke point" was wrong: the External Chat API (`ext/auth.ts`) landed on main
 *  with its own hash comparison and never routes through here. It calls
 *  {@link isFacadeOnlyKey} directly instead. Two enforcement points, ONE predicate — if you
 *  add a third credential path, call the predicate rather than re-deriving the rule. */
export function verifyKeyValue(key: string, d: Deps, opts?: { ingress?: boolean; ext?: boolean }): boolean {
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
  if (!acceptedHere(match, opts)) return false
  // Best-effort lastUsedAt bump (spec 06 §5). Never block the request on it.
  touchLastUsed(d, match)
  return true
}

/** {@link verifyKeyValue}'s rule for a stored key it matched, shared with
 *  {@link keyHashStillAccepted} so a re-check cannot drift from it. */
function acceptedHere(match: ApiKey, opts?: { ingress?: boolean; ext?: boolean }): boolean {
  // A grant only as the ADR-422 exception (see verifyKeyValue).
  if (isFacadeOnlyKey(match) && !(opts?.ingress === true && grantKind(match) === 'remote')) return false
  // An External Chat API tenant key ({@link isExtOnlyKey}) likewise, except where lanAuth judges
  // a request for /api/ext/v1 itself (`ext`), which then checks the tenant and scopes.
  if (isExtOnlyKey(match) && opts?.ext !== true) return false
  return true
}

/** Would {@link verifyKeyValue} still accept the key whose hash this is, on the same terms
 *  (`opts`; none for a Code terminal)? For a credential checked once and then held open (a Code
 *  terminal's WebSocket, an SSE stream), so it can be dropped once its key is revoked. No
 *  lastUsedAt bump: nothing is being used. */
export function keyHashStillAccepted(hash: string, d: Deps, opts?: { ingress?: boolean; ext?: boolean }): boolean {
  const match = d.store.snapshot().apiKeys.find((k) => k.hash === hash)
  return !!match && acceptedHere(match, opts)
}

/** Checks the presented key (any of the accepted headers, see presentedKey) against stored API
 *  keys. Shared by lanAuth and codeAuth below so both enforce the identical credential check —
 *  only WHEN each one is triggered differs. */
export function verifyPresentedKey(c: Context, d: Deps, opts?: { ingress?: boolean; ext?: boolean }): boolean {
  return verifyKeyValue(presentedKey(c), d, opts)
}

/** Did a browser send this request from another site? Fetch Metadata says so when present, but a
 *  browser sends it only to a "potentially trustworthy" URL (https, 127.0.0.1, localhost) and
 *  older ones not at all. Without it, the Origin header, which every current browser attaches
 *  to a non-GET request, is compared with the Host the request was sent to: "null" (a
 *  sandboxed frame, a file: page) or another host:port is another site. Neither header (a CLI
 *  or SDK, or a plain GET) is not a cross-site browser request. Behind a reverse proxy on plain
 *  http that rewrites Host (nginx's default sends `Host: 127.0.0.1`), the UI's own writes look
 *  exactly like that attack and are refused: such a proxy must pass the browser's Host through. */
function isCrossSite(c: Context): boolean {
  return crossSite(c.req.header('sec-fetch-site'), c.req.header('origin'), c.req.header('host'))
}

/** {@link isCrossSite} on raw header values, for the WebSocket upgrade (isLocalUpgrade). */
function crossSite(site: string | undefined, origin: string | undefined, host: string | undefined): boolean {
  if (site) return site !== 'same-origin' && site !== 'none'
  if (!origin || !host) return false
  try {
    const o = new URL(origin)
    return o.host !== new URL(`${o.protocol}//${host.trim()}`).host
  } catch {
    return true
  }
}

/** LAN auth middleware (spec 06 §5). Register AFTER cors + the Server header and
 *  BEFORE the API/chat/gateway routes. LAN peers need a key once the daemon is
 *  LAN-exposed (see isLanExposed) and requireApiKey is on (the default). The default
 *  loopback-only bind is NOT a pass-through: past the SPA shell and /healthz it admits
 *  keyless only loopback callers whose Host names this machine and, on Android, that carry
 *  the app secret (anyone else needs a key even with requireApiKey off), and browser
 *  cross-site writes to /api/* get a 403 on every bind. */
export function lanAuth(d: Deps): MiddlewareHandler {
  return async (c, next) => {
    // Hand the façade to its own gate before any of the LAN reasoning below — see
    // isLinkFacade. Not folded into `isExempt`, whose meaning is "no credential surface
    // applies"; the opposite is true here, a STRICTER one does.
    if (isLinkFacade(c)) return next()

    // Cross-site writes. A "simple" POST (text/plain, form) needs no CORS preflight, so /api's
    // CORS policy (server.ts) stops a hostile page from READING the answer but not the request
    // from running, and the loopback trust below would wave it straight into the local-admin
    // routes. Refuse anything a browser marks as coming from another site (see isCrossSite; the
    // engine-zip upload guard in routes.ts applies the Fetch Metadata half of this). The app's
    // own UI is same-origin, and CLIs/SDKs send neither Sec-Fetch-Site nor Origin.
    //
    // GET /api/v1/connect/:cli counts as a write: on a LAN-bound daemon it replaces the stored
    // `cli-<name>` key (routes.ts), and a GET needs no preflight, so an <img> on any site would
    // otherwise revoke a CLI's key or pile up `cli-<anything>` keys. Any method, as Hono serves
    // HEAD from the GET handler.
    const write = c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS'
    const connect = c.req.path.startsWith('/api/v1/connect/')
    if (c.req.path.startsWith('/api/') && (write || connect) && isCrossSite(c)) {
      // Refused on Origin alone (no Fetch Metadata): what a plain-http proxy that rewrites Host looks like.
      const hint = c.req.header('sec-fetch-site') ? '' : " Behind a reverse proxy, have it pass the browser's Host header through."
      return lanRefusal(c, 403, 'forbidden', `Cross-site request refused.${hint}`)
    }
    // That check can't see every cross-site GET: a GET carries no Origin, and a browser sends no
    // Fetch Metadata to some URLs that still get loopback trust (an old browser to 127.0.0.1,
    // WebKit to `localhost.`, any browser to a container host name the hosts file maps to
    // 127.0.0.1). So the route also needs the header the web UI sends (api.ts getConnect): a page
    // on another site can only add a custom header after a CORS preflight, which /api refuses: it
    // answers no other origin outside /api/v1/sysinfo (server.ts).
    if (connect && !c.req.header(UI_HEADER)) {
      const message =
        'Connect setup can only be requested from the TurboLLM app. If it was just updated, reload the page.'
      return c.json({ error: { code: 'forbidden', message } }, 403)
    }

    const daemon = d.store.snapshot().daemon
    const tunneled = isTunneled(c, d)
    // A loopback connection whose Host names some other machine (DNS rebinding — see
    // hostNamesThisMachine) gets no loopback trust: it is judged exactly like a LAN request on
    // a LAN-exposed listener.
    const foreignHost = !tunneled && !hostNamesThisMachine(c.req.header('host'), fromBrowser((h) => c.req.header(h)), d)
    // Likewise a loopback request without the Android app's secret: another app on the phone (see
    // appSecretPresented). With nothing LAN-exposed, `requireApiKey: false` opened the API to no
    // one, so it is not read as consent to open it to every other app (or to a rebinding page,
    // above): such a caller needs a key.
    const foreignApp = !tunneled && !foreignHost && !hasAppSecret(c)
    const basis = {
      lanBind: isLanExposed(d) || foreignHost || foreignApp,
      requireApiKey: daemon.requireApiKey || ((foreignHost || foreignApp) && !isLanExposed(d)),
      tunneled,
      loopback: foreignHost || foreignApp ? false : isLoopback(c),
      exempt: isExempt(c),
    }
    if (bypassesAuth(basis)) {
      // Keyless only because "Require an API key" is off (an open LAN) unless it would pass with
      // the requirement on as well (see holdOpen).
      admit(c, bypassesAuth({ ...basis, requireApiKey: true }) ? { by: 'local' } : { by: 'open' })
      return next()
    }

    // Tailscale Serve identity (ADR-422 §6.1): a tailnet-authenticated user needs no shared
    // secret. Gated on BOTH the ingress socket and the provider actually RUNNING being Serve —
    // Funnel and every public tunnel send no identity headers, so anything claiming one there is
    // a forgery attempt. The running provider, not the saved one: the saved one can name Serve
    // while a public tunnel started under another provider is still serving. And only for the
    // Host Serve serves (namesServedHost): the ingress port skips the Host check above, so a
    // DNS-rebinding page on 127.0.0.1:<ingress> could otherwise set the header itself. And only
    // while a local process, which can always forge it, already has as much (localProcessesTrusted).
    // And never for a request a browser marks as cross-site (isCrossSite, on every path and
    // method): Serve adds the header to everything it proxies from a tailnet device, a browser's
    // requests included, so it is ambient like a cookie, and with /v1's CORS '*' a page on any
    // site the user visits could run inference (and auto-swap models), list the library and read
    // the answers. Serve is https, so browsers always send Fetch Metadata there; the served UI is
    // same-origin, and CLIs, SDKs and server-side clients send neither header. A cross-site
    // browser client falls through to the key check below, like any other remote caller. The
    // ingress socket proven (arrivedOnIngress), not a local port that can't be read: that is the
    // main listener as far as anyone knows, where any LAN peer can send the header.
    if (
      arrivedOnIngress(c, d) &&
      d.remote?.activeProvider?.() === 'tailscale-serve' &&
      namesServedHost(c.req.header('host'), d) &&
      localProcessesTrusted(d) &&
      !isCrossSite(c) &&
      tailscaleIdentity(c)
    ) {
      admit(c, { by: 'identity' })
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
    // pass-through instead. Keyed on the provider actually RUNNING, like the Serve block above,
    // not the saved one: `--tunnel` runs cloudflare-quick whatever is saved, and a saved
    // cloudflare-named with Access would otherwise refuse the token `--tunnel` printed
    // (requireAccess on) or take an Access JWT in its place on the quick tunnel (off). The saved
    // one only while no provider is recorded on a live ingress (disable() drops it before the
    // tunnel has stopped), so `requireAccess` never lapses in that moment.
    const ra = d.store.snapshot().remoteAccess
    if (
      isTunneled(c, d) &&
      (d.remote?.activeProvider?.() ?? ra.provider) === 'cloudflare-named' &&
      ra.cloudflare.accessTeamDomain &&
      ra.cloudflare.accessAud
    ) {
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
      // Never for a request a browser marks as cross-site (isCrossSite), as for the Serve identity
      // above: Cloudflare adds the assertion to everything it lets through once the browser holds
      // the Access cookie, another site's requests included, so the login is ambient like a
      // cookie, and with /v1's CORS '*' a page on any site the owner visits could run inference
      // and auto-swap models with no key. Such a request goes on to the key check below; with
      // requireAccess on it still needs the verified login as well, as that key check is then a
      // supplement, not a replacement. Likewise a request whose local port can't be read
      // (arrivedOnIngress): it is judged as tunneled here, so requireAccess still applies, but the
      // login is no credential on its own off the proven ingress.
      if (verified && !isCrossSite(c) && arrivedOnIngress(c, d)) {
        admit(c, { by: 'identity' })
        return next()
      }
      // I2 (Phase 5 final review): `requireAccess: true` must refuse whenever control reaches
      // here WITHOUT a genuinely verified assertion, for ANY reason — none presented, one that
      // failed verification, or a JWKS fetch that itself failed. The previous structure only
      // refused the "no assertion at all" case; a JUNK assertion sent during a JWKS outage hit
      // neither branch and silently fell through to the ordinary bearer check instead, so the
      // "the bearer token is replaced, not supplemented" guarantee held for an attacker who
      // sent nothing and evaporated for one who sent garbage.
      if (ra.cloudflare.requireAccess && !verified) {
        return lanRefusal(c, 401, 'unauthorized', 'Cloudflare Access sign-in is required.')
      }
    }

    // A remote-access token only on the proven ingress (arrivedOnIngress), not on a request whose
    // local port can't be read.
    const ingress = arrivedOnIngress(c, d)
    const ext = isExtApi(c)
    if (!verifyPresentedKey(c, d, { ingress, ext })) {
      return lanRefusal(c, 401, 'unauthorized', 'A valid API key is required for non-local access.')
    }
    admit(c, { by: 'key', ingress, ext })
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
      // `/v1/*` only needs models:use, but its auto-swap path LOADS whatever model the body
      // names, evicting the owner's — the exact ADR-376 defect (see isFacadeOnlyKey) that
      // made "models:load" advice for link tokens. Without models:load, this request may use
      // only what is already loaded; ModelRouter refuses the load (see modelLoadsRefused).
      if (!hasCapability(resolved, 'models:load')) return remoteGrant.run(true, () => noModelLoads.run(true, next))
      return remoteGrant.run(true, next)
    }
    return next()
  }
}

/** Marks the async context of a request made with a remote-access token, whatever its
 *  capabilities. The chat tool loop runs inside that request, and its routine tools reach the
 *  same routines that /api/v1/routines guards (no capability maps there, so a remote token is
 *  refused): the tool registry refuses those tools too. */
const remoteGrant = new AsyncLocalStorage<boolean>()

/** True while serving a request made with a remote-access token (ADR-422). */
export function remoteGrantRequest(): boolean {
  return remoteGrant.getStore() === true
}

/** Marks the async context of a request that must not load a model (a remote-access token
 *  without models:load). An async context rather than a parameter because the load decision
 *  sits several calls below the gateway handlers (ModelRouter.route/routeTo), and every path
 *  to it must be covered. */
const noModelLoads = new AsyncLocalStorage<boolean>()

/** True while serving a request whose credential may not load models — ModelRouter checks it
 *  right before an auto-swap load and answers "not loaded" instead. */
export function modelLoadsRefused(): boolean {
  return noModelLoads.getStore() === true
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
    // Recorded over lanAuth's verdict: on Code a key is what lets a non-host caller in, whatever
    // "Require an API key" says (see holdOpen).
    if (isLocalRequest(c, d)) {
      admit(c, { by: 'local' })
      return next()
    }
    if (verifyPresentedKey(c, d)) {
      admit(c, { by: 'key', ingress: false, ext: false })
      return next()
    }

    return c.json(
      { error: { code: 'unauthorized', message: 'A valid API key is required to access Code from a non-host device.' } },
      401,
    )
  }
}

// ── Responses held open after their request was let in ─────────────────────────

/** How lanAuth, then codeAuth on /api/v1/code/*, let a request in. Both judge a request once, as it
 *  arrives; a response held open after it (an SSE stream) outlives that judgement, so holdOpen
 *  keeps this to judge it again once what let it in may be gone (endStaleStreams). */
type Admission =
  /** Nothing was needed, whatever the settings: the host's own caller (or a path open to all). */
  | { by: 'local' }
  /** Nothing was needed only because "Require an API key" is off: a peer on an open LAN. */
  | { by: 'open' }
  /** A Tailscale Serve identity or a Cloudflare Access login, on the remote-access ingress. */
  | { by: 'identity' }
  /** The key it presented, accepted on these terms (verifyKeyValue's `ingress` and `ext`). */
  | { by: 'key'; ingress: boolean; ext: boolean }

/** Each request's admission, for as long as the request object lives. */
const admissions = new WeakMap<Request, Admission>()

function admit(c: Context, a: Admission): void {
  admissions.set(c.req.raw, a)
}

interface HeldStream {
  admission: Extract<Admission, { by: 'open' | 'key' }>
  /** The hash of the key the request presented, if it presented one. */
  keyHash?: string
  end(): void
}

/** Every stream holdOpen keeps that could still be ended, until it ends. */
const heldStreams = new Set<HeldStream>()

/** Wrap an SSE stream's callback (streamSSE) so that, while it runs, endStaleStreams can end it
 *  through `stream.abort()` once what let its request in is gone: that runs the stream's own
 *  onAbort, as a client's disconnect does. The host's own caller, a Serve identity or Access login,
 *  and a request no lanAuth judged (an app built without it) are not kept: nothing here ends those. */
export function holdOpen<T extends { abort(): void }>(c: Context, cb: (stream: T) => Promise<void>): (stream: T) => Promise<void> {
  return async (stream) => {
    const admission = admissions.get(c.req.raw)
    if (!admission || admission.by === 'local' || admission.by === 'identity') return cb(stream)
    const raw = presentedKey(c)
    const held: HeldStream = { admission, keyHash: raw ? hashKey(raw) : undefined, end: () => stream.abort() }
    heldStreams.add(held)
    try { await cb(stream) } finally { heldStreams.delete(held) }
  }
}

/** A chat turn the daemon runs on after its request has been answered (chat-routes.ts startDetachedTurn), kept with
 *  how its request was let in, so what ends a held stream also ends the turn that caller started. */
interface HeldTurn {
  admission: Admission | undefined
  /** The hash of the key the request presented, if it presented one. */
  keyHash?: string
  /** It came through remote access: the ingress socket (isTunneled, as a request whose local port can't be read
   *  while remote access is live is judged). */
  tunneled: boolean
  /** It came from another machine on the main listener: not tunneled, and its peer is not on this machine's loopback
   *  (or could not be read, which counts as another machine, as isLocalRequest judges it). Only the LAN lets it in. */
  lanPeer: boolean
  stop(): void
}

/** Every chat turn holdTurn keeps that could still be stopped, until it has unwound. */
const heldTurns = new Set<HeldTurn>()

/** Keep a chat turn that outlives its request (the turn routes answer at once and the daemon runs the turn) so that it
 *  can be stopped once what let its request in is gone, as a held stream is ended (holdOpen): endStaleStreams stops a
 *  turn started on a key that is no longer accepted, or keyless on an open LAN once a key is required;
 *  endTunneledTurns, called when the remote-access ingress closes, stops every turn that came through it (a remote
 *  token's, a Tailscale Serve identity's, a Cloudflare Access login's, a key sent through the tunnel); and
 *  endLanTurns, called after every bind, stops every turn another machine sent to the main listener once the daemon
 *  is no longer LAN-exposed (LAN access turned off). The last two keep what a turn's disconnect did while it ran in
 *  its request (remote access's Stop and the LAN-off rebind close their listener's connections). The first is new:
 *  a turn's POST was never a held stream, so revoking the key it was sent with (a remote-access token included), or
 *  requiring a key of the keyless open-LAN peer that sent it, left it running. The host's own turns (and any where
 *  no lanAuth judged the request) are not kept: nothing here stops those. `stop` runs at most once; call the returned
 *  function once the turn has unwound. */
export function holdTurn(c: Context, d: Deps, stop: () => void): () => void {
  const admission = admissions.get(c.req.raw)
  const tunneled = isTunneled(c, d)
  if (!tunneled && (!admission || admission.by === 'local')) return () => {}
  const raw = presentedKey(c)
  const lanPeer = !tunneled && isLoopback(c) !== true
  const held: HeldTurn = { admission, keyHash: raw ? hashKey(raw) : undefined, tunneled, lanPeer, stop }
  heldTurns.add(held)
  return () => { heldTurns.delete(held) }
}

/** Stop every held turn (holdTurn) that came through remote access, and return how many. Called when the ingress
 *  listener stops (remote access turned off, its tunnel given up on, a new ingress started), which closes those
 *  callers' connections: a turn no longer ends with its connection, so it is stopped here. */
export function endTunneledTurns(): number {
  let ended = 0
  for (const t of heldTurns) {
    if (!t.tunneled) continue
    heldTurns.delete(t)
    t.stop()
    ended++
  }
  return ended
}

/** Stop every held turn (holdTurn) that another machine sent to the main listener, once the daemon is no longer
 *  LAN-exposed (isLanExposed, which follows the address really bound), and return how many. Turning LAN access off
 *  rebinds the listener in place and the old one closes its connections, which ended such a turn while it ran in its
 *  request; a turn no longer ends with its connection, so a LAN peer's reply ran on (and its Allow tool rounds, and
 *  its wait for approval) after the daemon stopped listening to the LAN. The same rule dropStaleTerminalSockets
 *  applies to a LAN peer's terminal. cli.ts calls this after every bind; a bind still LAN-exposed stops nothing. */
export function endLanTurns(d: Deps): number {
  if (isLanExposed(d)) return 0
  let ended = 0
  for (const t of heldTurns) {
    if (!t.lanPeer) continue
    heldTurns.delete(t)
    t.stop()
    ended++
  }
  return ended
}

/** End each held stream (holdOpen) whose way in is gone, and return how many. lanAuth and codeAuth
 *  checked its credential only when it opened, and it then ran until its client went away: a LAN
 *  client kept the engine log, the request log or a Code session's running turn after the key it
 *  opened them with was deleted or replaced, and a keyless open-LAN peer kept the two logs after
 *  "Require an API key" was turned on, while every new request of theirs got 401. Gone:
 *  - let in on a key that would no longer be accepted on the same terms (keyHashStillAccepted);
 *  - let in keyless on an open LAN, now that a key is required, unless it also sent one that is
 *    still accepted.
 *  What else lets a request in is the bind and the ingress, and those end these streams already: a
 *  rebind and remote access's Stop close the old listener's connections (closeAllConnections),
 *  unlike a Code terminal's upgraded socket (dropStaleTerminalSockets) or a chat turn that runs on
 *  after its request (endLanTurns, endTunneledTurns). Called where a key is
 *  removed (DELETE /api/v1/keys/:id, Connect's re-mint) and when PATCH /api/v1/settings turns the
 *  requirement on. */
export function endStaleStreams(d: Deps): number {
  let ended = 0
  const keyRequired = d.store.snapshot().daemon.requireApiKey
  for (const s of heldStreams) {
    const keyOk = s.keyHash !== undefined && keyHashStillAccepted(s.keyHash, d, s.admission.by === 'key' ? s.admission : undefined)
    if (keyOk || (s.admission.by === 'open' && !keyRequired)) continue
    heldStreams.delete(s)
    s.end()
    ended++
  }
  // The chat turns those callers started (holdTurn), on the same rule. One let in by a Serve identity or an Access
  // login presented no key that could go: endTunneledTurns stops it with remote access.
  for (const t of heldTurns) {
    const by = t.admission?.by
    if (by !== 'open' && by !== 'key') continue
    const keyOk = t.keyHash !== undefined && keyHashStillAccepted(t.keyHash, d, t.admission?.by === 'key' ? t.admission : undefined)
    if (keyOk || (by === 'open' && !keyRequired)) continue
    heldTurns.delete(t)
    t.stop()
    ended++
  }
  return ended
}
