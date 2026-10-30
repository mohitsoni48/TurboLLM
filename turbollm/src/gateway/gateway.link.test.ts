// Gateway-level coverage for Turbo Link peer-side proxying (ADR-376, phase 2 task 4).
//
// `link-proxy.test.ts` proves the HELPER works. This file proves the GATEWAY actually calls
// it: that a route result carrying `remote` leaves for the host's façade URL with the LINK
// token (never the caller's own credential), that the qualified id is unqualified before it
// travels, and that an inbound client abort reaches the upstream request. Verifying one layer
// in isolation is precisely how this path would ship broken.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { gatewayV1Handler, registerGateway } from './gateway'
import { ModelRouter } from './model-router'
import { lanAuth, provisionRemoteApiKey } from '../auth'
import { defaultConfig, type ApiKey } from '../config/config'
import { registerLinkApi } from '../link/link-routes'
import { registerChatRoutes } from '../chat/chat-routes'
import { ConversationStore } from '../chat/db'
import { tmpDir } from '../test-support/tmp'
import type { Deps } from '../deps'

const REMOTE = { linkId: 'lnk1', baseUrl: 'https://rig.trycloudflare.com', token: 'tllm-hostsecret', modelKey: 'Qwen3' }

function fakeDeps(): Deps {
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target: REMOTE.baseUrl, remote: REMOTE }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => null,
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
      setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'mlx-lm' }) },
    db: { recordApiUsage: () => {} },
  } as unknown as Deps
}

interface Captured { url: string; headers: Headers; body: string; signal: AbortSignal | undefined | null }

/** Swap in a fetch that records the outbound request. `respond` decides what comes back;
 *  a never-resolving promise models a host that is still generating. */
