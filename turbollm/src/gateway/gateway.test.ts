// gateway.ts and Jev models (ADR-434 (d)). describeEngineError and clientAbort
// are exported for /v1/classify with their bodies unchanged, so the first tests pin today's
// behaviour through the new export. The rest drive the public /v1/* surface in-process (Hono's
// app.request, a stubbed globalThis.fetch restored in `finally` — no port, no engine).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { clientAbort, describeEngineError, gatewayV1Handler, registerGateway } from './gateway'
import type { AliveSlot, RouteResult } from './model-router'

test('describeEngineError reads the OpenAI-shaped error message an engine returns', async () => {
  const res = new Response(JSON.stringify({ error: { message: 'bad input' } }), { status: 400 })
  assert.equal((await describeEngineError(res)).message, 'bad input')
})

test('describeEngineError falls back to a plain-text body as-is', async () => {
  const res = new Response('model crashed while loading', { status: 500 })
  assert.equal((await describeEngineError(res)).message, 'model crashed while loading')
})

test('describeEngineError names the status when the body is empty', async () => {
  assert.equal((await describeEngineError(new Response('', { status: 502 }))).message, 'Engine returned HTTP 502.')
})

test('clientAbort is already aborted when the client left before the call', () => {
  const left = new AbortController()
  left.abort()
  const raw = new Request('http://gateway.invalid/v1/classify', { method: 'POST', signal: left.signal })
  assert.equal(clientAbort({ req: { raw } }).signal.aborted, true)
})

test('clientAbort aborts later, when the client disconnects mid-request', () => {
  const client = new AbortController()
  const raw = new Request('http://gateway.invalid/v1/classify', { method: 'POST', signal: client.signal })
  const upstream = clientAbort({ req: { raw } })
  assert.equal(upstream.signal.aborted, false)
  client.abort()
  assert.equal(upstream.signal.aborted, true)
})

const ENGINE = 'http://engine.local'
const JEV_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const GGUF_KEY = 'qwen3-8b|Q4|123'

/** The OpenJev checkpoint as the scanner lists it. */
const OPENJEV_ENTRY = {
  key: JEV_KEY,
  name: 'qwen3.5 4b nli v2',
  jev: {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
  },
} as unknown as ModelEntry
const GGUF_ENTRY = { key: GGUF_KEY, name: 'Qwen3 8B' } as unknown as ModelEntry
const LIBRARY = [OPENJEV_ENTRY, GGUF_ENTRY]

const KITCHEN_PREMISE = 'A chef is chopping onions in a busy restaurant kitchen.'
const KITCHEN_HYPOTHESES = [
  'Someone is preparing food.',
  'The kitchen is empty and silent.',
  'The chef is wearing a blue apron.',
]

/** The engine's recorded /classify response for the kitchen hypotheses. */
const F2_KITCHEN = {
  data: [
    { index: 0, label: 'entailment', probs: [0.0, 0.957, 0.043], num_classes: 3 },
    { index: 1, label: 'contradiction', probs: [1.0, 0.0, 0.0], num_classes: 3 },
    { index: 2, label: 'neutral', probs: [0.001, 0.001, 0.998], num_classes: 3 },
  ],
  usage: { prompt_tokens: 69, total_tokens: 69 },
}

/** The engine's recorded /classify response for Berlin, Paris, Madrid. */
const F3_FRANCE = {
  data: [
    { index: 0, label: 'contradiction', probs: [0.990, 0.008, 0.002], num_classes: 3 },
    { index: 1, label: 'entailment', probs: [0.020, 0.941, 0.039], num_classes: 3 },
    { index: 2, label: 'contradiction', probs: [0.980, 0.016, 0.004], num_classes: 3 },
  ],
  usage: { prompt_tokens: 51, total_tokens: 51 },
}

