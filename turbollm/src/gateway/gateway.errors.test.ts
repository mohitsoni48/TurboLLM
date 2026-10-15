// Regression coverage for a real bug: the /v1/* OpenAI pass-through's engine fetch
// (gateway.ts) was unguarded — any throw (an unreachable engine, or fetch() rejecting
// immediately because the client's abort signal was already fired) escaped straight to
// Hono's default error handler: a bodyless 500 with no client-facing error envelope at
// all. Found live (2026-07-23) via a real /v1/chat/completions failure from an external
// tool while the Anthropic-protocol path and the engine itself both worked fine for the
// same model. Fixed by wrapping the fetch, mirroring the /v1/messages handler's guard.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { ModelRouter } from './model-router'
import { lanAuth, provisionRemoteApiKey } from '../auth'
import { defaultConfig, type Engine } from '../config/config'
import type { Manager, Status } from '../engines/manager'
import type { Deps } from '../deps'

const LIBRARY = [{ key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' }]

/** Minimal Deps double routing every request to `target` — a genuinely unreachable host
 *  by default, so the real fetch() call throws for real (no network mocking needed). */
function fakeDeps(target = 'http://engine.invalid.local:1'): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }), dir: () => '/tmp/turbollm-test-data' },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => target,
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
  } as unknown as Deps
}

test('POST /v1/chat/completions returns a structured error, not a bodyless 500, when the engine fetch throws', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string; code: string } }
  assert.ok(body.error, 'response must carry a structured error envelope, not an empty body')
  assert.equal(body.error!.type, 'api_error')
  assert.equal(body.error!.code, 'engine_unreachable')
  assert.ok(body.error!.message.length > 0, 'message must not be empty')
})

test('POST /v1/chat/completions with an already-aborted client signal reports client_disconnected, not a crash', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const ac = new AbortController()
  ac.abort() // simulate the client having already disconnected before the fetch fires

  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
    signal: ac.signal,
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string; code: string } }
  assert.ok(body.error, 'response must carry a structured error envelope, not an empty body')
  assert.equal(body.error!.code, 'client_disconnected')
})

test('GET /v1/models is unaffected by the fetch guard (no engine call on this path)', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const res = await app.request('/v1/models', { method: 'GET' })
  assert.equal(res.status, 200)
})

// ── /v1/messages (Anthropic protocol) — regression for a real bug: unlike the OpenAI
// pass-through above, this handler flattened EVERY engine failure to a hardcoded 500 +
// 'api_error', discarding the engine's real status and any structured error it returned. That
// made distinct failure classes (bad request, overload, crash) all read identically from a
// terminal-agent `claude` session, with no way to tell them apart. Fixed by forwarding the
// engine's real status/body when present, and by mirroring the OpenAI path's abort/unreachable
// distinction for the network-throw case.

/** A real, ephemeral HTTP server standing in for the engine target — the whole point of these
 *  tests is that the gateway now forwards the ENGINE's real status/body, so mocking fetch()
 *  would only test the mock, not the actual forwarding logic. */
async function withFakeEngine(
  respond: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(respond)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const messagesBody = JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], max_tokens: 100, stream: false })

test('POST /v1/messages forwards the engine\'s real status + structured error instead of a flattened 500', async () => {
  const engine = await withFakeEngine((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'the request exceeds the available context size', type: 'invalid_request_error' } }))
  })
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url))
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: messagesBody,
    })
    assert.equal(res.status, 400, "must forward the engine's real status, not a hardcoded 500")
    const body = (await res.json()) as { error?: { message: string; type: string } }
    assert.equal(body.error?.type, 'invalid_request_error')
    assert.equal(body.error?.message, 'the request exceeds the available context size')
  } finally {
    await engine.close()
  }
})

test('POST /v1/messages falls back to raw text + a status-mapped type when the engine error body is not JSON', async () => {
  const engine = await withFakeEngine((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('CUDA out of memory')
  })
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url))
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: messagesBody,
    })
    assert.equal(res.status, 503)
    const body = (await res.json()) as { error?: { message: string; type: string } }
    assert.equal(body.error?.type, 'overloaded_error')
    assert.equal(body.error?.message, 'CUDA out of memory')
  } finally {
    await engine.close()
  }
})

