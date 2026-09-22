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
import type { AliveSlot, RouteResult } from './model-router'
import { handleSystemOne, MAX_PAIR_CHARS } from './systemone-endpoint'

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
  linkedId?: string
  aliveSlots?: AliveSlot[]
  route?: RouteResult
  entailment?: number[]
  usages?: number[]
  reply?: (call: number) => Response
  fetchImpl?: typeof fetch
}

interface EngineCall {
  url: string
  init: RequestInit
  input: string[]
}

interface ScriptedEngine {
  fetchImpl: typeof fetch
  calls: EngineCall[]
  maxInFlight: () => number
}

interface Harness {
  app: Hono
  routed: ModelEntry[]
  resolvedLocally: string[]
  aliasLookups: string[]
  engineCalls: EngineCall[]
  generationStarted: string[]
  maxInFlight: () => number
}

interface Recorder {
  routed: ModelEntry[]
  resolvedLocally: string[]
  aliasLookups: string[]
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

function libraryModel(fields: { key: string; name: string; sizeBytes: number; jev?: JevInfo }): ModelEntry {
  return fields as unknown as ModelEntry
}

/** The library, in name order, as the scanner lists it: only the two smaller Jev models are verified. */
const CHAT = libraryModel({ key: 'qwen3.6-35b-a3b-q3', name: 'Qwen3.6-35B Q3', sizeBytes: 100 })
const JEV_08B = libraryModel({
  key: 'qwen3.5 0.8b nli v2s long|mlx-fp16|1700000000',
  name: 'qwen3.5 0.8b nli v2s long',
  sizeBytes: 1_700_000_000,
  jev: jevInfo({ verified: true }),
})
const JEV_35B = libraryModel({
  key: 'qwen3.5 35b a3b nli|mlx-fp16|69000000000',
  name: 'qwen3.5 35b a3b nli',
  sizeBytes: 69_000_000_000,
  jev: jevInfo({ verified: false }),
})
const JEV_4B = libraryModel({ key: MODEL_KEY, name: MODEL_NAME, sizeBytes: 9_100_000_000, jev: jevInfo() })
const JEV_SMALL_UNVERIFIED = libraryModel({
  key: 'small nli|mlx-fp16|1700000000',
  name: 'small nli',
  sizeBytes: 1_700_000_000,
  jev: jevInfo({ verified: false }),
})
const LIBRARY = [CHAT, JEV_08B, JEV_35B, JEV_4B]

function aliveSlot(entry: ModelEntry, state: AliveSlot['state'] = 'running'): AliveSlot {
  return { modelKey: entry.key, state, primary: true, lastUsedMs: 0 }
}

/** Row i answers input i with P(entailment) = entailment[i], on the default contradiction/entailment/neutral labels. */
function entailmentRows(entailment: readonly number[]): Array<Record<string, unknown>> {
  return entailment.map((e, index) => ({ index, label: 'entailment', probs: [0, e, 1 - e], num_classes: 3 }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function jsonReply(body: unknown, status = 200): () => Response {
  return () => jsonResponse(body, status)
}

function classifyResponse(entailment: readonly number[], promptTokens: number): Response {
  return jsonResponse({
    data: entailmentRows(entailment),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  })
}

/** A fetch double that records each call and answers from `setup`; the entailment values are consumed across calls
 *  in order. It yields between taking and releasing an in-flight slot, so overlapping calls would show in `maxInFlight`. */
function scriptedEngine(setup: HarnessSetup): ScriptedEngine {
  const calls: EngineCall[] = []
  const remaining = [...(setup.entailment ?? [])]
  let inFlight = 0
  let peak = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input
    assert.ok(input.length <= MAX_JEV_INPUTS, 'one engine batch never exceeds MAX_JEV_INPUTS')
    const call = calls.push({ url: String(url), init: init ?? {}, input }) - 1
    const reply = setup.reply
      ? setup.reply(call)
      : classifyResponse(input.map(() => remaining.shift() ?? UNSET_ENTAILMENT), setup.usages?.[call] ?? 32)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await Promise.resolve()
    inFlight -= 1
    return reply
  }) as typeof fetch
  return { fetchImpl, calls, maxInFlight: () => peak }
}

/** The router double answers only what the endpoint may ask it; route() and the generation gate must never be touched.
 *  The alive slots and the library are read only to resolve the `jev-latest` alias, and every such read is recorded. */
function depsDouble(setup: HarnessSetup, recorder: Recorder): Deps {
  const entries = setup.entries ?? [jevEntry()]
  return {
    modelRouter: {
      route: () => { throw new Error('handleSystemOne must never call route()') },
      resolveRemoteTarget: (id: string) => (id === setup.linkedId ? { target: 'https://rig.invalid' } : undefined),
      resolveLocal: (id: string) => {
        recorder.resolvedLocally.push(id)
        return entries.find((entry) => entry.key === id || entry.name === id)
      },
      routeTo: async (entry: ModelEntry) => {
        recorder.routed.push(entry)
        return setup.route ?? { target: ENGINE_TARGET }
      },
      aliveSlots: () => {
        recorder.aliasLookups.push('aliveSlots')
        return setup.aliveSlots ?? []
      },
    },
    scanner: {
      list: () => {
        recorder.aliasLookups.push('scanner.list')
        return { models: entries, scanning: false, lastScanAt: '' }
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
  const recorder: Recorder = { routed: [], resolvedLocally: [], aliasLookups: [], generationStarted: [] }
  const engine = scriptedEngine(setup)
  const d = depsDouble(setup, recorder)
  const app = new Hono()
  app.post('/v1/systemone', (c) => handleSystemOne(c, d, setup.fetchImpl ?? engine.fetchImpl))
  return { app, ...recorder, engineCalls: engine.calls, maxInFlight: engine.maxInFlight }
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

function tooLong(field: string): JevHttpError {
  return {
    status: 422,
    code: 'context_length_exceeded',
    type: 'invalid_request_error',
    message: `${field} is too long: this model reads about 8,192 tokens for the state and one question together.`,
  }
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

/** A yes/no question whose hypothesis is `instructions` followed by a `criteria.true` of `criterionChars` characters. */
function noulQuestionWithCriterion(criterionChars: number): Question {
  return { type: 'noul', instructions: Q_NOUL.instructions, criteria: { true: 'x'.repeat(criterionChars) } }
}

/** A pick-one question with options o0..o(n-1) and no descriptions: one hypothesis per option. */
function choiceQuestion(optionCount: number): Question {
  const criteria = Object.fromEntries(Array.from({ length: optionCount }, (_, index) => [`o${index}`, null]))
  return { type: 'choice', instructions: 'Q?', criteria }
}

function optionHypothesis(index: number): string {
  return premised(`Q? The correct answer is: o${index}`)
}

function batchSizes(harness: Harness): number[] {
  return harness.engineCalls.map((call) => call.input.length)
}

/** A yes/no request for `model` (the `jev-latest` alias by default) against the four-model library. */
async function requestModel(
  setup: HarnessSetup = {},
  model = 'jev-latest',
): Promise<{ harness: Harness; res: Response }> {
  const harness = systemOneHarness({ entries: LIBRARY, ...setup })
  return { harness, res: await postJson(harness.app, systemOneRequest({ model })) }
}

function assertRoutedOnlyTo(harness: Harness, entry: ModelEntry): void {
  assert.equal(harness.routed.length, 1)
  assert.equal(harness.routed[0], entry)
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

test('200 hypotheses go in two engine calls of 128 and 72, in plan order, and one question spans the boundary', async () => {
  const entailment = Array.from({ length: 200 }, (_, index) => (index + 1) / 1000)
  const harness = systemOneHarness({ entailment, usages: [50, 30] })

  const body = await servedBody(
    await postJson(harness.app, systemOneRequest({ questions: { q: choiceQuestion(200) } })),
  )

  assert.deepEqual(batchSizes(harness), [128, 72])
  assert.deepEqual(
    harness.engineCalls.flatMap((call) => call.input),
    Array.from({ length: 200 }, (_, index) => optionHypothesis(index)),
  )
  assert.equal(body.usage.input_tokens, 80, 'the input tokens are the sum over the chunks')
  const answer = choiceOf(body.answers.q)
  assert.equal(answer.choice, 'o199')
  assertClose(answer.probabilities.o0, 0.001 / entailment.reduce((sum, value) => sum + value, 0))
  assertClose(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0), 1)
})

test('exactly 128 hypotheses go in one engine call', async () => {
  const harness = systemOneHarness()

  await postJson(harness.app, systemOneRequest({ questions: { q: choiceQuestion(128) } }))

  assert.deepEqual(batchSizes(harness), [128])
})

test('129 hypotheses go in two engine calls of 128 and 1', async () => {
  const harness = systemOneHarness()

  await postJson(harness.app, systemOneRequest({ questions: { q: choiceQuestion(129) } }))

  assert.deepEqual(batchSizes(harness), [128, 1])
})

test('512 hypotheses, the most a request may produce, go in four engine calls of 128', async () => {
  const harness = systemOneHarness()
  const questions = { c1: choiceQuestion(255), c2: choiceQuestion(255), n1: Q_NOUL, n2: Q_NOUL }

  await servedBody(await postJson(harness.app, systemOneRequest({ questions })))

  assert.deepEqual(batchSizes(harness), [128, 128, 128, 128])
})

test('513 hypotheses are a 422 on the questions, and nothing is sent or routed', async () => {
  const harness = systemOneHarness()
  const questions = { c1: choiceQuestion(255), c2: choiceQuestion(255), n1: Q_NOUL, n2: Q_NOUL, n3: Q_NOUL }

  await assertRefused(
    await postJson(harness.app, systemOneRequest({ questions })),
    unprocessable('questions must produce at most 512 hypotheses in total.'),
  )

  assert.equal(harness.engineCalls.length, 0)
  assert.deepEqual(harness.routed, [])
})

test('the chunks are sent one after another, never in parallel', async () => {
  const harness = systemOneHarness()

  await postJson(harness.app, systemOneRequest({ questions: { q: choiceQuestion(200) } }))

  assert.equal(harness.engineCalls.length, 2)
  assert.equal(harness.maxInFlight(), 1)
})

test('identical requests are cut at identical chunk boundaries', async () => {
  const harness = systemOneHarness()
  const request = systemOneRequest({ questions: { q: choiceQuestion(200) } })

  await postJson(harness.app, request)
  await postJson(harness.app, request)

  assert.deepEqual(batchSizes(harness), [128, 72, 128, 72])
})

test('a failing later chunk fails the whole request with that chunk\'s refusal and no partial answer', async () => {
  const firstChunkAnswered = classifyResponse(Array.from({ length: MAX_JEV_INPUTS }, () => 0.5), 40)
  const reply = (call: number) =>
    call === 0 ? firstChunkAnswered : jsonResponse({ error: { message: 'engine overloaded' } }, 503)
  const harness = systemOneHarness({ reply })

  const res = await postJson(harness.app, systemOneRequest({ questions: { q: choiceQuestion(200) } }))

  await assertRefused(res, { status: 502, code: 'engine_error', type: 'api_error', message: 'engine overloaded' })
})

test('the character budget is four characters for each token of the launch-default context', () => {
  assert.equal(MAX_PAIR_CHARS, 32_768)
})

test('a state over the budget is a 422 naming the state, and nothing is routed, sent or counted as activity', async () => {
  resetLocalActivity()
  const harness = systemOneHarness()

  await assertRefused(
    await postJson(harness.app, systemOneRequest({ state: 'a'.repeat(MAX_PAIR_CHARS + 1) })),
    tooLong('state'),
  )

  assert.equal(harness.engineCalls.length, 0)
  assert.deepEqual(harness.routed, [])
  assert.equal(lastLocalActivityMs(), null, 'a refused request is not activity')
})

test('a question whose pair with a short state is over the budget is a 422 naming that question, and nothing is routed', async () => {
  const harness = systemOneHarness()
  const questions = { urgent: noulQuestionWithCriterion(MAX_PAIR_CHARS) }

  await assertRefused(await postJson(harness.app, systemOneRequest({ state: 's', questions })), tooLong('questions.urgent'))

  assert.equal(harness.engineCalls.length, 0)
  assert.deepEqual(harness.routed, [])
})

test('a pair exactly at the budget is accepted', async () => {
  const harness = systemOneHarness()
  const questions = { urgent: { type: 'noul', instructions: 'Q?' } }

  const res = await postJson(harness.app, systemOneRequest({ state: 'a'.repeat(MAX_PAIR_CHARS - 2), questions }))

  assert.equal(res.status, 200)
  assert.equal(harness.engineCalls.length, 1)
})

test('a state of exactly the budget leaves no room for a question, so the refusal names the question, not the state', async () => {
  const harness = systemOneHarness()

  await assertRefused(
    await postJson(harness.app, systemOneRequest({ state: 'a'.repeat(MAX_PAIR_CHARS) })),
    tooLong('questions.urgent'),
  )
})

test('only the offending pair counts: a long description on the second option names its question', async () => {
  const question: Question = {
    type: 'choice',
    instructions: 'Q?',
    criteria: { short: 'ok', long: 'x'.repeat(MAX_PAIR_CHARS) },
  }

  await assertRefused(
    await postJson(systemOneHarness().app, systemOneRequest({ state: 's', questions: { q: question } })),
    tooLong('questions.q'),
  )
})

test('of two questions where only the second is too long, the second is named', async () => {
  const questions = { first: Q_NOUL, second: noulQuestionWithCriterion(MAX_PAIR_CHARS) }

  await assertRefused(
    await postJson(systemOneHarness().app, systemOneRequest({ state: 's', questions })),
    tooLong('questions.second'),
  )
})

test('when several questions are too long, the first in request order is named, not the first alphabetically', async () => {
  const questions = { zulu: noulQuestionWithCriterion(MAX_PAIR_CHARS), alpha: noulQuestionWithCriterion(MAX_PAIR_CHARS) }

  await assertRefused(
    await postJson(systemOneHarness().app, systemOneRequest({ state: 's', questions })),
    tooLong('questions.zulu'),
  )
})

test('the refusal says how much the model reads, in tokens', async () => {
  const res = await postJson(systemOneHarness().app, systemOneRequest({ state: 'a'.repeat(MAX_PAIR_CHARS + 1) }))

  const { error } = (await res.json()) as { error: { message: string } }

  assert.match(error.message, /about 8,192 tokens/)
})

test('a long but legal premise reaches the engine whole, never truncated', async () => {
  const harness = systemOneHarness()
  const state = 'a'.repeat(MAX_PAIR_CHARS - 10)
  const questions = { urgent: { type: 'noul', instructions: 'Q?' } }

  await postJson(harness.app, systemOneRequest({ state, questions }))

  assert.ok(harness.engineCalls[0].input[0].includes(state))
})

test('jev-latest is served by the alive Jev model, whatever its size, and the resolved key is what gets routed', async () => {
  const { harness, res } = await requestModel({ aliveSlots: [aliveSlot(JEV_08B)] })

  assert.equal((await servedBody(res)).model, JEV_08B.key)
  assertRoutedOnlyTo(harness, JEV_08B)
  assert.deepEqual(harness.resolvedLocally, [JEV_08B.key])
})

test('jev-latest is matched case-insensitively on the trimmed model field', async () => {
  const { harness, res } = await requestModel({ aliveSlots: [aliveSlot(JEV_08B)] }, '  JEV-Latest ')

  assert.equal((await servedBody(res)).model, JEV_08B.key)
  assertRoutedOnlyTo(harness, JEV_08B)
})

test('with nothing alive, jev-latest picks the largest verified Jev model, not the first by name and not an unverified giant', async () => {
  const { harness, res } = await requestModel()

  assert.equal((await servedBody(res)).model, JEV_4B.key)
  assertRoutedOnlyTo(harness, JEV_4B)
})

test('with no verified Jev model, jev-latest picks the largest Jev model', async () => {
  const { harness, res } = await requestModel({ entries: [CHAT, JEV_35B, JEV_SMALL_UNVERIFIED] })

  assert.equal((await servedBody(res)).model, JEV_35B.key)
  assertRoutedOnlyTo(harness, JEV_35B)
})

test('a Jev slot that is being stopped is not alive for jev-latest, because routing to it would reload it', async () => {
  const { harness, res } = await requestModel({ aliveSlots: [aliveSlot(JEV_08B, 'stopping')] })

  assert.equal((await servedBody(res)).model, JEV_4B.key)
  assertRoutedOnlyTo(harness, JEV_4B)
})

test('jev-latest with no Jev model in the library is a 404 that names the alias, and nothing is resolved or routed', async () => {
  resetLocalActivity()
  const { harness, res } = await requestModel({ entries: [CHAT] })

  await assertRefused(res, {
    status: 404,
    code: 'model_not_found',
    type: 'invalid_request_error',
    message: "No Jev model in your library for 'jev-latest'.",
  })

  assert.deepEqual(harness.resolvedLocally, [])
  assert.deepEqual(harness.routed, [])
  assert.equal(harness.engineCalls.length, 0)
  assert.equal(lastLocalActivityMs(), null)
})

test('with auto-swap off the router refuses the alias\'s model with 503, never a silent load', async () => {
  const notLoaded = "'qwen3.5 4b nli v2' is not loaded. Load it from Models, or turn on auto-swap."

  const { harness, res } = await requestModel({ route: { status: 503, message: notLoaded } })

  await assertRefused(res, { status: 503, code: 'model_not_loaded', type: 'api_error', message: notLoaded })
  assert.equal(harness.engineCalls.length, 0)
})

test('a model requested by key never asks for the alive slots or the library', async () => {
  const { harness, res } = await requestModel({}, MODEL_KEY)

  assert.equal(res.status, 200)
  assert.deepEqual(harness.aliasLookups, [])
})

test('a model no library entry matches is a 404', async () => {
  const { harness, res } = await requestModel({}, 'nope')

  await assertRefused(res, {
    status: 404,
    code: 'model_not_found',
    type: 'invalid_request_error',
    message: "No local model matches 'nope'.",
  })
  assert.deepEqual(harness.routed, [])
})

test('a chat model is a 400 not_a_jev_model, and nothing is loaded', async () => {
  const { harness, res } = await requestModel({}, CHAT.key)

  await assertRefused(res, {
    status: 400,
    code: 'not_a_jev_model',
    type: 'invalid_request_error',
    message: "'Qwen3.6-35B Q3' is not a Jev model — /v1/classify and /v1/rerank need a model whose config.json " +
      'declares an NLI head (contradiction / entailment / neutral).',
  })
  assert.deepEqual(harness.routed, [])
})

test('a Jev model without an nli_template is a 400 jev_template_missing, and nothing is loaded or counted', async () => {
  resetLocalActivity()
  const templateless = libraryModel({
    key: 'nli-no-template',
    name: 'nli no template',
    sizeBytes: 5,
    jev: jevInfo({ nliTemplate: null }),
  })

  const { harness, res } = await requestModel({ entries: [templateless] }, templateless.key)

  await assertRefused(res, {
    status: 400,
    code: 'jev_template_missing',
    type: 'invalid_request_error',
    message: "'nli no template' doesn't say how to combine premise and hypothesis (its config.json has no " +
      "nli_template), so TurboLLM can't build its input.",
  })
  assert.deepEqual(harness.routed, [])
  assert.equal(lastLocalActivityMs(), null)
})

test('a Turbo Link machine/model id is a 400 link_jev_unsupported, never resolved locally', async () => {
  const { harness, res } = await requestModel({ linkedId: 'Rig/qwen3.5 4b nli v2' }, 'Rig/qwen3.5 4b nli v2')

  await assertRefused(res, {
    status: 400,
    code: 'link_jev_unsupported',
    type: 'invalid_request_error',
    message: 'Turbo Link does not carry the Jev endpoints — call the machine that has the model.',
  })
  assert.deepEqual(harness.resolvedLocally, [])
  assert.deepEqual(harness.routed, [])
})

test('an engine 4xx is a 400 engine_rejected carrying the engine\'s message', async () => {
  const reply = jsonReply({ error: { message: 'bad' } }, 422)

  const { res } = await requestModel({ reply }, MODEL_KEY)

  await assertRefused(res, { status: 400, code: 'engine_rejected', type: 'invalid_request_error', message: 'bad' })
})

test('an engine 5xx is a 502 engine_error carrying the engine\'s message', async () => {
  const reply = jsonReply({ error: { message: 'engine down' } }, 503)

  const { res } = await requestModel({ reply }, MODEL_KEY)

  await assertRefused(res, { status: 502, code: 'engine_error', type: 'api_error', message: 'engine down' })
})

const THREE_ROWS = entailmentRows([0.1, 0.2, 0.3])
const THREE_ROW_USAGE = { prompt_tokens: 30, total_tokens: 30 }
const MALFORMED_ENGINE_REPLIES: Array<[string, () => Response]> = [
  ['a probs vector of the wrong length', jsonReply({
    data: [{ ...THREE_ROWS[0], probs: [0.5, 0.5] }, THREE_ROWS[1], THREE_ROWS[2]],
    usage: THREE_ROW_USAGE,
  })],
  ['two rows claiming the same index', jsonReply({
    data: [THREE_ROWS[0], { ...THREE_ROWS[1], index: 0 }, THREE_ROWS[2]],
    usage: THREE_ROW_USAGE,
  })],
  ['two rows for three inputs', jsonReply({ data: THREE_ROWS.slice(0, 2), usage: THREE_ROW_USAGE })],
  ['a body that is not JSON', () => new Response('not json', { status: 200 })],
  ['a probs entry that is not a number', jsonReply({
    data: [{ ...THREE_ROWS[0], probs: ['x', 0, 0] }, THREE_ROWS[1], THREE_ROWS[2]],
    usage: THREE_ROW_USAGE,
  })],
]

for (const [name, reply] of MALFORMED_ENGINE_REPLIES) {
  test(`an engine reply with ${name} is a 502 engine_bad_response`, async () => {
    const harness = systemOneHarness({ reply })

    const res = await postJson(harness.app, systemOneRequest({ questions: { q: choiceQuestion(3) } }))

    await assertRefused(res, {
      status: 502,
      code: 'engine_bad_response',
      type: 'api_error',
      message: 'The engine returned an unexpected /classify response.',
    })
  })
}

test('an engine that cannot be reached is a 500 engine_unreachable', async () => {
  const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED') }) as typeof fetch

  const { res } = await requestModel({ fetchImpl }, MODEL_KEY)

  await assertRefused(res, {
    status: 500,
    code: 'engine_unreachable',
    type: 'api_error',
    message: 'Engine unreachable: connect ECONNREFUSED',
  })
})

test('a client that has already disconnected is a 500 with the disconnect message', async () => {
  const left = new AbortController()
  left.abort()
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
    return classifyResponse([0.5], 32)
  }) as typeof fetch
  const harness = systemOneHarness({ fetchImpl })

  const res = await harness.app.request('/v1/systemone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(systemOneRequest()),
    signal: left.signal,
  })

  await assertRefused(res, {
    status: 500,
    code: 'engine_unreachable',
    type: 'api_error',
    message: 'Client disconnected before the engine responded.',
  })
})

test('an unknown model is a 404 even when the state is too long: the model is resolved before the length check', async () => {
  const harness = systemOneHarness({ entries: LIBRARY })

  const res = await postJson(harness.app, systemOneRequest({ model: 'nope', state: 'a'.repeat(MAX_PAIR_CHARS + 1) }))

  await assertRefused(res, {
    status: 404,
    code: 'model_not_found',
    type: 'invalid_request_error',
    message: "No local model matches 'nope'.",
  })
})
