// System One (ADR-439): the request and response types, the request limits and the nesting bound,
// as the playground needs them. Every export is a hand-kept twin of the backend module named
// beside it: `web/` is a separate TypeScript project, so it cannot import `src/` (ADR-436 (1)).
// The limits are pinned by number in systemone-types.test.ts, so changing one here is a visible act.

export type StateValue = string | Record<string, unknown> | unknown[] // twin: src/models/systemone.ts
export type Instructions = string | Record<string, unknown> | unknown[]
export type Criterion = string | Record<string, unknown> | unknown[] | null

export type NoulQuestion = { type: 'noul'; instructions: Instructions; criteria?: { true?: Criterion; false?: Criterion } }
export type ChoiceQuestion = { type: 'choice'; instructions: Instructions; criteria: Record<string, Criterion> }
export type ScoreQuestion = { type: 'score'; instructions: Instructions; criteria: Criterion[] }
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export type SystemOneRequest = { state: StateValue; model: string; questions: Record<string, Question> }

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score'
      score: number
      legend: Record<string, string>
      probabilities: Record<string, number>
      confidence: number
    }

export type SystemOneResponse = {
  model: string
  answers: Record<string, Answer>
  usage: { input_tokens: number; output_tokens: number }
  /** Laya only: which of Laya's own checkpoints (e.g. 'english', 'multilingual') actually
   *  answered this request, and why it was picked. Absent for a Jev response. */
  routing?: { model: string; reason: string }
}

export const MIN_QUESTIONS = 1 // twin: src/models/systemone-request.ts MIN_QUESTIONS
export const MAX_QUESTIONS = 64 // twin: src/models/systemone-request.ts MAX_QUESTIONS
export const MAX_QUESTION_ID_CHARS = 128 // twin: src/models/systemone-request.ts MAX_QUESTION_ID_CHARS
export const MIN_INSTRUCTIONS_CHARS = 1 // twin: src/models/systemone-request.ts MIN_INSTRUCTIONS_CHARS
export const MAX_INSTRUCTIONS_CHARS = 4000 // twin: src/models/systemone-request.ts MAX_INSTRUCTIONS_CHARS
export const MIN_CHOICE_OPTIONS = 2 // twin: src/models/systemone-request.ts MIN_CHOICE_OPTIONS
export const MAX_CHOICE_OPTIONS = 255 // twin: src/models/systemone-request.ts MAX_CHOICE_OPTIONS
export const MAX_OPTION_CHARS = 255 // twin: src/models/systemone-request.ts MAX_OPTION_CHARS
export const MIN_SCORE_LEVELS = 2 // twin: src/models/systemone-request.ts MIN_SCORE_LEVELS
export const MAX_SCORE_LEVELS = 10 // twin: src/models/systemone-request.ts MAX_SCORE_LEVELS
export const MAX_SYSTEMONE_HYPOTHESES = 512 // twin: src/models/systemone-request.ts MAX_SYSTEMONE_HYPOTHESES
export const MAX_BODY_CHARS = 1_048_576 // twin: src/models/systemone-request.ts MAX_BODY_CHARS
export const MAX_NESTING_DEPTH = 32 // twin: src/models/systemone-request.ts MAX_NESTING_DEPTH

/** How many levels of arrays and objects `value` nests, counting up to `limit + 1` and no further.
 *  Twin of `jsonDepth` in src/models/systemone-request.ts. It is iterative on purpose: a recursive
 *  walk, like a pretty-print, would overflow the stack on a deeply nested value someone pasted. */
export function jsonDepth(value: unknown, limit: number): number {
  if (!isContainer(value)) return 0
  let deepest = 1
  const pending: Array<{ node: object; depth: number }> = [{ node: value, depth: 1 }]
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    deepest = Math.max(deepest, item.depth)
    if (deepest > limit) return deepest
    for (const child of Object.values(item.node)) {
      if (isContainer(child)) pending.push({ node: child, depth: item.depth + 1 })
    }
  }
  return deepest
}

const isContainer = (v: unknown): v is object => typeof v === 'object' && v !== null
