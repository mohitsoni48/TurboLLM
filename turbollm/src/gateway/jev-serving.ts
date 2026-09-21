// The primitives every Jev endpoint shares: refusal shapes, model resolution and routing, and the one
// batched engine call (ADR-434 (d), ADR-436 (3)). /v1/classify, /v1/rerank and /v1/systemone import from here,
// so no endpoint owns the infrastructure another one needs. The jev-latest alias resolution near the end is the
// one part only /v1/systemone uses; it lives here so it stays unit-testable. User strings are validated, never
// trimmed, except that the jev-latest alias match ignores case and surrounding whitespace.
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Deps } from '../deps'
import { ENGINE_MODEL_ALIAS } from '../engines/compat'
import { JevShapeError, type JevInfo } from '../models/jev'
import type { ModelEntry } from '../models/scanner'
import { describeEngineError } from './gateway'

/** Upper bound on one engine batch: hypotheses per /v1/classify, documents per /v1/rerank, and the chunk size
 *  /v1/systemone splits its hypotheses into. */
export const MAX_JEV_INPUTS = 128

/** A refusal in the OpenAI error envelope's terms. */
export interface JevHttpError {
  status: ContentfulStatusCode
  code: string
  type: 'invalid_request_error' | 'api_error'
  message: string
}

/** A failed engine call, carrying the refusal the gateway answers with. */
export class JevEndpointError extends Error {
  constructor(public http: JevHttpError) {
    super(http.message)
  }
}

/** One engine row: `index` is the input it answers, `probs` is still unchecked (mapProbs checks it). */
export interface EngineClassifyRow {
  index: number
  probs: unknown
}

export interface ClassifyUsage {
  prompt_tokens: number
  total_tokens: number
}

export interface EngineClassifyResult {
  rows: EngineClassifyRow[]
  usage: ClassifyUsage
}

/** A local model already known to be a Jev model. */
export interface JevModel {
  key: string
  jev: JevInfo
}

/** The model's own premise/hypothesis template. ADR-436 (8): with no
 *  usable `nli_template` the model is refused rather than given a guessed prompt, because ADR-434 (d)
 *  says the template is read from the model and never hardcoded. */
export function nliTemplateFor(entry: { name: string; jev?: JevInfo }): string | JevHttpError {
  const template = entry.jev?.nliTemplate
  if (typeof template === 'string') return template
  return {
    status: 400,
    code: 'jev_template_missing',
    type: 'invalid_request_error',
    message: `'${entry.name}' doesn't say how to combine premise and hypothesis (its config.json has no ` +
      "nli_template), so TurboLLM can't build its input.",
  }
}

/** The one engine call per request: a batched `POST <engine>/classify`. For a classification head
 *  that is the only route vLLM serves, and it has no /v1 prefix. Rows come back
 *  sorted by index, exactly one per input; any other failure is thrown as a JevEndpointError. */
