// POST /v1/systemone (ADR-439, ADR-436 (3)): a whole set of questions about one state, answered by one batched
// Jev engine call. Dispatched from the single `/v1/*` handler like the other Jev endpoints (ADR-421), and built
// only from ./jev-serving so it never imports a sibling endpoint. User strings are validated, never trimmed.
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { noteLocalActivity } from '../link/host-idle'
import { buildNliInput, mapProbs } from '../models/jev'
import { answersFrom, planSystemOne, type Answer, type SystemOneInput, type SystemOnePlan } from '../models/systemone'
import { parseSystemOneBody, type RequestProblem } from '../models/systemone-request'
import { clientAbort } from './gateway'
import {
  callEngineClassify,
  jevErrorResponse,
  jsonBodyOf,
  refusalFor,
  resolveJevModel,
  routeToJevModel,
  type EngineClassifyRow,
  type JevHttpError,
  type JevModel,
} from './jev-serving'

interface SystemOneResponse {
  model: string
  answers: Record<string, Answer>
  usage: { input_tokens: number; output_tokens: number }
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
): Promise<SystemOneResponse> {
  const { entry, nliTemplate } = resolveJevModel(d, input.model)
  const plan = planSystemOne(input)
  noteLocalActivity()
  const target = await routeToJevModel(d, entry)
  const engine = await callEngineClassify(target, engineInputsOf(plan, nliTemplate), clientAbort(c).signal, fetchImpl)
  return {
    model: entry.key,
    answers: answersFrom(input, plan, entailmentOf(entry, engine.rows)),
    usage: { input_tokens: engine.usage.prompt_tokens, output_tokens: 0 },
  }
}

function unprocessable(problem: RequestProblem): JevHttpError {
  return { status: 422, code: 'invalid_request', type: 'invalid_request_error', message: problem.message }
}

function engineInputsOf(plan: SystemOnePlan, nliTemplate: string): string[] {
  return plan.hypotheses.map((hypothesis) => buildNliInput(nliTemplate, plan.premise, hypothesis.text))
}

/** Read through the model's own labels, never by position: a permuted id2label moves the entailment column. */
function entailmentOf(entry: JevModel, rows: readonly EngineClassifyRow[]): number[] {
  return rows.map((row) => mapProbs(entry.jev.labels, row.probs).probs.entailment)
}