/** The expected /v1/classify and /v1/rerank bodies. */
const F7_CLASSIFY = {
  model: JEV_KEY,
  results: [
    {
      hypothesis: 'Someone is preparing food.',
      label: 'entailment',
      probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 },
    },
    {
      hypothesis: 'The kitchen is empty and silent.',
      label: 'contradiction',
      probs: { contradiction: 1, entailment: 0, neutral: 0 },
    },
    {
      hypothesis: 'The chef is wearing a blue apron.',
      label: 'neutral',
      probs: { contradiction: 0.001, entailment: 0.001, neutral: 0.998 },
    },
  ],
  usage: { prompt_tokens: 69, total_tokens: 69 },
}
const F7_RERANK = {
  model: JEV_KEY,
  results: [
    { index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' },
    { index: 2, document: { text: 'Madrid' }, relevance_score: 0.016, label: 'contradiction' },
    { index: 0, document: { text: 'Berlin' }, relevance_score: 0.008, label: 'contradiction' },
  ],
  usage: { prompt_tokens: 51, total_tokens: 51 },
}

/** The members the /v1 paths under test touch; the router resolves by exact key or name and records
 *  every model route() is asked for. */
function jevGatewayDeps(routed: string[] = []): Deps {
  const byKeyOrName = (id: string) => LIBRARY.find((e) => e.key === id || e.name === id)
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: {
      route: async (model: string) => {
        routed.push(model)
        return { target: ENGINE }
      },
      targetEntry: byKeyOrName,
      resolveRemoteTarget: () => undefined,
      resolveLocal: byKeyOrName,
      routeTo: async () => ({ target: ENGINE }),
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'running', model: { key: JEV_KEY, name: 'qwen3.5 4b nli v2' } }),
      target: () => ENGINE,
      currentOpts: () => undefined,
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'vllm' }) },
  } as unknown as Deps
}

interface EngineCall {
  url: string
  method: string | undefined
}

/** Replace globalThis.fetch with an engine that answers `reply`, for the duration of `run` only. */
async function withEngine(reply: unknown, run: (calls: EngineCall[]) => Promise<void>): Promise<void> {
  const calls: EngineCall[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = realFetch
  }
}

function gatewayApp(d: Deps = jevGatewayDeps()): Hono {
  const app = new Hono()
  registerGateway(app, d)
  return app
}

function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

test('POST /v1/classify is served by the Jev handler: one engine /classify call, the classify body', async () => {
  await withEngine(F2_KITCHEN, async (calls) => {
    const res = await postJson(gatewayApp(), '/v1/classify', {
      model: JEV_KEY, premise: KITCHEN_PREMISE, hypotheses: KITCHEN_HYPOTHESES,
    })

    assert.deepEqual(calls, [{ url: 'http://engine.local/classify', method: 'POST' }])
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), F7_CLASSIFY)
  })
})

test('POST /v1/classify/ (trailing slash) is served by the Jev handler, not proxied to the primary engine', async () => {
  await withEngine(F2_KITCHEN, async (calls) => {
    const res = await postJson(gatewayApp(), '/v1/classify/', {
      model: JEV_KEY, premise: KITCHEN_PREMISE, hypotheses: KITCHEN_HYPOTHESES,
    })

    assert.deepEqual(calls, [{ url: 'http://engine.local/classify', method: 'POST' }])
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), F7_CLASSIFY)
  })
})

test('POST /v1/rerank is served by the Jev handler: one engine /classify call, the rerank body', async () => {
  await withEngine(F3_FRANCE, async (calls) => {
    const res = await postJson(gatewayApp(), '/v1/rerank', {
      model: JEV_KEY, query: 'What is the capital of France?', documents: ['Berlin', 'Paris', 'Madrid'],
    })

    assert.deepEqual(calls, [{ url: 'http://engine.local/classify', method: 'POST' }])
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), F7_RERANK)
  })
})

