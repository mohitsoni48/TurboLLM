// Composed `lanAuth` integration tests (Phase 5 final review, "Evidence Run" section).
//
// The review's own finding: no test anywhere in this phase drives the REAL `lanAuth`
// middleware through more than one of its blocks at once — which is exactly why C1, C2, C3,
// I2, I4 and I6 all shipped despite a green suite. `auth.grant-kind.test.ts` unit-tests
// `requiredCapability` in isolation; `identity.test.ts`/`access-jwt.test.ts` test their own
// helpers alone; neither composes the Tailscale-identity block, the Cloudflare Access block
// and the ordinary bearer-token/capability check the way a REAL tunneled request does.
//
// This file builds a real `Hono` app with `lanAuth` registered as middleware (the same
// pattern link-auth.test.ts's `serverOrderApp` uses for lanAuth+linkAuth) and drives it
// end-to-end via `app.request()`, simulating a tunneled connection the same way
// auth.test.ts's `fakeContext` does for the unit-level tests: `env.incoming.socket.localPort`
// set to the ingress port (what `isTunneled` keys off) and `.remoteAddress` set to loopback
// (what a tunnel's local leg always looks like — the whole reason ADR-422 exists).
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { lanAuth, hostGate, hashKey, provisionRemoteApiKey, isLocalOrAuthenticated, isLocalUpgrade } from './auth'
import { defaultConfig } from './config/config'
import type { Deps } from './deps'
import { ModelRouter } from './gateway/model-router'
import type { Manager, Status } from './engines/manager'
import type { Registry } from './engines/registry'
import type { Scanner, ModelEntry } from './models/scanner'
import { ToolRegistry } from './tools/tool-registry'
import type { RoutineToolsStore } from './routines/routine-tools'
import type { Routine } from './routines/schema'
import type { CustomChatAgent } from './config/config'
import { rmSync } from 'node:fs'
import { registerChatRoutes } from './chat/chat-routes'
import { ConversationStore } from './chat/db'
import { SkillStore } from './agents/skills'
import { tmpDir } from './test-support/tmp'

// N3 (Phase 5 final-review-fix re-review): a GENUINELY valid, properly-signed Access assertion
// — the same RS256 keypair machinery access-jwt.test.ts uses — so the C3(b) test below proves
// the provider gate specifically, not merely that a trivially-malformed string always fails
// verification regardless of which block is being tested.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const ACCESS_JWK = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256' }
const ACCESS_JWKS_BODY = JSON.stringify({ keys: [ACCESS_JWK] })
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function makeValidAccessJwt(teamDomain: string, aud: string): string {
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
  const now = Math.floor(Date.now() / 1000)
  const body = b64url({ iss: teamDomain, aud: [aud], exp: now + 600, iat: now - 10, sub: randomUUID(), email: 'sam@example.com' })
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}
/** Stubs `fetch` to serve the matching JWKS for `teamDomain`'s certs endpoint only — any other
 *  URL falls through to the real `fetch`, so this can coexist with other tests in the file. */
function stubJwksEndpoint(teamDomain: string): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) === `${teamDomain}/cdn-cgi/access/certs`) {
      return new Response(ACCESS_JWKS_BODY, { status: 200 })
    }
    return real(input, init)
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

const INGRESS_PORT = 6997
/** The MagicDNS name Tailscale Serve serves this daemon under; Serve passes the browser's Host
 *  through, so genuine Serve traffic carries it. */
const SERVE_HOST = 'box.tail1234.ts.net'

function makeDeps(mutate: (cfg: ReturnType<typeof defaultConfig>) => void): { d: Deps; cfg: ReturnType<typeof defaultConfig> } {
  const cfg = defaultConfig()
  mutate(cfg)
  const d = {
    store: {
      snapshot: () => cfg,
      update: (fn: (c: typeof cfg) => void) => fn(cfg),
    },
    // The running provider mirrors the saved one unless a test says otherwise (they can differ).
    remote: {
      ingressPort: () => INGRESS_PORT,
      activeProvider: () => cfg.remoteAccess.provider,
      url: (): string | null => `https://${SERVE_HOST}`,
    },
  } as unknown as Deps
  return { d, cfg }
}

/** The real middleware plus a handful of stub routes at the EXACT paths the findings are
 *  about. `requiredCapability`/`hostGate` are pure functions `lanAuth` (and, for the keys
 *  route, the handler itself — mirroring api/routes.ts's own `keysHostGate`) call internally
 *  keyed on `c.req.method`/`c.req.path`, so a lightweight stub at the right path exercises the
 *  identical decision the real handler would, without pulling in the full `registerApi`
 *  dependency graph (scanner/manager/db/…), the same tradeoff link-auth.test.ts's
 *  `serverOrderApp` makes for the façade. */
function buildApp(d: Deps): Hono {
  const app = new Hono()
  app.use('*', lanAuth(d))
  // Mirrors api/routes.ts's `POST /api/v1/keys` gate exactly (`keysHostGate` there is a
  // one-line wrapper around the same `hostGate` call).
  app.post('/api/v1/keys', (c) => {
    if (!hostGate(c, d)) return c.json({ error: { code: 'forbidden', message: 'Host-only action.' } }, 403)
    return c.json({ ok: true })
  })
  app.post('/api/v1/conversations/:id/messages', (c) => c.json({ ok: true }))
  app.get('/api/v1/status', (c) => c.json({ ok: true }))
  app.get('/v1/models', (c) => c.json({ data: [] }))
  // Mirrors the local-admin routes (POST /engines, /build/*, /mcp/servers): isLocalOrAuthenticated.
  app.post('/api/v1/build/run', (c) => {
    if (!isLocalOrAuthenticated(c, d)) return c.json({ error: { code: 'forbidden', message: 'Host-only action.' } }, 403)
    return c.json({ ok: true })
  })
  // Mirrors gateway.ts: route on the body's `model`, which may auto-swap (load) it.
  app.post('/v1/chat/completions', async (c) => {
    const { model } = (await c.req.json()) as { model?: string }
    const r = await d.modelRouter.route(model ?? '')
    return 'status' in r ? c.json({ error: { message: r.message } }, r.status) : c.json({ ok: true })
  })
  return app
}

/** A request from this machine's own loopback to the MAIN listener (not the ingress socket). */
function loopbackRequest(app: Hono, path: string, init: RequestInit = {}): Response | Promise<Response> {
  return app.request(path, init, {
    incoming: { socket: { localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
  } as never)
}

/** A request that arrived over remote access: local port matches the ingress socket AND the
 *  remote address looks loopback — exactly what a tunnel's local leg always presents (ADR-422),
 *  and the whole reason `isTunneled` cannot be a plain loopback check. */
function tunneledRequest(app: Hono, path: string, init: RequestInit = {}): Response | Promise<Response> {
  return app.request(path, init, {
    incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } },
  } as never)
}

/** A request that arrived over the ordinary LAN listener — NOT the ingress socket — from a
 *  real non-loopback address. This is `hostGate`'s own "open LAN access" case (its first
 *  paragraph: "lanBind on, requireApiKey off... would let any device that can merely load the
 *  page mint itself a durable key"), and the exact configuration N1 (Phase 5 final-review-fix
 *  re-review) found the first `hostGate` fix reopened the same hole in. */
function lanRequest(app: Hono, path: string, init: RequestInit = {}): Response | Promise<Response> {
  return app.request(path, init, {
    incoming: { socket: { localPort: 6996, remoteAddress: '192.168.1.50', remotePort: 55555, remoteFamily: 'IPv4' } },
  } as never)
}

// ── N1 (Phase 5 final-review-fix re-review): hostGate must refuse ANY granted key, not just
// grant a real stored key a pass by hash alone — the first C1 fix (`resolveKey`) traded C1's
// hole in the default config for the SAME hole (mint-a-permanent-full-access-key,
// revoke-everyone-else's-key) in the open-LAN config (`lanBind: true, requireApiKey: false`).
// ────────────────────────────────────────────────────────────────────────────────────────────

