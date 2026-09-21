// System One mapping (ADR-439, ADR-436 (1)): the one place a request's state, instructions and
// criteria become the text the engine scores, and the one place entailment scores become answers.
// Pure: it imports only ./jev, and has no I/O, no clock and no randomness. Serialisation here must
// only be called on input whose nesting parseSystemOneBody has already bounded; nothing here re-checks it.

import { DEFAULT_HYPOTHESIS_TEMPLATE, fillHypothesisTemplate } from './jev'

const CORRECT_ANSWER = DEFAULT_HYPOTHESIS_TEMPLATE

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

/** One NLI pair to send, and the answer slot it feeds. */
export interface HypothesisSlot {
  questionId: string
  index: number
  text: string
}

export interface SystemOnePlan {
  premise: string
  hypotheses: HypothesisSlot[]
}

/** One premise for the whole request, then every hypothesis in the request's own order: questions in
 *  key order, and within a question its options in key order or its levels in array order. */
export function planSystemOne(input: SystemOneInput): SystemOnePlan {
  return {
    premise: serialiseState(input.state),
    hypotheses: Object.entries(input.questions).flatMap(([questionId, question]) =>
      hypothesisTextsOf(question).map((text, index) => ({ questionId, index, text })),
    ),
  }
}

function hypothesisTextsOf(question: Question): string[] {
  const instruction = instructionTextOf(question.instructions)
  switch (question.type) {
    case 'noul':
      return [noulHypothesis(instruction, question)]
    case 'choice':
      return choiceHypotheses(instruction, question)
    case 'score':
      return scoreHypotheses(instruction, question)
  }
}

function noulHypothesis(instruction: string, question: NoulQuestion): string {
  return join(instruction, criterionTextOf(question.criteria?.true))
}

function choiceHypotheses(instruction: string, question: ChoiceQuestion): string[] {
  return Object.entries(question.criteria).map(([option, description]) =>
    `${instruction} ${fillHypothesisTemplate(CORRECT_ANSWER, optionLabel(option, description))}`,
  )
}

function scoreHypotheses(instruction: string, question: ScoreQuestion): string[] {
  return question.criteria.map((level) =>
    `${instruction} ${fillHypothesisTemplate(CORRECT_ANSWER, levelTextOf(level))}`,
  )
}

/** Only `undefined` means "no text": an empty string still leaves its separating space. */
function join(instruction: string, addition: string | undefined): string {
  return addition === undefined ? instruction : `${instruction} ${addition}`
}

function optionLabel(option: string, description: Criterion): string {
  const text = criterionTextOf(description)
  return text ? `${option} (${text})` : option
}

/** A score level's text. Validation guarantees a level is a non-null string, object or array, so an
 *  absent text here is a bug: fail loudly instead of sending "undefined" (or a comma) to the engine. */
function levelTextOf(level: Criterion): string {
  const text = criterionTextOf(level)
  if (text === undefined) throw new TypeError('A score level has no text; validation refuses a null level.')
  return text
}
