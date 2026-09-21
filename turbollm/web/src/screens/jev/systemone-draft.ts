// System One playground (ADR-439): the two editors' texts become the exact request that is POSTed
// and rendered as curl, so the command on screen is the request that ran. Pure: no React, no I/O.
//
// The request is checked with the server's rules and wording, so a user sees the field path before
// the round trip rather than a 422 after it. Jev/System One request rules are duplicated between
// `src/models/systemone-request.ts` and this file; a drift test or a shared package would remove it.
import {
  MAX_BODY_CHARS,
  MAX_CHOICE_OPTIONS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_NESTING_DEPTH,
  MAX_OPTION_CHARS,
  MAX_QUESTIONS,
  MAX_QUESTION_ID_CHARS,
  MAX_SCORE_LEVELS,
  MAX_SYSTEMONE_HYPOTHESES,
  MIN_CHOICE_OPTIONS,
  MIN_INSTRUCTIONS_CHARS,
  MIN_QUESTIONS,
  MIN_SCORE_LEVELS,
  jsonDepth,
} from '../../lib/systemone-types'
import type { Instructions, Question, StateValue, SystemOneRequest } from '../../lib/systemone-types'

export interface SystemOneDraft {
  stateText: string
  questionsText: string
}

export type DraftProblem = { field: 'state' | 'questions' | string; message: string }

type DraftResult = { ok: true; request: SystemOneRequest } | { ok: false; problems: DraftProblem[] }
type CriteriaRule = (criteria: unknown, questionPath: string) => DraftProblem | undefined

const MIN_NAME_CHARS = 1
const QUESTION_KEYS = ['type', 'instructions', 'criteria']
const NOUL_CRITERIA_KEYS = ['true', 'false']

/** Never throws: a value nested too deeply for the JavaScript call stack is one more problem to show. */
export function draftRequest(model: string, draft: SystemOneDraft): DraftResult {
  try {
    return checkedRequest(model, draft)
  } catch (error) {
    if (error instanceof RangeError) {
      return { ok: false, problems: [problem('body', 'body is nested too deeply to be processed.')] }
    }
    throw error
  }
}

/** JSON objects, arrays and strings are the state; anything else is the raw text as a string, so
 *  typing `I was charged twice.` just works. Any parse failure, even one other than a SyntaxError
 *  on hostile input, means the user typed plain text. */
export function stateFromText(text: string): StateValue {
  try {
    const parsed: unknown = JSON.parse(text)
    return isTextOrContainer(parsed) ? parsed : text
  } catch {
    return text
  }
}

/** At most one problem per group, in the order state, questions, request (model, body). The body
 *  size is measured only once nothing else is wrong: it is the rule that stringifies everything. */
function checkedRequest(model: string, draft: SystemOneDraft): DraftResult {
  const state = stateFromText(draft.stateText)
  const questions = parseQuestions(draft.questionsText)
  const stateProblem = checkState(state)
  const questionsProblem = questions.problem ?? checkQuestions(questions.value)
  const request = { state, model, questions: questions.value }
  const bodyProblem = stateProblem || questionsProblem ? undefined : checkBody(request)

  const problems = presentProblems(stateProblem, questionsProblem, bodyProblem ?? checkModel(model))
  // Every rule passed, so the parsed questions really are System One questions.
  return problems.length === 0 ? { ok: true, request: request as SystemOneRequest } : { ok: false, problems }
}

function parseQuestions(text: string): { value: unknown; problem?: DraftProblem } {
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    return { value: undefined, problem: problem('questions', `questions is not valid JSON: ${messageOf(error)}`) }
  }
}

function checkState(state: StateValue): DraftProblem | undefined {
  if (isTooDeep(state)) return tooDeepProblem('state')
  return state === '' ? problem('state', 'state must not be empty.') : undefined
}

function checkModel(model: string): DraftProblem | undefined {
  return model === '' ? problem('model', 'model must be a non-empty string.') : undefined
}

function checkBody(request: object): DraftProblem | undefined {
  if (JSON.stringify(request).length <= MAX_BODY_CHARS) return undefined
  return problem('body', `body must be at most ${MAX_BODY_CHARS} characters.`)
}

