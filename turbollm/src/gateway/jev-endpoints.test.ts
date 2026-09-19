// /v1/classify and /v1/rerank (ADR-434 (d), architecture §2.5 / §3.1 / §3.2). Request bodies are
// validated into typed inputs or precise 400s before anything is resolved, routed or sent to an
// engine. User strings are never trimmed or rewritten.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { DEFAULT_HYPOTHESIS_TEMPLATE, JevShapeError, type JevInfo } from '../models/jev'
import {
  callEngineClassify,
  JevEndpointError,
  jevEndpointFor,
  jevErrorResponse,
  MAX_JEV_INPUTS,
  nliTemplateFor,
  parseClassifyBody,
  parseRerankBody,
  toClassifyResponse,
  toRerankResponse,
  type ClassifyInput,
  type EngineClassifyResult,
  type JevHttpError,
  type RerankInput,
} from './jev-endpoints'

const MODEL_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const MODEL_NAME = 'qwen3.5 4b nli v2'
const OPENJEV_TEMPLATE = 'Premise: {premise}\nHypothesis: {hypothesis}'
const KITCHEN_PREMISE = 'A chef is chopping onions in a busy restaurant kitchen.'
const KITCHEN_HYPOTHESES = [
  'Someone is preparing food.',
  'The kitchen is empty and silent.',
  'The chef is wearing a blue apron.',
]
const FRANCE_QUERY = 'What is the capital of France?'
const CITIES = ['Berlin', 'Paris', 'Madrid']

function invalidRequest(message: string): JevHttpError {
  return { status: 400, code: 'invalid_request', type: 'invalid_request_error', message }
}

function classifyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: MODEL_KEY, premise: KITCHEN_PREMISE, hypotheses: KITCHEN_HYPOTHESES, ...overrides }
}

function rerankBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: MODEL_KEY, query: FRANCE_QUERY, documents: CITIES, ...overrides }
}

/** Fixture F1's Jev descriptor, as detectJev() reads it from the OpenJev config.json. */
function openJevInfo(overrides: Partial<JevInfo> = {}): JevInfo {
  return {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: OPENJEV_TEMPLATE,
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
    ...overrides,
  }
}

function nonEmptyStrings(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `hypothesis ${i}`)
}

const BAD_HYPOTHESES = invalidRequest('hypotheses must be an array of 1 to 128 non-empty strings.')
const BAD_DOCUMENTS = invalidRequest(
  'documents must be an array of 1 to 128 non-empty strings or {"text": string} objects.',
)
const BAD_TOP_N = invalidRequest('top_n must be an integer of at least 1.')

test('jevEndpointFor: POST on the exact classify and rerank paths', () => {
  assert.equal(jevEndpointFor('POST', '/v1/classify'), 'classify')
  assert.equal(jevEndpointFor('POST', '/v1/rerank'), 'rerank')
})

test('jevEndpointFor: another method, a longer path or another endpoint is not a Jev endpoint', () => {
  assert.equal(jevEndpointFor('GET', '/v1/classify'), null)
  assert.equal(jevEndpointFor('POST', '/v1/classify/x'), null)
  assert.equal(jevEndpointFor('POST', '/v1/rerank/'), null)
  assert.equal(jevEndpointFor('POST', '/v1/chat/completions'), null)
})

test('MAX_JEV_INPUTS is 128', () => {
  assert.equal(MAX_JEV_INPUTS, 128)
})

test('classify: a valid body becomes the typed input, strings untouched', () => {
  const hypotheses = ['  padded hypothesis  ', 'Someone is preparing food.']
  assert.deepEqual(parseClassifyBody(classifyBody({ premise: ` ${KITCHEN_PREMISE}\n`, hypotheses })), {
    model: MODEL_KEY,
    premise: ` ${KITCHEN_PREMISE}\n`,
    hypotheses,
  })
})

test('classify: a body that is not a JSON object is refused', () => {
  const notAnObject = invalidRequest('Request body must be a JSON object.')
  for (const raw of [null, undefined, 'text', 42, [classifyBody()]]) {
    assert.deepEqual(parseClassifyBody(raw), notAnObject, `raw=${JSON.stringify(raw)}`)
  }
})

