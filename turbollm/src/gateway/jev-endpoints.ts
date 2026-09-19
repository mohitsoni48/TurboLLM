// /v1/classify and /v1/rerank — the gateway endpoints for Jev (NLI cross-encoder) models
// (ADR-434 (d), architecture §2.5). They live in their own module, dispatched from the single
// `/v1/*` handler, so the gateway hub doesn't grow and no new Hono route can be shadowed by
// registration order (ADR-421, divergence row 7). User strings are validated, never trimmed.
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ENGINE_MODEL_ALIAS } from '../engines/compat'
import {
  DEFAULT_HYPOTHESIS_TEMPLATE,
  mapProbs,
  validateHypothesisTemplate,
  type JevInfo,
  type JevLabel,
} from '../models/jev'
import { describeEngineError } from './gateway'

export type JevEndpoint = 'classify' | 'rerank'

/** Upper bound on hypotheses (classify) or documents (rerank) in one request — one engine batch. */
export const MAX_JEV_INPUTS = 128

export interface ClassifyInput {
  model: string
  premise: string
  hypotheses: string[]
}

export interface RerankInput {
  model: string
  query: string
  documents: string[]
  topN: number | undefined
  hypothesisTemplate: string
}

/** A refusal in the OpenAI error envelope's terms (architecture §3.2). */
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

export interface ClassifyResponse {
  model: string
  results: Array<{ hypothesis: string; label: JevLabel; probs: Record<JevLabel, number> }>
  usage: ClassifyUsage
}

export interface RerankResult {
  index: number
  document: { text: string }
  relevance_score: number
  label: JevLabel
}

export interface RerankResponse {
  model: string
  results: RerankResult[]
  usage: ClassifyUsage
}

/** Which Jev endpoint a request is for: POST on the exact path only. */
export function jevEndpointFor(method: string, pathname: string): JevEndpoint | null {
  if (method !== 'POST') return null
  return Object.hasOwn(JEV_ENDPOINT_PATHS, pathname) ? JEV_ENDPOINT_PATHS[pathname] : null
}

export function parseClassifyBody(raw: unknown): ClassifyInput | JevHttpError {
  if (!isJsonObject(raw)) return invalidRequest(NOT_A_JSON_OBJECT)
  if (!isNonEmptyString(raw.model)) return invalidRequest(MODEL_REQUIRED)
  if (!isNonEmptyString(raw.premise)) return invalidRequest('premise must be a non-empty string.')
  if (!isInputList(raw.hypotheses, isNonEmptyString)) {
    return invalidRequest(`hypotheses must be an array of 1 to ${MAX_JEV_INPUTS} non-empty strings.`)
  }
  return { model: raw.model, premise: raw.premise, hypotheses: raw.hypotheses }
}

export function parseRerankBody(raw: unknown): RerankInput | JevHttpError {
  if (!isJsonObject(raw)) return invalidRequest(NOT_A_JSON_OBJECT)
  if (!isNonEmptyString(raw.model)) return invalidRequest(MODEL_REQUIRED)
  if (!isNonEmptyString(raw.query)) return invalidRequest('query must be a non-empty string.')
  if (!isInputList(raw.documents, isRerankDocument)) return invalidRequest(DOCUMENTS_REQUIRED)
  if (!isAbsentOr(raw.top_n, isPositiveInteger)) return invalidRequest('top_n must be an integer of at least 1.')
  const hypothesisTemplate = chosenHypothesisTemplate(raw.hypothesis_template)
  if (typeof hypothesisTemplate !== 'string') return hypothesisTemplate
  return {
    model: raw.model,
    query: raw.query,
    documents: raw.documents.map(documentText),
    topN: raw.top_n,
    hypothesisTemplate,
  }
}

/** The model's own premise/hypothesis template. Q1 default (architecture §5, ADR-436 (8)): with no
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
 *  that is the only route vLLM serves, and it has no /v1 prefix (brief lines 21-25). Rows come back
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

/** One result per hypothesis, in input order, labelled through the model's own id2label. */
export function toClassifyResponse(
  entry: JevModel,
  input: ClassifyInput,
  rows: EngineClassifyRow[],
  usage: ClassifyUsage,
): ClassifyResponse {
  const results = rows.map((row) => ({
    hypothesis: input.hypotheses[row.index],
    ...mapProbs(entry.jev.labels, row.probs),
  }))
  return { model: entry.key, results, usage }
}

/** Documents ranked by P(entailment), best first (ties keep input order), cut to top_n. */
export function toRerankResponse(
  entry: JevModel,
  input: RerankInput,
  rows: EngineClassifyRow[],
  usage: ClassifyUsage,
): RerankResponse {
  const ranked = rows.map((row): RerankResult => {
    const { label, probs } = mapProbs(entry.jev.labels, row.probs)
    return { index: row.index, document: { text: input.documents[row.index] }, relevance_score: probs.entailment, label }
  })
  ranked.sort(byRelevanceThenInputOrder)
  return { model: entry.key, results: ranked.slice(0, input.topN ?? ranked.length), usage }
}

export function jevErrorResponse(c: Context, error: JevHttpError): Response {
  return c.json({ error: { message: error.message, type: error.type, code: error.code } }, error.status)
}

const JEV_ENDPOINT_PATHS: Readonly<Record<string, JevEndpoint>> = {
  '/v1/classify': 'classify',
  '/v1/rerank': 'rerank',
}

const NOT_A_JSON_OBJECT = 'Request body must be a JSON object.'
const MODEL_REQUIRED = 'model is required.'
const DOCUMENTS_REQUIRED =
  `documents must be an array of 1 to ${MAX_JEV_INPUTS} non-empty strings or {"text": string} objects.`

/** Cohere v2 / Jina accept a document as a bare string or as `{ "text": … }`. */
type RerankDocument = string | { text: string }

function invalidRequest(message: string): JevHttpError {
  return { status: 400, code: 'invalid_request', type: 'invalid_request_error', message }
}

/** The caller's template when it is valid, the authors' default when absent (ADR-434 (d)). */
function chosenHypothesisTemplate(requested: unknown): string | JevHttpError {
  if (requested === undefined) return DEFAULT_HYPOTHESIS_TEMPLATE
  const problem = validateHypothesisTemplate(requested)
  if (problem === null) return requested as string
  return { status: 400, code: 'invalid_hypothesis_template', type: 'invalid_request_error', message: problem }
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

function byRelevanceThenInputOrder(a: RerankResult, b: RerankResult): number {
  return b.relevance_score - a.relevance_score || a.index - b.index
}

function isInputList<T>(value: unknown, isInput: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_JEV_INPUTS && value.every(isInput)
}

function isRerankDocument(value: unknown): value is RerankDocument {
  return isNonEmptyString(value) || (isJsonObject(value) && isNonEmptyString(value.text))
}

function documentText(document: RerankDocument): string {
  return typeof document === 'string' ? document : document.text
}

function isAbsentOr<T>(value: unknown, isPresent: (v: unknown) => v is T): value is T | undefined {
  return value === undefined || isPresent(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
