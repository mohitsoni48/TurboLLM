// POST /v1/systemone (ADR-439, ADR-436 (3)). The request is validated, planned and length-checked before
// anything is resolved to an engine; the engine is a fetch double and nothing here binds a port.
// `./jev-serving` is deliberately the FIRST local import: it and `./gateway` import each other, so loading it
// first proves that no module of that cycle reads another member's binding at module top level.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { MAX_JEV_INPUTS, type JevHttpError } from './jev-serving'
import type { Deps } from '../deps'
import { ENGINE_MODEL_ALIAS } from '../engines/compat'
import { lastLocalActivityMs, resetLocalActivity } from '../link/host-idle'
import type { JevInfo } from '../models/jev'
import type { ModelEntry } from '../models/scanner'
import type { Answer, Question } from '../models/systemone'
import type { RouteResult } from './model-router'
import { handleSystemOne } from './systemone-endpoint'

const MODEL_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const MODEL_NAME = 'qwen3.5 4b nli v2'
const NLI_TEMPLATE = 'Premise: {premise}\nHypothesis: {hypothesis}'
const ENGINE_TARGET = 'http://engine.local'
const UNSET_ENTAILMENT = 0.5

const STATE_URGENT =
  "I've been unable to connect my payment provider for three days and the integration keeps failing. " +
  "I'm losing sales, please help as soon as possible."

const Q_NOUL: Question = { type: 'noul', instructions: 'Does the message convey urgency?' }
const Q_CHOICE: Question = {
  type: 'choice',
  instructions: 'Which team should handle this message?',
  criteria: {
    billing: 'Payment, invoices, refunds or subscription charges',
    technical: 'Bugs, outages or integration problems',
    sales: 'Pricing, plans, upgrades or discounts',
    documentation: 'Questions about where to find docs or reference material',
  },
}
const MOOD_LEVELS = [
  'Calm, just asking or stating facts',
  'Mildly annoyed but polite',
  'Clearly frustrated',
  'Very angry, strong language',
]
const Q_MOOD: Question = { type: 'score', instructions: "What is the customer's tone?", criteria: MOOD_LEVELS }

const THREE_QUESTION_HYPOTHESES = [
  'Does the message convey urgency?',
  'Which team should handle this message? The correct answer is: billing (Payment, invoices, refunds or subscription charges)',
  'Which team should handle this message? The correct answer is: technical (Bugs, outages or integration problems)',
  'Which team should handle this message? The correct answer is: sales (Pricing, plans, upgrades or discounts)',
  'Which team should handle this message? The correct answer is: documentation (Questions about where to find docs or reference material)',
  "What is the customer's tone? The correct answer is: Calm, just asking or stating facts",
  "What is the customer's tone? The correct answer is: Mildly annoyed but polite",
  "What is the customer's tone? The correct answer is: Clearly frustrated",
  "What is the customer's tone? The correct answer is: Very angry, strong language",
]
const THREE_QUESTION_ENTAILMENT = [0.945, 0.321, 0.515, 0.185, 0.005, 0.086, 0.089, 0.551, 0.274]

interface HarnessSetup {
  entries?: ModelEntry[]
  route?: RouteResult
  entailment?: number[]
  usages?: number[]
  reply?: () => Response
}

interface EngineCall {
  url: string
  init: RequestInit
  input: string[]
}

interface Harness {
  app: Hono
  routed: ModelEntry[]
  resolvedLocally: string[]
  engineCalls: EngineCall[]
  generationStarted: string[]
}

interface Recorder {
  routed: ModelEntry[]
  resolvedLocally: string[]
  generationStarted: string[]
}

interface SystemOneBody {
  model: string
  answers: Record<string, Answer>
  usage: { input_tokens: number; output_tokens: number }
}

function jevInfo(overrides: Partial<JevInfo> = {}): JevInfo {
  return {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: NLI_TEMPLATE,
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
    ...overrides,
  }
}

function jevEntry(overrides: Partial<JevInfo> = {}): ModelEntry {
  return { key: MODEL_KEY, name: MODEL_NAME, jev: jevInfo(overrides) } as unknown as ModelEntry
}