test('gatewayV1Handler behind the Turbo Link façade refuses /v1/classify (origin link)', async () => {
  const app = new Hono()
  const d = jevGatewayDeps()
  app.post('/api/link/v1/classify', (c) => gatewayV1Handler(c, d, { origin: 'link', pathname: '/v1/classify' }))

  await withEngine(F2_KITCHEN, async (calls) => {
    const res = await postJson(app, '/api/link/v1/classify', {
      model: JEV_KEY, premise: KITCHEN_PREMISE, hypotheses: KITCHEN_HYPOTHESES,
    })

    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'link_jev_unsupported')
    assert.deepEqual(calls, [])
  })
})

test('a trailing slash does not let a Turbo Link peer past the /v1/classify refusal either', async () => {
  const app = new Hono()
  const d = jevGatewayDeps()
  app.post('/api/link/v1/classify/', (c) => gatewayV1Handler(c, d, { origin: 'link', pathname: '/v1/classify/' }))

  await withEngine(F2_KITCHEN, async (calls) => {
    const res = await postJson(app, '/api/link/v1/classify/', {
      model: JEV_KEY, premise: KITCHEN_PREMISE, hypotheses: KITCHEN_HYPOTHESES,
    })

    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'link_jev_unsupported')
    assert.deepEqual(calls, [])
  })
})

const CANNOT_CHAT = "'qwen3.5 4b nli v2' is a Jev model: it labels premise/hypothesis pairs and cannot chat. " +
  'Call POST /v1/classify (or /v1/rerank) instead.'
const CANNOT_EMBED = "'qwen3.5 4b nli v2' is a Jev model: it labels premise/hypothesis pairs and cannot produce " +
  'embeddings. Call POST /v1/classify (or /v1/rerank) instead.'

test('POST /v1/chat/completions on a Jev model → 400 jev_model_wrong_endpoint, nothing routed or loaded', async () => {
  const routed: string[] = []
  await withEngine({}, async (calls) => {
    const res = await postJson(gatewayApp(jevGatewayDeps(routed)), '/v1/chat/completions', {
      model: JEV_KEY, messages: [{ role: 'user', content: 'hi' }],
    })

    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), {
      error: { type: 'invalid_request_error', code: 'jev_model_wrong_endpoint', message: CANNOT_CHAT },
    })
    assert.deepEqual(routed, [], 'route() must not run — it would auto-swap the Jev model in')
    assert.deepEqual(calls, [])
  })
})

test('POST /v1/embeddings on a Jev model → 400 jev_model_wrong_endpoint naming embeddings', async () => {
  const routed: string[] = []
  await withEngine({}, async (calls) => {
    const res = await postJson(gatewayApp(jevGatewayDeps(routed)), '/v1/embeddings', {
      model: 'qwen3.5 4b nli v2', input: 'hello world',
    })

    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), {
      error: { type: 'invalid_request_error', code: 'jev_model_wrong_endpoint', message: CANNOT_EMBED },
    })
    assert.deepEqual(routed, [])
    assert.deepEqual(calls, [])
  })
})

test('POST /v1/messages on a Jev model (claude- alias) → 400 in the Anthropic error envelope', async () => {
  const routed: string[] = []
  await withEngine({}, async (calls) => {
    const res = await postJson(gatewayApp(jevGatewayDeps(routed)), '/v1/messages', {
      model: `claude-${JEV_KEY}`, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
    })

    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), {
      type: 'error', error: { type: 'invalid_request_error', message: CANNOT_CHAT },
    })
    assert.deepEqual(routed, [])
    assert.deepEqual(calls, [])
  })
})

test('chat, embeddings and messages on a GGUF model still route exactly as before', async () => {
  const routed: string[] = []
  const app = gatewayApp(jevGatewayDeps(routed))
  await withEngine({}, async () => {
    await postJson(app, '/v1/chat/completions', { model: GGUF_KEY, messages: [{ role: 'user', content: 'hi' }] })
    await postJson(app, '/v1/embeddings', { model: GGUF_KEY, input: 'hello world' })
    await postJson(app, '/v1/messages', { model: GGUF_KEY, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })
  })
  assert.deepEqual(routed, [GGUF_KEY, GGUF_KEY, GGUF_KEY])
})

