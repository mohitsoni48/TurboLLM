// /v1/classify, /v1/rerank and /v1/systemone — the gateway endpoints for Jev (NLI cross-encoder) models
// (ADR-434 (d), ADR-439). They live outside gateway.ts and are dispatched from the single `/v1/*` handler,
// so the gateway hub doesn't grow and no new Hono route can be shadowed by registration order (ADR-421).
// classify and rerank are served here, /v1/systemone by ./systemone-endpoint. User strings are validated,
// never trimmed.
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { noteLocalActivity } from '../link/host-idle'
import {
  buildNliInput,
  DEFAULT_HYPOTHESIS_TEMPLATE,
  fillHypothesisTemplate,
  mapProbs,
  validateHypothesisTemplate,
  type JevLabel,
} from '../models/jev'
import { clientAbort, type GatewayV1Options } from './gateway'
import {
  callEngineClassify,
  isJsonObject,
  jevErrorResponse,
  jsonBodyOf,
  LINK_JEV_UNSUPPORTED,
  MAX_JEV_INPUTS,
  refusalFor,
  resolveJevModel,
  routeToJevModel,
  throwIfRefused,
  type ClassifyUsage,
  type EngineClassifyResult,
  type EngineClassifyRow,
  type JevHttpError,
  type JevModel,
} from './jev-serving'
import { handleSystemOne } from './systemone-endpoint'

export type JevEndpoint = 'classify' | 'rerank' | 'systemone'

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

/** Which Jev endpoint a request is for: POST on the exact path, forgiving ONE trailing slash (curl
 *  and several HTTP clients add it, and it would otherwise be proxied to the primary engine). */
export function jevEndpointFor(method: string, pathname: string): JevEndpoint | null {
  if (method !== 'POST') return null
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return Object.hasOwn(JEV_ENDPOINT_PATHS, path) ? JEV_ENDPOINT_PATHS[path] : null
}

/** One /v1/classify, /v1/rerank or /v1/systemone request: refuse a Turbo Link peer, validate, resolve exactly the
 *  named local Jev model, route to it (auto-swap may load it), then the batched engine call. It never
 *  takes the generation gate (classification is not a generation) and writes no request-log or usage
 *  entry. */
export async function handleJevRequest(
  c: Context,
  d: Deps,
  endpoint: JevEndpoint,
  opts: GatewayV1Options,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (opts.origin === 'link') return jevErrorResponse(c, LINK_JEV_UNSUPPORTED)
  if (endpoint === 'systemone') return handleSystemOne(c, d, fetchImpl)
  return endpoint === 'classify'
    ? serveJevRequest(c, d, CLASSIFY_ENDPOINT, fetchImpl)
    : serveJevRequest(c, d, RERANK_ENDPOINT, fetchImpl)
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
  if (!isInputList(raw.documents, isRerankDocument)) return invalidRequest(documentsRequired())
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

const JEV_ENDPOINT_PATHS: Readonly<Record<string, JevEndpoint>> = {
  '/v1/classify': 'classify',
  '/v1/rerank': 'rerank',
  '/v1/systemone': 'systemone',
}

/** What the two endpoints do differently; serveJevRequest is everything they share. */
interface EndpointBehaviour<Input extends { model: string }, Body> {
  parse: (raw: unknown) => Input | JevHttpError
  engineInputs: (nliTemplate: string, input: Input) => string[]
  respond: (model: JevModel, input: Input, engine: EngineClassifyResult) => Body
}

const CLASSIFY_ENDPOINT: EndpointBehaviour<ClassifyInput, ClassifyResponse> = {
  parse: parseClassifyBody,
  engineInputs: (nliTemplate, input) =>
    input.hypotheses.map((hypothesis) => buildNliInput(nliTemplate, input.premise, hypothesis)),
  respond: (model, input, engine) => toClassifyResponse(model, input, engine.rows, engine.usage),
}

/** Each document becomes a hypothesis through the request's template, with the query as premise. */
const RERANK_ENDPOINT: EndpointBehaviour<RerankInput, RerankResponse> = {
  parse: parseRerankBody,
  engineInputs: (nliTemplate, input) => input.documents.map((document) =>
    buildNliInput(nliTemplate, input.query, fillHypothesisTemplate(input.hypothesisTemplate, document))),
  respond: (model, input, engine) => toRerankResponse(model, input, engine.rows, engine.usage),
}

async function serveJevRequest<Input extends { model: string }, Body extends object>(
  c: Context,
  d: Deps,
  endpoint: EndpointBehaviour<Input, Body>,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    const input = throwIfRefused(endpoint.parse(await jsonBodyOf(c)))
    const { entry, nliTemplate } = resolveJevModel(d, input.model)
    noteLocalActivity()
    const target = await routeToJevModel(d, entry)
    const inputs = endpoint.engineInputs(nliTemplate, input)
    const engine = await callEngineClassify(target, inputs, clientAbort(c).signal, fetchImpl)
    return c.json(endpoint.respond(entry, input, engine))
  } catch (error) {
    return jevErrorResponse(c, refusalFor(error))
  }
}

const NOT_A_JSON_OBJECT = 'Request body must be a JSON object.'
const MODEL_REQUIRED = 'model is required.'
// A function, not a constant: MAX_JEV_INPUTS lives in a module that imports gateway.ts, which imports this
// one, so it is not yet initialised when this module loads first.
const documentsRequired = () =>
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