test('N1: a scoped remote token cannot mint a full-access key over open LAN access', async () => {
  const { d } = makeDeps((cfg) => {
    cfg.daemon.lanBind = true
    cfg.daemon.requireApiKey = false
  })
  const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  const app = buildApp(d)
  // Sanity: bypassesAuth's own "opted into open LAN access" rule lets an ordinary chat
  // request through with no credential at all, which is by design — the vulnerability is
  // specifically that this SAME openness let a granted key pass hostGate too.
  const chat = await lanRequest(app, '/api/v1/conversations/abc/messages', { method: 'POST' })
  assert.equal(chat.status, 200, 'open LAN access must still work for ordinary chat with no key')
  const res = await lanRequest(app, '/api/v1/keys', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': raw },
  })
  assert.equal(res.status, 403, 'a remote-kind (scoped) token must never pass hostGate — it is a granted key')
})

test('N1: a Turbo Link facade-only token cannot mint a full-access key over open LAN access either', async () => {
  const raw = 'tllm-linkfacadekeylinkfacadekeylinkface1'
  const { d } = makeDeps((cfg) => {
    cfg.daemon.lanBind = true
    cfg.daemon.requireApiKey = false
    cfg.apiKeys.push({
      id: 'peer', name: 'laptop', hash: hashKey(raw), prefix: raw.slice(0, 12),
      createdAt: '', lastUsedAt: null, grant: { capabilities: ['models:use'] },
    } as never)
  })
  const app = buildApp(d)
  const res = await lanRequest(app, '/api/v1/keys', { method: 'POST', headers: { 'X-TurboLLM-Auth': raw } })
  assert.equal(res.status, 403, 'ADR-376: a link grant is refused absolutely, including here')
})

test('N1: an ordinary (ungranted) key still passes hostGate over open LAN access, unchanged', async () => {
  const raw = 'tllm-ordinarykeyordinarykeyordinarykey01'
  const { d } = makeDeps((cfg) => {
    cfg.daemon.lanBind = true
    cfg.daemon.requireApiKey = false
    cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null } as never)
  })
  const app = buildApp(d)
  const res = await lanRequest(app, '/api/v1/keys', { method: 'POST', headers: { 'X-TurboLLM-Auth': raw } })
  assert.equal(res.status, 200, 'an ordinary key presenting itself is exactly the self-service case hostGate exists to allow')
})

// ── C1: a Tailscale-identity-only caller (no key at all) must reach ordinary chat routes
// but be refused at credential management. ────────────────────────────────────────────────

test('C1: Tailscale identity with no token reaches an ordinary chat route', async () => {
  const { d } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve'
  })
  const res = await tunneledRequest(buildApp(d), '/api/v1/conversations/abc/messages', {
    method: 'POST',
    headers: { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' },
  })
  assert.equal(res.status, 200)
})

test('C1: the SAME identity-only caller is REFUSED minting a durable key at POST /api/v1/keys', async () => {
  // Before the fix, hostGate read `daemon.requireApiKey === true` as proof of an authenticated
  // caller — true before Tasks 20/21 added a `return next()` path with NO key presented at
  // all. requireApiKey defaults to true (the shipped default), which is exactly the
  // configuration this reproduces.
  const { d, cfg } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve'
  })
  assert.equal(cfg.daemon.requireApiKey, true, 'this is the shipped default the finding depends on')
  const app = buildApp(d)
  const res = await tunneledRequest(app, '/api/v1/keys', {
    method: 'POST',
    headers: { Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com' },
  })
  assert.equal(res.status, 403)
  assert.equal(cfg.apiKeys.length, 0, 'no key may have been minted')
})

// ── C3/I6: a leftover Cloudflare Access config must neither brick nor bypass auth once the
// active provider is something else. ───────────────────────────────────────────────────────

test('C3/I6: a leftover Access config does not brick an ordinary bearer token on ngrok', async () => {
  const raw = 'tllm-plainkeyplainkeyplainkeyplainkeyplai1'
  const { d } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'ngrok'
    cfg.remoteAccess.cloudflare.accessTeamDomain = 'https://c3-lockout.cloudflareaccess.com'
    cfg.remoteAccess.cloudflare.accessAud = 'aud-c3-lockout'
    cfg.remoteAccess.cloudflare.requireAccess = true
    cfg.apiKeys.push({ id: 'k1', name: 'x', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null } as never)
  })
  const app = buildApp(d)
  const res = await tunneledRequest(app, '/api/v1/conversations/abc/messages', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': raw },
  })
  assert.equal(res.status, 200, 'a leftover requireAccess=true from a past cloudflare-named setup must not brick ngrok')
})

test('C3/I6: a GENUINELY VALID, replayed Access assertion does not bypass auth on ngrok', async () => {
  // N3 (Phase 5 final-review-fix re-review): a trivially malformed string like 'x.y.z' fails
  // verification regardless of which provider is active, so it cannot distinguish "the
  // provider gate refused this" from "the assertion itself was garbage" — it is a tautology,
  // not a regression test for the gate. This uses a REAL, correctly-signed assertion (matching
  // the team/aud, verified against a JWKS a stubbed fetch actually serves) — one that WOULD
  // pass verification if the gate were reverted — to prove the gate itself is what refuses it.
  const teamDomain = 'https://c3-bypass-real.cloudflareaccess.com'
  const restoreFetch = stubJwksEndpoint(teamDomain)
  try {
    const { d } = makeDeps((cfg) => {
      cfg.remoteAccess.provider = 'ngrok'
      cfg.remoteAccess.cloudflare.accessTeamDomain = teamDomain
      cfg.remoteAccess.cloudflare.accessAud = 'aud-c3-bypass-real'
      cfg.remoteAccess.cloudflare.requireAccess = false
    })
    const app = buildApp(d)
    const assertion = makeValidAccessJwt(teamDomain, 'aud-c3-bypass-real')
    const res = await tunneledRequest(app, '/api/v1/conversations/abc/messages', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': assertion },
    })
    assert.equal(res.status, 401, 'a genuinely valid Access assertion must not bypass auth once the active provider is not cloudflare-named')
  } finally {
    restoreFetch()
  }
})

// `turbollm --tunnel` runs cloudflare-quick whatever provider is saved, so the Access block must
// follow the RUNNING provider: keyed on a saved cloudflare-named, it refused the token --tunnel
// printed (requireAccess on) and took an Access JWT in its place on the quick tunnel (off).
test('a saved cloudflare-named Access config neither locks out nor admits by JWT a --tunnel quick tunnel', async () => {
  const teamDomain = 'https://tunnel-flag.cloudflareaccess.com'
  const restoreFetch = stubJwksEndpoint(teamDomain)
  try {
    const { d, cfg } = makeDeps((cfg) => {
      cfg.remoteAccess.provider = 'cloudflare-named'
      cfg.remoteAccess.cloudflare.accessTeamDomain = teamDomain
      cfg.remoteAccess.cloudflare.accessAud = 'aud-tunnel-flag'
      cfg.remoteAccess.cloudflare.requireAccess = true
    })
    ;(d.remote as unknown as { activeProvider: () => string }).activeProvider = () => 'cloudflare-quick'
    const raw = 'tllm-tunnelflagtunnelflagtunnelflagtunnel1' // what --tunnel prints (a full-access key)
    cfg.apiKeys.push({ id: 'k1', name: 'tunnel-x', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null } as never)
    const app = buildApp(d)
    assert.equal((await tunneledRequest(app, '/api/v1/status', { headers: { Authorization: `Bearer ${raw}` } })).status, 200)
    cfg.remoteAccess.cloudflare.requireAccess = false
    const jwt = makeValidAccessJwt(teamDomain, 'aud-tunnel-flag')
    assert.equal((await tunneledRequest(app, '/api/v1/status', { headers: { 'Cf-Access-Jwt-Assertion': jwt } })).status, 401)
    // The same JWT still works once the named tunnel is the one running.
    ;(d.remote as unknown as { activeProvider: () => string }).activeProvider = () => 'cloudflare-named'
    assert.equal((await tunneledRequest(app, '/api/v1/status', { headers: { 'Cf-Access-Jwt-Assertion': jwt } })).status, 200)
    // No provider recorded on a live ingress (disable() drops it before the tunnel has stopped):
    // the saved provider decides, so requireAccess does not lapse in that moment.
    ;(d.remote as unknown as { activeProvider: () => string | undefined }).activeProvider = () => undefined
    cfg.remoteAccess.cloudflare.requireAccess = true
    assert.equal((await tunneledRequest(app, '/api/v1/status', { headers: { Authorization: `Bearer ${raw}` } })).status, 401)
  } finally {
    restoreFetch()
  }
})

