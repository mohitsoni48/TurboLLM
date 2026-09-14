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
import { lanAuth, hostGate, hashKey, provisionRemoteApiKey } from './auth'
import { defaultConfig } from './config/config'
import type { Deps } from './deps'

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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `${teamDomain}/cdn-cgi/access/certs`) {
      return new Response(ACCESS_JWKS_BODY, { status: 200 })
    }
    return real(input, init)
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

const INGRESS_PORT = 6997

function makeDeps(mutate: (cfg: ReturnType<typeof defaultConfig>) => void): { d: Deps; cfg: ReturnType<typeof defaultConfig> } {
  const cfg = defaultConfig()
  mutate(cfg)
  const d = {
    store: {
      snapshot: () => cfg,
      update: (fn: (c: typeof cfg) => void) => fn(cfg),
    },
    remote: { ingressPort: () => INGRESS_PORT },
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
  return app
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
    headers: { 'Tailscale-User-Login': 'bob@example.com' },
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
    headers: { 'Tailscale-User-Login': 'bob@example.com' },
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
    headers: { 'Tailscale-User-Login': 'sam@example.com' },
  })
  assert.equal(res.status, 200, 'Access is genuinely not in a Serve request\'s path — this is intended, not a bypass')
})
