// Code over a Turbo Link, end to end, WITHOUT a second machine (ADR-376).
//
// The feature shipped unit-tested only against `resolveCodeUpstream`'s return value — nobody
// ever asked whether the URL in that value is a URL a real host answers. It is not: the field
// report was "chat over the link works, Code doesn't", and the reason is one line. So this
// suite deliberately does NOT assert on the resolver's shape (code-upstream.test.ts does
// that). It stands up a real HOST — `lanAuth` + `linkAuth` + the real façade routes + the
// shared `gatewayV1Handler`, composed in createApp's order — and drives it with a request
// built exactly the way pi's openai client builds one FROM `resolveCodeUpstream`'s output.
//
// "Exactly the way pi builds one" is the whole point (see `piFetch`): the openai SDK sends
// `Authorization: Bearer <apiKey>` unconditionally, appends `/chat/completions` to `baseUrl`,
// and — for a Code turn, unlike a chat turn — carries `tools`, prior `tool_calls`, a `tool`
// result message, and `stream: true`. Every one of those is a difference from the chat path
// that had never been exercised against the façade.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi, registerLinkAuth } from '../link/link-routes'
import { resetLocalActivity } from '../link/host-idle'
import { lanAuth } from '../auth'
import { resolveCodeUpstream } from './code-upstream'
import type { CodePiProvider } from './code-upstream'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'

const HOST_BASE = 'http://rig.local'
const LINK_TOKEN = 'tllm-linksecret'
const HOST_MODEL = 'qwen3-35b'

// ── The HOST ────────────────────────────────────────────────────────────────────────────

function grantedKey(raw: string, caps: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    grant: { capabilities: caps as never },
  }
}

interface HostHarness {
  /** Model ids the host's own router was asked for — i.e. the request reached the façade. */
  routed: string[]
  /** Set when the request landed on the host's PUBLIC /v1 mount instead of the façade. */
  hitPublicMount: boolean
  /** What the host actually sent to its engine. */
  toEngine: { url: string; body: string } | null
}

/** The host's config. `lanBind + requireApiKey` is the configuration every real Turbo Link
 *  host runs in, and the one where the old Code URL fails; `requireApiKey: false` is the
 *  "open LAN" variant, where it fails differently and far worse (it succeeds). */
function mkHost(opts: { requireApiKey?: boolean } = {}): { d: Deps; h: HostHarness; app: Hono } {
  const h: HostHarness = { routed: [], hitPublicMount: false, toEngine: null }
  const cfg: Record<string, unknown> = {
    apiKeys: [grantedKey(LINK_TOKEN, ['models:use'])],
    links: [],
    daemon: {
      lanBind: true,
      requireApiKey: opts.requireApiKey ?? true,
      machineId: 'machine-rig',
      experimental: { turboLink: true },
    },
    gateway: { autoSwap: true },
    modelDefaults: { maxTokens: 0 },
  }
  const d = {
    version: '1.12.1',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    db: { recordApiUsage: () => {}, getConversation: () => null, getAgentRun: () => null },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    modelRouter: {
      route: async (m: string) => { h.routed.push(m); return { target: 'http://engine.local' } },
      resolveRemoteTarget: () => undefined,
    },
    manager: {
      status: () => ({ state: 'running', model: { key: HOST_MODEL } }),
      target: () => 'http://engine.local',
      currentOpts: () => ({ modelPath: '' }),
      sessionStats: () => ({ activeRequests: 0 }),
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
    },
  } as unknown as Deps

  // createApp's real order (server.ts): lanAuth over everything, then the façade's own gate,
  // then the façade routes, then the PUBLIC gateway mount. Composing only the façade would
  // hide the entire defect — the old URL never reaches a façade route at all.
  const app = new Hono()
  app.use('*', lanAuth(d))
  registerLinkAuth(app, d)
  registerLinkApi(app, d, { authAlreadyRegistered: true })
  app.post('/v1/chat/completions', (c) => {
    // Stands in for registerGateway's public mount. Reaching this from a link token is
    // itself the finding: it is ungated by capability, allowlist, wake state and chaining.
    h.hitPublicMount = true
    return c.json({ id: 'public', choices: [] })
  })
  return { d, h, app }
}

// ── The PEER ────────────────────────────────────────────────────────────────────────────

const REMOTE = { linkId: 'lnk1', baseUrl: HOST_BASE, token: LINK_TOKEN, modelKey: HOST_MODEL }