// ── C2: a real models:use-scoped remote token must reach the actual chat surface. ──────────

test('C2: a models:use remote token reaches POST /api/v1/conversations/:id/messages', async () => {
  const { d } = makeDeps(() => {})
  const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  const app = buildApp(d)
  const res = await tunneledRequest(app, '/api/v1/conversations/abc/messages', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': raw },
  })
  assert.equal(res.status, 200, 'the feature\'s own headline chat journey must not 403 on a token its own UI can mint')
})

test('C2: the SAME token still 403s on config:read-gated /api/v1/status (the boundary is deliberate)', async () => {
  const { d } = makeDeps(() => {})
  const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  const app = buildApp(d)
  const res = await tunneledRequest(app, '/api/v1/status', { headers: { 'X-TurboLLM-Auth': raw } })
  assert.equal(res.status, 403, 'status carries launchCommand/log-tail filesystem detail and must stay behind config:read')
})

// ── I2: requireAccess=true must fail CLOSED, not open, when the JWKS fetch itself fails. ───

test('I2: requireAccess=true refuses with 401 when the JWKS fetch fails, even with a VALID bearer token also presented', async () => {
  // N3 (Phase 5 final-review-fix re-review): the original finding J was specifically "a junk
  // assertion during a JWKS outage, WITH a valid scoped bearer token ALSO presented" — sending
  // no bearer token at all (the prior version of this test) is 401 either way, from the Access
  // block with the fix or from the ordinary bearer check without it, so it does not distinguish
  // the two. A valid bearer token must be refused here specifically BECAUSE Access is mandatory
  // and unverifiable, not because no other credential existed.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('simulated network failure')
  }) as unknown as typeof fetch
  try {
    const raw = 'tllm-i2failopenkeyi2failopenkeyi2failope1'
    const { d } = makeDeps((cfg) => {
      cfg.remoteAccess.provider = 'cloudflare-named'
      cfg.remoteAccess.cloudflare.accessTeamDomain = 'https://i2-unreachable.cloudflareaccess.com'
      cfg.remoteAccess.cloudflare.accessAud = 'aud-i2'
      cfg.remoteAccess.cloudflare.requireAccess = true
      cfg.apiKeys.push({ id: 'k1', name: 'x', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null } as never)
    })
    const app = buildApp(d)
    const res = await tunneledRequest(app, '/api/v1/status', {
      headers: { 'Cf-Access-Jwt-Assertion': 'not.a.real.jwt', 'X-TurboLLM-Auth': raw },
    })
    assert.equal(res.status, 401, 'a JUNK assertion during a JWKS outage must not fall through to the bearer check, even with a valid bearer token present')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('I2: requireAccess=false still falls through silently to the ordinary bearer check on a JWKS failure', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('simulated network failure')
  }) as unknown as typeof fetch
  try {
    const raw = 'tllm-fallthroughfallthroughfallthroughfa1'
    const { d } = makeDeps((cfg) => {
      cfg.remoteAccess.provider = 'cloudflare-named'
      cfg.remoteAccess.cloudflare.accessTeamDomain = 'https://i2-fallthrough.cloudflareaccess.com'
      cfg.remoteAccess.cloudflare.accessAud = 'aud-i2-fallthrough'
      cfg.remoteAccess.cloudflare.requireAccess = false
      cfg.apiKeys.push({ id: 'k1', name: 'x', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null } as never)
    })
    const app = buildApp(d)
    const res = await tunneledRequest(app, '/api/v1/conversations/abc/messages', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'not.a.real.jwt', 'X-TurboLLM-Auth': raw },
    })
    assert.equal(res.status, 200, 'requireAccess=false + a failed verification must still allow a valid bearer token through')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── I6 (documented, accepted design — not a bug): Task 20's Tailscale-identity block runs
// BEFORE the Cloudflare Access block, so `requireAccess` stays inert (never bypassed OR
// enforced) on Tailscale Serve regardless of the C3 fix — see the final review's own
// "Positive Observations". Pinned here so a future reordering of the two blocks cannot
// silently reintroduce I6 as a live bypass. ────────────────────────────────────────────────

test('I6: Tailscale Serve identity still wins over an unrelated requireAccess=true, by design', async () => {
  const { d } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve'
    cfg.remoteAccess.cloudflare.accessTeamDomain = 'https://i6.cloudflareaccess.com'
    cfg.remoteAccess.cloudflare.accessAud = 'aud-i6'
    cfg.remoteAccess.cloudflare.requireAccess = true
  })
  const app = buildApp(d)
  const res = await tunneledRequest(app, '/api/v1/conversations/abc/messages', {
    method: 'POST',
    headers: { Host: SERVE_HOST, 'Tailscale-User-Login': 'sam@example.com' },
  })
  assert.equal(res.status, 200, 'Access is genuinely not in a Serve request\'s path — this is intended, not a bypass')
})

// ── Auth must follow the address ACTUALLY bound, not only the lanBind flag. ─────────────────
// `turbollm --addr 0.0.0.0:6996` (or daemon.host) binds every interface without setting
// lanBind, and every gate read lanBind alone — so the daemon enforced nothing at all, while
// `--help` promised key enforcement and the banner printed a freshly minted key.

test('a non-loopback bind with lanBind OFF still enforces the key for a LAN caller', async () => {
  const { d } = makeDeps(() => {}) // defaults: lanBind false, requireApiKey true
  d.bindHost = '0.0.0.0'
  const app = buildApp(d)
  assert.equal((await lanRequest(app, '/api/v1/status')).status, 401, 'no key from the LAN → refused')
  assert.equal((await lanRequest(app, '/api/v1/build/run', { method: 'POST' })).status, 401)
  assert.equal(isLocalUpgrade('192.168.1.77', 6996, {}, d), false, 'the terminal WebSocket must not treat a LAN peer as local')
  // The box's own loopback stays trusted, exactly as with lanBind on.
  assert.equal((await loopbackRequest(app, '/api/v1/status')).status, 200)
})

// Hono's '/v1/*' also matches the bare '/v1', so the gateway's app.all('/v1/*') answered a GET
// that lanAuth took for an SPA page: a keyless GET /v1?<query> reached gatewayV1Handler.
test('a keyless LAN GET of the bare /v1 or /api prefix is not an exempt SPA page', async () => {
  const raw = 'tllm-barev1prefixbarev1prefixbarev1prefi1'
  const { d, cfg } = makeDeps((cfg) => { cfg.daemon.lanBind = true })
  cfg.apiKeys.push({ id: 'k1', name: 'x', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null } as never)
  const app = new Hono()
  app.use('*', lanAuth(d))
  app.all('/v1/*', (c) => c.json({ reached: 'gateway' })) // mirrors gateway.ts
  app.get('/*', (c) => c.json({ reached: 'spa' })) // mirrors registerSpaFallback
  for (const path of ['/v1', '/v1?x=1', '/api', '/api?x=1']) {
    assert.equal((await lanRequest(app, path)).status, 401, path)
    assert.equal((await lanRequest(app, path, { headers: { Authorization: `Bearer ${raw}` } })).status, 200, `${path} with a key`)
  }
  // The SPA shell and its routes stay open, so a LAN user can load the page and paste a key.
  for (const path of ['/', '/index.html', '/assets/app.js', '/settings', '/v1abc', '/apidocs']) {
    assert.equal((await lanRequest(app, path)).status, 200, path)
  }
})