/** Row i answers input i with P(entailment) = entailment[i], on the default contradiction/entailment/neutral labels. */
function entailmentRows(entailment: readonly number[]): Array<Record<string, unknown>> {
  return entailment.map((e, index) => ({ index, label: 'entailment', probs: [0, e, 1 - e], num_classes: 3 }))
}

function jsonReply(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fetch double that records each call and answers from `setup`; the entailment values are consumed across calls in order. */
function scriptedEngine(setup: HarnessSetup): { fetchImpl: typeof fetch; calls: EngineCall[] } {
  const calls: EngineCall[] = []
  const remaining = [...(setup.entailment ?? [])]
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input
    assert.ok(input.length <= MAX_JEV_INPUTS, 'one engine batch never exceeds MAX_JEV_INPUTS')
    calls.push({ url: String(url), init: init ?? {}, input })
    if (setup.reply) return setup.reply()
    const entailment = input.map(() => remaining.shift() ?? UNSET_ENTAILMENT)
    const promptTokens = setup.usages?.[calls.length - 1] ?? 32
    return jsonReply({
      data: entailmentRows(entailment),
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    })()
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** The router double answers only what the endpoint may ask it; route() and the generation gate must never be touched. */
function depsDouble(setup: HarnessSetup, recorder: Recorder): Deps {
  const entries = setup.entries ?? [jevEntry()]
  return {
    modelRouter: {
      route: () => { throw new Error('handleSystemOne must never call route()') },
      resolveRemoteTarget: () => undefined,
      resolveLocal: (id: string) => {
        recorder.resolvedLocally.push(id)
        return entries.find((entry) => entry.key === id || entry.name === id)
      },
      routeTo: async (entry: ModelEntry) => {
        recorder.routed.push(entry)
        return setup.route ?? { target: ENGINE_TARGET }
      },
    },
    gate: { acquire: () => { throw new Error('a System One request must never queue on the generation gate') } },
    manager: {
      generationStart: () => { recorder.generationStarted.push('generationStart') },
      generationEnd: () => {},
    },
  } as unknown as Deps
}

function systemOneHarness(setup: HarnessSetup = {}): Harness {
  const recorder: Recorder = { routed: [], resolvedLocally: [], generationStarted: [] }
  const engine = scriptedEngine(setup)
  const d = depsDouble(setup, recorder)
  const app = new Hono()
  app.post('/v1/systemone', (c) => handleSystemOne(c, d, engine.fetchImpl))
  return { app, ...recorder, engineCalls: engine.calls }
}

function systemOneRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: STATE_URGENT, model: MODEL_KEY, questions: { urgent: Q_NOUL }, ...overrides }
}