/** A peer with NO local engine at all — the configuration Turbo Link exists to serve. */
function peerDeps(): Deps {
  return {
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => '',
      currentOpts: () => ({ modelPath: '' }),
    },
    registry: { active: () => ({ kind: 'llama-server' }) },
    modelRouter: { resolveRemoteTarget: () => ({ target: HOST_BASE, remote: REMOTE }) },
    remoteCatalog: { modelOn: () => ({ key: HOST_MODEL, name: 'Qwen3 35B', nativeCtx: 131072 }) },
  } as unknown as Deps
}

/** A Code-shaped chat-completions body: tool definitions, a prior assistant `tool_calls`
 *  turn, its `tool` result, and `stream: true`. A chat turn sends none of this — which is
 *  why "chat works" was never evidence that Code would. */
function codeShapedBody(model: string): Record<string, unknown> {
  return {
    model,
    stream: true,
    messages: [
      { role: 'user', content: 'rename the helper in src/util.ts' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ path: 'src/util.ts' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'export function helper() {}' },
    ],
    tools: [
      { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      { type: 'function', function: { name: 'edit', description: 'edit a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ],
  }
}

/**
 * Issue the request the way pi's openai client actually issues it, from a resolved provider.
 *
 * The two details that matter and that a shape-only assertion cannot catch:
 *  - the SDK appends `/chat/completions` to `baseUrl` verbatim, so `baseUrl` must be the
 *    façade prefix, not the host's public one; and
 *  - `new OpenAI({ apiKey })` sets `Authorization: Bearer <apiKey>` on EVERY request,
 *    independently of pi's `authHeader` flag (which only adds a second one).
 */
async function piFetch(app: Hono, provider: CodePiProvider, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${provider.apiKey}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(provider.headers ?? {}),
  }
  if (provider.authHeader) headers.authorization = `Bearer ${provider.apiKey}`
  return app.request(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

// ── The host's engine, stubbed as a REAL chunked SSE stream ──────────────────────────────

const realFetch = globalThis.fetch
let toEngine: { url: string; body: string } | null = null
/** Resolved by the test once it has read the FIRST chunk; the engine withholds the second
 *  until then. A façade that buffered the body would never see this resolve — the read below
 *  is bounded so that shows up as a failed assertion rather than a hung suite. */
let releaseSecond: (() => void) | null = null

beforeEach(() => {
  resetLocalActivity()
  toEngine = null
  releaseSecond = null
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    toEngine = { url: String(u), body: String(init?.body ?? '') }
    const gate = new Promise<void>((r) => { releaseSecond = r })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'))
        await gate
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"second"}}]}\n\n'))
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof globalThis.fetch
})
afterEach(() => { globalThis.fetch = realFetch; releaseSecond?.() })

/** Read one SSE chunk with a bound, so "the response never arrives until the engine is done"
 *  fails loudly instead of hanging the runner. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const timeout = new Promise<never>((_, rej) => {
    const t = setTimeout(() => rej(new Error('no chunk within 2s — the response was buffered, not streamed')), 2000)
    t.unref?.()
  })
  const { value } = await Promise.race([reader.read(), timeout])
  return new TextDecoder().decode(value)
}

// ── The round trip ───────────────────────────────────────────────────────────────────────

test('a Code turn resolved on the peer reaches the host FAÇADE and is served', async () => {
  const { h, app } = mkHost()
  const up = resolveCodeUpstream(peerDeps(), 'rig/qwen3-35b')

  const res = await piFetch(app, up.provider, codeShapedBody(up.modelId))

  assert.equal(res.status, 200)
  assert.equal(h.hitPublicMount, false, 'a link token must never reach the ungated public /v1 mount')
  assert.deepEqual(h.routed, [HOST_MODEL], 'went through the façade, capability check and all')
})

test('the pre-fix URL is exactly the 401 the field reported — chat worked, Code did not', async () => {
  // The regression pin. `<base>/v1` is the host's PUBLIC gateway; a link token carries a
  // grant, so isFacadeOnlyKey makes verifyKeyValue treat it as no match and lanAuth refuses.
  // Chat never hit this because its transport is proxyStream/buildUpstream, which spells the
  // façade URL for it.
  const { h, app } = mkHost()
  const up = resolveCodeUpstream(peerDeps(), 'rig/qwen3-35b')
  const preFix = { ...up.provider, baseUrl: `${REMOTE.baseUrl}/v1` }

  const res = await piFetch(app, preFix, codeShapedBody(up.modelId))

  assert.equal(res.status, 401)
  assert.deepEqual(h.routed, [], 'never reached the router, so never generated a token')
})

test('on an OPEN LAN the pre-fix URL SUCCEEDS, bypassing the whole capability grant', async () => {
  // The half that is worse than a 401: with requireApiKey off, lanAuth lets it straight
  // through to the public mount — no models:use check, no model allowlist, no wake gate, no
  // chaining refusal. A models:use-only token would have been able to swap the host's model.
  const { h, app } = mkHost({ requireApiKey: false })
  const up = resolveCodeUpstream(peerDeps(), 'rig/qwen3-35b')
  const preFix = { ...up.provider, baseUrl: `${REMOTE.baseUrl}/v1` }

  await piFetch(app, preFix, codeShapedBody(up.modelId))
  assert.equal(h.hitPublicMount, true, 'pins WHY the fix is not cosmetic')

  // The fixed URL is gated on the same host.
  h.hitPublicMount = false
  const ok = await piFetch(app, up.provider, codeShapedBody(up.modelId))
  assert.equal(ok.status, 200)
  assert.equal(h.hitPublicMount, false)
  assert.deepEqual(h.routed, [HOST_MODEL])
})

test("the link token never travels in Authorization, only in the façade's own header", async () => {
  const { app } = mkHost()
  const up = resolveCodeUpstream(peerDeps(), 'rig/qwen3-35b')

  let seen: Headers | null = null
  const spy = new Hono()
  spy.all('*', async (c) => { seen = c.req.raw.headers; return app.fetch(c.req.raw) })
  await piFetch(spy, up.provider, codeShapedBody(up.modelId))

  const h = seen as unknown as Headers
  assert.equal(h.get('x-turbollm-auth'), LINK_TOKEN)
  assert.ok(!(h.get('authorization') ?? '').includes(LINK_TOKEN), 'the peer secret must not be the host bearer')
})

test('a Code turn survives the façade with its tool calls intact, byte for byte', async () => {
  // The façade parses the body for gating and gatewayV1Handler parses it AGAIN; a Code turn
  // is where that double read has something to lose. `tools` also makes the host build its
  // openAiRequestView/analyzeTurn scaffolding, a path a plain chat turn never takes.
  const { app } = mkHost()
  const up = resolveCodeUpstream(peerDeps(), 'rig/qwen3-35b')

  const res = await piFetch(app, up.provider, codeShapedBody(up.modelId))
  assert.equal(res.status, 200)

  assert.ok(toEngine, 'the host reached its engine')
  const sent = JSON.parse(toEngine!.body) as Record<string, unknown>
  const tools = sent.tools as Array<{ function: { name: string } }>
  assert.deepEqual(tools.map((t) => t.function.name), ['read', 'edit'], 'tool DEFINITIONS crossed')
  const msgs = sent.messages as Array<Record<string, unknown>>
  const call = msgs.find((m) => m.role === 'assistant')?.tool_calls as Array<{ id: string }>
  assert.equal(call[0].id, 'call_1', 'the prior tool CALL crossed')
  assert.equal(msgs.find((m) => m.role === 'tool')?.tool_call_id, 'call_1', 'the tool RESULT crossed')
  assert.equal(sent.model, HOST_MODEL, 'unqualified on the host — a <machine>/ prefix names nothing there')
})

test('the host relays SSE chunk by chunk — the agent loop is not fed one blob at the end', async () => {
  // The property an agentic turn actually depends on. If any layer buffered, `first` would
  // not be readable until the engine finished, and the engine here does not finish until the
  // test says so — readChunk's bound turns that deadlock into a failed assertion.
  const { app } = mkHost()
  const up = resolveCodeUpstream(peerDeps(), 'rig/qwen3-35b')

  const res = await piFetch(app, up.provider, codeShapedBody(up.modelId))
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()

  const first = await readChunk(reader)
  assert.match(first, /first/, 'the first token arrived while the host was still generating')

  releaseSecond!()
  const second = await readChunk(reader)
  assert.match(second, /second/)
  await reader.cancel()
})

test('a Code turn from a token WITHOUT models:use is refused by the façade, not silently served', async () => {
  const { d, h, app } = mkHost()
  ;(d.store.snapshot() as unknown as { apiKeys: ApiKey[] }).apiKeys =
    [grantedKey(LINK_TOKEN, ['downloads:read'])]
  const up = resolveCodeUpstream(peerDeps(), 'rig/qwen3-35b')

  const res = await piFetch(app, up.provider, codeShapedBody(up.modelId))
  assert.equal(res.status, 403)
  assert.deepEqual(h.routed, [])
  assert.equal(h.hitPublicMount, false)
})
