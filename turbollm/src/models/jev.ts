// Jev models (ADR-434): NLI cross-encoders — a sequence-classification head that labels a
// premise/hypothesis pair contradiction / entailment / neutral. This module is the one place
// the Jev rule lives (ADR-436 (1)); the scanner, Discover, the launcher and the gateway call it.
// Pure: no imports, no I/O.

export type JevLabel = 'contradiction' | 'entailment' | 'neutral'
export const JEV_LABELS: readonly JevLabel[] = ['contradiction', 'entailment', 'neutral']

/** Present on a ModelEntry only when detectJev() matched — absent means "not a Jev model". */
export interface JevInfo {
  /** Canonical lower-case label per class id, in id2label index order (index i ↔ probs[i]). */
  labels: JevLabel[]
  /** config.json `nli_template` when it contains both `{premise}` and `{hypothesis}`, else null. */
  nliTemplate: string | null
  /** `architectures[0]` as declared, e.g. 'Qwen3_5ForSequenceClassification'. */
  architecture: string
  /** True when `architecture` has a row in JEV_LAUNCH_TABLE ("verified"); false → "Not verified". */
  verified: boolean
}

/** A launch flag: [name, value?]. JSON values are pre-serialised (no spaces), exactly as verified. */
export type LaunchFlag = readonly [flag: string, value?: string]

/** Verified launch rows keyed by architecture (rule (g)). Only verified rows go here. */
export const JEV_LAUNCH_TABLE: Readonly<Record<string, readonly LaunchFlag[]>> = {
  Qwen3_5ForSequenceClassification: [
    ['--runner', 'pooling'],
    ['--convert', 'classify'],
    ['--hf-overrides', '{"architectures":["Qwen3_5ForConditionalGeneration"]}'],
    ['--limit-mm-per-prompt', '{"image":0,"video":0}'],
  ],
}

/** Any other architecture: vLLM's native path; vLLM's own error surfaces if it can't load. */
export const JEV_DEFAULT_LAUNCH: readonly LaunchFlag[] = [['--runner', 'pooling']]

/** Rule (g). `cfg` is the parsed config.json (untrusted JSON). A Jev model needs a
 *  sequence-classification head whose id2label is exactly the three NLI labels, in any order. */
export function detectJev(cfg: unknown): JevInfo | undefined {
  if (!isRecord(cfg)) return undefined
  const architecture = sequenceClassifierArchitecture(cfg.architectures)
  const labels = nliLabelsByClassId(cfg.id2label)
  if (architecture === undefined || labels === undefined) return undefined
  return {
    labels,
    nliTemplate: usableNliTemplate(cfg.nli_template),
    architecture,
    verified: hasVerifiedLaunch(architecture),
  }
}

/** The table's flags for this model, minus every flag the user's extraArgs already set
 *  (compared by normalised name — see flagName()), flattened to argv in table order.
 *  The user wins by omission, so no flag ever appears twice on the command line. */
export function jevLaunchArgs(jev: JevInfo, userExtraArgs: readonly string[]): string[] {
  const userFlagNames = new Set(userExtraArgs.map(flagName))
  return launchFlagsFor(jev.architecture)
    .filter(([flag]) => !userFlagNames.has(flagName(flag)))
    .flatMap(([flag, value]) => (value === undefined ? [flag] : [flag, value]))
}

/** '--hf_overrides=…' → 'hf-overrides'; '--Runner' → 'runner'; non '--' tokens → null.
 *  vLLM's FlexibleArgumentParser treats '_' and '-' alike, so the comparison must too. */
export function flagName(token: string): string | null {
  if (!token.startsWith('--')) return null
  const name = token.slice(2).split('=')[0].replaceAll('_', '-').toLowerCase()
  return name === '' ? null : name
}

/** The authors' multiple-choice convention (ADR-434 (d)); `/v1/rerank` callers may override it. */
export const DEFAULT_HYPOTHESIS_TEMPLATE = 'The correct answer is: {}'

/** Single-pass literal substitution of {premise}/{hypothesis}. The replacement is a callback,
 *  so a premise containing the text "{hypothesis}" is never re-expanded and `$&`/`$1` in user
 *  text are never read as replacement patterns. */
