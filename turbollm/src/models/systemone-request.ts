// System One request validation (ADR-439, ADR-436 (1)): an untrusted body becomes a SystemOneInput or
// exactly one { field, message } problem (the first failure wins). Pure: it knows field paths and limits
// and nothing about HTTP status codes, and it never throws on bad input.
import {
  instructionTextOf,
  type Criterion,
  type Question,
  type StateValue,
  type SystemOneInput,
} from './systemone'

const MIN_NAME_CHARS = 1
const QUESTION_FIELDS: readonly string[] = ['type', 'instructions', 'criteria']
const QUESTION_TYPES: readonly unknown[] = ['noul', 'choice', 'score']
const NOUL_CRITERIA_KEYS: readonly string[] = ['true', 'false']

export const MIN_QUESTIONS = 1
export const MAX_QUESTIONS = 64
export const MAX_QUESTION_ID_CHARS = 128
export const MIN_INSTRUCTIONS_CHARS = 1
export const MAX_INSTRUCTIONS_CHARS = 4000
export const MIN_CHOICE_OPTIONS = 2
export const MAX_CHOICE_OPTIONS = 255
export const MAX_OPTION_CHARS = 255
export const MIN_SCORE_LEVELS = 2
export const MAX_SCORE_LEVELS = 10
export const MAX_SYSTEMONE_HYPOTHESES = 512
export const MAX_BODY_CHARS = 1_048_576
export const MAX_NESTING_DEPTH = 32

export type RequestProblem = { field: string; message: string }

export type ParseResult = { ok: true; input: SystemOneInput } | { ok: false; problem: RequestProblem }

type PlainObject = Record<string, unknown>

type PathedValue = readonly [path: string, value: unknown]

/** Defence in depth: nestingProblem is iterative and runs first, so no nesting can overflow the stack here.
 *  Any other RangeError raised while reading the body (for example a string-length limit inside
 *  JSON.stringify) is refused as a body problem too. The message is pinned, so it is not made generic. */
export function parseSystemOneBody(raw: unknown): ParseResult {
  try {
    return parseBody(raw)
  } catch (error) {
    if (error instanceof RangeError) {
      return refused({ field: 'body', message: 'body is nested too deeply to be processed.' })
    }
    throw error
  }
}

function parseBody(raw: unknown): ParseResult {
  if (!isPlainObject(raw)) return refused({ field: 'body', message: 'body must be a JSON object.' })
  const problem = firstProblemIn(raw)
  if (problem) return refused(problem)
  const input = inputFrom(raw)
  const oversize = checkHypothesisTotal(input.questions)
  return oversize ? refused(oversize) : { ok: true, input }
}

function refused(problem: RequestProblem): ParseResult {
  return { ok: false, problem }
}

function firstProblemIn(body: PlainObject): RequestProblem | undefined {
  return (
    nestingProblem(body) ??
    sizeProblem(body) ??
    modelProblem(body) ??
    stateProblem(body) ??
    questionsProblem(body)
  )
}

/** Every value that is later pretty-printed lies inside a value checked here, so no pretty-print can
 *  overflow the stack or balloon: nesting is refused before anything is serialised. */
function nestingProblem(body: PlainObject): RequestProblem | undefined {
  for (const [path, value] of boundedValuesOf(body)) {
    if (jsonDepth(value, MAX_NESTING_DEPTH) > MAX_NESTING_DEPTH) {
      return { field: path, message: `${path} must not be nested more than ${MAX_NESTING_DEPTH} levels deep.` }
    }
  }
  return undefined
}

/** The values whose depth is bounded, in walk order: each body key, except that a `questions` object is
 *  replaced by each question's own keys (or by the question itself when it is not an object). */
function boundedValuesOf(body: PlainObject): PathedValue[] {
  return Object.entries(body).flatMap(([key, value]): PathedValue[] =>
    key === 'questions' && isPlainObject(value) ? boundedQuestionValuesOf(value) : [[key, value]],
  )
}

function boundedQuestionValuesOf(questions: PlainObject): PathedValue[] {
  return Object.entries(questions).flatMap(([id, question]): PathedValue[] =>
    isPlainObject(question)
      ? Object.entries(question).map(([key, value]): PathedValue => [`questions.${id}.${key}`, value])
      : [[`questions.${id}`, question]],
  )
}

