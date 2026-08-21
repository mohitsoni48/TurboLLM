// The façade's POST /api/link/v1/chat/completions and its wake gating (spec §5.5).
//
// Every failure here asserts the error CODE, not just the status. A peer renders
// `host_busy` ("in use locally, try again shortly") and `model_not_loaded` ("this link
// may not load it") as different, differently-actionable states; collapsing both into a
// bare 503 is the bug these tests exist to catch.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi } from './link-routes'
import { resetLocalActivity } from './host-idle'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'

const LOADED = 'gemma-27b'
const COLD = 'qwen3-35b'

function key(raw: string, caps?: string[], models?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never, models } } : {}),
  }
}

interface Harness { routed: string[] }

function mkDeps(keys: ApiKey[], opts: { busy?: boolean; loaded?: string | null } = {}): { d: Deps; h: Harness } {
  const h: Harness = { routed: [] }
  const loaded = opts.loaded === undefined ? LOADED : opts.loaded
  const cfg: Record<string, unknown> = {
    apiKeys: keys, links: [], daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc' },
    gateway: { autoSwap: true }, modelDefaults: { maxTokens: 0 },
  }
  const d = {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    db: { recordApiUsage: () => {} },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    modelRouter: {
      route: async (m: string) => { h.routed.push(m); return { target: 'http://engine.local' } },
      // This box has no links of its own, so nothing a peer asks for can be a second hop.
      resolveRemoteTarget: () => undefined,
    },
    manager: {
      status: () => ({ state: 'running', model: loaded ? { key: loaded } : null }),
      target: () => 'http://engine.local',
      currentOpts: () => ({ modelPath: '' }),
      // The one live signal the wake gate reads for "mid-generation".
      sessionStats: () => ({ activeRequests: opts.busy ? 1 : 0 }),
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
    },
  } as unknown as Deps
  return { d, h }
}