test('POST /v1/messages reports a structured error, not a bodyless 500, when the engine fetch throws', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps()) // default fakeDeps target is genuinely unreachable

  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: messagesBody,
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string } }
  assert.ok(body.error, 'response must carry a structured error envelope, not an empty body')
  assert.equal(body.error!.type, 'api_error')
  assert.ok(body.error!.message.length > 0, 'message must not be empty')
})

test('POST /v1/messages with an already-aborted client signal reports a clear disconnect message, not a crash', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const ac = new AbortController()
  ac.abort() // simulate the client having already disconnected before the fetch fires

  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: messagesBody,
    signal: ac.signal,
  })

  assert.equal(res.status, 500)
  const body = (await res.json()) as { error?: { message: string; type: string } }
  assert.equal(body.error?.message, 'Client disconnected before the engine responded.')
})

// ── /v1/messages streaming (stream: true) — same four failure classes as above, but the
// response is already committed as a 200 SSE stream by the time any of these can be detected
// (ADR-347), so the failure surfaces as a mid-stream `error` event instead of a JSON response with
// a real status code. Review-caught gap: every case above used `stream: false`, so this behavior
// change for the ONLY request shape Claude Code actually sends (it always streams) had zero
// coverage. These tests document the accepted tradeoff explicitly, not just assert it's unchanged.

const streamingMessagesBody = JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], max_tokens: 100, stream: true })

/** Reads SSE `{event, data}` frames off a Response body as they arrive — same shape as
 *  gateway.queue-ping.test.ts's own reader, duplicated locally rather than shared across test
 *  files (matching this suite's existing per-file `withFakeEngine`/`fakeDeps` convention). */
function sseEventReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  return {
    async next(): Promise<{ event: string; data: string } | null> {
      while (true) {
        const frameEnd = buf.indexOf('\n\n')
        if (frameEnd !== -1) {
          const frame = buf.slice(0, frameEnd)
          buf = buf.slice(frameEnd + 2)
          const event = frame.match(/^event: (.+)$/m)?.[1] ?? ''
          const data = frame.match(/^data: (.*)$/m)?.[1] ?? ''
          return { event, data }
        }
        const { done, value } = await reader.read()
        if (done) return null
        buf += dec.decode(value, { stream: true })
      }
    },
  }
}

async function firstNonPingEvent(body: ReadableStream<Uint8Array>): Promise<{ event: string; data: string }> {
  const events = sseEventReader(body)
  for (;;) {
    const evt = await events.next()
    assert.ok(evt, 'stream ended before a non-ping event arrived')
    if (evt!.event !== 'message_start' && evt!.event !== 'ping') return evt!
  }
}

test('POST /v1/messages (streaming) forwards the engine\'s real error as an SSE event on a 200, not a 400 JSON response', async () => {
  const engine = await withFakeEngine((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'the request exceeds the available context size', type: 'invalid_request_error' } }))
  })
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url))
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: streamingMessagesBody,
    })
    assert.equal(res.status, 200, 'a streaming response is always 200 once the SSE connection has opened')
    assert.ok(res.body)
    const evt = await firstNonPingEvent(res.body!)
    assert.equal(evt.event, 'error')
    const parsed = JSON.parse(evt.data) as { error: { type: string; message: string } }
    assert.equal(parsed.error.type, 'invalid_request_error')
    assert.equal(parsed.error.message, 'the request exceeds the available context size')
  } finally {
    await engine.close()
  }
})

test('POST /v1/messages (streaming) falls back to raw text + a status-mapped type in the SSE error event when the engine body is not JSON', async () => {
  const engine = await withFakeEngine((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('CUDA out of memory')
  })
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url))
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: streamingMessagesBody,
    })
    assert.equal(res.status, 200)
    assert.ok(res.body)
    const evt = await firstNonPingEvent(res.body!)
    assert.equal(evt.event, 'error')
    const parsed = JSON.parse(evt.data) as { error: { type: string; message: string } }
    assert.equal(parsed.error.type, 'overloaded_error')
    assert.equal(parsed.error.message, 'CUDA out of memory')
  } finally {
    await engine.close()
  }
})

