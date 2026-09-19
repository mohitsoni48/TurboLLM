// /v1/classify and /v1/rerank — the gateway endpoints for Jev (NLI cross-encoder) models
// (ADR-434 (d), architecture §2.5). They live in their own module, dispatched from the single
// `/v1/*` handler, so the gateway hub doesn't grow and no new Hono route can be shadowed by
// registration order (ADR-421, divergence row 7). User strings are validated, never trimmed.
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { DEFAULT_HYPOTHESIS_TEMPLATE, validateHypothesisTemplate } from '../models/jev'

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