function app(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

function post(d: Deps, token: string, model: string) {
  return app(d).request('/api/link/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': token, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
}

const realFetch = globalThis.fetch
/** What the shared gateway handler actually sent to the engine, for the round-trip check. */
let upstream: { url: string; body: string } | null = null
beforeEach(() => {
  resetLocalActivity()
  upstream = null
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    upstream = { url: String(u), body: String(init?.body ?? '') }
    return new Response(
    JSON.stringify({ id: 'c1', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof globalThis.fetch
})
afterEach(() => { globalThis.fetch = realFetch })

async function errorCode(res: Response): Promise<string | undefined> {
  const body = await res.json() as { error?: { code?: string } }
  return body.error?.code
}

test('models:use on an already-loaded model succeeds', async () => {
  const { d, h } = mkDeps([key('tllm-a', ['models:use'])])
  const res = await post(d, 'tllm-a', LOADED)
  assert.equal(res.status, 200)
  assert.deepEqual(h.routed, [LOADED], 'reached the shared gateway handler')
  // The façade parses the body for its own gating and the shared handler parses it again;
  // if that double read lost the body, the engine would be asked to complete nothing.
  assert.equal(upstream!.url, 'http://engine.local/v1/chat/completions', 'proxied to the /v1 path, not /api/link/v1')
  assert.deepEqual(JSON.parse(upstream!.body).messages, [{ role: 'user', content: 'hi' }])
})

test('models:use on a COLD model is a typed model_not_loaded 503, and never swaps', async () => {
  const { d, h } = mkDeps([key('tllm-a', ['models:use'])])
  const res = await post(d, 'tllm-a', COLD)
  assert.equal(res.status, 503)
  assert.equal(await errorCode(res), 'model_not_loaded')
  assert.deepEqual(h.routed, [], 'the request never reached the router')
})

test('models:wake on a COLD model with an IDLE host swaps', async () => {
  const { d, h } = mkDeps([key('tllm-a', ['models:use', 'models:wake'])])
  const res = await post(d, 'tllm-a', COLD)
  assert.equal(res.status, 200)
  assert.deepEqual(h.routed, [COLD], 'fell through to the auto-swap path')
})

test('models:wake on a BUSY host is a typed host_busy 503', async () => {
  const { d, h } = mkDeps([key('tllm-a', ['models:use', 'models:wake'])], { busy: true })
  const res = await post(d, 'tllm-a', COLD)
  assert.equal(res.status, 503)
  assert.equal(await errorCode(res), 'host_busy')
  assert.deepEqual(h.routed, [], 'the owner\'s generation was not evicted')
})

test('models:load swaps regardless of the host being busy', async () => {
  const { d, h } = mkDeps([key('tllm-a', ['models:use', 'models:load'])], { busy: true })
  const res = await post(d, 'tllm-a', COLD)
  assert.equal(res.status, 200)
  assert.deepEqual(h.routed, [COLD])
})

test('a model outside the allowlist is 403, even with models:load', async () => {
  const { d, h } = mkDeps([key('tllm-a', ['models:use', 'models:load'], [LOADED])])
  const res = await post(d, 'tllm-a', COLD)
  assert.equal(res.status, 403)
  assert.equal(await errorCode(res), 'forbidden')
  assert.deepEqual(h.routed, [])
})

test('a token without models:use at all is 403 from requireCapability', async () => {
  const { d, h } = mkDeps([key('tllm-a', ['models:wake'])])
  const res = await post(d, 'tllm-a', LOADED)
  assert.equal(res.status, 403)
  assert.equal(await errorCode(res), 'forbidden')
  assert.deepEqual(h.routed, [])
})

test("a peer's own request does NOT count as the owner's local activity", async () => {
  // Otherwise one peer's chat would block the next wake for the whole idle grace window.
  const { d } = mkDeps([key('tllm-a', ['models:use', 'models:wake'])])
  assert.equal((await post(d, 'tllm-a', LOADED)).status, 200)
  const res = await post(d, 'tllm-a', COLD)
  assert.equal(res.status, 200, 'still wakeable after a peer request')
})

// ── Chaining is refused with the RIGHT reason, before any gate that could mislead ────────
// Final-review M-3: the authoritative refusal lives in gatewayV1Handler, but it ran AFTER
// the wake gate, so a models:use-only peer asking for a third machine got 503
// `model_not_loaded` — "this link may not load it" — when the true answer is that no link
// can serve it at all. Different remedies, so the wrong code sends the user to fix the
// wrong thing.

/** A host that itself has a link named ThirdBox — the only configuration where chaining
 *  is even reachable. `resolveRemoteTarget` is the SAME resolution the router uses; the
 *  route must never grow a second copy of parseRemoteId + linkByName. */
function chainedDeps(caps: string[]): Deps {
  const { d } = mkDeps([key('tllm-a', caps)])
  ;(d as unknown as { modelRouter: Record<string, unknown> }).modelRouter.resolveRemoteTarget =
    (id: string) => (id.startsWith('ThirdBox/')
      ? { target: 'https://third.box', remote: { linkId: 'l3', baseUrl: 'https://third.box', token: 't', modelKey: 'Qwen3' } }
      : undefined)
  return d
}

test("a second hop is refused as chaining, not as 'this link may not load it'", async () => {
  const d = chainedDeps(['models:use'])
  const res = await post(d, 'tllm-a', 'ThirdBox/Qwen3')
  assert.equal(res.status, 400)
  assert.equal(await errorCode(res), 'link_chaining_unsupported')
  // Nothing was relayed onward, and nothing reached a local engine either.
  assert.equal(upstream, null)
})

test('a wake-capable peer on a busy host gets the same chaining answer, not host_busy', async () => {
  const { d: base } = mkDeps([key('tllm-a', ['models:use', 'models:wake'])], { busy: true })
  ;(base as unknown as { modelRouter: Record<string, unknown> }).modelRouter.resolveRemoteTarget =
    (id: string) => (id.startsWith('ThirdBox/') ? { target: 'https://third.box', remote: { linkId: 'l3', baseUrl: 'https://third.box', token: 't', modelKey: 'Q' } } : undefined)
  const res = await post(base, 'tllm-a', 'ThirdBox/Qwen3')
  assert.equal(res.status, 400)
  assert.equal(await errorCode(res), 'link_chaining_unsupported')
})

test('a LOCAL model key containing a slash is untouched by the chaining guard', async () => {
  // The guard must key on "names a machine I link to", never on "looks qualified" —
  // `unsloth/Qwen3-GGUF` is an ordinary local model key.
  const d = chainedDeps(['models:use', 'models:load'])
  const res = await post(d, 'tllm-a', 'unsloth/Qwen3-GGUF')
  assert.equal(res.status, 200)
  assert.ok(upstream, 'reached the engine')
})