test('POST /v1/messages (streaming) reports an SSE error event, not a bodyless 500, when the engine fetch throws', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps()) // default fakeDeps target is genuinely unreachable

  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: streamingMessagesBody,
  })

  assert.equal(res.status, 200)
  assert.ok(res.body)
  const evt = await firstNonPingEvent(res.body!)
  assert.equal(evt.event, 'error')
  const parsed = JSON.parse(evt.data) as { error: { type: string; message: string } }
  assert.equal(parsed.error.type, 'api_error')
  assert.ok(parsed.error.message.length > 0, 'message must not be empty')
})

test('POST /v1/messages (streaming) with an already-aborted client signal reports a clear disconnect message as an SSE event', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const ac = new AbortController()
  ac.abort() // simulate the client having already disconnected before the fetch fires

  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: streamingMessagesBody,
    signal: ac.signal,
  })

  assert.equal(res.status, 200)
  assert.ok(res.body)
  const evt = await firstNonPingEvent(res.body!)
  assert.equal(evt.event, 'error')
  const parsed = JSON.parse(evt.data) as { error: { type: string; message: string } }
  assert.equal(parsed.error.message, 'Client disconnected before the engine responded.')
})

test('describeEngineError: the redactor is applied to both the structured and the raw message', async () => {
  const { describeEngineError } = await import('./gateway')
  const redact = (t: string) => t.replace('/secret/model.gguf', '<model>')
  const structured = new Response(JSON.stringify({ error: { message: 'failed to open /secret/model.gguf', type: 'x' } }), { status: 500 })
  assert.equal((await describeEngineError(structured, redact)).message, 'failed to open <model>')
  const raw = new Response('panic at /secret/model.gguf', { status: 500 })
  assert.equal((await describeEngineError(raw, redact)).message, 'panic at <model>')
})

// ── Hop-by-hop request headers: the local pass-through copied the caller's whole header set to
// the engine fetch, and undici refuses `expect`, `transfer-encoding`, `keep-alive` and `upgrade` before
// any I/O — curl's automatic `Expect: 100-continue` on a >1 MB vision body, or any chunked upload, was a
// 500 engine_unreachable. A real engine socket, since only the real undici fetch refuses them.

for (const [name, value] of [['expect', '100-continue'], ['transfer-encoding', 'chunked'], ['keep-alive', 'timeout=5'], ['upgrade', 'h2c']]) {
  test(`POST /v1/chat/completions with a client \`${name}\` header still reaches the engine`, async () => {
    let engineSaw: string | undefined = 'unset'
    const engine = await withFakeEngine((req, res) => {
      engineSaw = req.headers[name] as string | undefined
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }))
      })
    })
    try {
      const app = new Hono()
      registerGateway(app, { ...fakeDeps(engine.url), db: { recordApiUsage: () => {} } } as unknown as Deps)
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [name]: value },
        body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
      })
      assert.equal(res.status, 200, await res.clone().text())
      assert.equal(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, 'hi')
      if (name !== 'transfer-encoding') assert.equal(engineSaw, undefined, `the caller's \`${name}\` is not forwarded`)
    } finally {
      await engine.close()
    }
  })
}

test('POST /v1/chat/completions does not hand TurboLLM\'s own credentials to the engine port', async () => {
  const engineSaw: Record<string, string | undefined> = {}
  const engine = await withFakeEngine((req, res) => {
    for (const h of ['cookie', 'x-turbollm-auth', 'x-turbollm-app', 'x-custom']) engineSaw[h] = req.headers[h] as string | undefined
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }))
    })
  })
  try {
    const app = new Hono()
    registerGateway(app, { ...fakeDeps(engine.url), db: { recordApiUsage: () => {} } } as unknown as Deps)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', cookie: 'turbollm_app=s3cret', 'x-turbollm-auth': 'tllm_key',
        'x-turbollm-app': 's3cret', 'x-custom': 'kept',
      },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    assert.deepEqual(engineSaw, { cookie: undefined, 'x-turbollm-auth': undefined, 'x-turbollm-app': undefined, 'x-custom': 'kept' })
  } finally {
    await engine.close()
  }
})

// ── Route failures: every one is a 503, and Claude Code retries any 5xx up to 10 times unless told not to —
// re-running a model load that fails (evicting whatever was loaded) on every attempt. Only a refusal the router marks
// permanent says not to; one that clears by itself (ComfyUI's queue) is left retryable. The status codes are unchanged.