test('the same daemon bound to loopback is unchanged — nothing to enforce', async () => {
  const { d } = makeDeps(() => {})
  d.bindHost = '127.0.0.1'
  assert.equal((await lanRequest(buildApp(d), '/api/v1/status')).status, 200)
  assert.equal(isLocalUpgrade('127.0.0.1', 6996, {}, d), true)
})

// ── Cross-site browser writes must not reach the loopback-trusted API (CSRF). ───────────────

test('a cross-site POST from a browser is refused on the default loopback install', async () => {
  const { d } = makeDeps(() => {})
  const app = buildApp(d)
  for (const site of ['cross-site', 'same-site']) {
    const res = await loopbackRequest(app, '/api/v1/build/run', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example', 'Sec-Fetch-Site': site },
      body: '{}',
    })
    assert.equal(res.status, 403, `Sec-Fetch-Site: ${site} must be refused`)
  }
  // The app's own UI (same-origin), a typed URL (none) and a CLI/SDK (no header) still work.
  for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }, {}] as Record<string, string>[]) {
    assert.equal((await loopbackRequest(app, '/api/v1/build/run', { method: 'POST', headers })).status, 200)
  }
  // Reads are untouched: CORS already stops a cross-site page from reading the answer.
  assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200)
})

// ── DNS rebinding — a loopback request whose Host names another site gets no loopback trust.

test('a loopback request with a foreign Host header is judged like a LAN request', async () => {
  const { d } = makeDeps(() => {}) // loopback-only bind, requireApiKey on (the defaults)
  const app = buildApp(d)
  const evil = { Host: 'rebind.attacker.example:6996' }
  assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: evil })).status, 401)
  assert.equal(
    (await loopbackRequest(app, '/api/v1/build/run', { method: 'POST', headers: { ...evil, 'Sec-Fetch-Site': 'same-origin' } })).status,
    401,
  )
  assert.equal(isLocalUpgrade('127.0.0.1', 6996, { host: 'rebind.attacker.example:6996' }, d), false, 'terminal WebSocket too')
  // Every way the box's own clients address it keeps loopback trust.
  for (const host of ['127.0.0.1:6996', 'localhost:6996', 'LOCALHOST', '[::1]:6996', 'app.localhost:5173', '127.0.0.2']) {
    assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { Host: host } })).status, 200, host)
    assert.equal(isLocalUpgrade('127.0.0.1', 6996, { host }, d), true, host)
  }
  // ...and so does the exact name the daemon is bound to (`daemon.host` / `--addr`).
  d.bindHost = 'mybox.lan'
  assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { Host: 'mybox.lan:6996' } })).status, 200)
})

// A browser sends no Fetch Metadata to a URL that is not "potentially trustworthy", and
// http://0.0.0.0 (or [::]) is one that still lands on this machine's loopback. So is an
// IPv4-mapped literal such as http://[::ffff:127.0.0.1] (only 127/8 and ::1 are trustworthy). A
// page on any site can target them, and the request is indistinguishable from the UI's. The box's
// own clients use 127.0.0.1 / localhost (the banner, the browser it opens, every snippet).
test('an unspecified or IPv4-mapped address in Host (0.0.0.0, [::], [::ffff:127.0.0.1]) gets no loopback trust', async () => {
  const { d } = makeDeps(() => {})
  const app = buildApp(d)
  for (const bindHost of [undefined, '0.0.0.0']) {
    d.bindHost = bindHost
    for (const host of [
      '0.0.0.0:6996', '0.0.0.0', '0.1.2.3:6996', '[::]:6996', '[::ffff:0:0]:6996', '[0::0]',
      // How a browser writes http://[::ffff:127.0.0.1]/, and other spellings of the same address.
      '[::ffff:7f00:1]:6996', '[::ffff:127.0.0.1]:6996', '[0:0:0:0:0:ffff:7f00:1]:6996', '[::FFFF:7F00:1]',
    ]) {
      assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { Host: host } })).status, 401, `${host} (bound ${bindHost})`)
      assert.equal(isLocalUpgrade('127.0.0.1', 6996, { host }, d), false, host)
    }
    assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { Host: '127.0.0.1:6996' } })).status, 200)
  }
})

// Sec-Fetch-Site is absent for such a target and in older browsers, but every current browser
// attaches Origin to a non-GET request: compare it with the Host the request was sent to.
test('without Fetch Metadata, a write whose Origin is another site is refused', async () => {
  const { d } = makeDeps(() => {})
  const app = buildApp(d)
  const post = (headers: Record<string, string>) =>
    loopbackRequest(app, '/api/v1/build/run', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: '{}' })
  for (const origin of ['https://evil.example', 'http://127.0.0.1:7777', 'null']) {
    assert.equal((await post({ Host: '127.0.0.1:6996', Origin: origin })).status, 403, origin)
  }
  // A plain-http reverse proxy that rewrites Host trips this too: the refusal says what to fix.
  const proxied = await post({ Host: '127.0.0.1:6996', Origin: 'http://mybox.lan' })
  assert.match(((await proxied.json()) as { error: { message: string } }).error.message, /reverse proxy.*Host header/)
  // Same-origin UI writes (whatever name the UI was opened under), and CLIs (no Origin) still work.
  for (const [host, origin] of [
    ['127.0.0.1:6996', 'http://127.0.0.1:6996'],
    ['localhost:6996', 'http://LOCALHOST:6996'],
    ['[::1]:6996', 'http://[::1]:6996'],
    ['127.0.0.1', 'http://127.0.0.1:80'],
  ]) {
    assert.equal((await post({ Host: host, Origin: origin })).status, 200, origin)
  }
  assert.equal((await post({ Host: '127.0.0.1:6996' })).status, 200, 'CLI / SDK')
  // When Fetch Metadata IS present it decides, as before (Vite's dev proxy forwards Origin as-is).
  assert.equal((await post({ Host: '127.0.0.1:6996', Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' })).status, 200)
})

// A WebSocket handshake gets no CORS check, and a page on another site that opens
// ws://127.0.0.1:<port> sends a genuine Host. Same cross-site rule as the writes above.
test('the terminal WebSocket gives no loopback trust to a handshake from another site', () => {
  const { d } = makeDeps(() => {})
  const host = '127.0.0.1:6996'
  for (const headers of [
    { host, origin: 'https://turbollm.dev' },
    { host, origin: 'http://127.0.0.1:7777' },
    { host, origin: 'null' },
    { host, origin: 'http://127.0.0.1:6996', 'sec-fetch-site': 'cross-site' },
    { host, 'sec-fetch-site': 'same-site' },
  ]) {
    assert.equal(isLocalUpgrade('127.0.0.1', 6996, headers, d), false, JSON.stringify(headers))
  }
  for (const headers of [
    { host, origin: 'http://127.0.0.1:6996' },
    { host: 'localhost:6996', origin: 'http://LOCALHOST:6996' },
    { host: '127.0.0.1', origin: 'http://127.0.0.1:80' },
    // Vite's dev proxy keeps the browser's Host and Origin (localhost:5173) for the upgrade.
    { host: 'localhost:5173', origin: 'http://localhost:5173' },
    { host, origin: 'https://proxy.example', 'sec-fetch-site': 'same-origin' },
    { host }, // a CLI or script: no Origin
  ]) {
    assert.equal(isLocalUpgrade('127.0.0.1', 6996, headers, d), true, JSON.stringify(headers))
  }
})

// `.internal` has no public zone, but whoever controls the victim's resolver (a hostile
// Wi-Fi, a compromised router) can answer for any name in it and rebind it to 127.0.0.1. Only the
// names container runtimes give the host are needed.
test('only the container-runtime host names are trusted, not every .internal name', async () => {
  const { d } = makeDeps(() => {})
  const app = buildApp(d)
  for (const host of [
    'host.docker.internal:6996', 'gateway.docker.internal', 'host.containers.internal:6996', 'host.lima.internal:6996',
    'host.orb.internal:6996', 'host.rancher-desktop.internal', 'HOST.DOCKER.INTERNAL.',
  ]) {
    assert.equal((await loopbackRequest(app, '/v1/models', { headers: { Host: host } })).status, 200, host)
  }
  for (const host of ['rebind.internal:6996', 'evil.corp.internal', 'docker.internal', 'x.host.docker.internal', 'internal']) {
    assert.equal((await loopbackRequest(app, '/v1/models', { headers: { Host: host } })).status, 401, host)
    assert.equal(isLocalUpgrade('127.0.0.1', 6996, { host }, d), false, host)
  }
})

// Docker Desktop delivers a container's `host.docker.internal` connection on the host's own
// loopback, which is how Open WebUI (README) reaches a default, loopback-bound daemon. An IP
// literal has nothing to re-resolve, so it can't be rebound (the IPv4-mapped ones are refused
// for another reason, see the IPv4-mapped Host test above).
test('a loopback request whose Host is a .internal name or an IP literal keeps loopback trust', async () => {
  const { d } = makeDeps(() => {}) // loopback-only bind, requireApiKey on (the defaults)
  const app = buildApp(d)
  assert.equal((await loopbackRequest(app, '/v1/models', { headers: { Host: 'host.docker.internal:6996' } })).status, 200)
  for (const host of [
    'host.docker.internal', 'gateway.docker.internal:6996', 'host.containers.internal:6996',
    '192.168.1.20:6996', '10.0.0.5', '[fe80::1]:6996', '[2001:db8::7]',
  ]) {
    assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { Host: host } })).status, 200, host)
    assert.equal(isLocalUpgrade('127.0.0.1', 6996, { host }, d), true, host)
  }
  // A DNS name that merely contains one of those shapes is still foreign.
  for (const host of ['evil.example', 'evil.example:6996', 'internal.evil.example', 'host.docker.internal.evil.example', '127.0.0.1.evil.example']) {
    assert.equal((await loopbackRequest(app, '/v1/models', { headers: { Host: host } })).status, 401, host)
    assert.equal(isLocalUpgrade('127.0.0.1', 6996, { host }, d), false, host)
  }
})

