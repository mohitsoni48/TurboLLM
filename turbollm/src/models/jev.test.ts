// Jev (NLI cross-encoder) detection — ADR-434 (g). A config.json describes a Jev model only
// when its head is a sequence classifier with exactly the three NLI labels; everything else
// (chat models, 2/4-label classifiers, sentiment heads, malformed JSON) must stay untouched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildNliInput,
  DEFAULT_HYPOTHESIS_TEMPLATE,
  detectJev,
  fillHypothesisTemplate,
  flagName,
  JEV_LAUNCH_TABLE,
  jevLaunchArgs,
  JevShapeError,
  mapProbs,
  validateHypothesisTemplate,
  type JevInfo,
  type JevLabel,
} from './jev'

/** Fixture F1 — the OpenJev config.json fields that matter (plan Appendix). */
function openJevConfig(): Record<string, unknown> {
  return {
    architectures: ['Qwen3_5ForSequenceClassification'],
    model_type: 'qwen3_5',
    id2label: { '0': 'contradiction', '1': 'entailment', '2': 'neutral' },
    label2id: { contradiction: 0, entailment: 1, neutral: 2 },
    nli_template: 'Premise: {premise}\nHypothesis: {hypothesis}',
    vision_config: {},
    max_position_embeddings: 262144,
  }
}

function withField(field: string, value: unknown): Record<string, unknown> {
  return { ...openJevConfig(), [field]: value }
}

function without(field: string): Record<string, unknown> {
  const cfg = openJevConfig()
  delete cfg[field]
  return cfg
}

test('OpenJev config (F1) is a verified Jev model with its labels in id2label order', () => {
  assert.deepEqual(detectJev(openJevConfig()), {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
  })
})

test('permuted id2label (F4) keeps the model\'s own class order', () => {
  const cfg = withField('id2label', { '0': 'entailment', '1': 'neutral', '2': 'contradiction' })
  assert.deepEqual(detectJev(cfg)?.labels, ['entailment', 'neutral', 'contradiction'])
})

test('label case and surrounding whitespace are ignored, labels come back canonical', () => {
  const cfg = withField('id2label', { '0': ' Contradiction', '1': ' Entailment ', '2': 'NEUTRAL\n' })
  assert.deepEqual(detectJev(cfg)?.labels, ['contradiction', 'entailment', 'neutral'])
})

test('an NLI head on an architecture outside the launch table is detected but not verified', () => {
  const jev = detectJev(withField('architectures', ['BertForSequenceClassification']))
  assert.equal(jev?.architecture, 'BertForSequenceClassification')
  assert.equal(jev?.verified, false)
})

const notJevModels: Array<[string, unknown]> = [
  ['a 2-label head', withField('id2label', { '0': 'contradiction', '1': 'entailment' })],
  ['a 4-label head', withField('id2label', { '0': 'contradiction', '1': 'entailment', '2': 'neutral', '3': 'other' })],
  ['class ids 1..3 instead of 0..2', withField('id2label', { '1': 'contradiction', '2': 'entailment', '3': 'neutral' })],
  ['a misspelled label', withField('id2label', { '0': 'contradict', '1': 'entailment', '2': 'neutral' })],
  ['a duplicated label', withField('id2label', { '0': 'entailment', '1': 'entailment', '2': 'neutral' })],
  ['a causal-LM architecture', withField('architectures', ['Qwen3ForCausalLM'])],
  ['no architectures', without('architectures')],
  ['architectures that is a string', withField('architectures', 'Qwen3_5ForSequenceClassification')],
  ['architectures that is an array-like object', withField('architectures', { '0': 'Qwen3_5ForSequenceClassification' })],
  ['architectures[0] that is not a string', withField('architectures', [42])],
  ['no id2label', without('id2label')],
  ['a null config', null],
  ['an array config', []],
  ['a string config', 'x'],
]

for (const [description, cfg] of notJevModels) {
  test(`not a Jev model: ${description}`, () => {
    assert.equal(detectJev(cfg), undefined)
  })
}

const unusableTemplates: Array<[string, Record<string, unknown>]> = [
  ['missing', without('nli_template')],
  ['not a string', withField('nli_template', 42)],
  ['lacking {hypothesis}', withField('nli_template', 'Premise: {premise}')],
  ['lacking {premise}', withField('nli_template', 'Hypothesis: {hypothesis}')],
]

