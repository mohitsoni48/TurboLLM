// Gateway-level coverage for Turbo Link peer-side proxying (ADR-376, phase 2 task 4).
//
// `link-proxy.test.ts` proves the HELPER works. This file proves the GATEWAY actually calls
// it: that a route result carrying `remote` leaves for the host's façade URL with the LINK
// token (never the caller's own credential), that the qualified id is unqualified before it
// travels, and that an inbound client abort reaches the upstream request. Verifying one layer
// in isolation is precisely how this path would ship broken.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { gatewayV1Handler, registerGateway } from './gateway'
import type { Deps } from '../deps'

const REMOTE = { linkId: 'lnk1', baseUrl: 'https://rig.trycloudflare.com', token: 'tllm-hostsecret', modelKey: 'Qwen3' }

function fakeDeps(): Deps {
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: REMOTE.baseUrl, remote: REMOTE }) },
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
