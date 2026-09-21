// System One playground (ADR-439): the two editors' texts become the exact request that is POSTed
// and rendered as curl, so the command on screen is the request that ran. Pure: no React, no I/O.
import type { StateValue, SystemOneRequest } from '../../lib/systemone-types'

export interface SystemOneDraft {
  stateText: string
  questionsText: string
}

export type DraftProblem = { field: 'state' | 'questions' | string; message: string }

export function draftRequest(
  model: string,
  draft: SystemOneDraft,
): { ok: true; request: SystemOneRequest } | { ok: false; problems: DraftProblem[] } {
  const questions = parseQuestions(draft.questionsText)
  if ('problem' in questions) return { ok: false, problems: [questions.problem] }
  return { ok: true, request: { state: stateFromText(draft.stateText), model, questions: questions.value } }
}

/** JSON objects, arrays and strings are the state; anything else is the raw text as a string, so
 *  typing `I was charged twice.` just works. Any parse failure, even one other than a SyntaxError
 *  on hostile input, means the user typed plain text. */
export function stateFromText(text: string): StateValue {
  try {
    const parsed: unknown = JSON.parse(text)
    return isStateValue(parsed) ? parsed : text
  } catch {
    return text
  }
}

function parseQuestions(text: string): { value: SystemOneRequest['questions'] } | { problem: DraftProblem } {
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    return { problem: { field: 'questions', message: `questions is not valid JSON: ${messageOf(error)}` } }
  }
}

const isStateValue = (value: unknown): value is StateValue =>
  typeof value === 'string' || (typeof value === 'object' && value !== null)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