export function buildNliInput(template: string, premise: string, hypothesis: string): string {
  const pairText = { premise, hypothesis }
  return template.replace(NLI_TEMPLATE_SLOT, (_slot, field: keyof typeof pairText) => pairText[field])
}

/** null when valid; otherwise the 400 message. Valid = a string, 1–1000 chars, containing `{}`. */
export function validateHypothesisTemplate(t: unknown): string | null {
  if (typeof t !== 'string' || !t.includes(DOCUMENT_SLOT)) {
    return `hypothesis_template must contain ${DOCUMENT_SLOT} where each document goes.`
  }
  if (t.length > MAX_HYPOTHESIS_TEMPLATE_LENGTH) {
    return `hypothesis_template must be at most ${MAX_HYPOTHESIS_TEMPLATE_LENGTH} characters.`
  }
  return null
}

/** Every literal `{}` → document (split/join, no regex, no format-string semantics). */
export function fillHypothesisTemplate(t: string, document: string): string {
  return t.split(DOCUMENT_SLOT).join(document)
}

/** The engine's `/classify` row did not have the shape the model's own labels require. */
export class JevShapeError extends Error {}

/** probs[i] ↔ labels[i]. Throws JevShapeError unless probs is an array of exactly
 *  labels.length finite numbers. label = argmax (ties → lowest index). The engine's own `label`
 *  string is ignored: one mapping, derived from the model's own id2label, is the only source. */
export function mapProbs(
  labels: readonly JevLabel[],
  probs: unknown,
): { label: JevLabel; probs: Record<JevLabel, number> } {
  const classProbs = requireClassProbabilities(probs, labels.length)
  return {
    label: labels[indexOfStrongest(classProbs)],
    probs: Object.fromEntries(labels.map((label, i) => [label, classProbs[i]])) as Record<JevLabel, number>,
  }
}

const SEQUENCE_CLASSIFIER_SUFFIX = 'ForSequenceClassification'
const NLI_CLASS_IDS = ['0', '1', '2']

function sequenceClassifierArchitecture(architectures: unknown): string | undefined {
  if (!Array.isArray(architectures)) return undefined
  const declared: unknown = architectures[0]
  return typeof declared === 'string' && declared.endsWith(SEQUENCE_CLASSIFIER_SUFFIX) ? declared : undefined
}

function nliLabelsByClassId(id2label: unknown): JevLabel[] | undefined {
  if (!isRecord(id2label) || Object.keys(id2label).length !== NLI_CLASS_IDS.length) return undefined
  const labels = NLI_CLASS_IDS.map((id) => canonicalLabel(id2label[id]))
  return namesEveryNliLabel(labels) ? labels : undefined
}

/** Class ids 0..2 that between them name all three NLI labels name each exactly once — so a
 *  duplicated label, or a three-key id2label whose ids are not exactly 0..2, never passes. */
function namesEveryNliLabel(labels: readonly (string | undefined)[]): labels is JevLabel[] {
  return JEV_LABELS.every((label) => labels.includes(label))
}

function canonicalLabel(declared: unknown): string | undefined {
  return typeof declared === 'string' ? declared.trim().toLowerCase() : undefined
}

function usableNliTemplate(declared: unknown): string | null {
  if (typeof declared !== 'string') return null
  return declared.includes('{premise}') && declared.includes('{hypothesis}') ? declared : null
}

function launchFlagsFor(architecture: string): readonly LaunchFlag[] {
  return hasVerifiedLaunch(architecture) ? JEV_LAUNCH_TABLE[architecture] : JEV_DEFAULT_LAUNCH
}

function hasVerifiedLaunch(architecture: string): boolean {
  return Object.hasOwn(JEV_LAUNCH_TABLE, architecture)
}

const NLI_TEMPLATE_SLOT = /\{(premise|hypothesis)\}/g
const DOCUMENT_SLOT = '{}'
const MAX_HYPOTHESIS_TEMPLATE_LENGTH = 1000

function requireClassProbabilities(probs: unknown, classCount: number): number[] {
  if (Array.isArray(probs) && probs.length === classCount && probs.every(isFiniteNumber)) return probs
  throw new JevShapeError(`Expected ${classCount} finite class probabilities from the engine.`)
}

function indexOfStrongest(classProbs: readonly number[]): number {
  return classProbs.reduce((strongest, p, i) => (p > classProbs[strongest] ? i : strongest), 0)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