for (const [description, cfg] of unusableTemplates) {
  test(`nli_template ${description} → still a Jev model, with nliTemplate null`, () => {
    const jev = detectJev(cfg)
    assert.equal(jev?.architecture, 'Qwen3_5ForSequenceClassification')
    assert.equal(jev?.nliTemplate, null)
  })
}

test('the launch table holds exactly the flags the spike verified for OpenJev', () => {
  assert.deepEqual(JEV_LAUNCH_TABLE, {
    Qwen3_5ForSequenceClassification: [
      ['--runner', 'pooling'],
      ['--convert', 'classify'],
      ['--hf-overrides', '{"architectures":["Qwen3_5ForConditionalGeneration"]}'],
      ['--limit-mm-per-prompt', '{"image":0,"video":0}'],
    ],
  })
})

// Launch-arg merge — ADR-434 (g) "the user's extra args still apply on top", ADR-415.
// vLLM's argument parser treats '_' and '-' alike and accepts '--flag=value', so a user flag
// written either way must suppress the table's copy of it.

const flagNames: Array<[string, string | null]> = [
  ['--hf_overrides={"a":1}', 'hf-overrides'],
  ['--Runner', 'runner'],
  ['--limit-mm-per-prompt', 'limit-mm-per-prompt'],
  ['pooling', null],
  ['-x', null],
  ['--', null],
]

for (const [token, expected] of flagNames) {
  test(`flagName(${JSON.stringify(token)}) → ${JSON.stringify(expected)}`, () => {
    assert.equal(flagName(token), expected)
  })
}

const openJevInfo: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}
const unverifiedJevInfo: JevInfo = { ...openJevInfo, architecture: 'BertForSequenceClassification', verified: false }

const OPENJEV_LAUNCH_TOKENS = [
  '--runner', 'pooling',
  '--convert', 'classify',
  '--hf-overrides', '{"architectures":["Qwen3_5ForConditionalGeneration"]}',
  '--limit-mm-per-prompt', '{"image":0,"video":0}',
]

test('a verified model with no user args gets the 8 table tokens, JSON values byte-identical', () => {
  assert.deepEqual(jevLaunchArgs(openJevInfo, []), OPENJEV_LAUNCH_TOKENS)
})

test('a user --runner suppresses the table --runner and keeps the rest in table order', () => {
  assert.deepEqual(jevLaunchArgs(openJevInfo, ['--runner', 'pooling']), OPENJEV_LAUNCH_TOKENS.slice(2))
})

test('a user --hf_overrides=… (underscore, inline value) suppresses the table --hf-overrides', () => {
  assert.deepEqual(jevLaunchArgs(openJevInfo, ['--hf_overrides={"a":1}']), [
    '--runner', 'pooling',
    '--convert', 'classify',
    '--limit-mm-per-prompt', '{"image":0,"video":0}',
  ])
})

test('a user --RUNNER=pooling (upper case, inline value) suppresses the table --runner', () => {
  assert.deepEqual(jevLaunchArgs(openJevInfo, ['--RUNNER=pooling']), OPENJEV_LAUNCH_TOKENS.slice(2))
})

test('a user who already carries all four spike flags gets none from the table', () => {
  assert.deepEqual(jevLaunchArgs(openJevInfo, OPENJEV_LAUNCH_TOKENS), [])
})

test('an unverified architecture gets only vLLM\'s native --runner pooling', () => {
  assert.deepEqual(jevLaunchArgs(unverifiedJevInfo, []), ['--runner', 'pooling'])
})

test('an unverified architecture whose user sets --runner gets nothing from the table', () => {
  assert.deepEqual(jevLaunchArgs(unverifiedJevInfo, ['--runner', 'generate']), [])
})

// NLI input and hypothesis templates — ADR-434 (d). Substitution is literal and single-pass:
// user text is never re-expanded and never interpreted as a replacement pattern (QA E28).

const OPENJEV_NLI_TEMPLATE = 'Premise: {premise}\nHypothesis: {hypothesis}'