// With requireApiKey off and nothing LAN-exposed, the open-LAN branch ("the user opted into
// keyless LAN access") must not swallow a rebinding page: no LAN access was ever opened, so
// that setting is no consent for a foreign site — the request needs a key like any LAN one.
test('a foreign Host still needs a key when requireApiKey is off and nothing is LAN-exposed', async () => {
  const { d } = makeDeps((cfg) => {
    cfg.daemon.requireApiKey = false
  })
  d.bindHost = '127.0.0.1'
  const app = buildApp(d)
  const evil = { Host: 'rebind.attacker.example:6996' }
  assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: evil })).status, 401)
  assert.equal((await loopbackRequest(app, '/v1/models', { headers: evil })).status, 401)
  // The box's own clients are untouched by the key setting.
  assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: { Host: '127.0.0.1:6996' } })).status, 200)
  // Once LAN access really is open without a key, a foreign Host gets in keyless like any LAN
  // peer. That is not a protection: it is how a DNS-rebinding page from any website reaches an
  // open-LAN daemon, which the Settings and README copy now say. Only the key closes it.
  d.bindHost = '0.0.0.0'
  assert.equal((await loopbackRequest(app, '/api/v1/status', { headers: evil })).status, 200)
})

// ── Tailscale identity is trusted only while the RUNNING provider is Tailscale Serve. ──────

test('a forged Tailscale identity is refused when the saved provider is Serve but a public tunnel is running', async () => {
  const { d } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve' // saved after a public tunnel was started
  })
  ;(d.remote as unknown as { activeProvider: () => string }).activeProvider = () => 'cloudflare-quick'
  const res = await tunneledRequest(buildApp(d), '/api/v1/conversations/abc/messages', {
    method: 'POST',
    headers: { Host: SERVE_HOST, 'Tailscale-User-Login': 'forged@example.com' },
  })
  assert.equal(res.status, 401)
})

// ── On the ingress port the Host check is skipped (a tunnel's Host is its public name), so
// the Tailscale identity header must be tied to the name Serve actually serves. Otherwise a
// DNS-rebinding page on 127.0.0.1:<ingress> sets the header itself and gets full API access.

test('a DNS-rebinding page on the ingress port cannot forge a Tailscale identity', async () => {
  const { d, cfg } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve'
  })
  const app = buildApp(d)
  const send = (req: typeof tunneledRequest, headers: Record<string, string>) =>
    req(app, '/api/v1/conversations/abc/messages', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', ...headers } })
  const forged = { Host: 'rebind.attacker.example:6997', 'Tailscale-User-Login': 'forged@example.com' }
  assert.equal((await send(loopbackRequest, forged)).status, 401, 'main port')
  assert.equal((await send(tunneledRequest, forged)).status, 401, 'ingress port')
  assert.equal((await send(tunneledRequest, { 'Tailscale-User-Login': 'forged@example.com' })).status, 401, 'no Host is no proof')
  // Genuine Serve traffic carries the served name, in any case, with the served port (none for 443).
  for (const host of [SERVE_HOST, 'BOX.Tail1234.TS.NET', `${SERVE_HOST}.`, `${SERVE_HOST}:443`]) {
    assert.equal((await send(tunneledRequest, { Host: host, 'Tailscale-User-Login': 'sam@example.com' })).status, 200, host)
  }
  // The served name on another port is not Serve: a page whose own name resolves (via a hostile
  // resolver, with MagicDNS off) to 127.0.0.1 reaches the ingress only with the ingress port in its URL.
  for (const host of [`${SERVE_HOST}:${INGRESS_PORT}`, `${SERVE_HOST}:80`, `${SERVE_HOST}:8443`, `evil@${SERVE_HOST}`]) {
    assert.equal((await send(tunneledRequest, { Host: host, 'Tailscale-User-Login': 'forged@example.com' })).status, 401, host)
  }
  // Served on `--https=8443`: the Host carries that port.
  ;(d.remote as unknown as { url: () => string | null }).url = () => `https://${SERVE_HOST}:8443`
  assert.equal((await send(tunneledRequest, { Host: `${SERVE_HOST}:8443`, 'Tailscale-User-Login': 'sam@example.com' })).status, 200)
  assert.equal((await send(tunneledRequest, { Host: SERVE_HOST, 'Tailscale-User-Login': 'sam@example.com' })).status, 401)
  // A reconnect's backoff (url() is null) falls back to the persisted URL instead of locking
  // every tailnet user out; with neither, nothing is trusted.
  ;(d.remote as unknown as { url: () => string | null }).url = () => null
  assert.equal((await send(tunneledRequest, { Host: SERVE_HOST, 'Tailscale-User-Login': 'sam@example.com' })).status, 401)
  cfg.remoteAccess.lastUrl = `https://${SERVE_HOST}`
  cfg.remoteAccess.lastUrlProvider = 'tailscale-serve'
  assert.equal((await send(tunneledRequest, { Host: SERVE_HOST, 'Tailscale-User-Login': 'sam@example.com' })).status, 200)
  assert.equal((await send(tunneledRequest, forged)).status, 401)
})