for (const [label, result, retry] of [
  ['a failed model load', { status: 503, message: 'Engine start failed: out of memory', permanent: true }, 'false'],
  ['ComfyUI holding the GPU', { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }, null],
] as const) {
  for (const [path, body] of [
    ['/v1/messages', { model: 'big', max_tokens: 100, messages: [] }],
    ['/v1/chat/completions', { model: 'big', messages: [] }],
  ] as const) {
    test(`${path}: ${label} → 503 with x-should-retry ${retry ?? 'unset'}`, async () => {
      const app = new Hono()
      const deps = fakeDeps() as unknown as { modelRouter: { route: () => Promise<unknown> } }
      deps.modelRouter.route = async () => result
      registerGateway(app, deps as unknown as Deps)
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(res.status, 503)
      assert.equal(res.headers.get('x-should-retry'), retry)
    })
  }
}

// The same, with the REAL router deciding: an SDK told `x-should-retry: false` gives up at once, so a refusal that
// clears by itself must not carry it. Auto-swap off answers with whatever the primary holds — nothing while a model is
// still loading (or while ComfyUI holds the GPU, which unloads it until the render ends) — and a link not probed yet
// reads 'unknown'. A revoked link stays down until it is re-paired, so that one is still final.
function realRouterDeps(opts: { primary?: Status['state']; linkStatus?: string }): Deps {
  const store = { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false, keepN: 1 } }) }
  const primary = {
    status: () => ({ state: opts.primary ?? 'stopped', model: opts.primary === 'starting' ? { key: LIBRARY[0].key } : null }),
    target: () => null,
  }
  const scanner = { list: () => ({ models: LIBRARY }), get: () => undefined }
  const link = { id: 'l1', name: 'rig', status: opts.linkStatus ?? 'online', baseUrl: 'https://rig.example', token: 't' }
  const catalog = { linkByName: (n: string) => (n === 'rig' ? link : undefined), modelOn: () => undefined }
  const router = new ModelRouter(store as never, {} as never, primary as never, scanner as never, undefined, catalog as never)
  return { ...fakeDeps(), modelRouter: router } as unknown as Deps
}

for (const [label, deps, model, retry] of [
  ['a model still loading (auto-swap off)', () => realRouterDeps({ primary: 'starting' }), 'qwen3-8b|Q4|123', null],
  ['a linked machine not probed yet', () => realRouterDeps({ linkStatus: 'unknown' }), 'rig/Qwen3', null],
  ['a linked machine that revoked the link', () => realRouterDeps({ linkStatus: 'revoked' }), 'rig/Qwen3', 'false'],
] as const) {
  for (const path of ['/v1/messages', '/v1/chat/completions'] as const) {
    test(`${path}: ${label} → 503 with x-should-retry ${retry ?? 'unset'} (real router)`, async () => {
      const app = new Hono()
      registerGateway(app, deps())
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 100, messages: [] }),
      })
      assert.equal(res.status, 503, await res.clone().text())
      assert.equal(res.headers.get('x-should-retry'), retry)
    })
  }
}

// ── A remote-access token without models:load (auth.ts modelLoadsRefused) is answered "not loaded" instead of
// auto-swapping. That is final for the token only when nothing is bringing the model up: a model still loading (in the
// primary or into a pool slot), or the one ComfyUI's guard unloaded and reloads when its render ends, is served to the
// same token seconds later, so an SDK must not be told to give up on it. Composed for real: lanAuth marks the request
// and the real router decides.

const INGRESS_PORT = 6997
const MODEL = {
  key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B', path: '/m/qwen3-8b.gguf', format: 'gguf', quant: 'Q4', nativeCtx: 4096,
  vision: false, embedding: false, incomplete: false, parseError: null,
}
const OTHER = { ...MODEL, key: 'gemma-4b|Q4|456', name: 'Gemma 4B', path: '/m/gemma-4b.gguf' }

function managerIn(state: Status['state'], modelKey?: string, load?: () => Promise<void>) {
  let current = state
  return {
    status: () => ({ state: current, err: null, port: 0, pid: 0, loadElapsedMs: 0, model: modelKey ? { key: modelKey } : null }),
    target: () => (current === 'running' ? 'http://127.0.0.1:1' : null),
    load: async () => { await load?.(); current = 'running' },
    touch: () => {},
    currentOpts: () => null,
    generationStart: () => {},
    generationEnd: () => {},
  }
}