test('GET /v1/models marks a Jev model kind "jev" with no claude- alias; other rows are unchanged', async () => {
  const res = await gatewayApp().request('/v1/models')
  const body = (await res.json()) as { data: Array<Record<string, unknown>> }

  assert.deepEqual(body.data, [
    { id: JEV_KEY, object: 'model', owned_by: 'turbollm', kind: 'jev' },
    { id: GGUF_KEY, object: 'model', owned_by: 'turbollm' },
    { id: `claude-${GGUF_KEY}`, object: 'model', display_name: 'Qwen3 8B — TurboLLM' },
  ])
})

const LINKED = 'Rig/qwen3.5 4b nli v2'
const URGENT_REQUEST = {
  state: 'Thanks, that fixed it! Have a nice day.',
  model: JEV_KEY,
  questions: { urgent: { type: 'noul', instructions: 'Does the message convey urgency?' } },
}
const URGENT_ENGINE_REPLY = {
  data: [{ index: 0, label: 'entailment', probs: [0, 0.945, 0.055], num_classes: 3 }],
  usage: { prompt_tokens: 32, total_tokens: 32 },
}
const URGENT_RESPONSE = {
  model: JEV_KEY,
  answers: { urgent: { type: 'noul', noul: 0.945 } },
  usage: { input_tokens: 32, output_tokens: 0 },
}
const LISTED_MODELS = [
  { id: JEV_KEY, object: 'model', owned_by: 'turbollm', kind: 'jev' },
  { id: GGUF_KEY, object: 'model', owned_by: 'turbollm' },
  { id: `claude-${GGUF_KEY}`, object: 'model', display_name: 'Qwen3 8B — TurboLLM' },
]

interface SystemOneRouter {
  routedTo?: ModelEntry[]
  routed?: string[]
  routeResult?: RouteResult
  aliveSlots?: AliveSlot[]
}

/** jevGatewayDeps with a router that records what it is routed to, knows one Turbo Link model id and lists its alive slots. */
function systemOneDeps(setup: SystemOneRouter = {}): Deps {
  const base = jevGatewayDeps(setup.routed)
  return {
    ...base,
    modelRouter: {
      ...base.modelRouter,
      routeTo: async (entry: ModelEntry) => {
        setup.routedTo?.push(entry)
        return setup.routeResult ?? { target: ENGINE }
      },
      resolveRemoteTarget: (id: string) => (id === LINKED ? { target: 'https://rig.invalid' } : undefined),
      aliveSlots: () => setup.aliveSlots ?? [],
    },
  } as unknown as Deps
}

async function assertRefusedWith(res: Response, status: number, code: string): Promise<void> {
  assert.equal(res.status, status)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, code)
}

test('POST /v1/systemone is served by the Jev dispatch: one engine /classify call, the System One body', async () => {
  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(gatewayApp(systemOneDeps()), '/v1/systemone', URGENT_REQUEST)

    assert.deepEqual(calls, [{ url: 'http://engine.local/classify', method: 'POST' }])
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), URGENT_RESPONSE)
  })
})

test('POST /v1/systemone/ (trailing slash) is served identically, not proxied to the primary engine', async () => {
  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(gatewayApp(systemOneDeps()), '/v1/systemone/', URGENT_REQUEST)

    assert.deepEqual(calls, [{ url: 'http://engine.local/classify', method: 'POST' }])
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), URGENT_RESPONSE)
  })
})

test('gatewayV1Handler behind the Turbo Link façade refuses /v1/systemone (origin link)', async () => {
  const app = new Hono()
  const d = systemOneDeps()
  app.post('/api/link/v1/systemone', (c) => gatewayV1Handler(c, d, { origin: 'link', pathname: '/v1/systemone' }))

  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(app, '/api/link/v1/systemone', URGENT_REQUEST)

    await assertRefusedWith(res, 400, 'link_jev_unsupported')
    assert.deepEqual(calls, [])
  })
})