function captureFetch(respond: (cap: Captured) => Promise<Response>): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const cap: Captured = {
      url: String(input),
      headers: new Headers(init?.headers ?? {}),
      body: typeof init?.body === 'string' ? init.body : '',
      signal: init?.signal,
    }
    calls.push(cap)
    return respond(cap)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function jsonCompletion(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

test('/v1/chat/completions on a remote route reaches the façade with the link token', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const f = captureFetch(async () => jsonCompletion())
  try {
    await app.request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-TurboLLM-Auth': 'callers-own-key',
        'x-api-key': 'anthropic-style-key',
        Authorization: 'Bearer someone-elses',
      },
      body: JSON.stringify({ model: 'Rig/Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(f.calls.length, 1)
  const cap = f.calls[0]
  assert.equal(cap.url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  // Invariant 7, at the gateway rather than in the helper's own unit test.
  assert.equal(cap.headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
  assert.equal(cap.headers.get('x-api-key'), null)
  assert.equal(cap.headers.get('authorization'), null)
  // The host routes on ITS own plain key — a qualified id would find no such machine there.
  assert.equal((JSON.parse(cap.body) as { model: string }).model, 'Qwen3')
})

test('/v1/messages on a remote route reaches the façade with the link token', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const f = captureFetch(async () => jsonCompletion())
  try {
    await app.request('http://local.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'anthropic-style-key' },
      body: JSON.stringify({ model: 'Rig/Qwen3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.equal(f.calls[0].headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
  assert.equal(f.calls[0].headers.get('x-api-key'), null)
  assert.equal((JSON.parse(f.calls[0].body) as { model: string }).model, 'Qwen3')
})

// ── Invariant 6, at the gateway: the host must not keep generating into a dead socket.
//
// Run against BOTH proxy sites. They are separate code paths with separate fetch calls
// (`callUpstream()` in the /v1/messages handler, `proxyStream(...)` in gatewayV1Handler), and
// covering only one is precisely how the other ships broken.
async function assertAbortPropagates(path: string, body: Record<string, unknown>): Promise<void> {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  let upstreamAborted = false
  let sawRequest: (() => void) | null = null
  const seen = new Promise<void>((r) => { sawRequest = r })
  const f = captureFetch((cap) => new Promise<Response>((_res, rej) => {
    cap.signal?.addEventListener('abort', () => { upstreamAborted = true; rej(new Error('aborted')) })
    sawRequest?.()
  }))
  const ac = new AbortController()
  try {
    const p = Promise.resolve(app.request(new Request(`http://local.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    }))).catch(() => undefined)
    await seen
    ac.abort()
    await p
  } finally {
    f.restore()
  }
  // Pinned so this stays a test of the REMOTE branch: the local branch has always passed
  // ac.signal, so without this the assertion below could pass while the link path leaked.
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.equal(upstreamAborted, true)
}

test('aborting the inbound request aborts the upstream request to the host (/v1/chat/completions)', async () => {
  await assertAbortPropagates('/v1/chat/completions', { model: 'Rig/Qwen3', messages: [{ role: 'user', content: 'hi' }] })
})

test('aborting the inbound request aborts the upstream request to the host (/v1/messages)', async () => {
  await assertAbortPropagates('/v1/messages', { model: 'Rig/Qwen3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
})

// ── ADR-376: "Rejected — links that chain." ────────────────────────────────────────────────
// A peer sees a host's LOCAL models only. The host runs this same handler behind its façade,
// so without an explicit guard it would relay a third machine's id onward on its own token.

/** The host's façade mount, as link-routes.ts spells it (minus the capability middleware,
 *  which is not what is under test here). */
function facadeApp(deps: Deps): Hono {
  const app = new Hono()
  app.post('/api/link/v1/chat/completions', (c) =>
    gatewayV1Handler(c, deps, { pathname: '/v1/chat/completions', origin: 'link' }))
  return app
}

test('a third machine\'s id through the façade is a typed error, and never relays onward', async () => {
  const f = captureFetch(async () => jsonCompletion())
  let res: Response
  try {
    res = await facadeApp(fakeDeps()).request('http://host.test/api/link/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ThirdBox/Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(res.status, 400)
  const body = await res.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'link_chaining_unsupported')
  assert.match(body.error.message, /only its own local models/)
  // The whole point of a TYPED error over `remote = undefined`: clearing it would leave the id
  // merely unresolved and drop it into local resolution, answering the peer with the HOST's
  // own model — wrong weights, no error. Zero outbound calls proves neither happened: nothing
  // was relayed to the third machine AND nothing reached a local engine.
  assert.equal(f.calls.length, 0)
})

test('the same id on the PUBLIC mount still resolves remotely — the guard is façade-only', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const f = captureFetch(async () => jsonCompletion())
  let res: Response
  try {
    res = await app.request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ThirdBox/Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(res.status, 200)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.equal(f.calls[0].headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
})

// ── Single attribution + no local resource use for a federated generation ─────────────────
// Final-review I-1/I-3/I-4: the peer took the click, the HOST ran the tokens. Nothing on the
// peer may be written from the host's numbers, and nothing on the peer may be RESERVED for
// work its own engine is not doing. All three defects lived on the same branch, so they are
// pinned together against one recording Deps.

interface Ledger {
  gateAcquires: number
  generationStarts: number
  generationEnds: number
  completions: number
  liveGens: number
  apiUsage: number
}

function ledgerDeps(over: { remote?: boolean } = {}): { deps: Deps; ledger: Ledger } {
  const ledger: Ledger = {
    gateAcquires: 0, generationStarts: 0, generationEnds: 0, completions: 0, liveGens: 0, apiUsage: 0,
  }
  const remote = over.remote === false ? undefined : REMOTE
  const deps = {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: {
      targetEntry: () => undefined,
      route: async () => (remote ? { target: REMOTE.baseUrl, remote } : { target: 'http://127.0.0.1:8081' }),
      resolveRemoteTarget: () => undefined,
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    gate: {
      acquire: async () => { ledger.gateAcquires++; return () => {} },
    },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => null,
      currentOpts: () => null,
      generationStart: () => { ledger.generationStarts++ },
      generationEnd: () => { ledger.generationEnds++ },
      recordCompletion: () => { ledger.completions++ },
      setLiveGen: () => { ledger.liveGens++ },
    },
    registry: { active: () => ({ kind: 'mlx-lm' }) },
    db: { recordApiUsage: () => { ledger.apiUsage++ } },
  } as unknown as Deps
  return { deps, ledger }
}

async function drive(deps: Deps, path: string, body: Record<string, unknown>): Promise<Response> {
  const app = new Hono()
  registerGateway(app, deps)
  const f = captureFetch(async () => jsonCompletion())
  try {
    return await app.request(`http://local.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } finally {
    f.restore()
  }
}

for (const [path, body] of [
  ['/v1/chat/completions', { model: 'Rig/Qwen3', messages: [{ role: 'user', content: 'hi' }] }],
  ['/v1/messages', { model: 'Rig/Qwen3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }],
] as const) {
  test(`a remote generation writes nothing into this machine's ledgers (${path})`, async () => {
    const { deps, ledger } = ledgerDeps()
    const res = await drive(deps, path, body as unknown as Record<string, unknown>)
    assert.equal(res.status, 200)
    // Settle the same teed-body drain the local case below waits for, so "nothing was
    // recorded" is a real observation and not just an assertion made too early.
    await new Promise((r) => setTimeout(r, 20))
    // I-3: a remote request touches no local engine, so it must not hold a local slot —
    // the gate is sized to the LOCAL engine's --parallel count.
    assert.equal(ledger.gateAcquires, 0)
    // I-4: the peer's engine card must not read "Generating…" for another box's work, and
    // hostIdleState reads sessionStats().activeRequests, so a false busy there blocks a
    // third machine's legitimate wake.
    assert.equal(ledger.generationStarts, 0)
    assert.equal(ledger.generationEnds, 0)
    assert.equal(ledger.completions, 0)
    assert.equal(ledger.liveGens, 0)
    // I-1: db.recordApiUsage feeds db.gatewayDailyStats, which is emitted as gateway_daily.
    // The host records the same generation behind its façade, through this same code.
    assert.equal(ledger.apiUsage, 0)
  })

  test(`a LOCAL generation still records everything it always did (${path})`, async () => {
    const { deps, ledger } = ledgerDeps({ remote: false })
    const res = await drive(deps, path, { ...(body as object), model: 'Qwen3' } as Record<string, unknown>)
    assert.equal(res.status, 200)
    // The OpenAI path records usage off a TEED copy of the body, which drains after the
    // handler has already returned its Response — so settle before reading the ledger.
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(ledger.gateAcquires, 1)
    assert.equal(ledger.generationStarts, 1)
    assert.equal(ledger.generationEnds, 1)
    assert.equal(ledger.apiUsage, 1)
  })
}

test('a remote request forwards no query string to the host', async () => {
  // M-5: the header set is an allowlist for exactly this reason — a caller that puts a
  // credential in a query parameter must not have it handed to another machine.
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const f = captureFetch(async () => jsonCompletion())
  try {
    await app.request('http://local.test/v1/chat/completions?api_key=callers-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Rig/Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.ok(!f.calls[0].url.includes('callers-secret'))
})

test("a host engine's error body never crosses the façade verbatim", async () => {
  // M-6: llama.cpp error JSON routinely embeds absolute model/binary paths. The status
  // façade was hardened against exactly this; the chat error path was not.
  const { deps } = ledgerDeps({ remote: false })
  const enginePath = '/home/rig/models/Qwen3-35B-Q4_K_M.gguf'
  const f = captureFetch(async () => new Response(
    JSON.stringify({ error: { message: `failed to load model from ${enginePath}` } }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  ))
  let res: Response
  try {
    res = await facadeApp(deps).request('http://host.test/api/link/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  const text = await res.text()
  assert.ok(!text.includes(enginePath), text)
  assert.ok(!text.includes('/home/rig'), text)
  // The failure is still typed and still visible — only the host's free text is withheld.
  assert.equal(JSON.parse(text).error.code, 'engine_error')
  assert.ok(res.status >= 400)
})

test("the SAME engine error is still spelled out in full on the local mount", async () => {
  const { deps } = ledgerDeps({ remote: false })
  const enginePath = '/home/me/models/Qwen3-35B-Q4_K_M.gguf'
  const app = new Hono()
  registerGateway(app, deps)
  const f = captureFetch(async () => new Response(
    JSON.stringify({ error: { message: `failed to load model from ${enginePath}` } }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  ))
  let res: Response
  try {
    res = await app.request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  // Same machine, same user — the diagnostic is theirs to read.
  assert.ok((await res.text()).includes(enginePath))
})

test("a host reply fetch already decompressed is not relayed with the host's content-encoding", async () => {
  // fetch decodes a gzip/br body (Cloudflare's edge compresses JSON for a client that accepts it) but keeps the
  // header. Relayed as-is, the peer's client tried to gunzip plain JSON: "incorrect header check".
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const body = JSON.stringify({ choices: [{ message: { content: 'hi' } }] })
  const f = captureFetch(async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '57' },
  }))
  let res: Response
  try {
    res = await app.request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Rig/Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(res.headers.get('content-encoding'), null)
  assert.equal(res.headers.get('content-length'), null)
  assert.equal(await res.text(), body)
})

test("a remote stream drops the usage chunk only this machine asked the host for", async () => {
  // The peer injects `stream_options.include_usage` (the host then honours it as the caller's own), so the
  // `choices: []` chunk has to come off on THIS side — the tee that filters a local stream never runs for a remote one.
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const f = captureFetch(async () => new Response(
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n' +
    'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  ))
  let res: Response
  try {
    res = await app.request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Rig/Qwen3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.deepEqual(JSON.parse(f.calls[0].body).stream_options, { include_usage: true })
  assert.equal(await res.text(), 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
})

// ── A remote-access token without models:load must not load a model on a LINKED machine either ──────────────────
// Locally the router answers such a caller "not loaded" instead of auto-swapping (auth.ts modelLoadsRefused). A
// qualified `<machine>/<model>` id used to return the linked target before that check, and the request then left with
// THIS daemon's link token: a link granted models:load had the host swap models for a caller that may load none.
// Composed for real: lanAuth (which marks the request), the gateway, and the ModelRouter with a catalog stub.

const INGRESS_PORT = 6997

function linkedRouterDeps(advertised: { key: string; loaded: boolean }) {
  const cfg = defaultConfig()
  const link = {
    id: 'lnk1', name: 'rig', baseUrl: 'https://rig.trycloudflare.com', token: 'tllm-hostsecret', machineId: 'm1',
    grantedCapabilities: ['models:use', 'models:load'], linkApiVersion: 1, status: 'online', lastSeenAt: null, lastError: null,
  }
  const remoteModel = { key: advertised.key, name: advertised.key, quant: null, nativeCtx: 8192, vision: false, loaded: advertised.loaded }
  const catalog = {
    linkByName: (n: string) => (n.toLowerCase() === 'rig' ? link : undefined),
    modelOn: (id: string, key: string) => (id === link.id && key === remoteModel.key ? remoteModel : undefined),
  }
  const store = { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) }
  const manager = fakeDeps().manager
  const scanner = { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined }
  const router = new ModelRouter(store as never, {} as never, manager as never, scanner as never, undefined, catalog as never)
  return {
    ...fakeDeps(),
    store,
    scanner,
    modelRouter: router,
    remote: { ingressPort: () => INGRESS_PORT, activeProvider: () => cfg.remoteAccess.provider },
  } as unknown as Deps
}

async function tunneledChat(d: Deps, token: string, path: '/v1/chat/completions' | '/v1/messages'): Promise<{ res: Response; calls: Captured[] }> {
  const app = new Hono()
  app.use('*', lanAuth(d))
  registerGateway(app, d)
  const f = captureFetch(async () => jsonCompletion())
  try {
    const res = await app.request(`http://local.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-TurboLLM-Auth': token },
      body: JSON.stringify({ model: 'rig/big-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    }, { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
    return { res, calls: f.calls }
  } finally {
    f.restore()
  }
}

for (const path of ['/v1/chat/completions', '/v1/messages'] as const) {
  test(`${path}: a models:use-only remote token cannot make a linked machine load a model`, async () => {
    const d = linkedRouterDeps({ key: 'big-model', loaded: false })
    const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
    const { res, calls } = await tunneledChat(d, token, path)
    assert.equal(res.status, 503)
    assert.match(await res.text(), /may not load models/)
    assert.equal(calls.length, 0, 'nothing may go out to the linked machine')
    // Permanent for this caller: a retry would be refused the same way.
    assert.equal(res.headers.get('x-should-retry'), 'false')
  })

  test(`${path}: the same token still uses a model already loaded on the linked machine`, async () => {
    const d = linkedRouterDeps({ key: 'big-model', loaded: true })
    const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
    const { res, calls } = await tunneledChat(d, token, path)
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
    // ...marked, so the host serves it only while it is still loaded there (see the composed test below).
    assert.equal(calls[0].headers.get('X-TurboLLM-Link-No-Load'), '1')
  })

  test(`${path}: a remote token WITH models:load still reaches a linked model that is not loaded`, async () => {
    const d = linkedRouterDeps({ key: 'big-model', loaded: false })
    const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use', 'models:load'] })
    const { res, calls } = await tunneledChat(d, token, path)
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('X-TurboLLM-Link-No-Load'), null)
  })
}

// The peer's check reads its catalog, which refreshes every 15 s; the host acts on its live state. In between, a
// models:use token's next request switched back a host whose owner had just switched models, and in-app chat repeats
// the request for every tool round of a turn. The peer now marks the request (link-proxy.ts LINK_NO_LOAD_HEADER) and
// the host's façade refuses it on its live state. Composed for real on both sides: the peer's lanAuth, gateway and
// router, and the host's façade (link-routes.ts), joined by a fetch that hands the peer's request to the host.
test('a models:use token cannot switch a linked machine back to the model its catalog last saw loaded', async () => {
  const d = linkedRouterDeps({ key: 'big-model', loaded: true }) // the peer's last refresh
  const token = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  const hostLoaded = 'other-model' // the host's owner has switched since
  const hostRouted: string[] = []
  const linkKey: ApiKey = {
    id: 'k1', name: 'peer', hash: createHash('sha256').update('tllm-hostsecret').digest('hex'), prefix: 'tllm-hostsec',
    createdAt: 'c', lastUsedAt: null, grant: { capabilities: ['models:use', 'models:load'] },
  }
  const hostCfg = {
    apiKeys: [linkKey], links: [], gateway: { autoSwap: true }, modelDefaults: { maxTokens: 0 },
    daemon: { lanBind: true, requireApiKey: true, machineId: 'host-1', experimental: { turboLink: true } },
  }
  const hostDeps = {
    version: '1.14.7',
    store: { snapshot: () => hostCfg, update: (fn: (c: never) => void) => fn(hostCfg as never) },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    db: { recordApiUsage: () => {} },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    modelRouter: {
      targetEntry: () => undefined,
      route: async (m: string) => { hostRouted.push(m); return { target: 'http://host-engine.local' } },
      resolveRemoteTarget: () => undefined,
    },
    manager: {
      status: () => ({ state: 'running', model: { key: hostLoaded } }),
      target: () => 'http://host-engine.local',
      currentOpts: () => ({ modelPath: '' }),
      sessionStats: () => ({ activeRequests: 0 }),
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
    },
  } as unknown as Deps
  const host = new Hono()
  registerLinkApi(host, hostDeps)
  const peer = new Hono()
  peer.use('*', lanAuth(d))
  registerGateway(peer, d)
  const original = globalThis.fetch
  let hostCalls = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://rig.trycloudflare.com/')) {
      hostCalls++
      return host.request(url.slice('https://rig.trycloudflare.com'.length), { method: init?.method, headers: init?.headers, body: init?.body })
    }
    return jsonCompletion() // the host's own engine
  }) as typeof fetch
  try {
    const res = await peer.request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-TurboLLM-Auth': token },
      body: JSON.stringify({ model: 'rig/big-model', messages: [{ role: 'user', content: 'hi' }] }),
    }, { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
    assert.equal(res.status, 503)
    // The answer the peer gives itself when its catalog is current: final, and typed the same way.
    assert.equal(res.headers.get('x-should-retry'), 'false')
    const error = ((await res.json()) as { error?: { type?: string; code?: string; message?: string } }).error
    assert.equal(error?.type, 'model_not_loaded')
    assert.equal(error?.code, 'model_not_loaded')
    assert.match(error?.message ?? '', /not loaded on this machine/, 'the host refused it, on its live state')
    assert.equal(hostCalls, 1)
    assert.deepEqual(hostRouted, [], "the host never reached its auto-swap: the owner's model stays")
  } finally {
    globalThis.fetch = original
  }
})

// A refusal the host marks final (x-should-retry: false: a permanent route refusal such as a failed engine start, or
// the no-load refusal above) must reach a /v1/messages client as it reaches a /v1/chat/completions one. Claude Code
// retries a 5xx up to 10 times otherwise, and on a link granted models:load each retry runs the failing load again.
test("the host's x-should-retry: false reaches the client on /v1/messages, as on /v1/chat/completions", async () => {
  const d = fakeDeps()
  const app = new Hono()
  // /v1/messages reads a failed reply through redactLocalPaths, which asks the store for the data dir.
  registerGateway(app, { ...d, store: { ...d.store, dir: () => '/data' } } as unknown as Deps)
  const f = captureFetch(async () => new Response(
    JSON.stringify({ error: { message: 'Engine start failed: boom', type: 'model_not_loaded', code: 'model_not_loaded' } }),
    { status: 503, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } },
  ))
  try {
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const res = await app.request(`http://local.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Rig/Qwen3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 503, path)
      assert.equal(res.headers.get('x-should-retry'), 'false', path)
    }
  } finally {
    f.restore()
  }
  assert.deepEqual(f.calls.map((cap) => cap.url), Array(2).fill('https://rig.trycloudflare.com/api/link/v1/chat/completions'))
})

// The same check covers in-app chat: /api/v1/conversations/* is models:use for a remote token, and the turn resolves
// its remote target through the same router. Every request of the turn is built from that target, so the marker
// travels on all of them.
for (const loaded of [false, true]) {
  test(`in-app chat: a models:use remote token and a linked model that is ${loaded ? '' : 'not '}loaded`, async () => {
    const d = linkedRouterDeps({ key: 'big-model', loaded })
    const dir = tmpDir('tllm-gw-link-chat-')
    const db = new ConversationStore(dir)
    const cfg = d.store.snapshot() as unknown as Record<string, unknown>
    cfg.daemon = { ...(cfg.daemon as object), autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false }
    const chatDeps = {
      ...d,
      db,
      remoteCatalog: { modelOn: () => ({ key: 'big-model', name: 'Big', quant: null, nativeCtx: 8192, vision: false, loaded }) },
    } as unknown as Deps
    const token = provisionRemoteApiKey(chatDeps, { kind: 'remote', capabilities: ['models:use'] })
    const app = new Hono()
    app.use('*', lanAuth(chatDeps))
    registerChatRoutes(app, chatDeps)
    const f = captureFetch(async () => new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }))
    try {
      const conv = db.createConversation()
      const res = await app.request(`http://local.test/api/v1/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-TurboLLM-Auth': token },
        body: JSON.stringify({ content: 'hi', model: 'rig/big-model' }),
      }, { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
      const text = await res.text()
      if (!loaded) {
        assert.equal(res.status, 503, text)
        assert.match(text, /remote_unavailable/)
        assert.match(text, /may not load models/)
        assert.equal(f.calls.length, 0, 'nothing may go out to the linked machine')
      } else {
        assert.equal(res.status, 200, text)
        assert.ok(f.calls.length >= 1)
        for (const call of f.calls) assert.equal(call.headers.get('X-TurboLLM-Link-No-Load'), '1', call.url)
      }
    } finally {
      f.restore()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