function restrictedDeps(opts: {
  primary: ReturnType<typeof managerIn>
  keepN?: number
  slot?: ReturnType<typeof managerIn>
  comfySuspended?: string | null
}): { d: Deps; router: ModelRouter; token: string } {
  const cfg = defaultConfig()
  cfg.gateway.keepN = opts.keepN ?? 1
  const store = { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg), dir: () => '/tmp/turbollm-test-data' }
  const scanner = { list: () => ({ models: [MODEL, OTHER], scanning: false, lastScanAt: '' }), get: () => undefined }
  const engine = { id: 'llama', kind: 'llama-server', capabilities: { flags: [], kvTypes: [] } } as unknown as Engine
  const registry = { active: () => engine, layaEngine: () => undefined }
  const comfy = opts.comfySuspended === undefined
    ? undefined
    : { isBlocked: () => true, snapshot: () => ({ suspendedModelKey: opts.comfySuspended }) }
  const router = new ModelRouter(
    store as never, registry as never, opts.primary as unknown as Manager, scanner as never, comfy as never, undefined,
    () => (opts.slot ?? managerIn('stopped')) as unknown as Manager,
  )
  const d = {
    ...fakeDeps(),
    store, scanner, registry, manager: opts.primary, modelRouter: router,
    remote: { ingressPort: () => INGRESS_PORT, activeProvider: () => cfg.remoteAccess.provider },
  } as unknown as Deps
  return { d, router, token: provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] }) }
}

async function askAsRemoteToken(d: Deps, token: string, path: '/v1/messages' | '/v1/chat/completions'): Promise<Response> {
  const app = new Hono()
  app.use('*', lanAuth(d))
  registerGateway(app, d)
  return app.request(`http://local.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TurboLLM-Auth': token },
    body: JSON.stringify({ model: MODEL.key, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  }, { incoming: { socket: { localPort: INGRESS_PORT, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } } as never)
}

for (const path of ['/v1/messages', '/v1/chat/completions'] as const) {
  test(`${path}: a models:use token asking for a model the primary is still loading may retry`, async () => {
    const { d, token } = restrictedDeps({ primary: managerIn('starting', MODEL.key) })
    const res = await askAsRemoteToken(d, token, path)
    assert.equal(res.status, 503)
    assert.match(await res.text(), /still loading/)
    assert.equal(res.headers.get('x-should-retry'), null)
  })

  test(`${path}: a models:use token asking for a model loading into a pool slot may retry`, async () => {
    let finish!: () => void
    const slotLoaded = new Promise<void>((r) => { finish = r })
    const { d, router, token } = restrictedDeps({
      primary: managerIn('running', OTHER.key), keepN: 2, slot: managerIn('stopped', MODEL.key, () => slotLoaded),
    })
    const ownersLoad = router.route(MODEL.key) // an ordinary caller's auto-swap, still loading
    try {
      const res = await askAsRemoteToken(d, token, path)
      assert.equal(res.status, 503)
      assert.match(await res.text(), /still loading/)
      assert.equal(res.headers.get('x-should-retry'), null)
    } finally {
      finish()
      await ownersLoad
    }
  })

  test(`${path}: a models:use token asking for the model ComfyUI's render unloaded may retry`, async () => {
    const { d, token } = restrictedDeps({ primary: managerIn('stopped'), comfySuspended: MODEL.key })
    const res = await askAsRemoteToken(d, token, path)
    assert.equal(res.status, 503)
    assert.match(await res.text(), /ComfyUI is rendering/)
    assert.equal(res.headers.get('x-should-retry'), null)
  })

  for (const [label, deps] of [
    ['nothing is loading', () => restrictedDeps({ primary: managerIn('running', OTHER.key) })],
    ['ComfyUI will reload a different model', () => restrictedDeps({ primary: managerIn('stopped'), comfySuspended: OTHER.key })],
  ] as const) {
    test(`${path}: a models:use token asking for a model that is not loaded, when ${label}, is told not to retry`, async () => {
      const { d, token } = deps()
      const res = await askAsRemoteToken(d, token, path)
      assert.equal(res.status, 503)
      assert.match(await res.text(), /may not load models/)
      assert.equal(res.headers.get('x-should-retry'), 'false')
    })
  }
}