function postText(app: Hono, text: string): Promise<Response> {
  return Promise.resolve(
    app.request('/v1/systemone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }),
  )
}

function postJson(app: Hono, body: unknown): Promise<Response> {
  return postText(app, JSON.stringify(body))
}

function unprocessable(message: string): JevHttpError {
  return { status: 422, code: 'invalid_request', type: 'invalid_request_error', message }
}

async function assertRefused(res: Response, expected: JevHttpError): Promise<void> {
  assert.equal(res.status, expected.status)
  assert.match(res.headers.get('content-type') ?? '', /json/)
  assert.deepEqual(await res.json(), { error: { message: expected.message, type: expected.type, code: expected.code } })
}

async function servedBody(res: Response): Promise<SystemOneBody> {
  assert.equal(res.status, 200)
  return (await res.json()) as SystemOneBody
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not within 1e-9 of ${expected}`)
}

function assertCloseRecord(actual: Record<string, number>, expected: Record<string, number>): void {
  assert.deepEqual(Object.keys(actual), Object.keys(expected))
  for (const [key, value] of Object.entries(expected)) assertClose(actual[key], value)
}

function choiceOf(answer: Answer): Extract<Answer, { type: 'choice' }> {
  assert.equal(answer.type, 'choice')
  return answer as Extract<Answer, { type: 'choice' }>
}

function scoreOf(answer: Answer): Extract<Answer, { type: 'score' }> {
  assert.equal(answer.type, 'score')
  return answer as Extract<Answer, { type: 'score' }>
}

function premised(hypothesis: string, premise = STATE_URGENT): string {
  return `Premise: ${premise}\nHypothesis: ${hypothesis}`
}

function nestedArrays(depth: number): string {
  return '['.repeat(depth) + ']'.repeat(depth)
}

test('a yes/no question is answered from one engine call, with the model key and the token usage', async () => {
  const harness = systemOneHarness({ entailment: [0.945] })

  const res = await postJson(harness.app, systemOneRequest())

  assert.deepEqual(await servedBody(res), {
    model: MODEL_KEY,
    answers: { urgent: { type: 'noul', noul: 0.945 } },
    usage: { input_tokens: 32, output_tokens: 0 },
  })
  assert.equal(harness.engineCalls.length, 1)
  assert.equal(harness.engineCalls[0].url, 'http://engine.local/classify')
  assert.deepEqual(harness.engineCalls[0].input, [premised('Does the message convey urgency?')])
})

test('a yes/no, a pick-one and a scale question share one engine call and are answered in request order', async () => {
  const harness = systemOneHarness({ entailment: THREE_QUESTION_ENTAILMENT, usages: [129] })

  const body = await servedBody(
    await postJson(harness.app, systemOneRequest({ questions: { urgent: Q_NOUL, team: Q_CHOICE, mood: Q_MOOD } })),
  )

  assert.equal(harness.engineCalls.length, 1)
  assert.deepEqual(harness.engineCalls[0].input, THREE_QUESTION_HYPOTHESES.map((text) => premised(text)))
  assert.deepEqual(Object.keys(body.answers), ['urgent', 'team', 'mood'])
  assert.deepEqual(body.answers.urgent, { type: 'noul', noul: 0.945 })
  const team = choiceOf(body.answers.team)
  assert.equal(team.choice, 'technical')
  assertCloseRecord(team.probabilities, {
    billing: 0.3128654970760234,
    technical: 0.5019493177387915,
    sales: 0.18031189083820662,
    documentation: 0.004873294346978557,
  })
  assertClose(team.confidence, 0.31205475103149055)
  const mood = scoreOf(body.answers.mood)
  assertClose(mood.score, 2.013)
  assert.deepEqual(mood.legend, { 0: MOOD_LEVELS[0], 1: MOOD_LEVELS[1], 2: MOOD_LEVELS[2], 3: MOOD_LEVELS[3] })
  assertCloseRecord(mood.probabilities, { 0: 0.086, 1: 0.089, 2: 0.551, 3: 0.274 })
  assertClose(mood.confidence, 0.49210868531804325)
  assert.equal(body.usage.input_tokens, 129)
})

test('output_tokens is 0 whatever the engine reports', async () => {
  const reply = jsonReply({
    data: entailmentRows([0.945]),
    usage: { prompt_tokens: 10, completion_tokens: 99, total_tokens: 109 },
  })

  const body = await servedBody(await postJson(systemOneHarness({ reply }).app, systemOneRequest()))

  assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 0 })
})

test('a model requested by its name is answered under its key', async () => {
  const body = await servedBody(await postJson(systemOneHarness().app, systemOneRequest({ model: MODEL_NAME })))

  assert.equal(body.model, MODEL_KEY)
})

test('a served request counts as the owner using the machine', async () => {
  resetLocalActivity()

  await postJson(systemOneHarness().app, systemOneRequest())

  assert.notEqual(lastLocalActivityMs(), null)
})

test('a body that fails validation is a 422 that resolves, routes and sends nothing and is not activity', async () => {
  resetLocalActivity()
  const harness = systemOneHarness()

  await assertRefused(await postJson(harness.app, {}), unprocessable('model must be a non-empty string.'))

  assert.deepEqual(harness.resolvedLocally, [])
  assert.deepEqual(harness.routed, [])
  assert.equal(harness.engineCalls.length, 0)
  assert.equal(lastLocalActivityMs(), null, 'a refused request is not activity')
})

test('a body that is not JSON is a 422 that names the body', async () => {
  const harness = systemOneHarness()

  await assertRefused(await postText(harness.app, '{"model": '), unprocessable('body must be a JSON object.'))

  assert.equal(harness.engineCalls.length, 0)
})

test('the engine call is a JSON POST carrying the engine model alias, the inputs and the client-abort signal', async () => {
  const harness = systemOneHarness()

  await postJson(harness.app, systemOneRequest())

  const { init } = harness.engineCalls[0]
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(init.body)), { model: ENGINE_MODEL_ALIAS, input: harness.engineCalls[0].input })
  assert.ok(init.signal instanceof AbortSignal, 'the client-abort signal reaches the engine')
})

test('the request is routed to exactly the resolved model with routeTo, never route()', async () => {
  const entry = jevEntry()
  const harness = systemOneHarness({ entries: [entry] })

  const res = await postJson(harness.app, systemOneRequest())

  assert.equal(res.status, 200, 'route() throws in the double, so a call to it would not answer 200')
  assert.equal(harness.routed.length, 1)
  assert.equal(harness.routed[0], entry)
})

test('the generation gate is never taken', async () => {
  const res = await postJson(systemOneHarness().app, systemOneRequest())

  assert.equal(res.status, 200, 'gate.acquire throws in the double, so taking it would not answer 200')
})

test('a System One request is not counted as active work', async () => {
  const harness = systemOneHarness()

  await postJson(harness.app, systemOneRequest())

  assert.deepEqual(harness.generationStarted, [])
})

test('a permuted id2label reads the entailment through the model\'s own labels, not position 1', async () => {
  const entry = jevEntry({ labels: ['entailment', 'neutral', 'contradiction'] })
  const reply = jsonReply({
    data: [{ index: 0, label: 'entailment', probs: [0.9, 0.05, 0.05], num_classes: 3 }],
    usage: { prompt_tokens: 32, total_tokens: 32 },
  })

  const body = await servedBody(await postJson(systemOneHarness({ entries: [entry], reply }).app, systemOneRequest()))

  assert.deepEqual(body.answers.urgent, { type: 'noul', noul: 0.9 })
})

test('placeholders, $ patterns and braces in the state and the options reach the engine literally, once', async () => {
  const harness = systemOneHarness()
  const state = '{hypothesis} {premise} {} $& $1 costs 5'
  const question: Question = {
    type: 'choice',
    instructions: 'Q?',
    criteria: { '{}': null, other: null },
  }

  await postJson(harness.app, systemOneRequest({ state, questions: { q: question } }))

  assert.deepEqual(harness.engineCalls[0].input, [
    'Premise: {hypothesis} {premise} {} $& $1 costs 5\nHypothesis: Q? The correct answer is: {}',
    'Premise: {hypothesis} {premise} {} $& $1 costs 5\nHypothesis: Q? The correct answer is: other',
  ])
})

test('a state nested 5,000 deep is a JSON 422, never a plain-text 500, and reaches nothing', async () => {
  resetLocalActivity()
  const harness = systemOneHarness()
  const text = `{"state":${nestedArrays(5000)},"model":${JSON.stringify(MODEL_KEY)},` +
    '"questions":{"urgent":{"type":"noul","instructions":"Q?"}}}'

  await assertRefused(
    await postText(harness.app, text),
    unprocessable('state must not be nested more than 32 levels deep.'),
  )

  assert.deepEqual(harness.routed, [])
  assert.equal(harness.engineCalls.length, 0)
  assert.equal(lastLocalActivityMs(), null)
})

test('instructions nested 5,000 deep are a JSON 422 naming the question', async () => {
  const harness = systemOneHarness()
  const text = `{"state":"s","model":${JSON.stringify(MODEL_KEY)},` +
    `"questions":{"urgent":{"type":"noul","instructions":${nestedArrays(5000)}}}}`

  await assertRefused(
    await postText(harness.app, text),
    unprocessable('questions.urgent.instructions must not be nested more than 32 levels deep.'),
  )

  assert.equal(harness.engineCalls.length, 0)
})

test('integer-like question ids are re-ordered by JSON.parse, and the answers and the engine inputs follow that order', async () => {
  const harness = systemOneHarness()
  const text = `{"state":"s","model":${JSON.stringify(MODEL_KEY)},"questions":{` +
    '"b":{"type":"noul","instructions":"Bee?"},"2":{"type":"noul","instructions":"Two?"}}}'

  const body = await servedBody(await postText(harness.app, text))

  assert.deepEqual(Object.keys(body.answers), ['2', 'b'])
  assert.deepEqual(harness.engineCalls[0].input, [premised('Two?', 's'), premised('Bee?', 's')])
})