function sizeProblem(body: PlainObject): RequestProblem | undefined {
  if (JSON.stringify(body).length <= MAX_BODY_CHARS) return undefined
  return { field: 'body', message: `body must be at most ${MAX_BODY_CHARS} characters.` }
}

function modelProblem(body: PlainObject): RequestProblem | undefined {
  if (typeof body.model === 'string' && body.model !== '') return undefined
  return { field: 'model', message: 'model must be a non-empty string.' }
}

/** An object or array always serialises to at least two characters, so only a string can be empty. */
function stateProblem(body: PlainObject): RequestProblem | undefined {
  if (typeof body.state !== 'string' && !isContainer(body.state)) {
    return { field: 'state', message: 'state is required and must be a string, an object or an array.' }
  }
  if (body.state === '') return { field: 'state', message: 'state must not be empty.' }
  return undefined
}

function questionsProblem(body: PlainObject): RequestProblem | undefined {
  const { questions } = body
  if (!isPlainObject(questions) || !isWithinQuestionCount(Object.keys(questions).length)) {
    return {
      field: 'questions',
      message: `questions must be an object with ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions.`,
    }
  }
  return firstQuestionProblem(questions)
}

function isWithinQuestionCount(count: number): boolean {
  return count >= MIN_QUESTIONS && count <= MAX_QUESTIONS
}

function firstQuestionProblem(questions: PlainObject): RequestProblem | undefined {
  for (const [id, question] of Object.entries(questions)) {
    const problem = questionProblem(id, question)
    if (problem) return problem
  }
  return undefined
}

function questionProblem(id: string, question: unknown): RequestProblem | undefined {
  const field = `questions.${id}`
  if (id.length < MIN_NAME_CHARS || id.length > MAX_QUESTION_ID_CHARS) {
    return { field, message: `${field} must have an id of ${MIN_NAME_CHARS} to ${MAX_QUESTION_ID_CHARS} characters.` }
  }
  if (!isPlainObject(question)) return { field, message: `${field} must be an object.` }
  return (
    unknownFieldProblem(field, question) ??
    typeProblem(field, question) ??
    instructionsProblem(field, question) ??
    criteriaProblem(field, question)
  )
}

function unknownFieldProblem(field: string, question: PlainObject): RequestProblem | undefined {
  const unknownField = Object.keys(question).find((key) => !QUESTION_FIELDS.includes(key))
  if (unknownField === undefined) return undefined
  return { field: `${field}.${unknownField}`, message: `${field}.${unknownField} is not a known field.` }
}

function typeProblem(field: string, question: PlainObject): RequestProblem | undefined {
  if (QUESTION_TYPES.includes(question.type)) return undefined
  return { field: `${field}.type`, message: `${field}.type must be "noul", "choice" or "score".` }
}

function instructionsProblem(field: string, question: PlainObject): RequestProblem | undefined {
  const { instructions } = question
  const instructionsField = `${field}.instructions`
  if (!isTextOrContainer(instructions)) {
    return {
      field: instructionsField,
      message: `${instructionsField} is required and must be a string, an object or an array.`,
    }
  }
  const length = instructionTextOf(instructions).length
  if (length >= MIN_INSTRUCTIONS_CHARS && length <= MAX_INSTRUCTIONS_CHARS) return undefined
  return {
    field: instructionsField,
    message: `${instructionsField} must be ${MIN_INSTRUCTIONS_CHARS} to ${MAX_INSTRUCTIONS_CHARS} characters.`,
  }
}

/** `typeProblem` has already refused every type but these three, so the default is never reached. */
function criteriaProblem(field: string, question: PlainObject): RequestProblem | undefined {
  switch (question.type) {
    case 'noul':
      return checkNoulCriteria(`${field}.criteria`, question.criteria)
    case 'choice':
      return checkChoiceCriteria(`${field}.criteria`, question.criteria)
    case 'score':
      return checkScoreCriteria(`${field}.criteria`, question.criteria)
    default:
      return undefined
  }
}

function checkNoulCriteria(field: string, criteria: unknown): RequestProblem | undefined {
  if (criteria === undefined) return undefined
  if (!isPlainObject(criteria) || Object.keys(criteria).some((key) => !NOUL_CRITERIA_KEYS.includes(key))) {
    return { field, message: `${field} must be an object with only "true" and/or "false".` }
  }
  return checkNoulCriterion(field, 'true', criteria.true) ?? checkNoulCriterion(field, 'false', criteria.false)
}

