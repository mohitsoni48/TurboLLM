// System One request validation (ADR-439, ADR-436 (1)): an untrusted body becomes a SystemOneInput or
// exactly one { field, message } problem (the first failure wins). Pure: it knows field paths and limits
// and nothing about HTTP status codes, and it never throws on bad input.
import { instructionTextOf, type Question, type StateValue, type SystemOneInput } from './systemone'

const MIN_NAME_CHARS = 1
const QUESTION_FIELDS: readonly string[] = ['type', 'instructions', 'criteria']
const QUESTION_TYPES: readonly unknown[] = ['noul', 'choice', 'score']

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
  return problem ? refused(problem) : { ok: true, input: inputFrom(raw) }
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
  return unknownFieldProblem(field, question) ?? typeProblem(field, question) ?? instructionsProblem(field, question)
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

/** Every field has passed its rule above, so the casts only restore what those rules established. */
function inputFrom(body: PlainObject): SystemOneInput {
  return {
    state: body.state as StateValue,
    model: body.model as string,
    questions: questionsFrom(body.questions as PlainObject),
  }
}

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
