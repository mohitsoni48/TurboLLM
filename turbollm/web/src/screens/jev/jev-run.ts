// Turning a playground draft into a request, and timing the answer (ADR-434 (c), (d)).
//
// Each run keeps the request it sent, not just the reply: the JSON and API views show the user
// what actually went over the wire, so it has to be the same object the endpoint received.
import { classify, rerank } from '../../lib/jev-api'
import type { ClassifyRequest, ClassifyResponse, RerankRequest, RerankResponse } from '../../lib/types'

export type CheckDraft = { premise: string; hypotheses: string[] }

export type ChooseDraft = { question: string; options: string[] }

/** One completed run — the request, the reply, and how long the round trip took. */
export type JevRun =
  | { endpoint: 'classify'; request: ClassifyRequest; response: ClassifyResponse; ms: number }
  | { endpoint: 'rerank'; request: RerankRequest; response: RerankResponse; ms: number }

/** What is missing before this draft can run, or null when nothing is. */
export function checkDraftError(draft: CheckDraft): string | null {
  if (!draft.premise.trim()) return 'Enter a premise first'
  if (written(draft.hypotheses).length < 1) return 'Add at least one hypothesis'
  return null
}

export function chooseDraftError(draft: ChooseDraft): string | null {
  if (!draft.question.trim()) return 'Enter a question first'
  if (written(draft.options).length < 2) return 'Add at least two options'
  return null
}

export async function runCheck(model: string, draft: CheckDraft): Promise<JevRun> {
  const request: ClassifyRequest = {
    model,
    premise: draft.premise.trim(),
    hypotheses: written(draft.hypotheses),
  }
  const started = performance.now()
  const response = await classify(request)
  return { endpoint: 'classify', request, response, ms: elapsedSince(started) }
}

/** No `hypothesis_template`: that field is API-only, and the playground keeps the gateway's
 *  default ("The correct answer is: {}"), which is the convention the model was trained on. */
export async function runChoose(model: string, draft: ChooseDraft): Promise<JevRun> {
  const request: RerankRequest = {
    model,
    query: draft.question.trim(),
    documents: written(draft.options),
  }
  const started = performance.now()
  const response = await rerank(request)
  return { endpoint: 'rerank', request, response, ms: elapsedSince(started) }
}

/** The rows the user actually filled in — a blank row is an empty editor, not an input. */
function written(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== '')
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started)
}