function checkNoulCriterion(field: string, key: string, criterion: unknown): RequestProblem | undefined {
  if (criterion === undefined || isCriterion(criterion)) return undefined
  return { field: `${field}.${key}`, message: `${field}.${key} must be a string, an object, an array or null.` }
}

function checkChoiceCriteria(field: string, criteria: unknown): RequestProblem | undefined {
  if (!isPlainObject(criteria) || !isWithinOptionCount(Object.keys(criteria).length)) {
    return {
      field,
      message: `${field} must be an object of ${MIN_CHOICE_OPTIONS} to ${MAX_CHOICE_OPTIONS} options.`,
    }
  }
  for (const [option, description] of Object.entries(criteria)) {
    const problem = checkOption(field, option, description)
    if (problem) return problem
  }
  return undefined
}

function isWithinOptionCount(count: number): boolean {
  return count >= MIN_CHOICE_OPTIONS && count <= MAX_CHOICE_OPTIONS
}

function checkOption(field: string, option: string, description: unknown): RequestProblem | undefined {
  const optionField = `${field}.${option}`
  if (option.length < MIN_NAME_CHARS || option.length > MAX_OPTION_CHARS) {
    return {
      field: optionField,
      message: `${optionField} must be named with ${MIN_NAME_CHARS} to ${MAX_OPTION_CHARS} characters.`,
    }
  }
  if (isCriterion(description)) return undefined
  return { field: optionField, message: `${optionField} must be a string, an object, an array or null.` }
}

function checkScoreCriteria(field: string, criteria: unknown): RequestProblem | undefined {
  if (!Array.isArray(criteria) || !isWithinLevelCount(criteria.length)) {
    return {
      field,
      message: `${field} must be an ordered array of ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} level descriptions.`,
    }
  }
  for (const [index, level] of criteria.entries()) {
    if (!isLevelDescription(level)) {
      return {
        field: `${field}.${index}`,
        message: `${field}.${index} must be a non-empty string, an object or an array.`,
      }
    }
  }
  return undefined
}

function isWithinLevelCount(count: number): boolean {
  return count >= MIN_SCORE_LEVELS && count <= MAX_SCORE_LEVELS
}

/** The whole request is one engine batch, so its size is a property of all the questions together. */
function checkHypothesisTotal(questions: Record<string, Question>): RequestProblem | undefined {
  const total = Object.values(questions).reduce((sum, question) => sum + hypothesisCountOf(question), 0)
  if (total <= MAX_SYSTEMONE_HYPOTHESES) return undefined
  return {
    field: 'questions',
    message: `questions must produce at most ${MAX_SYSTEMONE_HYPOTHESES} hypotheses in total.`,
  }
}

function hypothesisCountOf(question: Question): number {
  switch (question.type) {
    case 'noul':
      return 1
    case 'choice':
      return Object.keys(question.criteria).length
    case 'score':
      return question.criteria.length
  }
}

/** Every field has passed its rule above, so the casts only restore what those rules established. */
function inputFrom(body: PlainObject): SystemOneInput {
  return {
    state: body.state as StateValue,
    model: body.model as string,
    questions: questionsFrom(body.questions as PlainObject),
  }
}

/** Rebuilt with Object.fromEntries, which defines every id as an own property: an assignment loop would treat
 *  an id of __proto__ as a setter. Each entry has already passed questionProblem, so the per-entry cast only
 *  restores that. */
function questionsFrom(questions: PlainObject): Record<string, Question> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]): [string, Question] => [id, question as Question]),
  )
}

/** Depth of a JSON value: a scalar is 0, an array or object is 1 + its deepest child. Iterative (an explicit
 *  stack), so no depth can overflow the call stack; it stops counting once the depth passes `limit`, so it costs
 *  O(body) and returns at most `limit + 1`. */
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

function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function isPlainObject(value: unknown): value is PlainObject {
  return isContainer(value) && !Array.isArray(value)
}

function isTextOrContainer(value: unknown): value is string | PlainObject | unknown[] {
  return typeof value === 'string' || isContainer(value)
}

function isCriterion(value: unknown): value is Criterion {
  return value === null || isTextOrContainer(value)
}

function isLevelDescription(value: unknown): boolean {
  return typeof value === 'string' ? value !== '' : isContainer(value)
}