test('classify: model must be a non-empty string', () => {
  for (const model of [undefined, '', 7, ['a']]) {
    assert.deepEqual(parseClassifyBody(classifyBody({ model })), invalidRequest('model is required.'))
  }
})

test('classify: premise must be a non-empty string', () => {
  for (const premise of [undefined, '', 3, { text: 'x' }]) {
    assert.deepEqual(
      parseClassifyBody(classifyBody({ premise })),
      invalidRequest('premise must be a non-empty string.'),
    )
  }
})

test('classify: hypotheses must be an array of 1 to 128 non-empty strings', () => {
  for (const hypotheses of [undefined, 'one', [], ['ok', ''], ['ok', 5], [{ text: 'x' }]]) {
    assert.deepEqual(parseClassifyBody(classifyBody({ hypotheses })), BAD_HYPOTHESES)
  }
})

test('classify: 128 hypotheses are accepted, 129 are refused', () => {
  const accepted = parseClassifyBody(classifyBody({ hypotheses: nonEmptyStrings(128) }))
  assert.deepEqual(accepted, { model: MODEL_KEY, premise: KITCHEN_PREMISE, hypotheses: nonEmptyStrings(128) })
  assert.deepEqual(parseClassifyBody(classifyBody({ hypotheses: nonEmptyStrings(129) })), BAD_HYPOTHESES)
})

test('classify: a whitespace-only string counts as non-empty (never trimmed)', () => {
  assert.deepEqual(parseClassifyBody(classifyBody({ premise: ' ', hypotheses: [' '] })), {
    model: MODEL_KEY,
    premise: ' ',
    hypotheses: [' '],
  })
})

test('classify: checks run in order — model before premise before hypotheses', () => {
  assert.deepEqual(parseClassifyBody({ premise: '', hypotheses: [] }), invalidRequest('model is required.'))
  assert.deepEqual(
    parseClassifyBody({ model: MODEL_KEY, hypotheses: [] }),
    invalidRequest('premise must be a non-empty string.'),
  )
})

test('rerank: a valid body with no template gets the default template and no top_n', () => {
  assert.deepEqual(parseRerankBody(rerankBody()), {
    model: MODEL_KEY,
    query: FRANCE_QUERY,
    documents: CITIES,
    topN: undefined,
    hypothesisTemplate: DEFAULT_HYPOTHESIS_TEMPLATE,
  })
})

test('rerank: {text} documents are normalised to strings, mixed forms allowed', () => {
  const documents = [{ text: 'Berlin' }, 'Paris', { text: 'Madrid' }]
  const parsed = parseRerankBody(rerankBody({ documents, top_n: 2, hypothesis_template: 'Answer: {}' }))
  assert.deepEqual(parsed, {
    model: MODEL_KEY,
    query: FRANCE_QUERY,
    documents: CITIES,
    topN: 2,
    hypothesisTemplate: 'Answer: {}',
  })
})

test('rerank: a body that is not a JSON object is refused', () => {
  assert.deepEqual(parseRerankBody('rerank me'), invalidRequest('Request body must be a JSON object.'))
})

test('rerank: model must be a non-empty string', () => {
  assert.deepEqual(parseRerankBody(rerankBody({ model: '' })), invalidRequest('model is required.'))
})

test('rerank: query must be a non-empty string', () => {
  for (const query of [undefined, '', 1]) {
    assert.deepEqual(parseRerankBody(rerankBody({ query })), invalidRequest('query must be a non-empty string.'))
  }
})

test('rerank: documents must be 1 to 128 non-empty strings or {text} objects', () => {
  const badDocuments = [
    undefined, 'Paris', [], ['Paris', ''], [{ text: '' }], [{ text: 3 }], [{}], [null], [7], [['Paris']],
  ]
  for (const documents of badDocuments) {
    assert.deepEqual(parseRerankBody(rerankBody({ documents })), BAD_DOCUMENTS, JSON.stringify(documents))
  }
})

test('rerank: 128 documents are accepted, 129 are refused', () => {
  const accepted = parseRerankBody(rerankBody({ documents: nonEmptyStrings(128) }))
  assert.equal((accepted as { documents: string[] }).documents.length, 128)
  assert.deepEqual(parseRerankBody(rerankBody({ documents: nonEmptyStrings(129) })), BAD_DOCUMENTS)
})