// Serve adds the identity to everything it proxies from a tailnet device, a browser's requests
// included, so the browser cannot leave it off: with /v1's CORS '*', a page on any site a tailnet
// user visits could use the served daemon's /v1 (inference, auto-swap loads) and read the answers.
test('a Tailscale Serve identity is no credential for a cross-site browser request', async () => {
  const raw = 'tllm-crosssiteservecrosssiteservecrosssi1'
  const { d, cfg } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve'
  })
  cfg.apiKeys.push({ id: 'k1', name: 'x', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null } as never)
  const app = buildApp(d)
  const serve = { Host: SERVE_HOST, 'Tailscale-User-Login': 'sam@example.com' }
  const get = (headers: Record<string, string>) => tunneledRequest(app, '/v1/models', { headers: { ...serve, ...headers } })
  assert.equal((await get({ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' })).status, 401)
  assert.equal((await get({ 'Sec-Fetch-Site': 'same-site' })).status, 401, 'another app on the same site is not this one')
  assert.equal((await get({ Origin: 'https://evil.example' })).status, 401, 'no Fetch Metadata: Origin vs Host')
  // The served UI itself, a typed URL, and a CLI/SDK (no browser headers) keep keyless access.
  assert.equal((await get({ 'Sec-Fetch-Site': 'same-origin', Origin: `https://${SERVE_HOST}` })).status, 200)
  assert.equal((await get({ 'Sec-Fetch-Site': 'none' })).status, 200)
  assert.equal((await get({})).status, 200)
  // A cross-site browser client with a key still gets in, through the ordinary key check.
  assert.equal((await get({ 'Sec-Fetch-Site': 'cross-site', Authorization: `Bearer ${raw}` })).status, 200)
})

// The persisted URL is whatever the last provider to connect served. Saved by another one (a
// custom tunnel the user still runs, pointed at the ingress), it is that tunnel's own name, so
// until Serve first connects every request through that tunnel would carry the "served" Host
// and could set the identity header itself.
test('before Serve first connects, a URL another provider saved does not stand in for the served name', async () => {
  const { d, cfg } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve'
    cfg.remoteAccess.lastUrl = 'https://tunnel.example.com'
    cfg.remoteAccess.lastUrlProvider = 'custom'
  })
  ;(d.remote as unknown as { url: () => string | null }).url = () => null // Serve still starting
  const app = buildApp(d)
  const run = (host: string) =>
    tunneledRequest(app, '/api/v1/conversations/abc/messages', {
      method: 'POST',
      headers: { Host: host, 'Tailscale-User-Login': 'forged@example.com', 'Sec-Fetch-Site': 'same-origin' },
    })
  assert.equal((await run('tunnel.example.com')).status, 401)
  delete cfg.remoteAccess.lastUrlProvider // saved before the provider was recorded
  assert.equal((await run('tunnel.example.com')).status, 401)
  // Saved by Serve itself, it is the name Serve serves.
  cfg.remoteAccess.lastUrl = `https://${SERVE_HOST}`
  cfg.remoteAccess.lastUrlProvider = 'tailscale-serve'
  assert.equal((await run(SERVE_HOST)).status, 200)
  // The identity is no API key: a host-side action still needs one (isLocalOrAuthenticated).
  const build = await tunneledRequest(app, '/api/v1/build/run', {
    method: 'POST',
    headers: { Host: SERVE_HOST, 'Tailscale-User-Login': 'sam@example.com', 'Sec-Fetch-Site': 'same-origin' },
  })
  assert.equal(build.status, 403)
})

// The ingress is a plain 127.0.0.1 listener, so any process on this machine can send the
// identity header and the served Host. That gives it nothing new while it already has keyless
// loopback trust on the main listener. Bound to one specific LAN address there is no loopback
// listener: the box's other users are LAN peers that need a key, and the header would hand them
// keyless API access instead.
test('on a specific non-loopback bind, a Tailscale identity sent to the ingress is not trusted', async () => {
  const { d } = makeDeps((cfg) => {
    cfg.remoteAccess.provider = 'tailscale-serve'
  })
  const app = buildApp(d)
  const identity = { Host: SERVE_HOST, 'Tailscale-User-Login': 'sam@example.com', 'Sec-Fetch-Site': 'same-origin' }
  const run = () => tunneledRequest(app, '/api/v1/conversations/abc/messages', { method: 'POST', headers: identity })
  d.bindHost = '192.168.1.10'
  // What the same local process gets on the main listener: it arrives from the bound address.
  const main = await app.request('/api/v1/conversations/abc/messages', { method: 'POST', headers: { Host: '192.168.1.10:6996' } }, {
    incoming: { socket: { localPort: 6996, remoteAddress: '192.168.1.10', remotePort: 55555, remoteFamily: 'IPv4' } },
  } as never)
  assert.equal(main.status, 401)
  assert.equal((await run()).status, 401, 'the ingress gives it no more')
  for (const bindHost of [undefined, '127.0.0.1', 'localhost', '0.0.0.0', '::', '[::]']) {
    d.bindHost = bindHost
    assert.equal((await run()).status, 200, `bound ${bindHost}: a local process already has loopback trust`)
  }
  // On Android, loopback trust needs the app's secret; the header must not stand in for it.
  d.bindHost = undefined
  const prev = process.env.TURBOLLM_APP_SECRET
  process.env.TURBOLLM_APP_SECRET = 'test-secret'
  try {
    assert.equal((await run()).status, 401)
  } finally {
    if (prev === undefined) delete process.env.TURBOLLM_APP_SECRET
    else process.env.TURBOLLM_APP_SECRET = prev
  }
})

// ── A remote token without models:load must not load (and evict) models via /v1/* ──────────

function routerWithUnloadedModel(): { router: ModelRouter; loads: unknown[] } {
  const loads: unknown[] = []
  const primary = {
    status: (): Status => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    load: async (opts: unknown) => { loads.push(opts) },
    target: () => null,
    touch: () => {},
  } as unknown as Manager
  const entry = { key: 'other-model', name: 'other-model', path: '/m/other.gguf', quant: 'Q4', sizeBytes: 1 } as unknown as ModelEntry
  const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
  const store = { snapshot: () => ({ ...defaultConfig(), gateway: { autoSwap: true, keepN: 1 } }), update: () => {} }
  const registry = { active: () => undefined } as unknown as Registry
  return { router: new ModelRouter(store as never, registry, primary, scanner, undefined), loads }
}

test('a models:use remote token gets "not loaded" instead of an auto-swap load on /v1/chat/completions', async () => {
  const { d } = makeDeps(() => {})
  const { router, loads } = routerWithUnloadedModel()
  ;(d as { modelRouter: ModelRouter }).modelRouter = router
  const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  const res = await tunneledRequest(buildApp(d), '/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': raw, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'other-model' }),
  })
  assert.equal(res.status, 503)
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /may not load models/)
  assert.deepEqual(loads, [], 'nothing may be loaded or evicted')
})

test('a remote token WITH models:load still auto-swaps through the router', async () => {
  const { d } = makeDeps(() => {})
  const { router } = routerWithUnloadedModel()
  ;(d as { modelRouter: ModelRouter }).modelRouter = router
  const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load'] })
  const res = await tunneledRequest(buildApp(d), '/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': raw, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'other-model' }),
  })
  // The fake registry has no engine, so the load itself fails — but past the capability refusal.
  const body = (await res.json()) as { error?: { message: string } }
  assert.doesNotMatch(body.error?.message ?? '', /may not load models/)
})

// ── A remote token must not reach the routines through the chat tools either ───────────────
// Every /api/v1/routines route maps to no capability, so a remote token is refused there. The
// chat tool loop runs inside the token's own /api/v1/conversations request (models:use), and its
// update_routine/run_routine_now/delete_routine/list_routines reach the same routines: a token
// without models:load could repoint an active routine's modelKey and let the scheduler load it.

