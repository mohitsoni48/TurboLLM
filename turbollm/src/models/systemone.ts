// System One mapping (ADR-439, ADR-436 (1)): the one place a request's state, instructions and
// criteria become the text the engine scores, and the one place entailment scores become answers.
// Pure: no imports, no I/O, no clock, no randomness. Serialisation here must only be called on
// input whose nesting parseSystemOneBody has already bounded; nothing in this module re-checks it.

export type StateValue = string | Record<string, unknown> | unknown[]
export type Instructions = string | Record<string, unknown> | unknown[]
export type Criterion = string | Record<string, unknown> | unknown[] | null

export interface NoulQuestion {
  type: 'noul'
  instructions: Instructions
  criteria?: { true?: Criterion; false?: Criterion }
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: Instructions
  criteria: Record<string, Criterion>
}

export interface ScoreQuestion {
  type: 'score'
  instructions: Instructions
  criteria: Criterion[]
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface SystemOneInput {
  state: StateValue
  model: string
  questions: Record<string, Question>
}

/** A string state is the premise verbatim; anything else is pretty JSON. */
export function serialiseState(state: StateValue): string {
  return typeof state === 'string' ? state : JSON.stringify(state, null, 2)
}

/** `instructions` -> the text that leads every hypothesis for that question. An object carrying a
 *  `question` field leads with it; the rest of the object follows as JSON. Paths are NOT resolved. */
export function instructionTextOf(instructions: Instructions): string {
  if (typeof instructions === 'string') return instructions
  if (Array.isArray(instructions)) return JSON.stringify(instructions, null, 2)
  const { question, ...rest } = instructions
  if (typeof question !== 'string' || question === '') return JSON.stringify(instructions, null, 2)
  return Object.keys(rest).length === 0 ? question : `${question}\n${JSON.stringify(rest, null, 2)}`
}

/** A criterion or description: `null` and `undefined` mean "no text"; objects and arrays are JSON. */
export function criterionTextOf(criterion: Criterion | undefined): string | undefined {
  if (criterion === null || criterion === undefined) return undefined
  return typeof criterion === 'string' ? criterion : JSON.stringify(criterion, null, 2)
}

/** Entailment probabilities -> a distribution that sums to 1. All-zero raws become uniform, not NaN. */
export function normalise(raw: readonly number[]): number[] {
  const total = raw.reduce((sum, value) => sum + value, 0)
  return total > 0 ? raw.map((value) => value / total) : raw.map(() => 1 / raw.length)
}