test('rerank: top_n, when present, must be an integer of at least 1', () => {
  for (const topN of [0, -1, 1.5, '2', null, Number.NaN]) {
    assert.deepEqual(parseRerankBody(rerankBody({ top_n: topN })), BAD_TOP_N, `top_n=${String(topN)}`)
  }
})

test('rerank: top_n larger than the document count is kept as given (the mapper clamps it)', () => {
  assert.equal((parseRerankBody(rerankBody({ top_n: 10 })) as { topN: number }).topN, 10)
})

test('rerank: a template without {} is refused with invalid_hypothesis_template', () => {
  assert.deepEqual(parseRerankBody(rerankBody({ hypothesis_template: 'no slot here' })), {
    status: 400,
    code: 'invalid_hypothesis_template',
    type: 'invalid_request_error',
    message: 'hypothesis_template must contain {} where each document goes.',
  })
})

test('rerank: a template over 1000 characters is refused with its own message', () => {
  const tooLong = `{}${'x'.repeat(999)}`
  assert.deepEqual(parseRerankBody(rerankBody({ hypothesis_template: tooLong })), {
    status: 400,
    code: 'invalid_hypothesis_template',
    type: 'invalid_request_error',
    message: 'hypothesis_template must be at most 1000 characters.',
  })
})

test('rerank: checks run in order — query before documents before top_n before the template', () => {
  assert.deepEqual(
    parseRerankBody({ model: MODEL_KEY, documents: [], top_n: 0, hypothesis_template: 'x' }),
    invalidRequest('query must be a non-empty string.'),
  )
  assert.deepEqual(
    parseRerankBody(rerankBody({ documents: [], top_n: 0, hypothesis_template: 'x' })),
    BAD_DOCUMENTS,
  )
  assert.deepEqual(parseRerankBody(rerankBody({ top_n: 0, hypothesis_template: 'x' })), BAD_TOP_N)
})

const TEMPLATE_MISSING: JevHttpError = {
  status: 400,
  code: 'jev_template_missing',
  type: 'invalid_request_error',
  message: "'qwen3.5 4b nli v2' doesn't say how to combine premise and hypothesis (its config.json has no " +
    "nli_template), so TurboLLM can't build its input.",
}

test('nliTemplateFor: the model\'s own nli_template is returned as-is', () => {
  assert.equal(nliTemplateFor({ name: MODEL_NAME, jev: openJevInfo() }), OPENJEV_TEMPLATE)
})

test('nliTemplateFor (Q1 default): no usable nli_template → 400 jev_template_missing, no fallback', () => {
  assert.deepEqual(nliTemplateFor({ name: MODEL_NAME, jev: openJevInfo({ nliTemplate: null }) }), TEMPLATE_MISSING)
})

test('nliTemplateFor: an entry with no Jev descriptor has no template either', () => {
  assert.deepEqual(nliTemplateFor({ name: MODEL_NAME }), TEMPLATE_MISSING)
})

test('jevErrorResponse answers the OpenAI error envelope with the error\'s status', async () => {
  const app = new Hono()
  app.get('/boom', (c) => jevErrorResponse(c, {
    status: 404,
    code: 'model_not_found',
    type: 'invalid_request_error',
    message: "No local model matches 'nope'.",
  }))

  const res = await app.request('/boom')

  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), {
    error: { message: "No local model matches 'nope'.", type: 'invalid_request_error', code: 'model_not_found' },
  })
})

const ENGINE_TARGET = 'http://engine.local'
const OPENJEV = { key: MODEL_KEY, name: MODEL_NAME, jev: openJevInfo() }

/** Fixture F2 — the engine's recorded /classify response for the three kitchen hypotheses. */
const F2_KITCHEN = {
  data: [
    { index: 0, label: 'entailment', probs: [0.0, 0.957, 0.043], num_classes: 3 },
    { index: 1, label: 'contradiction', probs: [1.0, 0.0, 0.0], num_classes: 3 },
    { index: 2, label: 'neutral', probs: [0.001, 0.001, 0.998], num_classes: 3 },
  ],
  usage: { prompt_tokens: 69, total_tokens: 69 },
}