const ROUTINE_TOOLS = ['create_routine', 'list_routines', 'update_routine', 'delete_routine', 'run_routine_now']

function routineToolsApp(d: Deps, reg: ToolRegistry): Hono {
  const app = new Hono()
  app.use('*', lanAuth(d))
  // Stands in for chat-routes.ts's runGeneration: it builds the tool list and runs each (approved)
  // tool call inside this request's own async context.
  app.post('/api/v1/conversations/:id/messages', async (c) => {
    const { name, args } = (await c.req.json()) as { name: string; args: Record<string, unknown> }
    const offered = (await reg.buildToolDefinitions({ forGeneration: true })).map((t) => t.function.name)
    return c.json({ offered, result: await reg.executeTool({ id: 't1', name, args }) })
  })
  return app
}

test('a remote token cannot create, list, update, delete or run routines through the chat tools', async () => {
  const { d } = makeDeps(() => {})
  const routine = {
    id: 'r1', flavor: 'chat', status: 'active', prompt: 'owner prompt', scheduleDisplay: 'daily',
    scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, nextFireAt: null, modelKey: 'owner-model',
    createdAt: 'now', updatedAt: 'now',
  } as unknown as Routine
  const touched: string[] = []
  const store = {
    createRoutine: () => { touched.push('create'); return routine },
    getRoutine: () => routine,
    listRoutines: () => { touched.push('list'); return [routine] },
    updateRoutine: () => { touched.push('update'); return routine },
    deleteRoutine: () => { touched.push('delete'); return true },
    listRoutineRuns: () => [],
  } as unknown as RoutineToolsStore
  const reg = new ToolRegistry({} as never, store, async () => { touched.push('run'); return { ok: true } })
  const app = routineToolsApp(d, reg)
  const calls: Array<[string, Record<string, unknown>]> = [
    ['update_routine', { routineId: 'r1', modelKey: 'huge-70b', scheduleRule: { kind: 'interval', everyMs: 60_000 }, confirm: true }],
    ['run_routine_now', { routineId: 'r1' }],
    ['delete_routine', { routineId: 'r1', confirm: true }],
    ['list_routines', {}],
    ['create_routine', { flavor: 'chat', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'huge-70b', agentId: 'a' }],
  ]
  for (const capabilities of [['models:use'], ['models:use', 'models:load']] as const) {
    const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: [...capabilities] })
    for (const [name, args] of calls) {
      const res = await tunneledRequest(app, '/api/v1/conversations/c1/messages', {
        method: 'POST',
        headers: { 'X-TurboLLM-Auth': raw, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args }),
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { offered: string[]; result: string }
      assert.match(body.result, /^Error: .*not allowed/, `${name} with ${capabilities.join('+')}`)
      assert.deepEqual(body.offered.filter((n) => ROUTINE_TOOLS.includes(n)), [], 'routine tools are not offered to the model')
    }
  }
  assert.deepEqual(touched, [], 'no routine may be read, written or run')

  // The host's own chat is unchanged.
  const res = await loopbackRequest(app, '/api/v1/conversations/c1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'run_routine_now', args: { routineId: 'r1' } }),
  })
  const body = (await res.json()) as { offered: string[]; result: string }
  assert.match(body.result, /is running now/)
  assert.deepEqual(body.offered.filter((n) => ROUTINE_TOOLS.includes(n)).sort(), [...ROUTINE_TOOLS].sort())
})

// POST /api/v1/chat-agents needs config:write, which a remote token never carries; the chat tool
// loop runs inside the token's own request, and its create_agent wrote the same agents list.
test('a remote token cannot create a chat agent through the chat tools; it can still list them', async () => {
  const { d } = makeDeps(() => {})
  const agents = { customAgents: [] as CustomChatAgent[] }
  const agentStore = { snapshot: () => agents, update: (fn: (c: typeof agents) => void) => fn(agents) }
  const reg = new ToolRegistry({} as never, undefined, undefined, agentStore)
  const app = routineToolsApp(d, reg)
  const call = async (req: typeof tunneledRequest, headers: Record<string, string>, name: string) => {
    const res = await req(app, '/api/v1/conversations/c1/messages', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args: { name: 'Helper', systemPrompt: 'attacker prompt', tools: ['run_code'] } }),
    })
    assert.equal(res.status, 200)
    return (await res.json()) as { offered: string[]; result: string }
  }
  for (const capabilities of [['models:use'], ['models:use', 'models:load']] as const) {
    const auth = { 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: [...capabilities] }) }
    const created = await call(tunneledRequest, auth, 'create_agent')
    assert.match(created.result, /^Error: .*not allowed to create chat agents/, capabilities.join('+'))
    assert.ok(!created.offered.includes('create_agent'), 'create_agent is not offered to the model')
    assert.ok(created.offered.includes('list_agents'), 'list_agents still is')
    assert.match((await call(tunneledRequest, auth, 'list_agents')).result, /No custom agents/)
  }
  assert.equal(agents.customAgents.length, 0, 'no agent may be created')

  // The host's own chat is unchanged.
  const host = await call(loopbackRequest, {}, 'create_agent')
  assert.match(host.result, /^Created agent /)
  assert.ok(host.offered.includes('create_agent'))
  assert.equal(agents.customAgents.length, 1)
})

