// GET /api/v1/app-proof (server.ts, appSecretProof in auth.ts): TurboLLM-Android asks whoever
// holds 127.0.0.1:7000 to prove it is the daemon the app started BEFORE it sends the app secret
// anywhere. Any app on the phone can listen there while the daemon does not (before it binds at
// launch, during a LAN-toggle rebind), and a secret sent to it stays valid for the daemon's whole
// life. Drives the REAL createApp, because what matters is that the route answers ahead of lanAuth
// (the app holds no credential it may send yet) and that nothing it returns opens that gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { Hono } from 'hono'
import { createApp, registerSpaFallback } from './server'
import type { Deps } from './deps'

const SECRET = 'b'.repeat(64)
const NONCE = '0123456789abcdef'.repeat(4) // 64 hex characters, as the app sends

function mkDeps(daemon: Record<string, unknown> = {}): Deps {
  // Same minimal double as server.route-order.test.ts: createApp wires every route module, some of
  // which touch the DB at registration time; this test is about the auth order only.
  const cfg: Record<string, unknown> = {
    apiKeys: [],
    links: [],
    daemon: { lanBind: false, requireApiKey: true, machineId: 'machine-test', port: 6996, ...daemon },
  }
  return {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '.' },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
  } as unknown as Deps
}

function mkApp(d: Deps = mkDeps()): Hono {
  const app = createApp(d)
  registerSpaFallback(app)
  return app
}

type Socket = { localAddress: string; localPort: number; remoteAddress: string }
const LOOPBACK: Socket = { localAddress: '127.0.0.1', localPort: 7000, remoteAddress: '127.0.0.1' }

function get(app: Hono, path: string, socket: Partial<Socket> = {}, headers: Record<string, string> = {}) {
  return app.request(path, { headers }, {
    incoming: { socket: { ...LOOPBACK, remotePort: 55555, remoteFamily: 'IPv4', ...socket } },
  } as never)
}

/** What the app computes (DaemonAuth.kt) for the daemon it expects at 127.0.0.1:7000. */
function expected(nonce: string, secret = SECRET, at = '127.0.0.1:7000'): string {
  return createHmac('sha256', secret).update(`turbollm-app-proof\n${at}\n${nonce}`).digest('hex')
}

async function withSecret(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.TURBOLLM_APP_SECRET
  if (value === undefined) delete process.env.TURBOLLM_APP_SECRET
  else process.env.TURBOLLM_APP_SECRET = value
  try {
    await fn()
  } finally {
    if (saved === undefined) delete process.env.TURBOLLM_APP_SECRET
    else process.env.TURBOLLM_APP_SECRET = saved
  }
}

test('without TURBOLLM_APP_SECRET (desktop, npm, Docker) the route does not exist', async () => {
  for (const value of [undefined, '']) {
    await withSecret(value, async () => {
      const res = await get(mkApp(), `/api/v1/app-proof?nonce=${NONCE}`)
      assert.equal(res.status, 404)
      assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'Unknown endpoint.' } })
    })
  }
})

test('with the secret set, a fresh nonce is answered with HMAC-SHA256(secret, nonce) and no credential is needed', () =>
  withSecret(SECRET, async () => {
    const app = mkApp()
    // The gate is really closed to this caller: no secret, no key.
    assert.equal((await get(app, '/api/v1/status')).status, 401)
    const res = await get(app, `/api/v1/app-proof?nonce=${NONCE}`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { proof: expected(NONCE) })
    // Bound to the nonce: another nonce gets another answer, so a recorded answer is no use later.
    const other = 'f'.repeat(64)
    const res2 = await get(app, `/api/v1/app-proof?nonce=${other}`)
    const { proof } = (await res2.json()) as { proof: string }
    assert.equal(proof, expected(other))
    assert.notEqual(proof, expected(NONCE))
    // Bound to the secret: a daemon started with another secret cannot answer for this app.
    assert.notEqual(expected(NONCE), expected(NONCE, 'c'.repeat(64)))
  }))

test('the proof names the socket it was asked on, so it cannot be relayed from another listener', () =>
  withSecret(SECRET, async () => {
    const app = mkApp(mkDeps({ lanBind: true }))
    const proofVia = async (socket: Partial<Socket>) =>
      ((await (await get(app, `/api/v1/app-proof?nonce=${NONCE}`, socket)).json()) as { proof: string }).proof
    // The remote-access ingress (another loopback port serving the same app) and another address on
    // port 7000 each give an answer the app, which expects 127.0.0.1:7000, rejects.
    assert.equal(await proofVia({ localPort: 6997 }), expected(NONCE, SECRET, '127.0.0.1:6997'))
    assert.notEqual(await proofVia({ localPort: 6997 }), expected(NONCE))
    assert.notEqual(await proofVia({ localAddress: '::1' }), expected(NONCE))
    assert.notEqual(await proofVia({ localAddress: '192.168.1.5', remoteAddress: '192.168.1.50' }), expected(NONCE))
    // A dual-stack listener reports IPv4 loopback in its mapped form: still 127.0.0.1.
    assert.equal(await proofVia({ localAddress: '::ffff:127.0.0.1' }), expected(NONCE))
  }))

test('a missing or malformed nonce gets a 400 and no proof', () =>
  withSecret(SECRET, async () => {
    const app = mkApp()
    for (const q of [
      '', '?nonce=', `?nonce=${'a'.repeat(31)}`, `?nonce=${'a'.repeat(129)}`, `?nonce=${NONCE.toUpperCase()}`,
      `?nonce=${'g'.repeat(64)}`, `?nonce=${encodeURIComponent(`${NONCE}\n127.0.0.1:7000\n${NONCE}`)}`,
    ]) {
      const res = await get(app, `/api/v1/app-proof${q}`)
      assert.equal(res.status, 400, q)
      const body = (await res.json()) as Record<string, unknown>
      assert.equal(body.proof, undefined, q)
    }
  }))

test('the answer cannot be used as the secret, as header or cookie', () =>
  withSecret(SECRET, async () => {
    const app = mkApp()
    const res = await get(app, `/api/v1/app-proof?nonce=${NONCE}`)
    assert.equal(res.status, 200)
    const { proof } = (await res.json()) as { proof: string }
    assert.match(proof, /^[0-9a-f]{64}$/)
    assert.equal((await get(app, '/api/v1/status', {}, { 'X-TurboLLM-App': proof })).status, 401)
    assert.equal((await get(app, '/api/v1/status', {}, { Cookie: `turbollm_app=${proof}` })).status, 401)
    // Nor can the nonce the caller chose.
    assert.equal((await get(app, '/api/v1/status', {}, { 'X-TurboLLM-App': NONCE })).status, 401)
    // The real secret still passes the gate (the handler behind it may fail on this test double).
    assert.notEqual((await get(app, '/api/v1/status', {}, { 'X-TurboLLM-App': SECRET })).status, 401)
  }))
