// /v1/classify and /v1/rerank (ADR-434 (d), architecture §2.5 / §3.1 / §3.2). Request bodies are
// validated into typed inputs or precise 400s before anything is resolved, routed or sent to an
// engine. User strings are never trimmed or rewritten.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { DEFAULT_HYPOTHESIS_TEMPLATE, type JevInfo } from '../models/jev'
import {
  jevEndpointFor,
  jevErrorResponse,
  MAX_JEV_INPUTS,
  nliTemplateFor,
  parseClassifyBody,
  parseRerankBody,
  type JevHttpError,
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