test('the OpenJev template joins the kitchen premise and hypothesis exactly', () => {
  assert.equal(
    buildNliInput(OPENJEV_NLI_TEMPLATE, 'A chef is chopping onions in a busy restaurant kitchen.', 'Someone is preparing food.'),
    'Premise: A chef is chopping onions in a busy restaurant kitchen.\nHypothesis: Someone is preparing food.',
  )
})

test('a premise that contains the text {hypothesis} is not re-expanded', () => {
  assert.equal(
    buildNliInput(OPENJEV_NLI_TEMPLATE, 'The note says {hypothesis}.', 'It rains.'),
    'Premise: The note says {hypothesis}.\nHypothesis: It rains.',
  )
})

test('replacement patterns like $& and $1 in a premise stay literal', () => {
  assert.equal(
    buildNliInput(OPENJEV_NLI_TEMPLATE, 'It costs $& and $1', 'It is priced.'),
    'Premise: It costs $& and $1\nHypothesis: It is priced.',
  )
})

const filledTemplates: Array<[string, string, string, string]> = [
  ['the default template', DEFAULT_HYPOTHESIS_TEMPLATE, 'Paris', 'The correct answer is: Paris'],
  ['every {} slot', '{} or {}', 'Paris', 'Paris or Paris'],
  ['only {} slots, never format-string fields', '{0} {name} {}', 'Paris', '{0} {name} Paris'],
  ['a document that itself contains {}', 'Answer: {}', 'set {} is empty', 'Answer: set {} is empty'],
  ['a document with replacement patterns', 'Answer: {}', 'costs $& and $1', 'Answer: costs $& and $1'],
]

for (const [description, template, document, expected] of filledTemplates) {
  test(`fillHypothesisTemplate fills ${description}`, () => {
    assert.equal(fillHypothesisTemplate(template, document), expected)
  })
}

const MISSING_SLOT = 'hypothesis_template must contain {} where each document goes.'
const TOO_LONG = 'hypothesis_template must be at most 1000 characters.'

const hypothesisTemplates: Array<[string, unknown, string | null]> = [
  ['the default template', DEFAULT_HYPOTHESIS_TEMPLATE, null],
  ['an empty string', '', MISSING_SLOT],
  ['a number', 42, MISSING_SLOT],
  ['a string without {}', 'no braces', MISSING_SLOT],
  ['exactly 1000 characters with {}', '{}' + 'x'.repeat(998), null],
  ['1001 characters with {}', '{}' + 'x'.repeat(999), TOO_LONG],
]

for (const [description, template, expected] of hypothesisTemplates) {
  test(`validateHypothesisTemplate: ${description} → ${expected ?? 'valid'}`, () => {
    assert.equal(validateHypothesisTemplate(template), expected)
  })
}

// Probability mapping — ADR-434 (g) "label order is irrelevant": probs[i] belongs to labels[i],
// the model's own id2label order. The engine's `label` string is never an input.

const F1_LABELS: JevLabel[] = ['contradiction', 'entailment', 'neutral']
const F4_LABELS: JevLabel[] = ['entailment', 'neutral', 'contradiction']

test('F1 labels map an entailment row to entailment with every class probability', () => {
  assert.deepEqual(mapProbs(F1_LABELS, [0, 0.957, 0.043]), {
    label: 'entailment',
    probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 },
  })
})

test('F4 permuted labels map through the model\'s own order', () => {
  assert.deepEqual(mapProbs(F4_LABELS, [0.957, 0.043, 0]), {
    label: 'entailment',
    probs: { entailment: 0.957, neutral: 0.043, contradiction: 0 },
  })
})

test('a tie picks the lowest class index', () => {
  assert.equal(mapProbs(F4_LABELS, [0.5, 0.5, 0]).label, 'entailment')
})

const malformedProbs: Array<[string, unknown]> = [
  ['two classes for three labels', [0.5, 0.5]],
  ['a NaN probability', [NaN, 0.5, 0.5]],
  ['an infinite probability', [Infinity, 0, 0]],
  ['a string probability', ['0.5', 0.25, 0.25]],
  ['not an array', '0.5'],
]

for (const [description, probs] of malformedProbs) {
  test(`mapProbs throws JevShapeError for ${description}`, () => {
    assert.throws(() => mapProbs(F1_LABELS, probs), JevShapeError)
  })
}