/** Nesting is checked over every question before any other rule, because the rules below
 *  pretty-print instructions and must only ever see a value whose depth is bounded. */
function checkQuestions(questions: unknown): DraftProblem | undefined {
  const tooDeepField = firstTooDeepQuestionsField(questions)
  if (tooDeepField !== undefined) return tooDeepProblem(tooDeepField)
  return checkQuestionsRules(questions)
}

function firstTooDeepQuestionsField(questions: unknown): string | undefined {
  if (!isObject(questions)) return isTooDeep(questions) ? 'questions' : undefined
  return firstFound(Object.entries(questions), ([id, question]) => firstTooDeepQuestionField(`questions.${id}`, question))
}

function firstTooDeepQuestionField(path: string, question: unknown): string | undefined {
  if (!isObject(question)) return isTooDeep(question) ? path : undefined
  return firstFound(Object.entries(question), ([key, value]) => (isTooDeep(value) ? `${path}.${key}` : undefined))
}

function checkQuestionsRules(questions: unknown): DraftProblem | undefined {
  if (!isObject(questions) || !inRange(Object.keys(questions).length, MIN_QUESTIONS, MAX_QUESTIONS)) {
    return problem('questions', `questions must be an object with ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions.`)
  }
  // Every question passed its rules, so each one really is a System One question.
  return firstFound(Object.entries(questions), checkQuestion) ?? checkHypothesisTotal(questions as Record<string, Question>)
}

function checkQuestion([id, question]: [string, unknown]): DraftProblem | undefined {
  const path = `questions.${id}`
  if (!inRange(id.length, MIN_NAME_CHARS, MAX_QUESTION_ID_CHARS)) {
    return problem(path, `${path} must have an id of ${MIN_NAME_CHARS} to ${MAX_QUESTION_ID_CHARS} characters.`)
  }
  if (!isObject(question)) return problem(path, `${path} must be an object.`)

  const unknownKey = Object.keys(question).find((key) => !QUESTION_KEYS.includes(key))
  if (unknownKey !== undefined) return problem(`${path}.${unknownKey}`, `${path}.${unknownKey} is not a known field.`)

  const type = question.type
  if (!isQuestionType(type)) return problem(`${path}.type`, `${path}.type must be "noul", "choice" or "score".`)
  return checkInstructions(question.instructions, path) ?? CRITERIA_RULES[type](question.criteria, path)
}

function checkInstructions(instructions: unknown, path: string): DraftProblem | undefined {
  const field = `${path}.instructions`
  if (!isTextOrContainer(instructions)) {
    return problem(field, `${field} is required and must be a string, an object or an array.`)
  }
  if (inRange(instructionTextOf(instructions).length, MIN_INSTRUCTIONS_CHARS, MAX_INSTRUCTIONS_CHARS)) return undefined
  return problem(field, `${field} must be ${MIN_INSTRUCTIONS_CHARS} to ${MAX_INSTRUCTIONS_CHARS} characters.`)
}

function checkNoulCriteria(criteria: unknown, path: string): DraftProblem | undefined {
  if (criteria === undefined) return undefined
  const field = `${path}.criteria`
  if (!isObject(criteria) || !Object.keys(criteria).every((key) => NOUL_CRITERIA_KEYS.includes(key))) {
    return problem(field, `${field} must be an object with only "true" and/or "false".`)
  }
  return firstFound(NOUL_CRITERIA_KEYS, (key) =>
    criteria[key] === undefined ? undefined : checkCriterion(criteria[key], `${field}.${key}`),
  )
}

function checkChoiceCriteria(criteria: unknown, path: string): DraftProblem | undefined {
  const field = `${path}.criteria`
  if (!isObject(criteria) || !inRange(Object.keys(criteria).length, MIN_CHOICE_OPTIONS, MAX_CHOICE_OPTIONS)) {
    return problem(field, `${field} must be an object of ${MIN_CHOICE_OPTIONS} to ${MAX_CHOICE_OPTIONS} options.`)
  }
  return firstFound(Object.entries(criteria), ([option, description]) => checkOption(option, description, field))
}