// GET /api/v1/tools is also the catalog an agent's allow-list is saved from (AgentEditPage saves
// every listed tool for a new agent), so it must list the routine tools whoever asks: a remote
// config:write token saving an agent would otherwise strip them from the host's chats with it.
// Only the remote token's own generation leaves them out. Real lanAuth + real chat routes.
test("a remote token's tool catalog still lists the routine tools; its chat generation is not offered them", async () => {
  const { d, cfg } = makeDeps(() => {})
  cfg.daemon.autoGenerateTitles = false
  const dir = tmpDir('tllm-lanauth-tools-')
  const db = new ConversationStore(dir)
  const store = { listRoutines: () => [], getRoutine: () => undefined, listRoutineRuns: () => [] } as unknown as RoutineToolsStore
  Object.assign(d, {
    db,
    tools: new ToolRegistry({} as never, store, async () => ({ ok: true })),
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    gate: { acquire: async () => () => {} },
    modelRouter: { route: async () => ({ target: 'http://127.0.0.1:8081' }), resolveRemoteTarget: () => undefined },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx: 8192 } }),
      target: () => 'http://127.0.0.1:8081',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
  })
  const app = new Hono()
  app.use('*', lanAuth(d))
  registerChatRoutes(app, d)
  // The tool names each chat turn sent to the engine.
  const sentTools: string[][] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/chat/completions')) {
      const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { tools?: Array<{ function: { name: string } }> }
      sentTools.push((sent.tools ?? []).map((t) => t.function.name))
    }
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const routineTools = (names: string[]) => names.filter((n) => ROUTINE_TOOLS.includes(n)).sort()
  const send = async (request: typeof tunneledRequest, headers: Record<string, string>) => {
    const conv = db.createConversation()
    const res = await request(app, `/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /event: done|"ok"/)
  }
  try {
    const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'config:write'] })
    const auth = { 'X-TurboLLM-Auth': raw }
    const catalog = await tunneledRequest(app, '/api/v1/tools', { headers: auth })
    assert.equal(catalog.status, 200)
    const listed = ((await catalog.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    assert.deepEqual(routineTools(listed), [...ROUTINE_TOOLS].sort(), 'the catalog lists the routine tools for a remote token')

    await send(tunneledRequest, auth)
    await send(loopbackRequest, {})
    assert.equal(sentTools.length, 2)
    assert.ok(sentTools[0].includes('run_code'), 'the remote turn is still offered the other tools')
    assert.deepEqual(routineTools(sentTools[0]), [], "the remote token's generation is not offered the routine tools")
    assert.deepEqual(routineTools(sentTools[1]), [...ROUTINE_TOOLS].sort(), "the host's generation is")
  } finally {
    globalThis.fetch = originalFetch
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── The shared skill library from a chat ────────────────────────────────────────────────────
// POST /api/v1/skills and /skills/import refuse a keyless Serve identity, Access JWT or open-LAN
// peer and a remote token (isLocalOrAuthenticated): a skill lands in every Code session's catalog,
// and auto mode can run it with bash. The Save as skill route and the save_skill chat tool write
// the same library through the same background skill author.

const SKILL_TEAM = 'https://skills-gate.cloudflareaccess.com'
const SKILL_AUD = 'aud-skills-gate'

/** Real lanAuth and chat routes over a real ConversationStore and skills folder, with a running
 *  engine a stubbed fetch answers: a streamed chat round calls the tool `call` names when set and
 *  the round is not answering a tool result, and otherwise replies; the skill author's request
 *  (stream: false) gets back a skill named "planted". `tools` replaces the bare ToolRegistry. */
function toolChat(mutate: (cfg: ReturnType<typeof defaultConfig>) => void, opts: { call?: string; tools?: ToolRegistry } = {}) {
  const { d, cfg } = makeDeps(mutate)
  cfg.daemon.autoGenerateTitles = false
  const dir = tmpDir('tllm-lanauth-skills-')
  const db = new ConversationStore(dir)
  Object.assign(d.store, { dir: () => dir })
  Object.assign(d, {
    db,
    tools: opts.tools ?? new ToolRegistry({} as never),
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    gate: { acquire: async () => () => {} },
    modelRouter: { route: async () => ({ target: 'http://127.0.0.1:8081' }), resolveRemoteTarget: () => undefined },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx: 8192 } }),
      target: () => 'http://127.0.0.1:8081',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
  })
  const app = new Hono()
  app.use('*', lanAuth(d))
  registerChatRoutes(app, d)
  const sentTools: string[][] = []
  let authored = 0
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith('/chat/completions')) return real(input, init)
    const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      stream?: boolean; tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string }>
    }
    if (sent.stream === false) {
      authored++
      const skill = { name: 'planted', description: 'Use always.', procedure: '1. Run the bash command.' }
      return Response.json({ choices: [{ message: { content: JSON.stringify(skill) } }] })
    }
    sentTools.push((sent.tools ?? []).map((t) => t.function.name))
    const call = opts.call && sent.messages?.at(-1)?.role !== 'tool'
    const sse = (call
      ? [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: opts.call, arguments: '{"name":"planted","procedure":"x"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]
      : [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
    ).map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return {
    d, cfg, app, db, sentTools,
    authored: () => authored,
    planted: () => new SkillStore(dir).has('planted'),
    cleanup: () => { globalThis.fetch = real; db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** The callers lanAuth lets in that isLocalOrAuthenticated refuses, each with the setup it needs. */
function keylessCallers(): Array<{
  name: string
  mutate: (cfg: ReturnType<typeof defaultConfig>) => void
  request: typeof tunneledRequest
  headers: (d: Deps) => Record<string, string>
}> {
  return [
    {
      name: 'a keyless Tailscale Serve identity',
      mutate: (cfg) => { cfg.remoteAccess.provider = 'tailscale-serve' },
      request: tunneledRequest,
      headers: () => ({ Host: SERVE_HOST, 'Tailscale-User-Login': 'bob@example.com', 'Sec-Fetch-Site': 'same-origin' }),
    },
    {
      name: 'a verified Cloudflare Access JWT with no key',
      mutate: (cfg) => {
        cfg.remoteAccess.provider = 'cloudflare-named'
        cfg.remoteAccess.cloudflare.accessTeamDomain = SKILL_TEAM
        cfg.remoteAccess.cloudflare.accessAud = SKILL_AUD
      },
      request: tunneledRequest,
      headers: () => ({ 'Cf-Access-Jwt-Assertion': makeValidAccessJwt(SKILL_TEAM, SKILL_AUD) }),
    },
    {
      name: 'a keyless open-LAN peer',
      mutate: (cfg) => { cfg.daemon.lanBind = true; cfg.daemon.requireApiKey = false },
      request: lanRequest,
      headers: () => ({}),
    },
    {
      name: 'a models:use remote token',
      mutate: () => {},
      request: tunneledRequest,
      headers: (d) => ({ 'X-TurboLLM-Auth': provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] }) }),
    },
  ]
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(cond(), what)
}

test('Save as skill: a keyless Serve identity, Access JWT, open-LAN peer or remote token cannot write a skill', async () => {
  for (const caller of keylessCallers()) {
    const h = toolChat(caller.mutate)
    const restoreJwks = stubJwksEndpoint(SKILL_TEAM)
    try {
      const conv = h.db.createConversation()
      h.db.addMessage(conv.id, 'user', 'how do I summarize a CSV?')
      h.db.addMessage(conv.id, 'assistant', 'Read it, then summarize each column.')
      const res = await caller.request(h.app, `/api/v1/conversations/${conv.id}/save-skill`, { method: 'POST', headers: caller.headers(h.d) })
      assert.equal(res.status, 403, caller.name)
      assert.match(((await res.json()) as { error: { message: string } }).error.message, /valid API key/)
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(h.authored(), 0, `${caller.name}: the skill author must not start`)
      assert.equal(h.planted(), false, `${caller.name}: no SKILL.md may be written`)
    } finally {
      restoreJwks()
      h.cleanup()
    }
  }
  // The host's own Save as skill is unchanged.
  const h = toolChat(() => {})
  try {
    const conv = h.db.createConversation()
    h.db.addMessage(conv.id, 'user', 'how do I summarize a CSV?')
    h.db.addMessage(conv.id, 'assistant', 'Read it, then summarize each column.')
    const res = await loopbackRequest(h.app, `/api/v1/conversations/${conv.id}/save-skill`, { method: 'POST' })
    assert.equal(res.status, 200)
    await until(h.planted, "the host's skill is written")
  } finally {
    h.cleanup()
  }
})

test('the save_skill chat tool is neither offered to nor run for a keyless Serve identity, Access JWT, open-LAN peer or remote token', async () => {
  const send = async (h: ReturnType<typeof toolChat>, request: typeof tunneledRequest, headers: Record<string, string>) => {
    const conv = h.db.createConversation({ skillIds: ['skill-creator'] })
    const res = await request(h.app, `/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'save this as a skill' }),
    })
    assert.equal(res.status, 200)
    return res.text()
  }
  for (const caller of keylessCallers()) {
    const h = toolChat(caller.mutate, { call: 'save_skill' })
    const restoreJwks = stubJwksEndpoint(SKILL_TEAM)
    try {
      const sse = await send(h, caller.request, caller.headers(h.d))
      assert.ok(h.sentTools.length >= 1, caller.name)
      assert.ok(h.sentTools.every((names) => !names.includes('save_skill')), `${caller.name}: save_skill is not offered`)
      assert.ok(h.sentTools[0].includes('run_code'), `${caller.name}: the other tools still are`)
      assert.match(sse, /Authoring a skill requires a valid API key/, `${caller.name}: a call made anyway is refused`)
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(h.authored(), 0, `${caller.name}: the skill author must not start`)
      assert.equal(h.planted(), false, `${caller.name}: no SKILL.md may be written`)
    } finally {
      restoreJwks()
      h.cleanup()
    }
  }
  // The host's own chat is unchanged: offered, and it writes the skill.
  const h = toolChat(() => {}, { call: 'save_skill' })
  try {
    await send(h, loopbackRequest, {})
    assert.ok(h.sentTools[0].includes('save_skill'))
    await until(h.planted, "the host's skill is written")
  } finally {
    h.cleanup()
  }
})