export async function callEngineClassify(
  target: string,
  input: string[],
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<EngineClassifyResult> {
  const res = await postToEngine(target, input, signal, fetchImpl)
  if (!res.ok) throw new JevEndpointError(await engineRefusal(res))
  const body = await engineJson(res)
  return { rows: rowsInInputOrder(body, input.length), usage: usageOf(body) }
}

export function jevErrorResponse(c: Context, error: JevHttpError): Response {
  return c.json({ error: { message: error.message, type: error.type, code: error.code } }, error.status)
}

/** An unparseable body reads as no body at all, which both parsers refuse as not a JSON object. */
export async function jsonBodyOf(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

export function throwIfRefused<T>(outcome: T | JevHttpError): T {
  if (isRefusal(outcome)) throw new JevEndpointError(outcome)
  return outcome
}

function isRefusal<T>(outcome: T | JevHttpError): outcome is JevHttpError {
  return typeof outcome === 'object' && outcome !== null && 'code' in outcome
}

export interface ResolvedJevModel {
  entry: ModelEntry & JevModel
  nliTemplate: string
}

/** Exactly the model the request names — a Turbo Link id is refused (ADR-427's embeddings stance)
 *  and nothing ever falls back to another local model. */
export function resolveJevModel(d: Deps, requested: string): ResolvedJevModel {
  if (d.modelRouter.resolveRemoteTarget(requested)) throw new JevEndpointError(LINK_JEV_UNSUPPORTED)
  const entry = d.modelRouter.resolveLocal(requested)
  if (!entry) throw new JevEndpointError(modelNotFound(requested))
  if (!isJevModel(entry)) throw new JevEndpointError(notAJevModel(entry.name))
  const nliTemplate = throwIfRefused(nliTemplateFor(entry))
  return { entry, nliTemplate }
}

function isJevModel(entry: ModelEntry): entry is ModelEntry & JevModel {
  return entry.jev !== undefined
}

/** routeTo, never route(): a model that isn't alive is loaded (auto-swap on) or refused, never
 *  answered by whatever the primary holds. */
export async function routeToJevModel(d: Deps, entry: ModelEntry): Promise<string> {
  const route = await d.modelRouter.routeTo(entry)
  if ('status' in route) {
    throw new JevEndpointError({ status: 503, code: 'model_not_loaded', type: 'api_error', message: route.message })
  }
  return route.target
}

/** Any other error is a bug, not a refusal, and propagates. */
export function refusalFor(error: unknown): JevHttpError {
  if (error instanceof JevEndpointError) return error.http
  if (error instanceof JevShapeError) return BAD_ENGINE_RESPONSE
  throw error
}

export const LINK_JEV_UNSUPPORTED: JevHttpError = {
  status: 400,
  code: 'link_jev_unsupported',
  type: 'invalid_request_error',
  message: 'Turbo Link does not carry the Jev endpoints — call the machine that has the model.',
}

function modelNotFound(requested: string): JevHttpError {
  return {
    status: 404,
    code: 'model_not_found',
    type: 'invalid_request_error',
    message: `No local model matches '${requested}'.`,
  }
}

function notAJevModel(name: string): JevHttpError {
  return {
    status: 400,
    code: 'not_a_jev_model',
    type: 'invalid_request_error',
    message: `'${name}' is not a Jev model — /v1/classify and /v1/rerank need a model whose config.json ` +
      'declares an NLI head (contradiction / entailment / neutral).',
  }
}

const BAD_ENGINE_RESPONSE: JevHttpError = {
  status: 502,
  code: 'engine_bad_response',
  type: 'api_error',
  message: 'The engine returned an unexpected /classify response.',
}

async function postToEngine(
  target: string,
  input: string[],
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(`${target}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ENGINE_MODEL_ALIAS, input }),
      signal,
    })
  } catch (e) {
    throw new JevEndpointError(engineUnreachable(e as Error, signal))
  }
}

function engineUnreachable(error: Error, signal: AbortSignal): JevHttpError {
  const message = signal.aborted
    ? 'Client disconnected before the engine responded.'
    : `Engine unreachable: ${error.message}`
  return { status: 500, code: 'engine_unreachable', type: 'api_error', message }
}

async function engineRefusal(res: Response): Promise<JevHttpError> {
  const { message } = await describeEngineError(res)
  return res.status >= 500
    ? { status: 502, code: 'engine_error', type: 'api_error', message }
    : { status: 400, code: 'engine_rejected', type: 'invalid_request_error', message }
}

async function engineJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new JevEndpointError(BAD_ENGINE_RESPONSE)
  }
}

/** Sorted by index, the rows must read 0..n-1 — one check that refuses a duplicate, a gap and an
 *  out-of-range index alike, so every result lines up with the input it answers. */
function rowsInInputOrder(body: unknown, inputCount: number): EngineClassifyRow[] {
  const data = isJsonObject(body) ? body.data : undefined
  if (!Array.isArray(data) || data.length !== inputCount || !data.every(isIndexedRow)) {
    throw new JevEndpointError(BAD_ENGINE_RESPONSE)
  }
  const rows = data.map(({ index, probs }) => ({ index, probs })).sort((a, b) => a.index - b.index)
  if (!rows.every((row, position) => row.index === position)) throw new JevEndpointError(BAD_ENGINE_RESPONSE)
  return rows
}

function isIndexedRow(row: unknown): row is EngineClassifyRow {
  return isJsonObject(row) && Number.isInteger(row.index)
}

function usageOf(body: unknown): ClassifyUsage {
  const usage: Record<string, unknown> = isJsonObject(body) && isJsonObject(body.usage) ? body.usage : {}
  return { prompt_tokens: tokenCount(usage.prompt_tokens), total_tokens: tokenCount(usage.total_tokens) }
}

function tokenCount(reported: unknown): number {
  return typeof reported === 'number' && Number.isFinite(reported) ? reported : 0
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const JEV_LATEST = 'jev-latest'

export const NO_JEV_MODEL_FOR_LATEST: JevHttpError = {
  status: 404,
  code: 'model_not_found',
  type: 'invalid_request_error',
  message: "No Jev model in your library for 'jev-latest'.",
}

export function isJevLatest(requested: string): boolean {
  return requested.trim().toLowerCase() === JEV_LATEST
}

/** The alias `jev-latest` (ADR-439): the alive Jev model, else the verified Jev model with the largest
 *  `sizeBytes` (a tie goes to library order), else the largest Jev model, else undefined. `verified` says the
 *  architecture is known to launch, not that this checkpoint was tested, so size is a heuristic and not a
 *  quality ranking. */
export function resolveJevLatest(aliveKeys: readonly string[], models: readonly ModelEntry[]): ModelEntry | undefined {
  const jevModels = models.filter(isJevModel)
  const verifiedModels = jevModels.filter((model) => model.jev.verified)
  return aliveJevModel(aliveKeys, jevModels) ?? largestModel(verifiedModels.length > 0 ? verifiedModels : jevModels)
}

function aliveJevModel(aliveKeys: readonly string[], jevModels: readonly ModelEntry[]): ModelEntry | undefined {
  for (const key of aliveKeys) {
    const alive = jevModels.find((model) => model.key === key)
    if (alive) return alive
  }
  return undefined
}

/** The first maximum, so a size tie goes to the earlier model in library order. */
function largestModel(models: readonly ModelEntry[]): ModelEntry | undefined {
  return models.reduce<ModelEntry | undefined>(
    (largest, model) => (largest === undefined || model.sizeBytes > largest.sizeBytes ? model : largest),
    undefined,
  )
}