function checkOption(option: string, description: unknown, criteriaField: string): DraftProblem | undefined {
  const field = `${criteriaField}.${option}`
  if (!inRange(option.length, MIN_NAME_CHARS, MAX_OPTION_CHARS)) {
    return problem(field, `${field} must be named with ${MIN_NAME_CHARS} to ${MAX_OPTION_CHARS} characters.`)
  }
  return checkCriterion(description, field)
}

function checkScoreCriteria(criteria: unknown, path: string): DraftProblem | undefined {
  const field = `${path}.criteria`
  if (!Array.isArray(criteria) || !inRange(criteria.length, MIN_SCORE_LEVELS, MAX_SCORE_LEVELS)) {
    return problem(
      field,
      `${field} must be an ordered array of ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} level descriptions.`,
    )
  }
  return firstFound(criteria.entries(), ([index, level]) => checkLevel(level, `${field}.${index}`))
}

function checkLevel(level: unknown, field: string): DraftProblem | undefined {
  const isUsable = typeof level === 'string' ? level !== '' : isTextOrContainer(level)
  return isUsable ? undefined : problem(field, `${field} must be a non-empty string, an object or an array.`)
}

function checkCriterion(criterion: unknown, field: string): DraftProblem | undefined {
  const isUsable = criterion === null || isTextOrContainer(criterion)
  return isUsable ? undefined : problem(field, `${field} must be a string, an object, an array or null.`)
}

function checkHypothesisTotal(questions: Record<string, Question>): DraftProblem | undefined {
  const total = Object.values(questions).reduce((sum, question) => sum + hypothesisCount(question), 0)
  if (total <= MAX_SYSTEMONE_HYPOTHESES) return undefined
  return problem('questions', `questions must produce at most ${MAX_SYSTEMONE_HYPOTHESES} hypotheses in total.`)
}

function hypothesisCount(question: Question): number {
  switch (question.type) {
    case 'noul':
      return 1
    case 'choice':
      return Object.keys(question.criteria).length
    case 'score':
      return question.criteria.length
  }
}

/** Twin of `instructionTextOf` in src/models/systemone.ts: the text that leads every hypothesis of
 *  a question, whose length the server bounds. It pretty-prints, so it is only called on input
 *  whose nesting `checkQuestions` has already bounded. */
function instructionTextOf(instructions: Instructions): string {
  if (typeof instructions === 'string') return instructions
  if (Array.isArray(instructions)) return JSON.stringify(instructions, null, 2)
  const { question, ...rest } = instructions
  if (typeof question !== 'string' || question === '') return JSON.stringify(instructions, null, 2)
  return Object.keys(rest).length === 0 ? question : `${question}\n${JSON.stringify(rest, null, 2)}`
}

const CRITERIA_RULES: Record<Question['type'], CriteriaRule> = {
  noul: checkNoulCriteria,
  choice: checkChoiceCriteria,
  score: checkScoreCriteria,
}

const isQuestionType = (value: unknown): value is Question['type'] =>
  typeof value === 'string' && Object.hasOwn(CRITERIA_RULES, value)

const problem = (field: string, message: string): DraftProblem => ({ field, message })

const tooDeepProblem = (field: string): DraftProblem =>
  problem(field, `${field} must not be nested more than ${MAX_NESTING_DEPTH} levels deep.`)

const presentProblems = (...found: Array<DraftProblem | undefined>): DraftProblem[] =>
  found.filter((each): each is DraftProblem => each !== undefined)

function firstFound<Item, Found>(items: Iterable<Item>, look: (item: Item) => Found | undefined): Found | undefined {
  for (const item of items) {
    const found = look(item)
    if (found !== undefined) return found
  }
  return undefined
}

const isTooDeep = (value: unknown): boolean => jsonDepth(value, MAX_NESTING_DEPTH) > MAX_NESTING_DEPTH

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTextOrContainer = (value: unknown): value is StateValue =>
  typeof value === 'string' || (typeof value === 'object' && value !== null)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
