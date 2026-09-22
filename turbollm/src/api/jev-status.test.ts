// `jevStatus()` tells the UI which Jev model is alive, in which slot and in what state, so the
// Workspace can follow the loaded model (ADR-434 (i)(1)). It reads the router's alive slots and
// the scanner's `jev` descriptor; 'stopping' counts as alive so a Jev→Jev switch never flickers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jevStatus } from './jev-status'
import type { Deps } from '../deps'
import type { AliveSlot } from '../gateway/model-router'
import type { JevInfo } from '../models/jev'
import type { ModelEntry } from '../models/scanner'

const OPENJEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

const JEV_V2 = { key: 'qwen3.5 4b nli v2|mlx-fp16|9012345678', name: 'qwen3.5 4b nli v2', jev: OPENJEV }
const JEV_V1 = { key: 'qwen3.5 4b nli v1|mlx-fp16|9012345000', name: 'qwen3.5 4b nli v1', jev: OPENJEV }
const CHAT = { key: 'gemma 4 e4b|Q6_K|6217256480', name: 'Gemma 4 E4B' }

function depsWith(slots: AliveSlot[]): Deps {
  const library = new Map([JEV_V2, JEV_V1, CHAT].map((m) => [m.key, m as unknown as ModelEntry]))
  return {
    modelRouter: { aliveSlots: () => slots },
    scanner: { get: (key: string) => library.get(key) },
  } as unknown as Deps
}

function slot(modelKey: string, overrides: Partial<AliveSlot> = {}): AliveSlot {
  return { modelKey, state: 'running', primary: false, lastUsedMs: 0, ...overrides }
}

test('a running Jev primary is reported in the primary slot', () => {
  const status = jevStatus(depsWith([slot(JEV_V2.key, { primary: true })]))

  assert.deepEqual(status, {
    key: JEV_V2.key, name: JEV_V2.name, labels: OPENJEV.labels, state: 'running', slot: 'primary',
  })
})

test('with a chat primary, the most recently used Jev pool slot is reported', () => {
  const status = jevStatus(depsWith([
    slot(CHAT.key, { primary: true, lastUsedMs: 900 }),
    slot(JEV_V1.key, { lastUsedMs: 100 }),
    slot(JEV_V2.key, { lastUsedMs: 500 }),
  ]))

  assert.deepEqual(status, {
    key: JEV_V2.key, name: JEV_V2.name, labels: OPENJEV.labels, state: 'running', slot: 'pool',
  })
})

test('a Jev primary wins over a more recently used Jev pool slot', () => {
  const status = jevStatus(depsWith([
    slot(JEV_V1.key, { primary: true, lastUsedMs: 100 }),
    slot(JEV_V2.key, { lastUsedMs: 500 }),
  ]))

  assert.equal(status?.key, JEV_V1.key)
  assert.equal(status?.slot, 'primary')
})

test('a stopping Jev primary still counts as alive', () => {
  const status = jevStatus(depsWith([slot(JEV_V2.key, { primary: true, state: 'stopping' })]))

  assert.equal(status?.state, 'stopping')
  assert.equal(status?.slot, 'primary')
})

test('a starting Jev pool slot is reported as starting', () => {
  const status = jevStatus(depsWith([slot(JEV_V2.key, { state: 'starting' })]))

  assert.equal(status?.state, 'starting')
  assert.equal(status?.slot, 'pool')
})

test('nothing Jev alive → null', () => {
  assert.equal(jevStatus(depsWith([])), null)
  assert.equal(jevStatus(depsWith([slot(CHAT.key, { primary: true })])), null)
})

test('a slot whose model is no longer in the library is not a Jev model', () => {
  assert.equal(jevStatus(depsWith([slot('deleted|Q4|1', { primary: true })])), null)
})