/** Fixture F3 — the engine's recorded /classify response for Berlin, Paris, Madrid. */
const F3_FRANCE = {
  data: [
    { index: 0, label: 'contradiction', probs: [0.990, 0.008, 0.002], num_classes: 3 },
    { index: 1, label: 'entailment', probs: [0.020, 0.941, 0.039], num_classes: 3 },
    { index: 2, label: 'contradiction', probs: [0.980, 0.016, 0.004], num_classes: 3 },
  ],
  usage: { prompt_tokens: 51, total_tokens: 51 },
}

/** Fixture F7 — the gateway's expected /v1/classify body for F2. */
const F7_CLASSIFY = {
  model: MODEL_KEY,
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

/** Fixture F7 — the gateway's expected /v1/rerank body for F3. */
const F7_RERANK = {
  model: MODEL_KEY,
  results: [
    { index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' },
    { index: 2, document: { text: 'Madrid' }, relevance_score: 0.016, label: 'contradiction' },
    { index: 0, document: { text: 'Berlin' }, relevance_score: 0.008, label: 'contradiction' },
  ],
  usage: { prompt_tokens: 51, total_tokens: 51 },
}

const KITCHEN_ENGINE_INPUT = KITCHEN_HYPOTHESES.map((h) => `Premise: ${KITCHEN_PREMISE}\nHypothesis: ${h}`)
const KITCHEN_CLASSIFY: ClassifyInput = { model: MODEL_KEY, premise: KITCHEN_PREMISE, hypotheses: KITCHEN_HYPOTHESES }

function franceRerank(topN: number | undefined = undefined): RerankInput {
  return {
    model: MODEL_KEY,
    query: FRANCE_QUERY,
    documents: CITIES,
    topN,
    hypothesisTemplate: DEFAULT_HYPOTHESIS_TEMPLATE,
  }
}

interface EngineCall {
  url: string
  init: RequestInit
}

/** A fetch double that records every call and answers each with a fresh Response. No socket. */
function recordingEngine(reply: () => Response): { fetchImpl: typeof fetch; calls: EngineCall[] } {
  const calls: EngineCall[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply()
  }) as typeof fetch
  return { fetchImpl, calls }
}

function jsonReply(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function throwingEngine(error: Error): typeof fetch {
  return (async () => { throw error }) as typeof fetch
}

function classifyKitchen(fetchImpl: typeof fetch, signal = new AbortController().signal): Promise<EngineClassifyResult> {
  return callEngineClassify(ENGINE_TARGET, KITCHEN_ENGINE_INPUT, signal, fetchImpl)
}

async function engineFailure(call: Promise<unknown>): Promise<JevHttpError> {
  try {
    await call
  } catch (e) {
    if (e instanceof JevEndpointError) return e.http
    throw e
  }
  return assert.fail('expected the engine call to fail')
}

function withRows(rows: unknown): Record<string, unknown> {
  return { ...structuredClone(F2_KITCHEN), data: rows }
}

function kitchenRowsWith(index: number, change: Record<string, unknown>): Array<Record<string, unknown> | null> {
  const rows: Array<Record<string, unknown> | null> = structuredClone(F2_KITCHEN.data)
  rows[index] = { ...rows[index], ...change }
  return rows
}

function kitchenRowsWithNull(index: number): Array<Record<string, unknown> | null> {
  const rows: Array<Record<string, unknown> | null> = structuredClone(F2_KITCHEN.data)
  rows[index] = null
  return rows
}

const BAD_ENGINE_RESPONSE: JevHttpError = {
  status: 502,
  code: 'engine_bad_response',
  type: 'api_error',
  message: 'The engine returned an unexpected /classify response.',
}

test('callEngineClassify: one POST to <target>/classify (no /v1) with the engine alias and every input', async () => {
  const engine = recordingEngine(jsonReply(F2_KITCHEN))
  const signal = new AbortController().signal

  await classifyKitchen(engine.fetchImpl, signal)

  assert.equal(engine.calls.length, 1)
  const [{ url, init }] = engine.calls
  assert.equal(url, 'http://engine.local/classify')
  assert.equal(init.method, 'POST')
  assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
  assert.deepEqual(JSON.parse(String(init.body)), { model: 'default_model', input: KITCHEN_ENGINE_INPUT })
  assert.equal(init.signal, signal)
})

test('callEngineClassify: F2 → rows in index order with their probs, and the usage', async () => {
  const result = await classifyKitchen(recordingEngine(jsonReply(F2_KITCHEN)).fetchImpl)
  assert.deepEqual(result, {
    rows: [
      { index: 0, probs: [0.0, 0.957, 0.043] },
      { index: 1, probs: [1.0, 0.0, 0.0] },
      { index: 2, probs: [0.001, 0.001, 0.998] },
    ],
    usage: { prompt_tokens: 69, total_tokens: 69 },
  })
})

test('callEngineClassify: rows the engine returns out of order are sorted by index', async () => {
  const [first, second, third] = F2_KITCHEN.data
  const shuffled = withRows([third, first, second])
  const result = await classifyKitchen(recordingEngine(jsonReply(shuffled)).fetchImpl)
  assert.deepEqual(result.rows.map((row) => row.index), [0, 1, 2])
  assert.deepEqual(result.rows[2].probs, [0.001, 0.001, 0.998])
})

test('callEngineClassify: missing or non-numeric usage counts become 0', async () => {
  const noUsage = { data: structuredClone(F2_KITCHEN.data) }
  const oddUsage = { ...structuredClone(F2_KITCHEN), usage: { prompt_tokens: '69', total_tokens: null } }
  for (const body of [noUsage, oddUsage]) {
    const result = await classifyKitchen(recordingEngine(jsonReply(body)).fetchImpl)
    assert.deepEqual(result.usage, { prompt_tokens: 0, total_tokens: 0 })
  }
})

test('callEngineClassify: each malformed engine body (F5) → 502 engine_bad_response', async () => {
  const malformed: Array<[string, () => Response]> = [
    ['a row without index', jsonReply(withRows(kitchenRowsWith(1, { index: undefined })))],
    ['two rows with index 0', jsonReply(withRows(kitchenRowsWith(1, { index: 0 })))],
    ['a non-integer index', jsonReply(withRows(kitchenRowsWith(1, { index: 1.5 })))],
    ['an index out of range', jsonReply(withRows(kitchenRowsWith(2, { index: 3 })))],
    ['a row that is not an object', jsonReply(withRows(kitchenRowsWithNull(1)))],
    ['data not an array', jsonReply(withRows({ 0: F2_KITCHEN.data[0] }))],
    ['no data at all', jsonReply({ usage: F2_KITCHEN.usage })],
    ['2 rows for 3 inputs', jsonReply(withRows(F2_KITCHEN.data.slice(0, 2)))],
    ['a non-JSON body', () => new Response('<html>oops</html>', { status: 200 })],
  ]
  for (const [name, reply] of malformed) {
    assert.deepEqual(await engineFailure(classifyKitchen(recordingEngine(reply).fetchImpl)), BAD_ENGINE_RESPONSE, name)
  }
})

test('callEngineClassify: an engine 4xx → 400 engine_rejected with the engine\'s own message', async () => {
  const engine = recordingEngine(jsonReply({ error: { message: 'bad' } }, 422))
  assert.deepEqual(await engineFailure(classifyKitchen(engine.fetchImpl)), {
    status: 400, code: 'engine_rejected', type: 'invalid_request_error', message: 'bad',
  })
})

test('callEngineClassify: an engine 5xx → 502 engine_error', async () => {
  const engine = recordingEngine(() => new Response('', { status: 500 }))
  assert.deepEqual(await engineFailure(classifyKitchen(engine.fetchImpl)), {
    status: 502, code: 'engine_error', type: 'api_error', message: 'Engine returned HTTP 500.',
  })
})

test('callEngineClassify: a fetch that throws → 500 engine_unreachable', async () => {
  const failure = await engineFailure(classifyKitchen(throwingEngine(new TypeError('fetch failed'))))
  assert.deepEqual(failure, {
    status: 500, code: 'engine_unreachable', type: 'api_error', message: 'Engine unreachable: fetch failed',
  })
})

test('callEngineClassify: a client that already left → 500 engine_unreachable naming the disconnect', async () => {
  const left = new AbortController()
  left.abort()
  const aborted = throwingEngine(new DOMException('This operation was aborted', 'AbortError'))
  assert.deepEqual(await engineFailure(classifyKitchen(aborted, left.signal)), {
    status: 500,
    code: 'engine_unreachable',
    type: 'api_error',
    message: 'Client disconnected before the engine responded.',
  })
})

test('toClassifyResponse: F2 → the F7 classify body, labels read from the model\'s own id2label', async () => {
  const engine = await classifyKitchen(recordingEngine(jsonReply(F2_KITCHEN)).fetchImpl)
  assert.deepEqual(toClassifyResponse(OPENJEV, KITCHEN_CLASSIFY, engine.rows, engine.usage), F7_CLASSIFY)
})

test('toClassifyResponse: the engine\'s own label strings are ignored (all "neutral" in, real labels out)', async () => {
  const allNeutral = withRows(F2_KITCHEN.data.map((row) => ({ ...row, label: 'neutral' })))
  const engine = await classifyKitchen(recordingEngine(jsonReply(allNeutral)).fetchImpl)
  const response = toClassifyResponse(OPENJEV, KITCHEN_CLASSIFY, engine.rows, engine.usage)
  assert.deepEqual(response.results.map((r) => r.label), ['entailment', 'contradiction', 'neutral'])
})

test('toClassifyResponse: a permuted id2label (F4) maps each probability to its own label', () => {
  const permuted = { key: MODEL_KEY, jev: openJevInfo({ labels: ['entailment', 'neutral', 'contradiction'] }) }
  const input: ClassifyInput = { model: MODEL_KEY, premise: KITCHEN_PREMISE, hypotheses: [KITCHEN_HYPOTHESES[0]] }
  const response = toClassifyResponse(permuted, input, [{ index: 0, probs: [0.957, 0.043, 0.0] }], F2_KITCHEN.usage)
  assert.deepEqual(response.results, [{
    hypothesis: 'Someone is preparing food.',
    label: 'entailment',
    probs: { entailment: 0.957, neutral: 0.043, contradiction: 0 },
  }])
})

test('toClassifyResponse: a probs row of the wrong shape (F5) throws JevShapeError', () => {
  for (const probs of [[0.957, 0.043], ['x', 0, 0]]) {
    const rows = [{ index: 0, probs }, ...F2_KITCHEN.data.slice(1)]
    assert.throws(() => toClassifyResponse(OPENJEV, KITCHEN_CLASSIFY, rows, F2_KITCHEN.usage), JevShapeError)
  }
})

test('toRerankResponse: F3 → Paris, Madrid, Berlin by P(entailment) with their original indices (F7)', async () => {
  const engine = await classifyKitchen(recordingEngine(jsonReply(F3_FRANCE)).fetchImpl)
  assert.deepEqual(toRerankResponse(OPENJEV, franceRerank(), engine.rows, engine.usage), F7_RERANK)
})

test('toRerankResponse: top_n 2 keeps the two best; top_n 10 is clamped to the 3 documents', () => {
  const rows = F3_FRANCE.data
  const top2 = toRerankResponse(OPENJEV, franceRerank(2), rows, F3_FRANCE.usage)
  assert.deepEqual(top2.results.map((r) => r.document.text), ['Paris', 'Madrid'])
  assert.equal(toRerankResponse(OPENJEV, franceRerank(10), rows, F3_FRANCE.usage).results.length, 3)
})

test('toRerankResponse: equal scores keep the documents\' input order', () => {
  const [berlin, paris] = F3_FRANCE.data
  const tied = [
    { index: 0, probs: paris.probs },
    { index: 1, probs: paris.probs },
    { index: 2, probs: berlin.probs },
  ]
  for (const rows of [tied, [...tied].reverse()]) {
    const response = toRerankResponse(OPENJEV, franceRerank(), rows, F3_FRANCE.usage)
    assert.deepEqual(response.results.map((r) => r.index), [0, 1, 2])
  }
})
