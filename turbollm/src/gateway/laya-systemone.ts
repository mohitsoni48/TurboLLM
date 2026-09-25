// POST /v1/systemone for a Laya model. The Laya engine already speaks this wire protocol (laya-serve's own
// /v1/systemone, TypeSafe's field names), so the validated state and questions are forwarded as they came and the
// answers returned as it gave them — unlike a Jev model, whose answers TurboLLM computes from NLI scores. Laya
// enforces its own limits (64 questions, 50,000 characters of state) and reads at most its checkpoint's token
// budget of the state, so the Jev context guard does not apply here.
import type { ModelEntry } from '../models/scanner'
import type { SystemOneInput } from '../models/systemone'
import { isJsonObject, JevEndpointError, type JevHttpError } from './jev-serving'

export interface LayaSystemOneResponse {
  model: string
  answers: Record<string, unknown>
  usage: { input_tokens: number; output_tokens: number }
  /** Which of the folder's checkpoints answered, and why laya's router chose it. */
  routing?: { model: string; reason: string }
}

/** One engine call. Throws a JevEndpointError for every refusal, so the endpoint answers it like any other. */
export async function answerWithLaya(
  entry: ModelEntry,
  input: SystemOneInput,
  target: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<LayaSystemOneResponse> {
  const res = await postToLaya(target, input, signal, fetchImpl)
  const body = await engineJson(res)
  if (!res.ok) throw new JevEndpointError(refusalFrom(res.status, body))
  if (!isLayaAnswer(body)) throw new JevEndpointError(BAD_LAYA_RESPONSE)
  const routing = routingOf(body.routing)
  return {
    model: entry.key,
    answers: body.answers,
    usage: { input_tokens: tokenCount(body.usage.input_tokens), output_tokens: tokenCount(body.usage.output_tokens) },
    ...(routing ? { routing } : {}),
  }
}

interface LayaAnswer {
  answers: Record<string, unknown>
  usage: Record<string, unknown>
  routing?: unknown
}

async function postToLaya(target: string, input: SystemOneInput, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(`${target}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: input.state, questions: input.questions }),
      signal,
    })
  } catch (e) {
    const message = signal.aborted
      ? 'Client disconnected before the engine responded.'
      : `Engine unreachable: ${(e as Error).message}`
    throw new JevEndpointError({ status: 500, code: 'engine_unreachable', type: 'api_error', message })
  }
}

/** A refusal body that isn't JSON still carries its status, so it is read as no body rather than a bad response. */
async function engineJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    if (!res.ok) return undefined
    throw new JevEndpointError(BAD_LAYA_RESPONSE)
  }
}

/** The statuses laya-serve uses for a request it cannot answer: 400, 413 and 422, each with a FastAPI `detail`. */
const CALLER_REFUSALS: ReadonlySet<number> = new Set([400, 413, 422])

/** Each of those is a request the caller must change, which this endpoint answers with 422 (ADR-440). Any other
 *  non-2xx is the engine failing (a 401 from a key the caller never sent, a 404 from a route that is gone), which a
 *  422 would blame on the caller. */
function refusalFrom(status: number, body: unknown): JevHttpError {
  const message = detailOf(body) ?? `The Laya engine answered HTTP ${status}.`
  return CALLER_REFUSALS.has(status)
    ? { status: 422, code: 'invalid_request', type: 'invalid_request_error', message }
    : { status: 502, code: 'engine_error', type: 'api_error', message }
}

function detailOf(body: unknown): string | undefined {
  if (!isJsonObject(body) || body.detail === undefined) return undefined
  const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  return detail.slice(0, MAX_DETAIL_CHARS)
}

function isLayaAnswer(body: unknown): body is LayaAnswer {
  return isJsonObject(body) && isJsonObject(body.answers) && isJsonObject(body.usage)
}

/** Only the checkpoint and the reason: laya's own routing record also carries the folder path and its language
 *  detection, which a caller has no use for and must not see. */
function routingOf(routing: unknown): LayaSystemOneResponse['routing'] {
  if (!isJsonObject(routing) || typeof routing.model !== 'string' || typeof routing.reason !== 'string') return undefined
  return { model: routing.model, reason: routing.reason }
}

function tokenCount(reported: unknown): number {
  return typeof reported === 'number' && Number.isFinite(reported) ? reported : 0
}

const MAX_DETAIL_CHARS = 500

const BAD_LAYA_RESPONSE: JevHttpError = {
  status: 502,
  code: 'engine_bad_response',
  type: 'api_error',
  message: 'The Laya engine returned an unexpected /v1/systemone response.',
}
