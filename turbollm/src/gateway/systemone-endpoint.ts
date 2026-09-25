// POST /v1/systemone (ADR-439, ADR-436 (3)): a whole set of questions about one state, answered by one batched
// Jev engine call — or, for a Laya model, by the Laya engine's own /v1/systemone (./laya-systemone). Dispatched from the single `/v1/*` handler like the other Jev endpoints (ADR-421), and built
// only from ./jev-serving so it never imports a sibling endpoint. User strings are validated, never trimmed,
// except that the jev-latest alias match ignores case and surrounding whitespace.
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { noteLocalActivity } from '../link/host-idle'
import { buildNliInput, JEV_DEFAULT_MAX_MODEL_LEN, mapProbs } from '../models/jev'
import { answersFrom, planSystemOne, type Answer, type SystemOneInput, type SystemOnePlan } from '../models/systemone'
import { parseSystemOneBody, type RequestProblem } from '../models/systemone-request'
import { clientAbort } from './gateway'
import { answerWithLaya, type LayaSystemOneResponse } from './laya-systemone'
import {
  callEngineClassify,
  jevErrorResponse,
  isJevLatest,
  JevEndpointError,
  jsonBodyOf,
  MAX_JEV_INPUTS,
  NO_JEV_MODEL_FOR_LATEST,
  refusalFor,
  resolveJevLatest,
  jevModelFrom,
  resolveLocalModel,
  routeToJevModel,
  type EngineClassifyRow,
  type JevHttpError,
  type JevModel,
} from './jev-serving'

/** The local, approximate context guard: four characters to a token of the launch-default context (ADR-438).
 *  The daemon has no tokenizer, so this is a cheap first line; a pair that slips past it and is really too long
 *  is refused by the engine itself, exactly. Nothing is ever truncated: a shortened premise is a confident wrong
 *  answer with no signal. */
export const MAX_PAIR_CHARS = 4 * JEV_DEFAULT_MAX_MODEL_LEN

interface SystemOneResponse {
  model: string
  answers: Record<string, Answer>
  usage: { input_tokens: number; output_tokens: number }
}

/** Where and how one request reaches its engine: one abort signal for the whole request, not one per call. */
interface EngineConnection {
  target: string
  signal: AbortSignal
  fetchImpl: typeof fetch
}

interface Scores {
  entailment: number[]
  inputTokens: number
}

/** One System One request. It never takes the generation gate (classification is not a generation), does not
 *  count as active work, and writes no request-log or usage entry. */
export async function handleSystemOne(c: Context, d: Deps, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    const parsed = parseSystemOneBody(await jsonBodyOf(c))
    if (!parsed.ok) return jevErrorResponse(c, unprocessable(parsed.problem))
    return c.json(await answerSystemOne(c, d, parsed.input, fetchImpl))
  } catch (error) {
    return jevErrorResponse(c, refusalFor(error))
  }
}

/** The model is resolved and the request planned before `routeTo`, which may load a model: a request that is
 *  refused must never cost a load, and only a request that will be served counts as the owner using the machine. */
async function answerSystemOne(
  c: Context,
  d: Deps,
  input: SystemOneInput,
  fetchImpl: typeof fetch,
): Promise<SystemOneResponse | LayaSystemOneResponse> {
  const named = resolveLocalModel(d, requestedModelName(d, input.model))
  if (named.laya) {
    noteLocalActivity()
    const target = await routeToJevModel(d, named)
    return answerWithLaya(named, input, target, clientAbort(c).signal, fetchImpl)
  }
  const { entry, nliTemplate } = jevModelFrom(named)
  const plan = planSystemOne(input)
  requireWithinBudget(plan)
  noteLocalActivity()
  const target = await routeToJevModel(d, entry)
  const engine: EngineConnection = { target, signal: clientAbort(c).signal, fetchImpl }
  const { entailment, inputTokens } = await scoreInChunks(entry, engineInputsOf(plan, nliTemplate), engine)
  return {
    model: entry.key,
    answers: answersFrom(input, plan, entailment),
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  }
}

/** Sequential and in plan order: one engine call at a time, and chunk boundaries that depend on nothing but the
 *  request. The first chunk that fails fails the whole request, so a partial answer is never reported. */
async function scoreInChunks(entry: JevModel, inputs: readonly string[], engine: EngineConnection): Promise<Scores> {
  const scores: Scores = { entailment: [], inputTokens: 0 }
  for (const chunk of chunksOf(inputs, MAX_JEV_INPUTS)) {
    const { rows, usage } = await callEngineClassify(engine.target, chunk, engine.signal, engine.fetchImpl)
    scores.entailment.push(...entailmentOf(entry, rows))
    scores.inputTokens += usage.prompt_tokens
  }
  return scores
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, chunk) =>
    items.slice(chunk * size, (chunk + 1) * size),
  )
}

/** Only this endpoint knows the `jev-latest` alias, and only it reads the alive slots and the library. A model that is
 *  being stopped is not alive: routing to it would reload it. */
function requestedModelName(d: Deps, model: string): string {
  if (!isJevLatest(model)) return model
  const aliveKeys = d.modelRouter
    .aliveSlots()
    .filter((slot) => slot.state !== 'stopping')
    .map((slot) => slot.modelKey)
  const latest = resolveJevLatest(aliveKeys, d.scanner.list().models)
  if (!latest) throw new JevEndpointError(NO_JEV_MODEL_FOR_LATEST)
  return latest.key
}

function unprocessable(problem: RequestProblem): JevHttpError {
  return { status: 422, code: 'invalid_request', type: 'invalid_request_error', message: problem.message }
}

function requireWithinBudget(plan: SystemOnePlan): void {
  const field = overLongField(plan)
  if (field !== undefined) throw new JevEndpointError(contextLengthExceeded(field))
}

/** `state` when the premise alone is over budget, otherwise the first question, in plan order, whose pair is. */
function overLongField(plan: SystemOnePlan): string | undefined {
  if (plan.premise.length > MAX_PAIR_CHARS) return 'state'
  const offender = plan.hypotheses.find((hypothesis) => plan.premise.length + hypothesis.text.length > MAX_PAIR_CHARS)
  return offender === undefined ? undefined : `questions.${offender.questionId}`
}

function contextLengthExceeded(field: string): JevHttpError {
  const tokens = JEV_DEFAULT_MAX_MODEL_LEN.toLocaleString('en-US')
  return {
    status: 422,
    code: 'context_length_exceeded',
    type: 'invalid_request_error',
    message: `${field} is too long: this model reads about ${tokens} tokens for the state and one question together.`,
  }
}

function engineInputsOf(plan: SystemOnePlan, nliTemplate: string): string[] {
  return plan.hypotheses.map((hypothesis) => buildNliInput(nliTemplate, plan.premise, hypothesis.text))
}

/** Read through the model's own labels, never by position: a permuted id2label moves the entailment column. */
function entailmentOf(entry: JevModel, rows: readonly EngineClassifyRow[]): number[] {
  return rows.map((row) => mapProbs(entry.jev.labels, row.probs).probs.entailment)
}