test('a trailing slash does not let a Turbo Link peer past the /v1/systemone refusal either', async () => {
  const app = new Hono()
  const d = systemOneDeps()
  app.post('/api/link/v1/systemone/', (c) => gatewayV1Handler(c, d, { origin: 'link', pathname: '/v1/systemone/' }))

  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(app, '/api/link/v1/systemone/', URGENT_REQUEST)

    await assertRefusedWith(res, 400, 'link_jev_unsupported')
    assert.deepEqual(calls, [])
  })
})

test('a Turbo Link machine/model id on /v1/systemone is refused, with nothing routed and no engine call', async () => {
  const routedTo: ModelEntry[] = []
  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(gatewayApp(systemOneDeps({ routedTo })), '/v1/systemone', { ...URGENT_REQUEST, model: LINKED })

    await assertRefusedWith(res, 400, 'link_jev_unsupported')
    assert.deepEqual(routedTo, [])
    assert.deepEqual(calls, [])
  })
})

test('a GGUF model on /v1/systemone is a 400 not_a_jev_model', async () => {
  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(gatewayApp(systemOneDeps()), '/v1/systemone', { ...URGENT_REQUEST, model: GGUF_KEY })

    await assertRefusedWith(res, 400, 'not_a_jev_model')
    assert.deepEqual(calls, [])
  })
})

test('an unknown model on /v1/systemone is a 404 model_not_found', async () => {
  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(gatewayApp(systemOneDeps()), '/v1/systemone', { ...URGENT_REQUEST, model: 'nope' })

    await assertRefusedWith(res, 404, 'model_not_found')
    assert.deepEqual(calls, [])
  })
})

test('/v1/systemone routes with routeTo to exactly the named model and never calls route()', async () => {
  const routedTo: ModelEntry[] = []
  const routed: string[] = []
  await withEngine(URGENT_ENGINE_REPLY, async () => {
    await postJson(gatewayApp(systemOneDeps({ routedTo, routed })), '/v1/systemone', URGENT_REQUEST)
  })

  assert.deepEqual(routedTo, [OPENJEV_ENTRY])
  assert.deepEqual(routed, [], 'route() would answer with whatever the primary holds')
})

test('a router that cannot produce a target answers /v1/systemone with 503 model_not_loaded', async () => {
  const routeResult: RouteResult = { status: 503, message: "'qwen3.5 4b nli v2' is not loaded. Turn on auto-swap." }
  await withEngine(URGENT_ENGINE_REPLY, async (calls) => {
    const res = await postJson(gatewayApp(systemOneDeps({ routeResult })), '/v1/systemone', URGENT_REQUEST)

    await assertRefusedWith(res, 503, 'model_not_loaded')
    assert.deepEqual(calls, [])
  })
})

test('an empty /v1/systemone body is a 422 invalid_request through the real gateway', async () => {
  const res = await postJson(gatewayApp(systemOneDeps()), '/v1/systemone', {})

  assert.equal(res.status, 422)
  assert.deepEqual(await res.json(), {
    error: { message: 'model must be a non-empty string.', type: 'invalid_request_error', code: 'invalid_request' },
  })
})

test('jev-latest is accepted by /v1/systemone but never advertised by GET /v1/models', async () => {
  const aliveSlots: AliveSlot[] = [{ modelKey: JEV_KEY, state: 'running', primary: true, lastUsedMs: 0 }]
  const app = gatewayApp(systemOneDeps({ aliveSlots }))
  const listedIds = async () => ((await (await app.request('/v1/models')).json()) as { data: Array<{ id: string }> }).data

  const before = await listedIds()
  await withEngine(URGENT_ENGINE_REPLY, async () => {
    const res = await postJson(app, '/v1/systemone', { ...URGENT_REQUEST, model: 'jev-latest' })

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), URGENT_RESPONSE)
  })

  assert.deepEqual(before, LISTED_MODELS)
  assert.deepEqual(await listedIds(), LISTED_MODELS)
  assert.equal(before.some((row) => row.id.includes('jev-latest')), false)
})
