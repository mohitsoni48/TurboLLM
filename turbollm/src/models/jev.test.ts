// Jev (NLI cross-encoder) detection — ADR-434 (g). A config.json describes a Jev model only
// when its head is a sequence classifier with exactly the three NLI labels; everything else
// (chat models, 2/4-label classifiers, sentiment heads, malformed JSON) must stay untouched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectJev, JEV_LAUNCH_TABLE } from './jev'

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
