// ADR-434 (f): a Jev model labels premise/hypothesis pairs and can never chat, so every list
// that says "pick a model to talk to" must leave it out. One predicate, so no picker can drift.
import { describe, expect, it } from 'vitest'
import { isChatModel, isSystemOneModel } from './model-kind'
import type { JevInfo, ModelEntry } from './types'

const JEV_INFO: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

function model(fields: Partial<ModelEntry>): ModelEntry {
  return fields as ModelEntry
}

describe('isChatModel', () => {
  it('accepts an ordinary model, which carries no jev descriptor', () => {
    expect(isChatModel(model({ key: 'qwen3-8b' }))).toBe(true)
  })

  it('rejects a Jev model', () => {
    expect(isChatModel(model({ key: 'qwen3.5 4b nli v2', jev: JEV_INFO }))).toBe(false)
  })

  it('still rejects a Jev model that is not verified, since it can never chat either', () => {
    expect(isChatModel(model({ jev: { ...JEV_INFO, verified: false } }))).toBe(false)
  })

  it('does not drop an embedding model: removing those from pickers is a different, undecided change', () => {
    expect(isChatModel(model({ key: 'nomic-embed', embedding: true }))).toBe(true)
  })
})

// A Laya model answers POST /v1/systemone exactly like a Jev model (it runs on its own 'laya'
// engine instead of vLLM, but that's an engine-routing detail, not a chat-vs-labeling one) — the
// Jev Playground's model picker groups both together as "not a chat model" (SwitchModelMenu).
describe('isSystemOneModel', () => {
  it('accepts a Jev model', () => {
    expect(isSystemOneModel(model({ key: 'qwen3.5-4b-nli-v2', jev: JEV_INFO }))).toBe(true)
  })

  it('accepts a Laya model', () => {
    expect(isSystemOneModel(model({ key: 'laya', laya: { checkpoints: ['english', 'multilingual'] } }))).toBe(true)
  })

  it('rejects an ordinary chat model', () => {
    expect(isSystemOneModel(model({ key: 'qwen3-8b' }))).toBe(false)
  })
})

describe('isChatModel with a Laya model', () => {
  it('leaves a Laya decision model out: it answers /v1/systemone and can never chat', () => {
    expect(isChatModel(model({ key: 'laya', laya: { checkpoints: ['english'] } }))).toBe(false)
  })
})
